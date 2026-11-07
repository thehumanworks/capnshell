import { randomBytes } from "node:crypto";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { validatePeerUrl } from "./peer-files.js";
import { fingerprint, type PublicKey } from "./identity.js";
import { grantsSchema, publicKeySchema, type Permission } from "./peers.js";

/**
 * Pairing: the one-time exchange in which two devices learn each other's identity
 * and each person confirms the other device and the access they grant it.
 *
 * The inviting device prints an invite. The invited device dials one of its
 * addresses, authenticates with the invite's secret (auth.ts), and proposes a
 * pairing over `PairingApi`: its name, what it requests, what it offers. The
 * inviting device's person decides; the proposal resolves with the decision.
 */

export const INVITE_PREFIX = "cns1:";
export const DEFAULT_INVITE_MS = 5 * 60 * 1000;
export const MAX_INVITE_MS = 60 * 60 * 1000;
const base64url = /^[A-Za-z0-9_-]+$/;
const inviteSchema = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  key: publicKeySchema,
  addr: z.array(z.string().max(2048)).min(1).max(16),
  secret: z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 16),
  exp: z.int().positive(),
  /** The name the inviting device suggests for itself. */
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
});
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
export const proposalSchema = z.strictObject({
  /** The name the proposer suggests for itself, usually its hostname. */
  name: nameSchema,
  /** Where the proposer's own daemon can be reached, if it runs one, so the inviting device can dial back. */
  addresses: z.array(z.string().max(2048)).max(16).optional(),
  /** What the proposer asks to do on the inviting device. */
  requests: grantsSchema,
  /** What the proposer lets the inviting device do on it. */
  offers: grantsSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;
export interface Decision {
  accept: boolean;
  /** Locally, the alias to save the proposer under. It is never sent to the proposer. */
  name?: string;
  /** The subset of the requests the inviting device granted. */
  granted?: Permission[];
  reason?: string;
}
export const decisionSchema = z.strictObject({
  accept: z.boolean(), name: nameSchema.optional(), granted: grantsSchema.optional(), reason: z.string().max(512).optional(),
});

/** A name for this device that other devices can save: its short hostname, made to fit the alias rules. */
export function suggestedName(hostname: string): string {
  const cleaned = hostname.split(".")[0]!.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64);
  return cleaned || "device";
}

export interface Invite {
  id: string;
  key: PublicKey;
  addresses: string[];
  secret: Uint8Array;
  expiresAt: number;
  /** The name the inviting device suggests for itself, which the invited device offers as its alias. */
  name?: string;
}

/** A new single-use invite for this device, reachable at `addresses`. */
export function createInvite(key: PublicKey, addresses: string[], ttlMs = DEFAULT_INVITE_MS, name?: string): Invite & { text: string } {
  if (!addresses.length) throw new Error("An invite needs at least one address other devices can reach.");
  if (!(ttlMs > 0 && ttlMs <= MAX_INVITE_MS)) throw new Error(`Invites last between 1 ms and ${MAX_INVITE_MS} ms.`);
  for (const address of addresses) validatePeerUrl(address);
  if (name !== undefined) nameSchema.parse(name);
  const invite: Invite = { id: randomBytes(8).toString("base64url"), key, addresses, secret: randomBytes(16), expiresAt: Date.now() + ttlMs, ...name ? { name } : {} };
  const body = { v: 1, id: invite.id, key, addr: addresses, secret: Buffer.from(invite.secret).toString("base64url"), exp: invite.expiresAt, ...name ? { name } : {} };
  return { ...invite, text: INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url") };
}

/** The invite behind a `cns1:` string; expired invites are refused here already. */
export function decodeInvite(text: string, now = Date.now()): Invite {
  if (!text.startsWith(INVITE_PREFIX)) throw new Error("An invite starts with cns1:. Paste the whole string cns pair printed.");
  let body: unknown;
  try { body = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8")); } catch { throw new Error("This invite is not readable. Paste the whole string cns pair printed."); }
  const parsed = inviteSchema.safeParse(body);
  if (!parsed.success) throw new Error("This invite is not valid.");
  for (const address of parsed.data.addr) validatePeerUrl(address);
  if (parsed.data.exp <= now) throw new Error("This invite has expired. Run cns pair on the other device again.");
  return {
    id: parsed.data.id, key: parsed.data.key, addresses: parsed.data.addr, secret: Buffer.from(parsed.data.secret, "base64url"), expiresAt: parsed.data.exp,
    ...parsed.data.name ? { name: parsed.data.name } : {},
  };
}

/** What the inviting device shows its person about a proposal. */
export function describeProposal(peer: PublicKey, proposal: Proposal): string {
  return `${proposal.name} (fingerprint ${fingerprint(peer)})`;
}

/**
 * What the inviting device exports to a device that authenticated with an invite,
 * instead of a shell. `propose` resolves once the inviting device's person decided.
 */
export class PairingApi extends RpcTarget {
  #decide: (proposal: Proposal) => Promise<Decision>;
  #closed?: () => void;
  #proposed = false;
  /** `closed` runs once the proposing device has gone, so nobody saves a pairing it never learns about. */
  constructor(decide: (proposal: Proposal) => Promise<Decision>, closed?: () => void) {
    super();
    this.#decide = decide;
    this.#closed = closed;
  }
  async propose(proposal: Proposal): Promise<Decision> {
    if (this.#proposed) throw new Error("This invite has already received a proposal.");
    this.#proposed = true;
    const parsed = proposalSchema.parse(proposal);
    for (const address of parsed.addresses ?? []) validatePeerUrl(address);
    return await this.#decide(parsed);
  }
  [Symbol.dispose]() {
    const closed = this.#closed;
    this.#closed = undefined;
    closed?.();
  }
}
