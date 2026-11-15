import { z } from "zod";
import { identityFromPrivateKey, newKeyPair, type Identity, type PublicKey } from "./identity.js";
import { validatePeerUrl } from "./peer-files.js";
import { publicKeySchema, type PairedPeer, type Permission } from "./peers.js";
import type { Refusal } from "./auth.js";

/**
 * Tokens: a way for a program on a machine nobody sits at, such as a CI job, a server or an
 * agent's container, to reach one device with no pairing and no prompt.
 *
 * `cns token create NAME --grant ...` on the device makes a new key pair and saves its public
 * key as a paired device named NAME, with those grants and an expiry. It prints the token once:
 * the private key, with this device's key, name and addresses. The device keeps no copy of the
 * private key. A program with the token in CNS_TOKEN signs in with it as NAME, through the
 * handshake every paired device uses (auth.ts), so the token is never sent: the relay and
 * anyone on the path see a paired device's signature, which they cannot reuse.
 *
 * A token's life on the device is its record: valid until `expiresAt`, if it has one, and
 * gone once revoked (the record removed). The device refuses an expired token at each
 * handshake and ends its live connections when it expires; the token carries its expiry too,
 * so the program can say so before dialing.
 */

export const TOKEN_PREFIX = "cnst1:";
/** How long a token lasts unless `--expires` says otherwise. */
export const DEFAULT_TOKEN_EXPIRY = "30d";
/** The refusal a device gives an expired token, which the program holding it explains. */
export const TOKEN_EXPIRED = "This token has expired.";
/** The first cns that accepts tokens, for the message a program gets from an older device. */
export const TOKENS_SINCE = "1.7.0";

const base64url = /^[A-Za-z0-9_-]+$/;
const nameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const tokenSchema = z.strictObject({
  v: z.literal(1),
  /** The token's private key: PKCS#8 Ed25519, base64url. */
  sk: z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 48),
  /** The name the device saved the token under, which its grants and refusals use. */
  as: nameSchema,
  /** The device: its key, the name the program calls it by, and where to reach it. */
  key: publicKeySchema,
  name: nameSchema,
  addr: z.array(z.string().max(2048)).min(1).max(16),
  /** When it expires, in milliseconds since 1970; absent for a token that never does. */
  exp: z.int().positive().optional(),
});

/** A token as the program holding it uses it. */
export interface Token {
  identity: Identity;
  /** What the device calls this token. */
  as: string;
  device: { name: string; publicKey: PublicKey; addresses: string[] };
  expiresAt?: number;
}

/** A new token for the device `device`, saved there as `as`. Returns its public key, for the device's record, and its text, to print once. */
export function mintToken(device: { name: string; publicKey: PublicKey; addresses: readonly string[] }, as: string, expiresAt?: number): { publicKey: PublicKey; text: string } {
  if (!device.addresses.length) throw new Error("A token needs at least one address the program can reach this device at.");
  for (const address of device.addresses) validatePeerUrl(address);
  const { publicKey, privateKey } = newKeyPair();
  const body = tokenSchema.parse({ v: 1, sk: privateKey, as, key: device.publicKey, name: device.name, addr: [...device.addresses], ...expiresAt === undefined ? {} : { exp: expiresAt } });
  return { publicKey, text: TOKEN_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url") };
}

/** The token behind a `cnst1:` string. An expired one is still decoded: using it says so. */
export function decodeToken(text: string): Token {
  const unreadable = "CNS_TOKEN is not a cns token. Set it to the whole line cns token create printed.";
  if (!text.startsWith(TOKEN_PREFIX)) throw new TokenError(unreadable, 2);
  let body: unknown;
  try { body = JSON.parse(Buffer.from(text.slice(TOKEN_PREFIX.length), "base64url").toString("utf8")); } catch { throw new TokenError(unreadable, 2); }
  const parsed = tokenSchema.safeParse(body);
  if (!parsed.success) throw new TokenError(unreadable, 2);
  try { for (const address of parsed.data.addr) validatePeerUrl(address); } catch { throw new TokenError(unreadable, 2); }
  let identity: Identity;
  try { identity = identityFromPrivateKey(parsed.data.sk); } catch { throw new TokenError(unreadable, 2); }
  return {
    identity, as: parsed.data.as,
    device: { name: parsed.data.name, publicKey: parsed.data.key, addresses: parsed.data.addr },
    ...parsed.data.exp === undefined ? {} : { expiresAt: parsed.data.exp },
  };
}

/** The tokens in CNS_TOKEN, separated by spaces, commas or newlines; undefined when it is unset or empty. */
export function tokensFrom(value: string | undefined): Token[] | undefined {
  const texts = value?.split(/[\s,]+/).filter(Boolean) ?? [];
  if (!texts.length) return undefined;
  const tokens = texts.map(decodeToken);
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token.device.name)) throw new TokenError(`CNS_TOKEN holds two tokens for ${token.device.name}; keep one.`, 2);
    seen.add(token.device.name);
  }
  return tokens;
}

/** The tokens this process has, from CNS_TOKEN. */
export const environmentTokens = (): Token[] | undefined => tokensFrom(process.env.CNS_TOKEN);

/** An error with the exit status the CLI should end with. */
export class TokenError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "TokenError";
  }
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The device a command names, reached with the token for it: what to expect there, and the
 * identity to sign in with. A name no token is for is a usage error (2); an expired token,
 * a refused one (3), as the device would refuse it.
 */
export function tokenTarget(name: string, tokens: readonly Token[], now = Date.now()): { name: string; publicKey: PublicKey; outgoing: Permission[]; addresses: string[]; identity: Identity } {
  const token = tokens.find((candidate) => candidate.device.name === name);
  if (!token) {
    const names = tokens.map((candidate) => candidate.device.name).join(", ");
    throw new TokenError(`CNS_TOKEN reaches ${names}, not ${name}. Name ${tokens.length === 1 ? "that device" : "one of those"}, or unset CNS_TOKEN to use this device's own pairings.`, 2);
  }
  if (token.expiresAt !== undefined && token.expiresAt <= now) {
    throw new TokenError(`The token for ${name} expired on ${day(token.expiresAt)}. On ${name}, make a new one: cns token create NAME --grant ...`, 3);
  }
  return { name, publicKey: token.device.publicKey, outgoing: [], addresses: [...token.device.addresses], identity: token.identity };
}

/** What a program holding a token is told when the device refuses it as not paired; `reason` is the refusal as the handshake reports it. */
export function explainTokenRefusal(device: string, reason: string): string {
  if (reason.endsWith(TOKEN_EXPIRED)) return `${device} refused this token: it has expired. On ${device}, make a new one: cns token create NAME --grant ...`;
  return `${device} does not accept this token: it was revoked, or ${device} runs a cns older than ${TOKENS_SINCE} (upgrade it and restart its daemon). On ${device}, cns token list shows the tokens it accepts.`;
}

/** Whether a paired-device record is a token that has expired by `now`. */
export function tokenExpired(record: Pick<PairedPeer, "token">, now: number): boolean {
  const expiresAt = record.token?.expiresAt;
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

/** The device's answer to a key that signed in: refused when its record is an expired token. */
export function tokenRefusal(record: Pick<PairedPeer, "token">, now: number): Refusal | undefined {
  return tokenExpired(record, now) ? { code: "not-paired", reason: TOKEN_EXPIRED } : undefined;
}

/** When a token given `--expires` ends: `never`, or a number of days (30d) or hours (12h) from `now`. */
export function parseExpiry(value: string, now: number): number | undefined {
  if (value === "never") return undefined;
  const match = /^([1-9]\d{0,4})([dh])$/.exec(value);
  if (!match) throw new TokenError("--expires takes a number of days or hours, such as 30d or 12h, or never.", 2);
  return now + Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
}
