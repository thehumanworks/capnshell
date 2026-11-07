import { AuthError } from "../auth.js";
import { errorMessage, printable } from "../errors.js";
import { ensureIdentity } from "../identity.js";
import type { PeerConfig } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { dialAddresses, isRelayAddress } from "../relay-hub.js";
import { connectFirst, rpcSession, secureReady } from "../secure.js";
import type { PtySessionInfo, ShellApi } from "../shell.js";
import { attachTerminal, ConnectionLost, DETACH_KEY, plain, type RemoteNamedPty } from "../terminal.js";
import { localRelay } from "./daemon.js";
import { commandExitCode, describeExit } from "./one-shot.js";

/** The session `cns tty DEVICE` uses on a paired device when no other is named. */
export const DEFAULT_SESSION = "main";
/** How long an attach keeps trying to get back to its session after the connection drops. */
export const RECONNECT_MS = Number(process.env.CNS_RECONNECT_MS) > 0 ? Number(process.env.CNS_RECONNECT_MS) : 10 * 60 * 1000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 15_000;
const CTRL_C = 0x03;

const say = (message: string) => process.stderr.write(`${process.stderr.isTTY ? "\r\n" : ""}[cns: ${message}]\n`);

/** A failure that ends the attach for good, with its exit status. */
class Final extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}
/** The device grants this one no session access, so `cns tty DEVICE` uses an unnamed terminal instead. */
export const NO_SESSIONS = Symbol("no sessions");

/** What a failure while connecting or reattaching means; on the first attempt nothing was ever granted or found. */
function classify(error: unknown, device: string, name: string, first: boolean): Final | undefined {
  const message = printable(errorMessage(error));
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) {
    return new Final(`${device} ${first ? "does not accept" : "no longer accepts"} this device (${message}).`, 3);
  }
  if (/^Permission denied/.test(message)) {
    return new Final(first ? `${device} does not let this device use that session: ${message}` : `access to ${device}'s sessions was revoked: ${message}`, 4);
  }
  if (/No PTY session named/.test(message)) {
    return new Final(first ? `there is no session ${name} on ${device}; cns sessions ${device} lists them.` : `the session ${name} no longer exists on ${device}: it was killed, its time limit passed, or ${device}'s daemon restarted.`, 1);
  }
  if (/no longer exists/.test(message)) return new Final(`the session ${name} no longer exists on ${device}.`, 1);
  return undefined;
}

/** Whether the device grants no session access at all, so a plain terminal is all `cns tty DEVICE` can give. */
const noSessionAccess = (error: unknown) => /^Permission denied: sessions:(view|create) not granted/.test(errorMessage(error));

/**
 * `cns tty DEVICE [--attach NAME]` for a paired device: attach to a named session, by
 * default `main`, starting a login shell there if it does not exist yet. When the
 * connection drops, keep trying to reach the device again for RECONNECT_MS, then
 * reattach to the same session, reporting how much output was written meanwhile and
 * whether input may have been lost. Input in flight is never sent twice; at a terminal,
 * keys typed while disconnected are read and discarded, except Ctrl-C (stop) and
 * Ctrl-] (give up and leave the session running).
 *
 * Returns NO_SESSIONS when the default session was asked for and the device grants no
 * session access, so the caller can open an unnamed terminal instead.
 */
export async function attachPaired(config: PeerConfig): Promise<number | typeof NO_SESSIONS> {
  const expect = config.expect!;
  const name = config.name ?? DEFAULT_SESSION;
  const create = !config.attach;
  const { identity } = ensureIdentity();
  // Saved addresses, and this device's relay when the record has none: devices that share a relay meet there.
  const addresses = dialAddresses(expect, await localRelay(config.state));
  await secureReady();
  const interrupted = new AbortController();
  let exitOnSignal = 130;
  const onSigint = () => { exitOnSignal = 130; interrupted.abort(); };
  const onSigterm = () => { exitOnSignal = 143; interrupted.abort(); };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const input = process.stdin;
  const terminal = !!(input.isTTY && process.stdout.isTTY);
  const originalRaw = input.isTTY ? input.isRaw : false;
  const restore = () => { if (input.isTTY) input.setRawMode(originalRaw); };
  process.once("exit", restore);
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
  const stopped = () => gaveUp ? (say(`stopped reconnecting; ${name} keeps running on ${expect.name}`), 0) : exitOnSignal;
  try {
    for (;;) {
      const deadline = Date.now() + RECONNECT_MS;
      let wait = RETRY_MIN_MS;
      let connected: Awaited<ReturnType<typeof open>>;
      for (;;) {
        if (interrupted.signal.aborted) return stopped();
        try {
          connected = await open(name, first && create);
          break;
        } catch (error) {
          if (interrupted.signal.aborted) return stopped();
          if (first && create && noSessionAccess(error)) return NO_SESSIONS;
          const final = error instanceof Final ? error : classify(error, expect.name, name, first);
          if (final) { say(final.message); return final.code; }
          if (first) throw error;
          if (Date.now() > deadline) { say(`gave up reaching ${expect.name} after ${Math.round(RECONNECT_MS / 60000)} minutes: ${printable(errorMessage(error))}`); return 1; }
          await delay(wait);
          wait = Math.min(RETRY_MAX_MS, wait * 2);
        }
      }
      disconnectedInput(false);
      if (dropped) {
        say(`discarded ${dropped} byte${dropped === 1 ? "" : "s"} typed while disconnected`);
        dropped = 0;
      }
      const reattaching = !first;
      let reported = false;
      // The first chunk of an attachment is the redraw, at the offset it shows.
      const report = (end: number | undefined) => {
        if (!reported) {
          reported = true;
          if (reattaching && seen !== undefined && end !== undefined && end > seen) {
            say(`reattached to ${expect.name}/${name} via ${connected.via}; ${end - seen} bytes of output were written while disconnected and are shown as the current screen`);
          } else if (reattaching) say(`reattached to ${expect.name}/${name} via ${connected.via}`);
        }
        if (end !== undefined) seen = end;
      };
      if (first && process.stderr.isTTY) say(`connected to ${expect.name} via ${connected.via}; session ${name}. Ctrl-] detaches.`);
      first = false;
      try {
        const sized = !!process.stdout.isTTY || config.cols !== undefined || config.rows !== undefined;
        const result = await attachTerminal((sink, options) => connected.session.attach(sink, {
          ...(sized ? { cols: options.cols, rows: options.rows } : {}), answers: !options.respond,
        }), { cols: config.cols, rows: config.rows }, {
          signal: interrupted.signal, detachKey: DETACH_KEY, alternateScreen: true, onOutput: report,
          onInputRefused: (reason) => say(`${expect.name} lets this device watch ${name} but not type into it (${printable(reason)})`),
        });
        if (result.exit) {
          if (process.stdout.isTTY) say(`${name} ${describeExit(result.exit)}`);
          return commandExitCode(result.exit);
        }
        if (result.detached) { say(printable(result.detached)); return 1; }
        if (process.stdout.isTTY) say(`detached from ${name}; it keeps running on ${expect.name}`);
        return 0;
      } catch (error) {
        if (interrupted.signal.aborted) return stopped();
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
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

  async function open(session: string, startIfMissing: boolean) {
    const { channel, url } = await connectFirst(addresses, identity, { expect: expect.publicKey, signal: interrupted.signal });
    const remote = rpcSession<ShellApi>(channel, new RefusingShell());
    const close = () => { remote[Symbol.dispose](); channel.close("Attachment ended"); };
    let startedNow = false;
    const start = async () => {
      startedNow = true;
      try {
        using started = await remote.startPtySession(session, { cwd: config.cwd, cols: config.cols ?? process.stdout.columns, rows: config.rows ?? process.stdout.rows, term: config.term, timeoutMs: config.timeoutMs });
        void started;
        say(`started a login shell on ${expect.name} as session ${session}`);
      } catch (error) {
        // Another client started it a moment ago: use theirs.
        if (!/already exists/.test(errorMessage(error))) throw error;
        startedNow = false;
      }
      return await remote.ptySession(session) as unknown as RemoteNamedPty;
    };
    try {
      let handle: RemoteNamedPty;
      try { handle = await remote.ptySession(session) as unknown as RemoteNamedPty; }
      catch (error) {
        if (!startIfMissing || !/No PTY session named/.test(errorMessage(error))) throw error;
        handle = await start();
      }
      let info = await plain(handle.info());
      if (startIfMissing && !info.running) {
        // A finished default session is replaced by a fresh shell, when this device may end it.
        try {
          await plain(handle.kill());
          handle[Symbol.dispose]();
          handle = await start();
          info = await plain(handle.info());
          say(`the previous ${session} had ended; started a new login shell`);
        } catch (error) {
          const message = errorMessage(error);
          if (/no longer exists/.test(message)) { handle[Symbol.dispose](); handle = await remote.ptySession(session) as unknown as RemoteNamedPty; info = await plain(handle.info()); }
          else if (/^Permission denied/.test(message)) say(`${session} on ${expect.name} has ended, and this device may not replace it; showing its last screen`);
          else throw error;
        }
      }
      if (!original) {
        original = { pid: info.pid, startedAt: info.startedAt };
        if (startIfMissing && !startedNow && (config.cwd !== undefined || config.term !== undefined || config.timeoutMs !== undefined)) {
          say(`${session} already runs on ${expect.name}; --cwd, --term and --timeout apply only when it starts`);
        }
      } else if (info.pid !== original.pid || info.startedAt !== original.startedAt) {
        handle[Symbol.dispose]();
        throw new Final(`${session} on ${expect.name} ended and was replaced while disconnected; run cns tty ${expect.name}${config.attach ? ` --attach ${session}` : ""} again to attach to the new one.`, 1);
      }
      const opened = handle;
      return {
        session: opened,
        info,
        via: isRelayAddress(url) ? "the relay" : "a direct link",
        lost: () => !channel.open,
        close: () => { opened[Symbol.dispose](); close(); },
      };
    } catch (error) {
      close();
      throw error;
    }
  }
}
