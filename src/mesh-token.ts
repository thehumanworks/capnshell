import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { ensureIdentity, PUBLIC_KEY_BYTES, type PublicKey } from "./identity.js";
import { applyMeshes, openList, readMesh, signedListSchema, writeMesh, type MemberList, type SignedList } from "./mesh.js";
import { peerFileExists, peerNamePattern, validatePeerUrl } from "./peer-files.js";
import { findPairedPeer, grantsSchema, savePairedPeer, type Permission } from "./peers.js";

/**
 * A mesh bot token: everything a machine nobody sits at, such as a CI runner or a server,
 * needs to be one member of a mesh. The mesh's admin makes it with `cns mesh token`: a new
 * key pair for the bot, listed in the mesh under the bot's name and paired with the admin.
 * The token carries the bot's private key, the signed member list with the bot in it, where
 * to reach the admin, and what members may use on the bot. The admin keeps no copy of the
 * private key.
 *
 * With the token in CNS_TOKEN, any cns command on that machine first makes it the bot
 * (startAsBot): its identity, its pairing with the admin and the mesh, as `cns mesh join`
 * would have left them. `cns up` then runs it as a member others reach, and commands reach
 * the other members. The token works again on a new machine, so a runner that is replaced
 * comes back as the same bot; one machine should use it at a time.
 */

export const BOT_TOKEN_PREFIX = "cnsbot1:";
/** Longer tokens do not fit in a Windows environment variable with room to spare. */
export const MAX_TOKEN_CHARS = 30_000;

const base64url = /^[A-Za-z0-9_-]+$/;
const tokenSchema = z.strictObject({
  v: z.literal(1),
  /** The bot's private key: PKCS#8 Ed25519, base64url. */
  sk: z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 48),
  list: signedListSchema,
  /** Where the admin's daemon answers, as it advertised then. */
  admin: z.array(z.string().max(2048)).max(16),
  /** What other members, and the admin, may use on the bot. */
  allow: grantsSchema,
});

export interface BotToken {
  keys: { publicKey: PublicKey; privateKey: string };
  signed: SignedList;
  list: MemberList;
  adminAddresses: string[];
  allow: Permission[];
}

/** A token as `cns mesh token` prints it. */
export function mintBotToken(privateKey: string, signed: SignedList, adminAddresses: readonly string[], allow: readonly Permission[]): string {
  const text = BOT_TOKEN_PREFIX + Buffer.from(JSON.stringify(tokenSchema.parse({ v: 1, sk: privateKey, list: signed, admin: [...adminAddresses], allow: [...allow] }))).toString("base64url");
  if (text.length > MAX_TOKEN_CHARS) throw new Error(`The token would be ${text.length} characters, more than an environment variable safely holds. Remove members or addresses from the mesh, then try again.`);
  return text;
}

/** The bot a token makes. Anything that is not a whole, valid token of a bot listed by its mesh's admin is refused. */
export function decodeBotToken(text: string): BotToken {
  const unreadable = "CNS_TOKEN is not a cns mesh bot token. Set it to the whole line cns mesh token printed.";
  if (!text.startsWith(BOT_TOKEN_PREFIX)) throw new Error(unreadable);
  let body: z.infer<typeof tokenSchema>;
  let publicKey: PublicKey;
  let list: MemberList;
  try {
    body = tokenSchema.parse(JSON.parse(Buffer.from(text.slice(BOT_TOKEN_PREFIX.length), "base64url").toString("utf8")));
    for (const address of body.admin) validatePeerUrl(address);
    const key = createPrivateKey({ key: Buffer.from(body.sk, "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Not an Ed25519 key.");
    publicKey = (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).subarray(-PUBLIC_KEY_BYTES).toString("base64url");
    list = openList(body.list);
  } catch { throw new Error(unreadable); }
  if (list.admin === publicKey || !list.members.some((member) => member.key === publicKey)) throw new Error(unreadable);
  return { keys: { publicKey, privateKey: body.sk }, signed: body.list, list, adminAddresses: body.admin, allow: body.allow };
}

/**
 * Make this machine the bot a token describes, saving what is missing: its identity, its
 * pairing with the admin and the mesh. What is already saved is kept, such as a newer
 * member list. A machine that is already another device is refused: it has an identity of
 * its own, which the token must not replace.
 */
export function startAsBot(text: string): { created: boolean } {
  const token = decodeBotToken(text);
  const { identity, created } = ensureIdentity(token.keys);
  if (identity.publicKey !== token.keys.publicKey) {
    throw new Error(`CNS_TOKEN makes this machine a mesh bot, but it is already another device (${identity.fingerprint}). Run the bot with a configuration directory of its own: CNS_CONFIG_DIR=DIRECTORY.`);
  }
  const { list } = token;
  if (!findPairedPeer(list.admin)) {
    const wanted = list.members.find((member) => member.key === list.admin)!.name;
    let name = peerNamePattern.test(wanted) ? wanted : "admin";
    for (let n = 2; peerFileExists(name); n++) name = `${wanted.slice(0, 60)}-${n}`;
    savePairedPeer(name, { publicKey: list.admin, addresses: token.adminAddresses, pairedAt: new Date().toISOString(), grants: { incoming: token.allow, outgoing: [] } });
  }
  if (!readMesh(list.mesh)) {
    writeMesh({ name: list.mesh, admin: list.admin, allow: token.allow, signed: token.signed });
    applyMeshes(identity.publicKey);
  }
  return { created };
}
