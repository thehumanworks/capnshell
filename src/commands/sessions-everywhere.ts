import { openDeviceLink } from "../device-link.js";
import { everywhereExitCode, formatEverywhere, listEverywhere, notesEverywhere } from "../fleet-sessions.js";
import { ensureIdentity } from "../identity.js";
import { listPeers } from "../peers.js";
import { environmentTokens, TokenError } from "../tokens.js";
import { secureReady } from "../secure.js";
import type { PtySessionInfo } from "../shell.js";
import { plain } from "../terminal.js";

/**
 * `cns sessions` without a device: every paired device's named sessions in one table. Each
 * device is reached as any command reaches it, through the local daemon's standing link when
 * it has one; a device that may not be listed is reported without being dialed.
 */
export async function sessionsEverywhere({ json = false }: { json?: boolean } = {}): Promise<number> {
  if (environmentTokens()) throw new TokenError("cns sessions without a device asks this device's own pairings, not CNS_TOKEN. With a token, name the device: cns sessions DEVICE.", 2);
  const { identity } = ensureIdentity();
  await secureReady();
  const devices = listPeers().filter((peer) => !peer.token).map((peer) => ({ name: peer.name, publicKey: peer.publicKey, addresses: peer.addresses, outgoing: peer.grants.outgoing }));
  const results = await listEverywhere(devices, async (device, signal) => {
    const link = await openDeviceLink(device, identity, signal);
    // A device that answers too late must not keep this command waiting on its link.
    const close = () => { link.remote[Symbol.dispose](); link.close("Listing ended"); };
    signal.addEventListener("abort", close, { once: true });
    try {
      const sessions = await plain(link.remote.ptySessions() as unknown as Promise<PtySessionInfo[]>);
      return { sessions, via: link.via };
    } finally {
      signal.removeEventListener("abort", close);
      close();
    }
  });
  if (json) process.stdout.write(JSON.stringify(results, null, 2) + "\n");
  else {
    const table = formatEverywhere(results);
    if (table) process.stdout.write(table + "\n");
    for (const note of notesEverywhere(results)) process.stderr.write(`cns: ${note}\n`);
  }
  return everywhereExitCode(results);
}
