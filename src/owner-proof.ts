import { createHash, randomBytes } from "node:crypto";
import { fingerprint, verify, type Identity, type PublicKey } from "./identity.js";
import { publicKeySchema } from "./peers.js";

/**
 * Owner requests to the gateway (gateway/): what `cns gateway` sends to pair it with a
 * device, approve a connector or revoke one. Each request is signed with the device
 * identity of one of the gateway's owners, so there is no password or account to steal:
 *
 *   Cns-Owner: cns-owner-1 KEY TIME NONCE SIG
 *   SIG = Ed25519(KEY, "cns-owner-1" 0 host 0 METHOD 0 path 0 TIME 0 NONCE 0 hex(SHA-256(body)))
 *
 * The gateway accepts it when KEY is one of its owners, TIME is within OWNER_SKEW_MS of its
 * clock and it has not seen NONCE before, so a request seen in a log cannot be sent again
 * or turned into another one.
 */

export const OWNER_HEADER = "Cns-Owner";
const SCHEME = "cns-owner-1";
/** How far an owner's clock may be from the gateway's, and how long the gateway remembers a nonce. */
export const OWNER_SKEW_MS = 5 * 60 * 1000;
const noncePattern = /^[A-Za-z0-9_-]{22}$/;
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

function signedBytes(host: string, method: string, path: string, time: number, nonce: string, body: Uint8Array): Uint8Array {
  const digest = createHash("sha256").update(body).digest("hex");
  return new TextEncoder().encode([SCHEME, host.toLowerCase(), method.toUpperCase(), path, String(time), nonce, digest].join("\0"));
}

/** The Cns-Owner header for a request to `url` with `body`. */
export function ownerProof(identity: Identity, method: string, url: string, body: Uint8Array, now = Date.now()): string {
  const { host, pathname } = new URL(url);
  const nonce = randomBytes(16).toString("base64url");
  const signature = Buffer.from(identity.sign(signedBytes(host, method, pathname, now, nonce, body))).toString("base64url");
  return `${SCHEME} ${identity.publicKey} ${now} ${nonce} ${signature}`;
}

export interface OwnerCheck {
  /** The owner devices' public keys. */
  owners: readonly PublicKey[];
  /** Remember `nonce` until `until`; false when it was already seen. */
  claimNonce(nonce: string, until: number): Promise<boolean>;
  now?: number;
}

/**
 * The owner that signed this request, or a reason it is refused. The body must be the
 * exact bytes received.
 */
export async function verifyOwner(header: string | null, request: { method: string; url: string }, body: Uint8Array, check: OwnerCheck): Promise<{ owner: PublicKey; fingerprint: string } | { refused: string }> {
  if (!header || header.length > 512) return { refused: "Owner requests must be signed by cns gateway." };
  const [scheme, key, timeText, nonce, signature, ...rest] = header.split(" ");
  if (scheme !== SCHEME || rest.length || !key || !publicKeySchema.safeParse(key).success || !timeText || !/^\d{1,15}$/.test(timeText) || !nonce || !noncePattern.test(nonce) || !signature || !signaturePattern.test(signature)) {
    return { refused: "This owner signature is not readable." };
  }
  if (!check.owners.includes(key)) return { refused: `Device ${fingerprint(key)} is not an owner of this gateway.` };
  const now = check.now ?? Date.now();
  const time = Number(timeText);
  if (Math.abs(now - time) > OWNER_SKEW_MS) return { refused: "This request's time is too far from the gateway's; check this device's clock." };
  const { host, pathname } = new URL(request.url);
  if (!verify(key, signedBytes(host, request.method, pathname, time, nonce, body), Buffer.from(signature, "base64url"))) {
    return { refused: "The owner signature does not match this request." };
  }
  if (!(await check.claimNonce(nonce, time + OWNER_SKEW_MS))) return { refused: "This request was already received." };
  return { owner: key, fingerprint: fingerprint(key) };
}

/** Parse the gateway's OWNER_KEYS setting: public keys separated by commas or whitespace. */
export function ownerKeys(setting: string | undefined): PublicKey[] {
  const keys = (setting ?? "").split(/[\s,]+/).filter(Boolean);
  for (const key of keys) {
    if (!publicKeySchema.safeParse(key).success) throw new Error(`OWNER_KEYS has ${JSON.stringify(key)}, which is not a device public key (cns identity --json prints one).`);
  }
  return keys;
}
