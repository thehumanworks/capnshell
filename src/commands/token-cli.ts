import os from "node:os";
import { ensureIdentity, fingerprint } from "../identity.js";
import { suggestedName } from "../pairing.js";
import { removePeerFile } from "../peer-files.js";
import { describeGrants, getPeer, listPeers, savePairedPeer, type PeerEntry } from "../peers.js";
import { DEFAULT_TOKEN_EXPIRY, mintToken, parseExpiry, tokenExpired, TokenError } from "../tokens.js";
import { connectControl } from "./daemon.js";
import { checkFreeName, driftWarning, pairedDaemon, parseGrants } from "./pairing-cli.js";

export interface TokenCreateOptions { grant?: string; expires?: string; state?: string }

const day = (iso: string) => iso.slice(0, 10);

/**
 * `cns token create NAME --grant ...`: a token a program elsewhere reaches this device with,
 * as NAME. The token goes to stdout, once, so it can be piped into a secret store; this device
 * keeps only its public key.
 */
export async function createToken(name: string, options: TokenCreateOptions): Promise<void> {
  checkFreeName(name);
  const what = "Say what the token may use here: --grant shell, files, sessions, all, or a comma-separated list of permissions.";
  if (options.grant === undefined) throw new TokenError(what, 2);
  const grants = parseGrants(options.grant, []);
  if (!grants.length) throw new TokenError(what, 2);
  const now = Date.now();
  const expiresAt = parseExpiry(options.expires ?? DEFAULT_TOKEN_EXPIRY, now);
  const { identity } = ensureIdentity();
  // The token names the addresses the daemon answers at, so the daemon must run; start it if it does not.
  const { control } = await pairedDaemon(options);
  let status: Awaited<ReturnType<typeof control.remote.status>>;
  try { status = await control.remote.status(); } finally { control.close(); }
  if (status.identity && status.identity.publicKey !== identity.publicKey) {
    throw new Error(`The running daemon is another device (${status.identity.fingerprint}) than this one (${identity.fingerprint}), so it would not know this token. Stop it with cns stop, then run cns up.`);
  }
  const addresses = status.addresses ?? [];
  if (!addresses.length) throw new Error("The daemon has no address another machine could reach it at. Check cns doctor, then try again.");
  const deviceName = suggestedName(os.hostname());
  const token = mintToken({ name: deviceName, publicKey: identity.publicKey, addresses }, name, expiresAt);
  savePairedPeer(name, {
    publicKey: token.publicKey, addresses: [], pairedAt: new Date(now).toISOString(),
    grants: { incoming: grants, outgoing: [] },
    token: expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt).toISOString() },
  });
  console.log(token.text);
  console.error([
    `Token ${name} (fingerprint ${fingerprint(token.publicKey)}). It may use this machine's: ${describeGrants(grants)}. ${expiresAt === undefined ? "It never expires." : `It expires on ${day(new Date(expiresAt).toISOString())}.`}`,
    `Anyone who has it can do that as ${name}. This machine keeps no copy: store it as a secret now.`,
    `On the machine that uses it, set CNS_TOKEN to it, then run for example: cns run ${deviceName} -- hostname`,
    `To revoke it: cns token revoke ${name}`,
  ].join("\n"));
  const drift = driftWarning(status, options.state);
  if (drift) console.error(`Warning: the daemon accepts tokens only once it runs this cns. ${drift}`);
}

/** The tokens saved here, by name. */
const savedTokens = (): PeerEntry[] => listPeers().filter((peer) => peer.token);

/** `cns token list`: the tokens this device accepts, with what they may use and when they expire. */
export function listTokens(options: { json?: boolean }): void {
  const now = Date.now();
  const rows = savedTokens().map((token) => ({
    name: token.name, fingerprint: token.fingerprint, grants: token.grants.incoming,
    createdAt: token.pairedAt, expiresAt: token.token?.expiresAt ?? null, expired: tokenExpired(token, now),
  }));
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("No tokens. Make one with cns token create NAME --grant shell (or files, sessions, all)."); return; }
  const table = [["NAME", "MAY USE", "EXPIRES", "FINGERPRINT"], ...rows.map((row) => [
    row.name, describeGrants(row.grants), row.expiresAt === null ? "never" : `${day(row.expiresAt)}${row.expired ? " (expired)" : ""}`, row.fingerprint,
  ])];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  console.log(table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"));
}

/** `cns token revoke NAME`: refuse the token from now on, and end the connections using it. */
export async function revokeToken(name: string, options: { state?: string }): Promise<void> {
  const entry = getPeer(name);
  if (!entry) throw new TokenError(`No token is saved as ${name}. cns token list shows the tokens.`, 2);
  if (!entry.token) throw new TokenError(`${name} is a paired device, not a token. To unpair it, run cns peer remove ${name}.`, 2);
  removePeerFile(name);
  let control: Awaited<ReturnType<typeof connectControl>> | undefined;
  try { control = await connectControl(options.state); } catch { /* No daemon: nothing is connected. */ }
  if (control) {
    try { await control.remote.forget(entry.publicKey); } finally { control.close(); }
  }
  console.log(`Revoked ${name}. Connections that used it have ended.`);
}
