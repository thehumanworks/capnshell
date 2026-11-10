import { AuthError } from "./auth.js";
import { errorMessage, printable } from "./errors.js";
import { explainDenial } from "./peers.js";
import type { PtySessionInfo } from "./shell.js";

/**
 * What `cns tty DEVICE` does when it cannot reach its session, on the first attempt or while
 * reconnecting after the connection dropped (src/commands/paired-tty.ts). The attach loop
 * there does the connecting and the terminal; these pure decisions say whether to stop, end
 * with an exit status, fall back to an unnamed terminal, retry after a wait, or give up, so
 * tty-recovery.test.ts can check every failure in every situation as a table.
 *
 *   connecting ──open──▶ attached ──connection lost──▶ reconnecting ──open──▶ attached
 *       │                   │                              │
 *       └ afterOpenFailure  └ exit, detach, Ctrl-C         └ afterOpenFailure: retry with
 *         (first: true)                                      backoff until the deadline
 */

/** A reconnecting attach waits this long after its first failed try, doubling up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 15_000;

/** A failure that ends the attach for good, with its exit status. */
export class Final extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

/** What a failure while connecting or reattaching means; on the first attempt nothing was ever granted or found. */
export function classify(error: unknown, device: string, name: string, first: boolean): Final | undefined {
  const message = printable(errorMessage(error));
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) {
    return new Final(`${device} ${first ? "does not accept" : "no longer accepts"} this device (${message}).`, 3);
  }
  if (/^Permission denied/.test(message)) {
    const explained = explainDenial(message, device);
    return new Final(first ? `${device} does not let this device use that session: ${explained}` : `access to ${device}'s sessions was revoked: ${explained}`, 4);
  }
  if (/No PTY session named/.test(message)) {
    return new Final(first ? `there is no session ${name} on ${device}; cns sessions ${device} lists them.` : `the session ${name} no longer exists on ${device}: it was killed, its time limit passed, or ${device}'s daemon restarted.`, 1);
  }
  if (/no longer exists/.test(message)) return new Final(`the session ${name} no longer exists on ${device}.`, 1);
  if (/Too many named PTY sessions/.test(message)) {
    return new Final(`${device} already holds as many named sessions as it keeps; cns sessions ${device} lists them, and cns kill ${device} NAME ends one.`, 1);
  }
  return undefined;
}

/** Whether the device refuses this one a new session, so a plain terminal is all `cns tty DEVICE` can give. */
export const noSessionAccess = (error: unknown) => /^Permission denied: sessions:(view|create) not granted/.test(errorMessage(error));

/**
 * A reattach must reach the session it first attached to, not a later one that took its
 * name while this terminal was away: the Final to end with when `info` is another session.
 */
export function sessionReplaced(original: Pick<PtySessionInfo, "pid" | "startedAt">, info: Pick<PtySessionInfo, "pid" | "startedAt">, device: string, session: string, own: boolean): Final | undefined {
  if (info.pid === original.pid && info.startedAt === original.startedAt) return undefined;
  return new Final(`${session} on ${device} ended and was replaced while disconnected; ${own ? `cns tty ${device} opens a new terminal` : `run cns tty ${device} --attach ${session} again to attach to the new one`}.`, 1);
}

export interface OpenFailure {
  device: string;
  /** The session, once started or named with --attach. */
  name: string | undefined;
  /** No attachment has been made yet. */
  first: boolean;
  /** The terminal starts its own session, rather than joining one with --attach. */
  own: boolean;
  /** Ctrl-C, Ctrl-] or a signal stopped the attach. */
  aborted: boolean;
  now: number;
  /** When a reconnecting attach gives up, and how long that is, for the message. */
  deadline: number;
  reconnectMs: number;
  /** The wait before the next try. */
  wait: number;
}

export type AfterOpenFailure =
  | { kind: "stopped" }
  | { kind: "no-sessions" }
  | { kind: "final"; message: string; code: number }
  /** A first attempt that failed for another reason reports it as cns does any error. */
  | { kind: "throw" }
  | { kind: "give-up"; message: string }
  | { kind: "retry"; waitMs: number; nextWaitMs: number };

/** What to do after a try to reach the session failed with `error`. */
export function afterOpenFailure(error: unknown, at: OpenFailure): AfterOpenFailure {
  if (at.aborted) return { kind: "stopped" };
  if (at.first && at.own && noSessionAccess(error)) return { kind: "no-sessions" };
  const final = error instanceof Final ? error : classify(error, at.device, at.name ?? "a new session", at.first);
  if (final) return { kind: "final", message: final.message, code: final.code };
  if (at.first) return { kind: "throw" };
  if (at.now > at.deadline) {
    return { kind: "give-up", message: `gave up reaching ${at.device} after ${Math.round(at.reconnectMs / 60000)} minutes: ${printable(errorMessage(error))}` };
  }
  return { kind: "retry", waitMs: at.wait, nextWaitMs: Math.min(RETRY_MAX_MS, at.wait * 2) };
}
