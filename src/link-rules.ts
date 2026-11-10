import type { AuthCode } from "./auth.js";
import { dialAddresses, isRelayAddress } from "./relay-hub.js";

/**
 * The rules by which two daemons keep exactly one standing link between them.
 *
 * Both daemons dial every paired device they hold no link to, so after pairing, after a
 * restart and after an outage both often dial at once. Each daemon applies these rules on
 * its own, with no message about which link to keep, and both must still end up holding
 * the same single link. The rules are pure: src/commands/peer.ts calls them at each point
 * where a link can appear, and src/link-rules.test.ts checks them as tables and runs them
 * on two simulated daemons through every order in which their links can open and close.
 *
 * The points where a link can appear, and the rule each one takes:
 *
 *   a dial loop's turn        dialTurn     dial (every address, or only direct ones to
 *                                          replace a relayed link) or wait
 *   a dial that failed        afterDialFailure  stop the loop, or try again later
 *   a link this side dialed   onDialed     take it, replace the held link, or drop it
 *   a link the other dialed   onInbound    take it, replace the held link, or refuse it
 *
 * A held link is the standing link this daemon has to the device, if any, whether or not
 * it has answered yet. One command's connection and a pairing proposal never count.
 */

/**
 * Daemon links made within this long of each other count as both devices dialing at
 * once, settled by the key rule. A daemon dials only when it has no link, so a dial
 * that arrives later means the link this side holds is dead on the other.
 */
export const DIAL_RACE_MS = 5000;
/**
 * A standing link through the relay is replaced by a direct one this long after it was made,
 * if the device can be dialed directly by then: twice the dial race, so that both daemons,
 * whose clocks for the link start a moment apart, agree that the race is over.
 */
export const UPGRADE_AFTER_MS = 2 * DIAL_RACE_MS;
/** A dial loop, or a relay registration, waits this long after its first failure, doubling up to REDIAL_MAX_MS. */
export const REDIAL_MIN_MS = 1000;
export const REDIAL_MAX_MS = 30_000;

/** What the rules need to know about the standing link a daemon holds to a device. */
export interface HeldLink {
  /** This daemon dialed it. */
  readonly outbound: boolean;
  readonly via: "direct" | "relay";
  /** When this daemon took the link, in milliseconds since the epoch. */
  readonly since: number;
}

/** How long to wait before retry number `attempt` (counted from 0): 1 s, doubling, at most 30 s. */
export function redialDelay(attempt: number): number {
  return Math.min(REDIAL_MAX_MS, REDIAL_MIN_MS * 2 ** Math.min(Math.max(attempt, 0), 5));
}

/** When both devices dialed each other at once, the one with the smaller key keeps the link it dialed. */
export function keepsOutbound(ownKey: string, otherKey: string): boolean {
  return ownKey < otherKey;
}

/**
 * Whether to keep a standing link to a paired device. A device that gave no address of its
 * own and lets this one do nothing, such as the gateway (gateway/), never answers through
 * the relay and offers nothing over a link: it dials when it needs this device, so dialing
 * it would only knock on the relay every 30 seconds for nothing.
 */
export function worthDialing(entry: { publicKey: string; addresses: readonly string[]; grants: { outgoing: readonly string[] } }, relay: string | undefined): boolean {
  if (!entry.addresses.length && !entry.grants.outgoing.length) return false;
  return dialAddresses(entry, relay).length > 0;
}

export type DialTurn =
  | { action: "wait" }
  /** `upgrade`: the dial is to replace the held relayed link with a direct one. */
  | { action: "dial"; addresses: string[]; upgrade: boolean };

/**
 * What a dial loop does on its turn, given the link held to the device and the addresses
 * to dial it at. Without a link it dials them all. With one it waits, unless the link runs
 * through the relay, is past the dial race that the other daemon also applies, and the
 * device has a direct address: then it dials only those, to replace the relayed link. A
 * device that cannot be dialed, such as one in WSL behind its host's firewall, can still
 * dial this one, and whichever daemon dialed first, typing would otherwise cross the relay.
 */
export function dialTurn(held: HeldLink | undefined, addresses: readonly string[], now: number): DialTurn {
  if (!held) return { action: "dial", addresses: [...addresses], upgrade: false };
  const direct = addresses.filter((url) => !isRelayAddress(url));
  if (held.via !== "relay" || !direct.length || now - held.since < UPGRADE_AFTER_MS) return { action: "wait" };
  return { action: "dial", addresses: direct, upgrade: true };
}

/**
 * Whether a dial loop goes on after its dial failed with `code` (an AuthError's, if it was
 * one). A device that answers as another device, or no longer knows this one, ends the
 * loop: dialing again would get the same answer until a person pairs again. While upgrading,
 * a direct address that answers wrongly says nothing about the device, whose relayed link
 * still works, so the loop goes on.
 */
export function afterDialFailure(code: AuthCode | undefined, upgrade: boolean): "stop" | "retry" {
  if (!upgrade && (code === "identity-changed" || code === "not-paired")) return "stop";
  return "retry";
}

/**
 * What to do with a daemon link this side dialed, now that it has opened. `held` is the
 * standing link held now; `replacing` says it is the very link the dial set out to
 * replace (dialTurn's `upgrade`), which it then does, here and, through onInbound, on the
 * other device. Any other held link appeared while dialing: both devices dialed at once,
 * and exactly one link survives, chosen the same way on both sides.
 */
export function onDialed(held: HeldLink | undefined, replacing: boolean, ownKeepsOutbound: boolean): "take" | "replace" | "drop" {
  if (!held) return "take";
  if (replacing) return "replace";
  return ownKeepsOutbound ? "replace" : "drop";
}

/**
 * What to do with a link the other device dialed, once it has authenticated. A command's
 * connection or a pairing proposal (`daemon` false) is taken beside any standing link. A
 * daemon link replaces the one held, except that the smaller key keeps a link it dialed
 * within the dial race: the other device dialed at the same time, and drops its own link
 * through onDialed. A held link older than that is dead on the other device, which only
 * dials without one, as after a restart or a direct link replacing a relayed one.
 */
export function onInbound(held: HeldLink | undefined, daemon: boolean, ownKeepsOutbound: boolean, now: number): "take" | "replace" | "refuse" {
  if (!daemon || !held) return "take";
  if (held.outbound && ownKeepsOutbound && now - held.since < DIAL_RACE_MS) return "refuse";
  return "replace";
}
