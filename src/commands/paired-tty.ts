import type { RpcStub } from "capnweb";
import { errorMessage, printable } from "../errors.js";
import { ensureIdentity } from "../identity.js";
import { explainDenial } from "../peers.js";
import type { PeerConfig } from "../options.js";
import { openDeviceLink } from "../device-link.js";
import { secureReady } from "../secure.js";
import type { PtySessionInfo, PtySessionOptions, ShellApi } from "../shell.js";
import { attachTerminal, ConnectionLost, DETACH_KEY, plain, type RemoteNamedPty } from "../terminal.js";
import { afterOpenFailure, RETRY_MIN_MS, sessionReplaced } from "../tty-recovery.js";
import { commandExitCode, describeExit } from "./one-shot.js";

/** `cns tty DEVICE` starts a session of its own, named tty-1, tty-2 and so on: the first name free on the device. */
export const SESSION_PREFIX = "tty-";
/** How many taken names a new terminal tries before giving up; the device's own session limit usually ends it first. */
const MAX_NAME_TRIES = 64;
/** How long a terminal that is stopping waits for its device to end the session it started. */
const END_MS = 3000;
/** How long an attach keeps trying to get back to its session after the connection drops. */
export const RECONNECT_MS = Number(process.env.CNS_RECONNECT_MS) > 0 ? Number(process.env.CNS_RECONNECT_MS) : 10 * 60 * 1000;
const CTRL_C = 0x03;

const say = (message: string) => process.stderr.write(`${process.stderr.isTTY ? "\r\n" : ""}[cns: ${message}]\n`);

/** The device does not let this one start sessions, so `cns tty DEVICE` uses an unnamed terminal instead. */
export const NO_SESSIONS = Symbol("no sessions");

/** Settle with `promise`, or reject once `ms` have passed. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); })]);
  } finally { clearTimeout(timer); }
}

/**
 * Start a login shell under the first free name of tty-1, tty-2, ... and return the name.
 * Listing needs sessions:list; without it, taken names are found by trying them. Two
 * terminals starting at once both try the same name, and the one refused takes the next.
 */
export async function startTerminal(remote: RpcStub<ShellApi>, options: PtySessionOptions): Promise<string> {
  let taken = new Set<string>();
  try { taken = new Set((await plain(remote.ptySessions() as unknown as Promise<PtySessionInfo[]>)).map((session) => session.name)); }
  catch (error) { if (!/^Permission denied/.test(errorMessage(error))) throw error; }
  for (let number = 1, tries = 0; ; number++) {
    const name = `${SESSION_PREFIX}${number}`;
    if (taken.has(name)) continue;
    try {
      using started = await remote.startPtySession(name, options);
      void started;
      return name;
    } catch (error) {
      if (!/already exists/.test(errorMessage(error)) || ++tries >= MAX_NAME_TRIES) throw error;
    }
  }
}

/**
 * `cns tty DEVICE` at a terminal, and `cns tty DEVICE --attach NAME`, for a paired device.
 *
 * Without --attach, each invocation starts a login shell of its own in a new named session
 * (tty-1, tty-2, ...), so several terminals on one device each get their own. The session
 * belongs to this terminal: it is removed when its program exits, and ended when cns stops
 * or its terminal closes (SIGHUP, SIGTERM, SIGINT) while the device can be reached. Ctrl-]
 * detaches and leaves it running, to rejoin with --attach NAME. --attach joins a session
 * that may be shared and never ends it.
 *
 * Either way, when the connection drops, keep trying to reach the device again for
 * RECONNECT_MS, then reattach to the same session, reporting how much output was written
 * meanwhile and whether input may have been lost. Input in flight is never sent twice;
 * at a terminal, keys typed while disconnected are read and discarded, except Ctrl-C
 * (stop) and Ctrl-] (give up and leave the session running).
 *
 * Returns NO_SESSIONS when a new session was asked for and the device does not let this
 * one start sessions, so the caller can open an unnamed terminal instead.
 */
export async function attachPaired(config: PeerConfig): Promise<number | typeof NO_SESSIONS> {
  const expect = config.expect!;
  const own = !config.attach;
  /** The session, once this terminal has started it or from --attach. */
  let name: string | undefined = own ? undefined : config.name;
  const { identity } = ensureIdentity();
  await secureReady();
  const interrupted = new AbortController();
  let exitOnSignal = 130;
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const handlers = Object.entries(signals).map(([signal, code]) => {
    const handler = () => { exitOnSignal = code; interrupted.abort(); };
    // A closed terminal sends SIGHUP. A platform that lacks one of these signals never sends it.
    try { process.once(signal, handler); } catch {}
    return [signal, handler] as const;
  });
  const input = process.stdin;
  const terminal = !!(input.isTTY && process.stdout.isTTY);
  const originalRaw = input.isTTY ? input.isRaw : false;
  // A terminal that has closed refuses to change mode; there is nothing left to restore.
  const restore = () => { try { if (input.isTTY) input.setRawMode(originalRaw); } catch {} };
  process.once("exit", restore);
  // Writing to a terminal that has closed fails; that must not stop cns from ending its session.
  const ignore = () => {};
  process.stdout.on("error", ignore);
  process.stderr.on("error", ignore);
  let seen: number | undefined;
  /** The session as first attached: a reattach must reach this one, not a later one that took its name. */
  let original: Pick<PtySessionInfo, "pid" | "startedAt"> | undefined;
  let first = true;
  let gaveUp = false;
  // While disconnected at a terminal: keep it raw so typing is neither echoed nor kept, and read it away.
  let dropped = 0;
  const discard = (chunk: Buffer | string) => {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (data.includes(CTRL_C)) { exitOnSignal = 130; interrupted.abort(); return; }
    if (data.includes(DETACH_KEY)) { gaveUp = true; interrupted.abort(); return; }
    dropped += data.length;
  };
  const disconnectedInput = (on: boolean) => {
    if (!terminal) return;
    if (on) { input.setRawMode(true); input.on("data", discard); input.resume(); }
    else { input.off("data", discard); input.pause(); }
  };
  const delay = (ms: number) => new Promise<void>((resolve) => {
    if (interrupted.signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); interrupted.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    interrupted.signal.addEventListener("abort", done, { once: true });
  });
  const rejoin = (session: string) => `cns tty ${expect.name} --attach ${session} returns to it`;
  /** This terminal's session outlives it: say how to get back to it or end it. */
  const kept = () => { if (own && name !== undefined) say(`${name} keeps running on ${expect.name}: ${rejoin(name)}, cns kill ${expect.name} ${name} ends it`); };
  /** End and remove the session this terminal started; false when the device could not do it in time. */
  const end = async (connected: Connected) => {
    try { await within(plain(connected.session.kill()), END_MS); return true; }
    catch { return false; }
  };
  /** cns was stopped: end this terminal's session when it is still reachable. */
  const stopped = async (connected?: Connected) => {
    if (gaveUp) {
      // Only possible once attached, so the session has its name.
      say(`stopped reconnecting; ${name} keeps running on ${expect.name}: ${rejoin(name!)}`);
      return 0;
    }
    if (own && name !== undefined && !(connected && await end(connected))) kept();
    return exitOnSignal;
  };
  try {
    for (;;) {
      const deadline = Date.now() + RECONNECT_MS;
      let wait = RETRY_MIN_MS;
      let connected: Connected;
      for (;;) {
        if (interrupted.signal.aborted) return await stopped();
        try {
          connected = await open();
          break;
        } catch (error) {
          // Stop, end, fall back, give up or retry: tty-recovery.ts decides.
          const next = afterOpenFailure(error, { device: expect.name, name, first, own, aborted: interrupted.signal.aborted, now: Date.now(), deadline, reconnectMs: RECONNECT_MS, wait });
          if (next.kind === "stopped") return await stopped();
          if (next.kind === "no-sessions") return NO_SESSIONS;
          if (next.kind === "final") { say(next.message); return next.code; }
          if (next.kind === "throw") throw error;
          if (next.kind === "give-up") { say(next.message); kept(); return 1; }
          await delay(next.waitMs);
          wait = next.nextWaitMs;
        }
      }
      disconnectedInput(false);
      if (dropped) {
        say(`discarded ${dropped} byte${dropped === 1 ? "" : "s"} typed while disconnected`);
        dropped = 0;
      }
      const session = name!;
      const reattaching = !first;
      let reported = false;
      // The first chunk of an attachment is the redraw, at the offset it shows.
      const report = (end: number | undefined) => {
        if (!reported) {
          reported = true;
          if (reattaching && seen !== undefined && end !== undefined && end > seen) {
            say(`reattached to ${expect.name}/${session} via ${connected.via}; ${end - seen} bytes of output were written while disconnected and are shown as the current screen`);
          } else if (reattaching) say(`reattached to ${expect.name}/${session} via ${connected.via}`);
        }
        if (end !== undefined) seen = end;
      };
      if (first && process.stderr.isTTY) say(`connected to ${expect.name} via ${connected.via}; session ${session}. Ctrl-] detaches.`);
      first = false;
      try {
        const sized = !!process.stdout.isTTY || config.cols !== undefined || config.rows !== undefined;
        const result = await attachTerminal((sink, options) => connected.session.attach(sink, {
          ...(sized ? { cols: options.cols, rows: options.rows } : {}), answers: !options.respond,
        }), { cols: config.cols, rows: config.rows }, {
          signal: interrupted.signal, detachKey: DETACH_KEY, alternateScreen: true, onOutput: report,
          onInputRefused: (reason) => say(`${expect.name} lets this device watch ${session} but not type into it (${explainDenial(printable(reason), expect.name)})`),
        });
        if (result.exit) {
          // This terminal's session ends with its program; one joined with --attach keeps its final screen for others.
          if (own && !await end(connected)) say(`${session} has ended, but ${expect.name} still lists it; cns kill ${expect.name} ${session} removes it`);
          if (process.stdout.isTTY) say(`${session} ${describeExit(result.exit)}`);
          return commandExitCode(result.exit);
        }
        if (result.detached) { say(printable(result.detached)); kept(); return 1; }
        if (process.stdout.isTTY) say(`detached from ${session}; it keeps running on ${expect.name}${own ? `: ${rejoin(session)}` : ""}`);
        return 0;
      } catch (error) {
        if (interrupted.signal.aborted) return await stopped(connected);
        // A link that broke during the attach call itself is a lost connection too.
        const lost = error instanceof ConnectionLost ? error : connected.lost() ? new ConnectionLost(errorMessage(error), 0) : undefined;
        if (!lost) throw error;
        disconnectedInput(true);
        say(`the connection to ${expect.name} was lost; reconnecting${terminal ? " (Ctrl-C stops, Ctrl-] gives up and leaves the session running)" : ""}`);
        if (lost.inFlight) say(`${lost.inFlight} byte${lost.inFlight === 1 ? "" : "s"} of input may not have arrived; check the screen before typing again`);
      } finally {
        connected.close();
      }
    }
  } finally {
    disconnectedInput(false);
    restore();
    process.off("exit", restore);
    process.stdout.off("error", ignore);
    process.stderr.off("error", ignore);
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }

  async function open() {
    // The local daemon's standing link when it has one, else a connection of its own; after
    // an outage too, so the daemon's link, once it is back, serves the reattach.
    const link = await openDeviceLink(expect, identity, interrupted.signal);
    const { remote } = link;
    const close = () => { remote[Symbol.dispose](); link.close("Attachment ended"); };
    let started = false;
    let handle: RemoteNamedPty | undefined;
    try {
      if (name === undefined) {
        name = await startTerminal(remote, { cwd: config.cwd, cols: config.cols ?? process.stdout.columns, rows: config.rows ?? process.stdout.rows, term: config.term, timeoutMs: config.timeoutMs });
        started = true;
        say(`started a login shell on ${expect.name} as session ${name}`);
      }
      const session = name;
      handle = await remote.ptySession(session) as unknown as RemoteNamedPty;
      const info = await plain(handle.info());
      original ??= { pid: info.pid, startedAt: info.startedAt };
      const replaced = sessionReplaced(original, info, expect.name, session, own);
      if (replaced) throw replaced;
      const opened = handle;
      return {
        session: opened,
        info,
        via: link.lent ? `this device's daemon (${link.via === "relay" ? "through the relay" : "directly"})` : link.via === "relay" ? "the relay" : "a direct link",
        lost: () => !link.open,
        close: () => { opened[Symbol.dispose](); close(); },
      };
    } catch (error) {
      // A terminal that never attached to the session it just started does not leave it behind.
      if (started && handle) {
        try { await within(plain(handle.kill()), END_MS); name = undefined; } catch {}
      }
      handle?.[Symbol.dispose]();
      close();
      throw error;
    }
  }
}

type Connected = {
  session: RemoteNamedPty;
  info: PtySessionInfo;
  via: string;
  lost: () => boolean;
  close: () => void;
};
