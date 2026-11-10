import { fingerprint, type PublicKey } from "./identity.js";
import type { Decision, Proposal } from "./pairing.js";
import type { Permission } from "./peers.js";

/**
 * The invites a daemon has handed out and not yet settled, each a small state machine:
 *
 *   open ──propose──▶ proposed ──decide──▶ (saved and dialing, or declined)
 *     │                  │
 *     └─ expired         └─ undecided, left
 *     └─ cancelled, stopped (from either state)
 *
 * While open, the invite's secret proves a pairing (secretFor) until it expires. The first
 * device to propose takes it: the secret stops working, so it pairs one device at most,
 * and the person at `cns pair` has DECISION_MS to decide. An invite that ends otherwise
 * tells everyone waiting on it why, and nothing is saved on either side. A decision grants
 * at most what the proposing device requested, and when saving fails the device is told
 * no, so neither side keeps half a pairing.
 *
 * The clock and timers are passed in, so invites.test.ts can run every state against every
 * event without waiting.
 */

/** How long the person on the inviting device has to decide once a proposal arrives. */
export const DECISION_MS = 10 * 60 * 1000;

/** Why an invite ended without a decision, as the proposing device and `cns pair` are told. */
export const ENDED = {
  expired: "The invite expired before another device used it.",
  undecided: "Nobody answered the pairing proposal in time.",
  left: "The other device left before the pairing was decided.",
  cancelled: "The inviting device stopped waiting.",
  stopped: "The daemon stopped.",
} as const;

export const NOT_OPEN = "This invite is no longer open.";
export const UNKNOWN = "Unknown or expired invite.";
export const NOTHING_TO_DECIDE = "The other device left, or the invite expired; nothing was saved.";
export const SAVE_FAILED = "The other device could not save the pairing.";
export const DECLINED = "The other device declined.";

/** Timers and the clock, which tests replace. */
export interface Clock {
  now(): number;
  /** Run `run` after `ms`; a background timer does not keep the process alive. */
  set(run: () => void, ms: number, background: boolean): unknown;
  clear(timer: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  set: (run, ms, background) => {
    const timer = setTimeout(run, ms);
    if (background) timer.unref?.();
    return timer;
  },
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export type InvitePhase = "open" | "proposed";
export interface Proposed { peer: PublicKey; fingerprint: string; proposal: Proposal }

interface Entry {
  phase: InvitePhase;
  secret: Uint8Array;
  expiresAt: number;
  timer: unknown;
  proposed?: Proposed;
  waiters: Array<{ resolve: (value: Proposed) => void; reject: (error: Error) => void }>;
  decision: ReturnType<typeof Promise.withResolvers<Decision>>;
}

export class InviteBook {
  #entries = new Map<string, Entry>();
  #clock: Clock;
  #decisionMs: number;

  constructor(clock: Clock = systemClock, decisionMs = DECISION_MS) {
    this.#clock = clock;
    this.#decisionMs = decisionMs;
  }

  /** Where the invite `id` is, or undefined once it has ended or was never made. */
  phase(id: string): InvitePhase | undefined { return this.#entries.get(id)?.phase; }

  /** Hand out an invite, which ends unused after `ttlMs`. */
  open(id: string, secret: Uint8Array, expiresAt: number, ttlMs: number): void {
    const entry: Entry = { phase: "open", secret, expiresAt, timer: undefined, waiters: [], decision: Promise.withResolvers<Decision>() };
    entry.timer = this.#clock.set(() => this.#end(entry, ENDED.expired), ttlMs, true);
    this.#entries.set(id, entry);
  }

  /** The secret a device must prove to propose with invite `id`: only while it is open and unexpired. */
  secretFor(id: string): Uint8Array | undefined {
    const entry = this.#entries.get(id);
    return entry?.phase === "open" && entry.expiresAt > this.#clock.now() ? entry.secret : undefined;
  }

  /**
   * A device that proved the secret proposes a pairing. The first one takes the invite;
   * the promise settles with the decision, or rejects with why the invite ended first.
   */
  propose(id: string, peer: PublicKey, proposal: Proposal): Promise<Decision> {
    const entry = this.#entries.get(id);
    if (entry?.phase !== "open") throw new Error(NOT_OPEN);
    entry.phase = "proposed";
    entry.proposed = { peer, fingerprint: fingerprint(peer), proposal };
    this.#clock.clear(entry.timer);
    entry.timer = this.#clock.set(() => this.#end(entry, ENDED.undecided), this.#decisionMs, false);
    for (const waiter of entry.waiters.splice(0)) waiter.resolve(entry.proposed);
    return entry.decision.promise;
  }

  /** The proposal for invite `id`, once there is one; rejects with why it ended, if it does first. */
  awaitProposal(id: string): Promise<Proposed> {
    const entry = this.#entries.get(id);
    if (!entry) return Promise.reject(new Error(UNKNOWN));
    if (entry.proposed) return Promise.resolve({ ...entry.proposed });
    return new Promise((resolve, reject) => entry.waiters.push({ resolve, reject }));
  }

  /** The proposal waiting for a decision on invite `id`; throws when there is none. */
  proposal(id: string): Proposed {
    const proposed = this.#entries.get(id)?.proposed;
    if (!proposed) throw new Error(NOTHING_TO_DECIDE);
    return proposed;
  }

  /**
   * Decide on invite `id`'s proposal and end the invite. Accepting saves the device under
   * `name` (the name it proposed, unless given) with `save`, granting what `granted` and its
   * requests have in common. If saving throws, the device is told no and the error is thrown.
   */
  decide(id: string, decision: { accept: boolean; name?: string; granted?: Permission[]; reason?: string }, save: (proposed: Proposed, name: string, granted: Permission[]) => void): Decision {
    const entry = this.#entries.get(id);
    const proposed = this.proposal(id);
    let result: Decision = { accept: false, reason: decision.reason ?? DECLINED };
    let failure: unknown;
    if (decision.accept) {
      const name = decision.name ?? proposed.proposal.name;
      const granted = (decision.granted ?? []).filter((permission) => proposed.proposal.requests.includes(permission));
      try {
        save(proposed, name, granted);
        result = { accept: true, name, granted };
      } catch (error) {
        failure = error;
        result = { accept: false, reason: SAVE_FAILED };
      }
    }
    this.#clock.clear(entry!.timer);
    this.#entries.delete(id);
    entry!.decision.resolve(result);
    if (failure) throw failure;
    return result;
  }

  /** The proposing device left: its invite ends, as nobody could tell it the decision. Another device leaving changes nothing. */
  left(id: string, peer: PublicKey): void {
    const entry = this.#entries.get(id);
    if (entry?.proposed?.peer === peer) this.#end(entry, ENDED.left);
  }

  /** The `cns pair` waiting on invite `id` went away. */
  cancel(id: string): void {
    const entry = this.#entries.get(id);
    if (entry) this.#end(entry, ENDED.cancelled);
  }

  /** The daemon is stopping: every invite ends. */
  endAll(): void {
    for (const entry of [...this.#entries.values()]) this.#end(entry, ENDED.stopped);
  }

  #end(entry: Entry, why: string) {
    this.#clock.clear(entry.timer);
    for (const [id, other] of this.#entries) if (other === entry) this.#entries.delete(id);
    const error = new Error(why);
    for (const waiter of entry.waiters.splice(0)) waiter.reject(error);
    entry.decision.reject(error);
    entry.decision.promise.catch(() => {});
  }
}
