import { AuthError } from "../auth.js";
import { errorMessage } from "../errors.js";
import { ensureIdentity } from "../identity.js";
import type { PeerConfig } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { isRelayAddress } from "../relay-hub.js";
import { connectFirst, rpcSession, secureReady } from "../secure.js";
import type { ShellApi } from "../shell.js";
import { attachTerminal, ConnectionLost, DETACH_KEY, plain, type RemoteNamedPty } from "../terminal.js";
import { commandExitCode, describeExit } from "./one-shot.js";

/** The session `cns tty DEVICE` uses on a paired device when no other is named. */
export const DEFAULT_SESSION = "main";
/** How long an attach keeps trying to get back to its session after the connection drops. */
export const RECONNECT_MS = 10 * 60 * 1000;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 15_000;

const say = (message: string) => process.stderr.write(`${process.stderr.isTTY ? "\r\n" : ""}[cns: ${message}]\n`);
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** A failure that ends the attach for good, with its exit status. */
class Final extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

/** What a failure while connecting or reattaching means for the attach. */
function classify(error: unknown, device: string, name: string): Final | undefined {
  const message = errorMessage(error);
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) {
    return new Final(`${device} no longer accepts this device (${message}).`, 3);
  }
  if (/^Permission denied/.test(message)) return new Final(`access to ${device}'s sessions was revoked: ${message}`, 4);
  if (/No PTY session named|no longer exists/.test(message)) {
    return new Final(`the session ${name} no longer exists on ${device}: it was killed, its time limit passed, or ${device}'s daemon restarted.`, 1);
  }
  return undefined;
}

/**
 * `cns tty DEVICE [--attach NAME]` for a paired device: attach to a named session, by
 * default `main`, starting a login shell there if it does not exist yet. When the
 * connection drops, keep trying to reach the device again for RECONNECT_MS, then
 * reattach to the same session, reporting how much output was written meanwhile and
 * whether input may have been lost. Input in flight is never sent twice, and keys typed
 * at a terminal while disconnected are discarded rather than typed blind.
 */
export async function attachPaired(config: PeerConfig): Promise<number> {
  const expect = config.expect!;
  const name = config.name ?? DEFAULT_SESSION;
  const create = !config.attach;
  const { identity } = ensureIdentity();
  await secureReady();
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let seen: number | undefined;
  let first = true;
  try {
    for (;;) {
      let deadline = Date.now() + RECONNECT_MS;
      let wait = RETRY_MIN_MS;
      // Connect, and find (or start) the session.
      let connected: { close(): void; session: RemoteNamedPty; via: string };
      for (;;) {
        if (interrupted.signal.aborted) return 130;
        try {
          connected = await open(name, first && create);
          break;
        } catch (error) {
          const final = classify(error, expect.name, name);
          if (final) { say(final.message); return final.code; }
          if (first) throw error;
          if (Date.now() > deadline) { say(`gave up reaching ${expect.name} after ${Math.round(RECONNECT_MS / 60000)} minutes: ${errorMessage(error)}`); return 1; }
          await delay(wait, interrupted.signal);
          wait = Math.min(RETRY_MAX_MS, wait * 2);
        }
      }
      // Keys typed at a terminal while disconnected were typed blind: never send them.
      if (!first && process.stdin.isTTY) {
        let dropped = 0;
        for (let chunk = process.stdin.read(); chunk !== null; chunk = process.stdin.read()) dropped += chunk.length;
        if (dropped) say(`discarded ${dropped} byte${dropped === 1 ? "" : "s"} typed while disconnected`);
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
        }), { cols: config.cols, rows: config.rows }, { signal: interrupted.signal, detachKey: DETACH_KEY, alternateScreen: true, onOutput: report });
        if (result.exit) {
          if (process.stdout.isTTY) say(`${name} ${describeExit(result.exit)}`);
          return commandExitCode(result.exit);
        }
        if (result.detached) { say(result.detached); return 1; }
        if (process.stdout.isTTY) say(`detached from ${name}; it keeps running on ${expect.name}`);
        return 0;
      } catch (error) {
        if (interrupted.signal.aborted) return 130;
        if (!(error instanceof ConnectionLost)) throw error;
        say(`the connection to ${expect.name} was lost; reconnecting`);
        if (error.inFlight) say(`${error.inFlight} byte${error.inFlight === 1 ? "" : "s"} of input may not have arrived; check the screen before typing again`);
        deadline = Date.now() + RECONNECT_MS;
      } finally {
        connected.close();
      }
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }

  async function open(session: string, startIfMissing: boolean) {
    const { channel, url } = await connectFirst(expect.addresses, identity, { expect: expect.publicKey, signal: interrupted.signal });
    const remote = rpcSession<ShellApi>(channel, new RefusingShell());
    const close = () => { remote[Symbol.dispose](); channel.close("Attachment ended"); };
    try {
      let handle: RemoteNamedPty;
      try { handle = await remote.ptySession(session) as unknown as RemoteNamedPty; }
      catch (error) {
        if (!startIfMissing || !/No PTY session named/.test(errorMessage(error))) throw error;
        using started = await remote.startPtySession(session, { cwd: config.cwd, cols: config.cols ?? process.stdout.columns, rows: config.rows ?? process.stdout.rows, term: config.term });
        void started;
        handle = await remote.ptySession(session) as unknown as RemoteNamedPty;
        say(`started a login shell on ${expect.name} as session ${session}`);
      }
      // A finished default session is replaced by a fresh shell rather than showing its last screen.
      if (startIfMissing) {
        const info = await plain(handle.info());
        if (!info.running) {
          await plain(handle.kill());
          handle[Symbol.dispose]();
          using started = await remote.startPtySession(session, { cwd: config.cwd, cols: config.cols ?? process.stdout.columns, rows: config.rows ?? process.stdout.rows, term: config.term });
          void started;
          handle = await remote.ptySession(session) as unknown as RemoteNamedPty;
          say(`the previous ${session} had ended; started a new login shell`);
        }
      }
      return { session: handle, via: isRelayAddress(url) ? "the relay" : "a direct link", close: () => { handle[Symbol.dispose](); close(); } };
    } catch (error) {
      close();
      throw error;
    }
  }
}
