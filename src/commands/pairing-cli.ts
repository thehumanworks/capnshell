import os from "node:os";
import readline from "node:readline";
import { AuthError } from "../auth.js";
import { connectFirst, connectSecure, rpcSession, type SecureChannel } from "../secure.js";
import { isRelayAddress, redactRelay, relayEndpoint } from "../relay-hub.js";
import { errorMessage } from "../errors.js";
import { ensureIdentity, fingerprint as fingerprintOf, identityPath, loadIdentity } from "../identity.js";
import { allPrivate } from "../addresses.js";
import { endpointUrl, isLoopback } from "../options.js";
import { decisionSchema, decodeInvite, DEFAULT_INVITE_MS, MAX_INVITE_MS, suggestedName, type Decision, type Invite, type PairingApi, type Proposal } from "../pairing.js";
import { peerFileExists, peerNamePattern, removeAlias, validatePeerUrl } from "../aliases.js";
import { describeGrants, expandGrants, findPairedPeer, getPeer, listPeers, savePairedPeer, updatePairedPeer, PERMISSIONS, type Permission } from "../peers.js";
import { plain } from "../terminal.js";
import type { ShellApi } from "../shell.js";
import type { RpcStub } from "capnweb";
import { RefusingShell } from "../refusing-shell.js";
import { connectControl, removeStaleState, startDaemon, type ControlConnection } from "./daemon.js";

/** How long the invited device waits for the inviting person to decide. */
const PROPOSAL_WAIT_MS = 10 * 60 * 1000;

export interface UpOptions { bind?: string; port?: string; relay?: string; state?: string }
export interface PairOptions { name?: string; yes?: boolean; request?: string; grant?: string; expires?: string; state?: string }
export interface PeersOptions { json?: boolean; state?: string }
export interface StatusOptions { json?: boolean; state?: string }
export interface DoctorOptions { json?: boolean; state?: string }

interface Prompt {
  /** --yes: every question takes its default. */
  yes: boolean;
  ask(question: string, fallback: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

/** Ask on the terminal; without one, only --yes can answer. Close it, or stdin keeps the process alive. */
function prompter(yes: boolean | undefined): Prompt {
  if (yes) return { yes: true, ask: async (_question, fallback) => fallback, confirm: async () => true, close() {} };
  if (!process.stdin.isTTY) throw new Error("Pairing asks for confirmation on a terminal. Pass --yes to accept without asking.");
  const lines = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (question: string, fallback: string) => new Promise<string>((resolve) => lines.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, (answer) => resolve(answer.trim() || fallback)));
  return {
    yes: false,
    ask,
    async confirm(question, defaultYes = false) {
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

/** Ask what a newly paired device may use here, until the answer is one `--grant` would take. */
async function chooseGrants(prompt: Prompt, name: string): Promise<Permission[]> {
  for (;;) {
    const answer = await prompt.ask(`What may ${name} use on this device? none, shell, files, sessions, all, or a comma-separated list`, "none");
    try { return parseGrants(answer, []); }
    catch { console.error(`Answer none, shell, files, sessions, all, or a comma-separated list of those or of ${PERMISSIONS.join(", ")}.`); }
  }
}

/** Refuse a name that is not a valid alias or that a saved peer, of any kind, already uses. */
function checkFreeName(name: string): void {
  if (!peerNamePattern.test(name)) throw new Error("Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  if (peerFileExists(name)) throw new Error(`A saved peer is already named ${name}. Choose another with --name, or remove it first with cns peer remove ${name}.`);
}

/** `wanted` if no saved peer uses it, else the first free wanted-2, wanted-3, ... */
function freeName(wanted: string): string {
  const base = peerNamePattern.test(wanted) ? wanted : "peer";
  if (!peerFileExists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (!peerFileExists(candidate)) return candidate;
  }
}

/** The alias for a newly paired device: --name, which must be free, else asked for until a free one is given. */
async function chooseName(prompt: Prompt, question: string, given: string | undefined, suggested: string): Promise<string> {
  if (given !== undefined) { checkFreeName(given); return given; }
  for (;;) {
    const name = await prompt.ask(question, freeName(suggested));
    try { checkFreeName(name); return name; }
    catch (error) {
      if (prompt.yes) throw error;
      console.error(errorMessage(error));
    }
  }
}

/** The local paired daemon, started if it is not running, or if the one that was has crashed. */
async function pairedDaemon(options: { bind?: string; port?: string; relay?: string; state?: string }, quiet = false): Promise<{ control: ControlConnection; started: boolean }> {
  const { created } = ensureIdentity();
  if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
  let running: ControlConnection | undefined;
  try { running = await connectControl(options.state); }
  catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    // A daemon that crashed, or a reboot, leaves its state file behind; remove it once its process is gone.
    if (!missing && !(await removeStaleState(options.state))) throw error;
  }
  if (running) {
    try {
      const status = await running.remote.status();
      if (!status.paired) throw new Error("A daemon that is not for paired devices is running. Stop it with cns stop, then run cns up.");
      const relay = options.relay ?? process.env.CNS_RELAY;
      if (relay && relay !== status.relay) console.error(`The running daemon ${status.relay ? `uses the relay ${redactRelay(status.relay)}` : "uses no relay"}; run cns stop, then cns up --relay URL, to change it.`);
      return { control: running, started: false };
    } catch (error) {
      running.close();
      throw error;
    }
  }
  const bind = options.bind ?? process.env.CNS_BIND ?? "0.0.0.0";
  const port = Number(options.port ?? process.env.CNS_PORT ?? 47381);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port requires an integer from 1 to 65535.");
  const relay = options.relay ?? process.env.CNS_RELAY;
  if (relay) {
    relayEndpoint(relay, "accept", "A".repeat(43)); // Refuse a malformed relay URL before starting anything.
    if (new URL(relay).protocol === "ws:" && !isLoopback(new URL(relay).hostname)) console.error("The relay URL is ws://, so the relay token and registration travel unencrypted; links themselves stay encrypted. Use wss:// for a relay beyond this machine.");
  }
  const daemon = await startDaemon({ bind, port, url: endpointUrl(bind, port), remote: !isLoopback(bind), state: options.state, paired: true, ...relay ? { relay } : {} });
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
    if (status.relay) console.log(`Relay: ${redactRelay(status.relay)}${status.relayRegistered ? ", registered" : ", registering"}.`);
    const paired = listPeers().filter((peer) => peer.kind === "paired");
    console.log(paired.length
      ? `Paired devices: ${paired.map((peer) => `${peer.name}${peers.some((connected) => connected.peer?.daemon && connected.peer.fingerprint === peer.fingerprint) ? " (online)" : ""}`).join(", ")}.`
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
  const grants = parseGrants(options.grant, []);
  // Check what can fail before another device starts waiting on this one.
  if (options.name !== undefined) checkFreeName(options.name);
  let prompt: Prompt | undefined;
  let control: ControlConnection | undefined;
  try {
    prompt = prompter(options.yes);
    ({ control } = await pairedDaemon(options));
    const created = await control.remote.invite(minutes * 60_000);
    console.log(`Invite: ${created.text}`);
    // An invite that only names private addresses reaches nothing beyond this network; say so now, not after it expires unused.
    const invited = decodeInvite(created.text).addresses;
    if (!invited.some(isRelayAddress) && allPrivate(invited)) console.error(`This invite lists only private addresses (${invited.join(", ") || "none"}). A device on another network cannot reach them. For one, stop the daemon with cns stop and start it with cns up --relay URL, then pair again.`);
    console.error(`On the other device, run: cns pair '${created.text}'\nWaiting for it (the invite expires in ${minutes} minute${minutes === 1 ? "" : "s"})...`);
    const { peer, fingerprint, proposal } = await control.remote.awaitProposal(created.id) as { peer: string; fingerprint: string; proposal: Proposal };
    console.error([
      `\n${proposal.name} (fingerprint ${fingerprint}) wants to pair.`,
      `  It asks to use this machine's: ${describeGrants(proposal.requests)}`,
      `  It lets this machine use its:  ${describeGrants(proposal.offers)}`,
      ...proposal.addresses?.length ? [`  This machine will dial it at:  ${proposal.addresses.join(", ")}`] : [],
    ].join("\n"));
    const decline = async (reason: string, message: string) => {
      await control!.remote.decide(created.id, { accept: false, reason });
      console.log(message);
      process.exitCode = 3;
    };
    const existing = findPairedPeer(peer);
    if (existing) {
      await decline("The other device already has this device paired. Remove it there with cns peer remove, then pair again.", `Not paired: this device is already paired with it as ${existing.name}.`);
      return;
    }
    if (!(await prompt.confirm(`Pair with ${proposal.name}? Compare the fingerprint on its screen`, false))) {
      await decline("Declined on the inviting device.", "Not paired.");
      return;
    }
    const name = await chooseName(prompt, "Save it as", options.name, proposal.name);
    // --grant, or --yes alone, decides without asking; --yes never grants what --grant does not name.
    let granted: Permission[] = [];
    if (options.grant !== undefined || prompt.yes) granted = grants.filter((permission) => proposal.requests.includes(permission));
    else if (proposal.requests.length && await prompt.confirm(`Allow ${name} to use this machine's ${describeGrants(proposal.requests)}?`, false)) granted = proposal.requests;
    let decision: Decision;
    try { decision = await control.remote.decide(created.id, { accept: true, name, granted }) as Decision; }
    catch (error) { process.exitCode = 3; throw error; }
    console.log(`Paired with ${decision.name} (${fingerprint}). It may use this machine's: ${describeGrants(decision.granted ?? [])}. This machine may use its: ${describeGrants(proposal.offers)}.`);
  } finally {
    prompt?.close();
    control?.close();
  }
}

async function acceptInvite(text: string, options: PairOptions): Promise<void> {
  let invite: Invite;
  // An expired or unreadable invite is a refused pairing, as an unknown one is.
  try { invite = decodeInvite(text); }
  catch (error) { process.exitCode = 3; throw error; }
  const requests = parseGrants(options.request, ["all"]);
  let offers = parseGrants(options.grant, []);
  let prompt: Prompt | undefined;
  let control: ControlConnection | undefined;
  let channel: SecureChannel | undefined;
  try {
    prompt = prompter(options.yes);
    const { identity, created } = ensureIdentity();
    if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
    // Check what can fail before the other device saves anything.
    const existing = findPairedPeer(invite.key);
    if (existing) throw new Error(`This device is already paired with it as ${existing.name}. To pair again, remove it first with cns peer remove ${existing.name}.`);
    if (options.name !== undefined) checkFreeName(options.name);
    const peerFingerprint = fingerprintOf(invite.key);
    // --grant, or --yes alone, decides without asking; --yes never grants what --grant does not name.
    const askGrants = options.grant === undefined && !prompt.yes;
    console.error([
      `The invite is from ${invite.name ?? "a device"} with fingerprint ${peerFingerprint}, reachable at ${invite.addresses.join(", ")}.`,
      `  This device will ask to use its: ${describeGrants(requests)}`,
      ...askGrants ? [] : [`  and let it use this device's:   ${describeGrants(offers)}`],
      `  This device is ${identity.fingerprint}; the other side will see that.`,
    ].join("\n"));
    if (!(await prompt.confirm("Pair with it?", true))) { console.log("Not paired."); process.exitCode = 3; return; }
    const name = await chooseName(prompt, "Save it as", options.name, invite.name ?? "peer");
    if (askGrants) offers = await chooseGrants(prompt, name);
    // Our own daemon's addresses, if it runs, so the other device can dial back.
    let addresses: string[] | undefined;
    let pairedDaemonRuns = false;
    try { control = await connectControl(options.state); } catch { control = undefined; }
    if (control) {
      try {
        const status = await control.remote.status();
        pairedDaemonRuns = !!status.paired;
        if (status.paired) addresses = status.addresses;
      } catch { /* Not a daemon this device can use; pair without dialing back. */ }
    }
    try { ({ channel } = await connectFirst(invite.addresses, identity, { expect: invite.key, invite: { id: invite.id, secret: invite.secret } })); }
    catch (error) {
      process.exitCode = error instanceof AuthError && error.code !== "closed" ? 3 : 1;
      throw error;
    }
    const remote = rpcSession<PairingApi>(channel, new RefusingShell());
    console.error("Connected. Waiting for the other device to confirm...");
    const open = channel;
    const timer = setTimeout(() => open.close("Pairing timed out"), PROPOSAL_WAIT_MS);
    let answer: unknown;
    try { answer = await plain(remote.propose({ name: suggestedName(os.hostname()), requests, offers, ...addresses?.length ? { addresses } : {} })); }
    catch (error) {
      console.log(`Not paired: ${errorMessage(error)}`);
      process.exitCode = 3;
      return;
    } finally {
      clearTimeout(timer);
      remote[Symbol.dispose]();
    }
    const parsed = decisionSchema.safeParse(answer);
    if (!parsed.success) throw new Error("The other device sent an answer this cns cannot read; nothing was saved here.");
    const decision = parsed.data;
    if (!decision.accept) { console.log(`Not paired: ${decision.reason ?? "the other device declined."}`); process.exitCode = 3; return; }
    try {
      savePairedPeer(name, { publicKey: invite.key, addresses: invite.addresses, pairedAt: new Date().toISOString(), grants: { incoming: offers, outgoing: decision.granted ?? [] } });
    } catch (error) {
      throw new Error(`The other device saved the pairing, but this device could not: ${errorMessage(error)}. Remove this device there with cns peer remove, then pair again.`);
    }
    console.log(`Paired with ${name} (${peerFingerprint}). This device may use its: ${describeGrants(decision.granted ?? [])}. It may use this device's: ${describeGrants(offers)}.`);
    if (control && pairedDaemonRuns) await control.remote.dial(name);
  } finally {
    channel?.close();
    control?.close();
    prompt?.close();
  }
}

/** The running daemon's control connection, or undefined when none runs. */
async function daemonIfRunning(state?: string): Promise<ControlConnection | undefined> {
  try { return await connectControl(state); } catch { return undefined; }
}

/** Text another device sent, made safe to print: no terminal control sequences. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/** The paired devices the local daemon has a standing link to, by fingerprint. */
async function standingLinks(control: ControlConnection): Promise<Map<string, { name: string; hostname: string; via: "direct" | "relay" }>> {
  return new Map((await control.controller.peers()).flatMap((peer) => peer.peer?.daemon ? [[peer.peer.fingerprint, { name: peer.peer.name, hostname: printable(peer.info.hostname), via: peer.peer.via }]] : []));
}

/** `cns status`: this device, its daemon and its links. */
export async function status(options: StatusOptions): Promise<void> {
  const identity = loadIdentity();
  const control = await daemonIfRunning(options.state);
  let daemon: Record<string, unknown> | null = null;
  const links: Array<{ name: string; fingerprint: string; address: string; hostname: string }> = [];
  if (control) {
    try {
      const info = await control.remote.status();
      daemon = { pid: info.pid, url: info.url, paired: !!info.paired, addresses: info.addresses ?? [], relay: info.relay ? redactRelay(info.relay) : null, relayRegistered: info.relayRegistered ?? null, startedAt: new Date(info.startedAt).toISOString() };
      for (const [fingerprint, link] of await standingLinks(control)) links.push({ name: link.name, fingerprint, address: link.via, hostname: link.hostname });
    } finally { control.close(); }
  }
  const paired = listPeers().filter((peer) => peer.kind === "paired");
  if (options.json) {
    console.log(JSON.stringify({ identity: identity ? { publicKey: identity.publicKey, fingerprint: identity.fingerprint } : null, daemon, links, paired: paired.length }, null, 2));
    return;
  }
  console.log(`This device: ${identity ? identity.fingerprint : "no identity yet (cns identity or cns up creates one)"}`);
  if (!daemon) console.log("Daemon:      not running (cns up starts it)");
  else if (!daemon.paired) console.log(`Daemon:      pid ${daemon.pid} at ${daemon.url}, legacy listener (not for paired devices)`);
  else {
    console.log(`Daemon:      pid ${daemon.pid} at ${daemon.url}${(daemon.addresses as string[]).length ? `, reachable at ${(daemon.addresses as string[]).join(", ")}` : ""}`);
    if (daemon.relay) console.log(`Relay:       ${daemon.relay} (${daemon.relayRegistered ? "registered" : "registering"})`);
  }
  console.log(`Paired:      ${paired.length} device${paired.length === 1 ? "" : "s"}${paired.length ? `: ${paired.map((peer) => peer.name).join(", ")}` : ""}`);
  console.log(links.length ? `Links:       ${links.map((link) => `${link.name} (${link.address}, ${link.hostname})`).join(", ")}` : "Links:       none");
}

/** `cns doctor NAME`: how, and whether, this device reaches a paired device right now. */
export async function doctor(name: string, options: DoctorOptions): Promise<void> {
  const entry = getPeer(name);
  if (!entry) throw new Error(`Unknown peer: ${name}. cns peers lists the saved ones.`);
  const report: Record<string, unknown> = { name, kind: entry.kind };
  const lines: string[] = [];
  if (entry.kind === "address") {
    lines.push(`${name} is a saved address, not a paired device: ${entry.url}. Pair with it to authenticate it.`);
    report.url = entry.url;
  } else {
    const identity = ensureIdentity().identity;
    report.fingerprint = entry.fingerprint;
    report.access = entry.grants.outgoing;
    report.grants = entry.grants.incoming;
    lines.push(`${name}: paired device ${entry.fingerprint}`, `  This device may use its:  ${describeGrants(entry.grants.outgoing)}`, `  It may use this device's: ${describeGrants(entry.grants.incoming)}`);
    const accessLine = lines.length - 2;
    const control = await daemonIfRunning(options.state);
    let linked = false;
    if (control) {
      let via: string | undefined;
      try { via = (await standingLinks(control)).get(entry.fingerprint)?.via; } finally { control.close(); }
      linked = via !== undefined;
      lines.push(`  Daemon link: ${via ? `online (${via})` : "offline"}`);
    } else lines.push("  Daemon link: no daemon running here (cns up)");
    report.link = control ? (linked ? "online" : "offline") : "no-daemon";
    const attempts: Array<{ address: string; result: string; detail?: string }> = [];
    /** What the device says this one may use there now, from the first address that answers. */
    let live: Permission[] | undefined;
    if (!entry.addresses.length) lines.push("  No saved address: cns peer address NAME ws://HOST:PORT adds one.");
    for (const address of entry.addresses) {
      const cancelled = new AbortController();
      // The deadline covers the whole attempt: connecting, authenticating and the first call.
      const timer = setTimeout(() => cancelled.abort(new Error("Timed out after 10 s.")), 10_000);
      try {
        const { channel } = await connectSecure(address, identity, { expect: entry.publicKey, signal: cancelled.signal });
        const hangUp = () => channel.close("Timed out");
        cancelled.signal.addEventListener("abort", hangUp, { once: true });
        try {
          const remote = rpcSession<ShellApi>(channel, new RefusingShell());
          try {
            const info = await plain(remote.info());
            attempts.push({ address, result: "ok", detail: printable(`${info.hostname}, ${info.platform}/${info.shell}, encrypted`) });
            live ??= await liveAccess(remote);
          } finally { remote[Symbol.dispose](); }
        } finally {
          cancelled.signal.removeEventListener("abort", hangUp);
          channel.close();
        }
      } catch (error) {
        const detail = cancelled.signal.aborted ? "Timed out after 10 s." : printable(errorMessage(error));
        attempts.push({ address, result: error instanceof AuthError && !cancelled.signal.aborted ? error.code : "unreachable", detail });
      } finally { clearTimeout(timer); }
    }
    report.attempts = attempts;
    for (const attempt of attempts) lines.push(`  ${attempt.address}${isRelayAddress(attempt.address) ? " [relay]" : ""}: ${attempt.result}${attempt.detail ? ` (${attempt.detail})` : ""}`);
    if (live) {
      report.access = live;
      const saved = entry.grants.outgoing;
      if (live.length !== saved.length || live.some((permission) => !saved.includes(permission))) {
        // Kept for display only, since the other device enforces it: record what it says now.
        updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, outgoing: live! } }));
        lines[accessLine] = `  This device may use its:  ${describeGrants(live)} (changed since it was saved as ${describeGrants(saved)}; saved now)`;
      }
      if (!live.length) lines.push(`  ${noAccessHint([name]).split("\n").slice(0, 2).join("\n  ")}`);
    }
    if (attempts.some((attempt) => attempt.result === "identity-changed")) process.exitCode = 3;
    else if (attempts.some((attempt) => attempt.result === "not-paired")) process.exitCode = 3;
    else if (!attempts.some((attempt) => attempt.result === "ok")) process.exitCode = 5;
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(lines.join("\n"));
}

/** What a paired device says this one may use on it, or undefined if it does not say in a form this cns reads. */
async function liveAccess(remote: RpcStub<ShellApi>): Promise<Permission[] | undefined> {
  try {
    const text: unknown = await (remote as unknown as { grants: Promise<unknown> }).grants;
    return typeof text === "string" && text.length <= 256 ? parseGrants(text.replaceAll(" ", ""), []) : undefined;
  } catch { return undefined; }
}

/** Tell the running daemon that a device's record changed, if there is one. */
async function refresh(name: string, state?: string) {
  const control = await daemonIfRunning(state);
  if (!control) return;
  try { if ((await control.remote.status()).paired) await control.remote.refresh(name); } finally { control.close(); }
}

/** `cns peer grant NAME GRANTS`: let a paired device do more here, at once and without interrupting its links. */
export async function grant(name: string, words: string[], options: { state?: string }): Promise<void> {
  const added = expandGrants(words.flatMap((word) => word.split(",")).map((word) => word.trim()).filter(Boolean));
  if (!added.length) throw new Error(`Name what to grant: ${["shell", "files", "sessions", "all", ...PERMISSIONS].join(", ")}.`);
  const updated = updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, incoming: expandGrants([...peer.grants.incoming, ...added]) } }));
  await refresh(name, options.state);
  console.log(`${name} may use this device's: ${describeGrants(updated.grants.incoming)}.`);
}

/** `cns peer revoke NAME [GRANTS]`: take access away, now, ending what used it; without grants, all of it. */
export async function revoke(name: string, words: string[], options: { state?: string }): Promise<void> {
  const removed = words.length ? new Set(expandGrants(words.flatMap((word) => word.split(",")).map((word) => word.trim()).filter(Boolean))) : new Set(PERMISSIONS);
  const updated = updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, incoming: peer.grants.incoming.filter((permission) => !removed.has(permission)) } }));
  await refresh(name, options.state);
  console.log(`${name} may use this device's: ${describeGrants(updated.grants.incoming)}.`);
}

/** `cns peer address NAME URL...`: where to reach a paired device; `--remove` takes addresses away. */
export async function address(name: string, urls: string[], options: { remove?: boolean; state?: string }): Promise<void> {
  const validated = urls.map((url) => validatePeerUrl(url));
  const updated = updatePairedPeer(name, (peer) => ({
    ...peer,
    addresses: options.remove ? peer.addresses.filter((saved) => !validated.includes(validatePeerUrl(saved))) : [...new Set([...peer.addresses, ...validated])],
  }));
  await refresh(name, options.state);
  console.log(updated.addresses.length ? `${name} is dialed at: ${updated.addresses.join(", ")}.` : `${name} has no saved address.`);
}

/** `cns peer remove NAME`: forget a saved peer; for a paired device, the running daemon drops its links at once. */
export async function removePeer(name: string, options: { state?: string }): Promise<void> {
  let publicKey: string | undefined;
  try { const entry = getPeer(name); if (entry?.kind === "paired") publicKey = entry.publicKey; }
  catch { /* An unreadable record is removed all the same. */ }
  removeAlias(name);
  if (publicKey) {
    const control = await daemonIfRunning(options.state);
    if (control) {
      try { if ((await control.remote.status()).paired) await control.remote.forget(publicKey); } finally { control.close(); }
    }
  }
  console.log(`Removed ${name}.`);
}

/** `cns peers`: every saved device with its status. */
export async function peers(options: PeersOptions): Promise<void> {
  const saved = listPeers();
  let online = new Map<string, { via: "direct" | "relay" }>();
  const control = await daemonIfRunning(options.state);
  if (control) {
    try { online = await standingLinks(control); }
    catch { /* A daemon that cannot answer: everything is offline. */ }
    finally { control.close(); }
  }
  const rows = saved.map((peer) => peer.kind === "paired"
    ? { name: peer.name, kind: "paired" as const, fingerprint: peer.fingerprint, status: online.has(peer.fingerprint) ? "online" : "offline", connection: online.get(peer.fingerprint)?.via ?? null, access: peer.grants.outgoing, grants: peer.grants.incoming, addresses: peer.addresses }
    : { name: peer.name, kind: "address" as const, status: "unpaired", connection: null, url: peer.url });
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("No saved peers. Run cns pair to pair with another device."); return; }
  const table = [["NAME", "STATUS", "CONNECTION", "ACCESS", "FINGERPRINT"], ...rows.map((row) => [
    row.name, row.status, row.connection ?? "-", row.kind === "paired" ? describeGrants(row.access) : "-", row.kind === "paired" ? row.fingerprint : row.url,
  ])];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  console.log(table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"));
  const blocked = rows.flatMap((row) => row.kind === "paired" && !row.access.length ? [row.name] : []);
  if (blocked.length) console.error(`\n${noAccessHint(blocked)}`);
}

/** What to do about paired devices that grant this one nothing, which the other device alone can change. */
function noAccessHint(names: readonly string[]): string {
  const fingerprint = loadIdentity()?.fingerprint;
  const which = names.length === 1 ? names[0]! : names.join(", ");
  const where = names.length === 1 ? `on ${names[0]}` : "on each of them";
  return [
    `${which} ${names.length === 1 ? "grants" : "grant"} this device no access. To change that, run ${where}: cns peer grant NAME shell (or files, sessions, all),`,
    `where NAME is what it calls this device; cns peers there lists it${fingerprint ? ` with fingerprint ${fingerprint}` : ""}.`,
    `ACCESS is what was granted when you paired; cns doctor ${names.length === 1 ? names[0] : "NAME"} checks it again.`,
  ].join("\n");
}
