import os from "node:os";
import readline from "node:readline";
import { newWebSocketRpcSession } from "capnweb";
import { AuthError } from "../auth.js";
import { closeSocket, openSocket } from "../connect.js";
import { ensureIdentity, fingerprint as fingerprintOf, identityPath } from "../identity.js";
import { authenticateClient } from "../link.js";
import { endpointUrl, isLoopback } from "../options.js";
import { decodeInvite, DEFAULT_INVITE_MS, MAX_INVITE_MS, suggestedName, type Decision, type PairingApi, type Proposal } from "../pairing.js";
import { describeGrants, expandGrants, listPeers, savePairedPeer, type Permission } from "../peers.js";
import { RefusingShell } from "../refusing-shell.js";
import { connectControl, startDaemon, type ControlConnection } from "./daemon.js";
import { authExitCode } from "./peer.js";

/** How long the invited device waits for the inviting person to decide. */
const PROPOSAL_WAIT_MS = 10 * 60 * 1000;

export interface UpOptions { bind?: string; port?: string; state?: string }
export interface PairOptions { name?: string; yes?: boolean; request?: string; offer?: string; expires?: string; state?: string }
export interface PeersOptions { json?: boolean; state?: string }

/** Ask on the terminal; without one, only --yes can answer. */
function prompter(yes: boolean | undefined) {
  if (yes) return { ask: async (_question: string, fallback: string) => fallback, confirm: async () => true, close() {} };
  if (!process.stdin.isTTY) throw new Error("Pairing asks for confirmation on a terminal. Pass --yes to accept without asking.");
  const lines = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (question: string, fallback: string) => new Promise<string>((resolve) => lines.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, (answer) => resolve(answer.trim() || fallback)));
  return {
    ask,
    async confirm(question: string, defaultYes = false) {
      const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
      return answer ? answer.startsWith("y") : defaultYes;
    },
    close() { lines.close(); },
  };
}

function parseGrants(value: string | undefined, fallback: readonly string[]): Permission[] {
  const words = value === undefined ? fallback : value.split(",").map((word) => word.trim()).filter(Boolean);
  if (value !== undefined && !words.length) return [];
  return expandGrants(words);
}

/** The local paired daemon, started if it is not running. */
async function pairedDaemon(options: { bind?: string; port?: string; state?: string }, quiet = false): Promise<{ control: ControlConnection; started: boolean }> {
  const { created } = ensureIdentity();
  if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
  try {
    const control = await connectControl(options.state);
    const status = await control.remote.status();
    if (!status.paired) { control.close(); throw new Error("A daemon that is not for paired devices is running. Stop it with cns stop, then run cns up."); }
    return { control, started: false };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const bind = options.bind ?? process.env.CNS_BIND ?? "0.0.0.0";
  const port = Number(options.port ?? process.env.CNS_PORT ?? 47381);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port requires an integer from 1 to 65535.");
  const daemon = await startDaemon({ bind, port, url: endpointUrl(bind, port), remote: !isLoopback(bind), state: options.state, paired: true });
  if (!quiet) console.error(`Started the peer daemon (pid ${daemon.pid}) listening at ${daemon.url}. Log: ${daemon.log}`);
  return { control: await connectControl(options.state), started: true };
}

/** `cns up`: run this device as a paired peer. */
export async function up(options: UpOptions): Promise<void> {
  const { control, started } = await pairedDaemon(options, true);
  try {
    const status = await control.remote.status();
    const peers = await control.controller.peers();
    console.log(`${started ? "Started" : "Running"} as ${status.identity?.fingerprint} (pid ${status.pid}), listening at ${status.url}.`);
    if (status.addresses?.length) console.log(`Reachable at ${status.addresses.join(", ")}.`);
    const paired = listPeers().filter((peer) => peer.kind === "paired");
    console.log(paired.length
      ? `Paired devices: ${paired.map((peer) => `${peer.name}${peers.some((connected) => connected.peer?.name === peer.name) ? " (online)" : ""}`).join(", ")}.`
      : "No paired devices yet. Run cns pair here and paste the invite on the other device.");
  } finally { control.close(); }
}

/** `cns pair`: print an invite and wait for the other device; `cns pair INVITE`: pair with the device that printed it. */
export async function pair(invite: string | undefined, options: PairOptions): Promise<void> {
  if (invite === undefined) await inviteAndWait(options);
  else await acceptInvite(invite, options);
}

async function inviteAndWait(options: PairOptions): Promise<void> {
  const minutes = options.expires === undefined ? DEFAULT_INVITE_MS / 60_000 : Number(options.expires);
  if (!(minutes > 0 && minutes * 60_000 <= MAX_INVITE_MS)) throw new Error(`--expires takes minutes, up to ${MAX_INVITE_MS / 60_000}.`);
  const prompt = prompter(options.yes);
  const { control } = await pairedDaemon(options);
  try {
    const created = await control.remote.invite(minutes * 60_000);
    console.log(`Invite: ${created.text}`);
    console.error(`On the other device, run: cns pair '${created.text}'\nWaiting for it (the invite expires in ${minutes} minute${minutes === 1 ? "" : "s"})...`);
    const { peer, fingerprint, proposal } = await control.remote.awaitProposal(created.id) as { peer: string; fingerprint: string; proposal: Proposal };
    console.error(`\n${proposal.name} (fingerprint ${fingerprint}) wants to pair.\n  It asks to use this machine's: ${describeGrants(proposal.requests)}\n  It lets this machine use its:  ${describeGrants(proposal.offers)}`);
    if (!(await prompt.confirm(`Pair with ${proposal.name}? Compare the fingerprint on its screen`, false))) {
      await control.remote.decide(created.id, { accept: false, reason: "Declined on the inviting device." });
      console.log("Not paired.");
      process.exitCode = 3;
      return;
    }
    const name = options.name ?? await prompt.ask("Save it as", proposal.name);
    let granted: Permission[] = [];
    if (proposal.requests.length) {
      granted = options.yes ? proposal.requests : (await prompt.confirm(`Allow ${name} to use this machine's ${describeGrants(proposal.requests)}?`, false)) ? proposal.requests : [];
    }
    const decision = await control.remote.decide(created.id, { accept: true, name, granted }) as Decision;
    console.log(`Paired with ${decision.name} (${fingerprint}). It may use this machine's: ${describeGrants(decision.granted ?? [])}. This machine may use its: ${describeGrants(proposal.offers)}.`);
    void peer;
  } finally {
    prompt.close();
    control.close();
  }
}

async function acceptInvite(text: string, options: PairOptions): Promise<void> {
  const invite = decodeInvite(text);
  const prompt = prompter(options.yes);
  const { identity, created } = ensureIdentity();
  if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
  const requests = parseGrants(options.request, ["all"]);
  const offers = parseGrants(options.offer, []);
  try {
    const peerFingerprint = fingerprintOf(invite.key);
    console.error(`The invite is from a device with fingerprint ${peerFingerprint}, reachable at ${invite.addresses.join(", ")}.\n  This device will ask to use its: ${describeGrants(requests)}\n  and let it use this device's:   ${describeGrants(offers)}\n  This device is ${identity.fingerprint}; the other side will see that.`);
    if (!(await prompt.confirm("Pair with it?", true))) { console.log("Not paired."); process.exitCode = 3; return; }
    // Our own daemon's addresses, if it runs, so the other device can dial back.
    let addresses: string[] | undefined;
    let control: ControlConnection | undefined;
    try {
      control = await connectControl(options.state);
      const status = await control.remote.status();
      if (status.paired) addresses = status.addresses;
    } catch { control = undefined; }
    const cancelled = new AbortController();
    let socket: WebSocket | undefined;
    let failure: unknown;
    for (const address of invite.addresses) {
      try {
        const candidate = await openSocket(address, cancelled.signal);
        await authenticateClient(candidate, identity, { expect: invite.key, invite: { id: invite.id, secret: invite.secret } });
        socket = candidate;
        break;
      } catch (error) {
        failure = error;
        if (error instanceof AuthError && error.code !== "closed") break;
      }
    }
    if (!socket) { process.exitCode = authExitCode(failure); throw failure instanceof Error ? failure : new Error("Could not reach the inviting device at any of its addresses."); }
    try {
      const remote = newWebSocketRpcSession<PairingApi>(socket, new RefusingShell());
      console.error("Connected. Waiting for the other device to confirm...");
      const timer = setTimeout(() => closeSocket(socket!, "Pairing timed out"), PROPOSAL_WAIT_MS);
      let decision: Decision;
      try { decision = await remote.propose({ name: suggestedName(os.hostname()), requests, offers, ...addresses?.length ? { addresses } : {} }) as Decision; }
      finally { clearTimeout(timer); remote[Symbol.dispose](); }
      if (!decision.accept) { console.log(`Not paired: ${decision.reason ?? "the other device declined."}`); process.exitCode = 3; return; }
      const name = options.name ?? await prompt.ask("Save the other device as", decision.inviter ?? "peer");
      savePairedPeer(name, { publicKey: invite.key, addresses: invite.addresses, pairedAt: new Date().toISOString(), grants: { incoming: offers, outgoing: decision.granted ?? [] } });
      console.log(`Paired with ${name} (${peerFingerprint}). This device may use its: ${describeGrants(decision.granted ?? [])}. It may use this device's: ${describeGrants(offers)}.`);
      if (control) await control.remote.dial(name);
    } finally {
      closeSocket(socket);
      control?.close();
    }
  } finally { prompt.close(); }
}

/** `cns peers`: every saved device with its status. */
export async function peers(options: PeersOptions): Promise<void> {
  const saved = listPeers();
  let online = new Map<string, { fingerprint: string }>();
  try {
    const control = await connectControl(options.state);
    try { online = new Map((await control.controller.peers()).flatMap((peer) => peer.peer ? [[peer.peer.name, { fingerprint: peer.peer.fingerprint }]] : [])); }
    finally { control.close(); }
  } catch { /* No daemon: everything is offline. */ }
  const rows = saved.map((peer) => peer.kind === "paired"
    ? { name: peer.name, kind: "paired" as const, fingerprint: peer.fingerprint, status: online.has(peer.name) ? "online" : "offline", connection: online.has(peer.name) ? "direct" : null, access: peer.grants.outgoing, grants: peer.grants.incoming, addresses: peer.addresses }
    : { name: peer.name, kind: "address" as const, status: "unpaired", connection: null, url: peer.url });
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("No saved peers. Run cns pair to pair with another device."); return; }
  const table = [["NAME", "STATUS", "CONNECTION", "ACCESS", "FINGERPRINT"], ...rows.map((row) => [
    row.name, row.status, row.connection ?? "-", row.kind === "paired" ? describeGrants(row.access) : "-", row.kind === "paired" ? row.fingerprint : row.url,
  ])];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  console.log(table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"));
}
