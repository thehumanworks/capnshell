import { createPrivateKey, createPublicKey } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { z } from "zod";
import { ensureIdentity, PUBLIC_KEY_BYTES, type PublicKey } from "./identity.js";
import { applyMeshes, openList, readMesh, signedListSchema, writeMesh, type MemberList, type SignedList } from "./mesh.js";
import { peerFileExists, peerNamePattern } from "./peer-files.js";
import { advertisedSchema, findPairedPeer, grantsSchema, savePairedPeer, type Permission } from "./peers.js";

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
  admin: advertisedSchema,
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
  const body = { v: 1, sk: privateKey, list: signed, admin: adminAddresses, allow };
  const text = BOT_TOKEN_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
  if (text.length > MAX_TOKEN_CHARS) throw new Error(`The token would be ${text.length} characters, more than an environment variable safely holds. Remove members or addresses from the mesh, then try again.`);
  checkedBot(body, (why) => new Error(`Cannot issue a bot token: ${why}`));
  return text;
}

/** Both ends check the same fields, key and signature. Never include token data or a raw parser error in a diagnostic. */
function checkedBot(value: unknown, invalid: (why: string) => Error): BotToken {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === "admin") throw invalid("invalid admin address list.");
    if (field === "sk") throw invalid("invalid bot private key.");
    if (field === "list") throw invalid("invalid signed member list.");
    throw invalid("the token fields do not match the cnsbot1 format.");
  }
  const body = parsed.data;
  let publicKey: PublicKey;
  try {
    const key = createPrivateKey({ key: Buffer.from(body.sk, "base64url"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    publicKey = (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).subarray(-PUBLIC_KEY_BYTES).toString("base64url");
  } catch { throw invalid("the private key is not a valid Ed25519 key."); }
  let list: MemberList;
  try { list = openList(body.list); }
  catch { throw invalid("the signed member list is invalid or its admin signature did not verify."); }
  if (list.admin === publicKey) throw invalid("the token contains the admin's own key, not a bot key.");
  if (!list.members.some((member) => member.key === publicKey)) throw invalid("the bot key is not listed in the signed member list.");
  return { keys: { publicKey, privateKey: body.sk }, signed: body.list, list, adminAddresses: body.admin, allow: body.allow };
}

/** An explicitly named file may be a mounted secret (including a projected symlink). Do not block on pipes or read unbounded input. */
export function readBotTokenFile(path: string): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch { throw new Error("Cannot read --token-file. Pass the path to a readable token file, not the token itself."); }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("--token-file must name a regular file.");
    // Allow space for line wrapping and line endings. The token itself has a smaller limit.
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = readSync(fd, bytes, used, bytes.length - used, null);
      if (!n) return bytes.toString("utf8", 0, used);
      used += n;
    }
    throw new Error("The token file is too long (over 64 KiB). Use only stdout from cns mesh token.");
  } finally { closeSync(fd); }
}

/** Where a token came from: the environment, --token-file, or a code from `cns mesh token --code` (cns mesh join --code). */
type TokenSource = "CNS_TOKEN" | "token file" | "code";
const sourceLabel = (source: TokenSource) => source === "code" ? "token from the code" : source;

/** Read a whole token, allowing only transport formatting (outer quotes, whitespace and line wrapping). */
export function decodeBotToken(value: string, source: TokenSource = "CNS_TOKEN"): BotToken {
  let text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim();
  if (!text) throw new Error(source === "token file" ? "The token file is empty." : "CNS_TOKEN is set but empty. Set it to the token, or unset it to run as a regular device.");
  const invalid = (why: string) => new Error(`Invalid ${sourceLabel(source)} (${text.length} characters): ${why}`);
  if (!text.startsWith(BOT_TOKEN_PREFIX)) throw invalid(`the value must start with ${BOT_TOKEN_PREFIX} and contain only the token printed by cns mesh token.`);
  const encoded = text.slice(BOT_TOKEN_PREFIX.length).replace(/[ \t\r\n]+/g, "");
  if (BOT_TOKEN_PREFIX.length + encoded.length > MAX_TOKEN_CHARS) throw invalid("the value is too long to be a cns mesh bot token.");
  if (!base64url.test(encoded)) throw invalid("set it to only the token from stdout, without the instructions from stderr.");
  let body: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    body = JSON.parse(bytes.toString("utf8"));
  } catch { throw invalid("the payload after cnsbot1: is incomplete or damaged. Transfer stdout directly to a secret store or private file."); }
  return checkedBot(body, invalid);
}

/**
 * Make this machine the bot a token describes, saving what is missing: its identity, its
 * pairing with the admin and the mesh. What is already saved is kept, such as a newer
 * member list. A machine that is already another device is refused: it has an identity of
 * its own, which the token must not replace.
 */
export function startAsBot(text: string, source: TokenSource = "CNS_TOKEN"): { created: boolean; token: BotToken } {
  const token = decodeBotToken(text, source);
  const { identity, created } = ensureIdentity(token.keys);
  if (identity.publicKey !== token.keys.publicKey) {
    throw new Error(`${source === "token file" ? "The token file" : source === "code" ? "The token from the code" : source} makes this machine a mesh bot, but it is already another device (${identity.fingerprint}). Run the bot with a configuration directory of its own: CNS_CONFIG_DIR=DIRECTORY.`);
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
  return { created, token };
}
