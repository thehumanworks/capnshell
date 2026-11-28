import os from "node:os";
import type { RpcStub } from "capnweb";
import { attachClientSocket, clientWire, connectFirst, rpcSession, secureReady, SecureChannel, serverWire, type Established } from "../secure.js";
import { challengeBytes, dialAddresses, isRelayAddress, relayEndpoint } from "../relay-hub.js";
import { builtInRelay } from "../relay-config.js";
import { serve, type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import { PtyRegistry, ShellApi, type ShellInfo } from "../shell.js";
import type { PtyExit, SessionHost } from "../pty.js";
import { HeldSessions, HOLDERS, holderDirectory, keepsSessions, socketsTooLong } from "../held-sessions.js";
import type { ConnectionController } from "../console.js";
import { errorMessage, printable, strictlyPrintable } from "../errors.js";
import type { DaemonConfig, PeerConfig } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import { closeSocket, forkShell, openSocket } from "../connect.js";
import { AuthError, type Refusal } from "../auth.js";
import { ensureIdentity, fingerprint, type Identity, type PublicKey } from "../identity.js";
import { GrantedShell, type GrantHolder } from "../granted-shell.js";
import { createInvite, decisionSchema, PairingApi, suggestedName } from "../pairing.js";
import { InviteBook } from "../invites.js";
import { advertisedSchema, describeGrants, explainDenial, findPairedPeer, getPeer, grantsSchema, isRevoked, lanSchema, learnAddresses, listPeers, revokedDevices, savePairedPeer, updatePairedPeer, type LanCard, type PeerEntry } from "../peers.js";
import { lanCards } from "../wake.js";
import { listeningAddresses } from "../addresses.js";
import { serveControl, type PairingController } from "./daemon-server.js";
import { daemonStatePath, keptSessions, listenFailure, removeStaleState } from "./daemon.js";
import { runOneShot } from "./one-shot.js";
import { infoSchema } from "./connect-device.js";
import { describeVersion } from "../version.js";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { afterDialFailure, dialTurn, keepsOutbound, onDialed, onInbound, redialDelay, worthDialing } from "../link-rules.js";
import { isRegistered, RELAY_PING_MS, startRegistration, stepRegistration, type Registration, type RegistrationEffect, type RegistrationEvent } from "../relay-registration.js";
import { applyMeshes, droppedBy, listMeshes, listsFor, newerLists, removeMesh, writeMesh, type SignedList } from "../mesh.js";
import { secretsFor, takeSecrets, type SecretCopy } from "../secrets.js";
import { secretsHere } from "./secret-cli.js";
import { auditLog } from "../audit.js";

/** CLI exit statuses for failures, as docs/paired-peers.md lists them: 3 unpaired or changed device, 4 permission denied, else 1. */
export function authExitCode(error: unknown): number {
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) return 3;
  if (/^Permission denied/.test(errorMessage(error))) return 4;
  return 1;
}

export { commandExitCode } from "./one-shot.js";

/** The server `listen` starts at the daemon's address, or an error that says why it cannot and what to run next. */
function bound<T>(daemon: DaemonConfig, listen: () => T): T {
  try { return listen(); }
  catch (error) {
    const failure = listenFailure(error, daemon);
    throw failure ? new Error(failure, { cause: error }) : error;
  }
}

// Bound connections that have not authenticated yet, including ones that never complete the handshake.
export const MAX_PEERS = 32;
const HANDSHAKE_MS = 5000;
interface SocketData { address: string; session?: Session; channel?: SecureChannel }
interface Session {
  id: string;
  address: string;
  /** Close the connection this session runs on. */
  close(reason: string): void;
  /** This process dialed the connection. */
  outbound: boolean;
  /** Whether the connection runs directly or through a relay. */
  via: "direct" | "relay";
  local: { [Symbol.dispose](): void };
  remote: RpcStub<ShellApi>;
  timer: ReturnType<typeof setTimeout>;
  info?: ShellInfo;
  /** The authenticated paired device on the other end; `daemon` marks a standing link between daemons. */
  peer?: { name: string; publicKey: PublicKey; daemon: boolean };
  /** What the paired device may do here, shared with its GrantedShell so additions apply live. */
  grants?: GrantHolder;
  /** A device that arrived with an invite and may only propose a pairing; not a peer to select. */
  pairing?: boolean;
  /** When the link was made, to tell two daemons dialing at once from a link that has gone stale. */
  since: number;
  /** The saved address this process dialed the link at. */
  dialed?: string;
  /** Local commands borrowing this link, told when it ends. */
  borrowers: Set<() => void>;
}
/** Dialers the relay announced that the daemon is answering at once; more are ignored. */
const MAX_RELAY_ANSWERS = 32;

/**
 * Run the paired daemon, or one command on a paired device: the same link machinery, the
 * daemon listening, registered at the relay and linked to every paired device, a command
 * holding one encrypted connection to the device it names.
 */
export async function startPeer(config: PeerConfig | DaemonConfig): Promise<void> {
  const daemon = config.role === "daemon" ? config : undefined;
  const command = config.role !== "daemon" ? config : undefined;
  const sessions = new Map<string, Session>();
  const announce = (message: string) => { if (daemon) console.log(message); };
  // Named PTY sessions outlive the connection that started them. The daemon's run in holder
  // processes of their own, which outlive it too (held-sessions.ts); on Windows, or where their
  // sockets' paths would be too long, they live here.
  const holderDir = daemon && HOLDERS ? holderDirectory(daemonStatePath(daemon.state)) : undefined;
  const tooLong = holderDir && socketsTooLong(holderDir);
  const holders = holderDir && !tooLong ? new HeldSessions(holderDir, announce, { adopted: auditEnd }) : undefined;
  const ptys: SessionHost & Disposable = holders ?? new PtyRegistry();
  /** Whether they outlive this daemon: not when systemd stops them with it (keepsSessions). */
  const keeps = !!holders && keepsSessions(!!daemon?.service);
  let nextId = 1;
  let listener: Server<SocketData> | undefined;
  let controlCleanup: (() => Promise<void>) | undefined;
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const oneShot = !daemon;
  const cancelled = new AbortController();
  // Machine-readable command output must contain only the remote command's streams: announce is the daemon's alone.
  const identity: Identity = ensureIdentity().identity;
  /** The mesh secrets this device reads, for the programs paired devices start here. */
  const localSecrets = secretsHere(identity);
  /** What paired devices do here, one line each in the audit log (audit.ts). */
  const audit = auditLog();
  /**
   * The end of a session a paired device started under an earlier daemon, as its GrantedShell
   * would have recorded it there: the device by its name here now, or its fingerprint.
   */
  function auditEnd(record: { name: string; owner: string | null; startedAt: string }, exited: Promise<PtyExit>) {
    const { owner } = record;
    if (owner === null) return;
    void exited.then((exit) => {
      const peer = listPeers().find((entry) => fingerprint(entry.publicKey) === owner)?.name ?? owner;
      try {
        audit({
          start: record.startedAt, end: new Date().toISOString(), peer, fingerprint: owner, action: "session.end", target: record.name,
          exitCode: exit.exitCode, ...exit.signal ? { signal: exit.signal } : {}, ...exit.timedOut ? { timedOut: true } : {},
        });
      } catch { /* Lost; the audit log reports why. */ }
    }, () => {});
  }
  // The relay built into cns: the daemon registers there, and paired devices are dialed there after their direct addresses.
  const relay = builtInRelay();
  /**
   * The record of a device paired here, unless it was removed here (revokeDevice): a record left
   * behind, such as one restored from a backup, does not let it in. Pairing again clears that.
   */
  const pairedHere = (publicKey: PublicKey) => isRevoked(publicKey) ? undefined : findPairedPeer(publicKey);
  /** What this device lets an authenticated paired device do here: exactly its saved incoming grants. `daemon`: the device's daemon made the link. */
  function offerTo(publicKey: PublicKey, daemon: boolean): { local: GrantedShell; name: string; grants: GrantHolder } {
    const entry = pairedHere(publicKey);
    if (!entry) throw new AuthError("not-paired", "Not paired with this device.");
    const grants: GrantHolder = { current: entry.grants.incoming };
    const owner = fingerprint(publicKey);
    return { local: new GrantedShell(new ShellApi(ptys, { owner }), grants, entry.name, owner, advertisedToPeers, answerMeshes(publicKey), answerSecrets(publicKey), localSecrets, audit, lanFor(entry, daemon, grants)), name: entry.name, grants };
  }
  /**
   * This device's network cards, for cns wake: told only over a standing link to another daemon, and
   * only while this device grants that one something. A command's connection, the cns gateway's
   * (which links as one, and may also be saved as a mesh's gateway) and a device granted nothing
   * here learn none.
   */
  const lanFor = (entry: Pick<PeerEntry, "gateway">, daemon: boolean, grants: GrantHolder) => (): LanCard[] =>
    daemon && !entry.gateway && grants.current.length ? lanCards() : [];
  /** Invites handed out and not yet settled (invites.ts). */
  const invites = new InviteBook();
  const links = new Map<string, { stop: () => void; publicKey: PublicKey }>();
  /** The standing daemon link to a paired device, if any, answered yet or not; one command's connection does not count. */
  const linkTo = (publicKey: PublicKey) => [...sessions.values()].find((session) => session.peer?.publicKey === publicKey && session.peer.daemon);
  /** Drop every link and dial loop for a device: its commands end and its handles are revoked. */
  function forget(publicKey: PublicKey) {
    for (const session of [...sessions.values()]) if (session.peer?.publicKey === publicKey) remove(session);
    for (const link of [...links.values()]) if (link.publicKey === publicKey) link.stop();
  }
  /** When both devices dialed each other, the one with the smaller key keeps its outbound link. */
  const keepsOwnOutbound = (publicKey: PublicKey) => keepsOutbound(identity.publicKey, publicKey);

  function describe(session: Session): string {
    const who = session.peer ? `${session.peer.name} (paired)` : session.info?.hostname;
    return who ? `${who} (${session.address})` : session.address;
  }

  function remove(session: Session) {
    if (!sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    // Close first: releasing the stub afterwards then finds the session already ended
    // rather than reporting an aborted one to the other side.
    session.close("Shell session ended");
    session.local[Symbol.dispose]();
    session.remote[Symbol.dispose]();
    // Commands that borrowed the link lose it as they would their own connection.
    for (const lost of [...session.borrowers]) lost();
    session.borrowers.clear();
    if (!stopping) announce(`Disconnected from ${describe(session)}.`);
  }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    cancelled.abort();
    for (const link of links.values()) link.stop();
    for (const channel of relayAnswers.values()) channel?.close("The daemon is stopping");
    relayAnswers.clear();
    invites.endAll();
    for (const session of sessions.values()) remove(session);
    const kept = holders?.running ?? [];
    ptys[Symbol.dispose]();
    if (kept.length && keeps) announce(keptSessions(kept));
    try {
      await Promise.all([listener?.stop(true), controlCleanup?.()]);
    } catch (error) {
      process.exitCode = 1;
      console.error(errorMessage(error));
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      finished();
    }
  }
  const interrupt = () => { void stop(oneShot ? 130 : 0); };
  const terminate = () => { void stop(oneShot ? 143 : 0); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  function requireSession(id: string) {
    const session = sessions.get(id);
    if (!session?.info) throw new Error(`Peer ${id} is not connected. Use :peers and :use ID.`);
    return session;
  }
  const controller: ConnectionController = {
    async lend(publicKey, released, lost) {
      // Only a standing link that has answered: one still authenticating may yet be refused.
      const session = linkTo(publicKey);
      if (!session?.info || stopping || released.aborted) return undefined;
      let shell: RpcStub<ShellApi>;
      // A fork, so releasing it ends the borrower's commands, unnamed terminals and handles, and nothing else.
      try { shell = await forkShell(session.remote); }
      catch (error) {
        // Forking needs the shell grant. Without it the device offers only files and sessions,
        // whose handles end when the borrower releases them, so its own shell will do.
        if (!/^Permission denied/.test(errorMessage(error))) throw error;
        shell = session.remote.dup();
      }
      if (!sessions.has(session.id) || released.aborted) {
        shell[Symbol.dispose]();
        return undefined;
      }
      session.borrowers.add(lost);
      released.addEventListener("abort", () => session.borrowers.delete(lost), { once: true });
      return { shell, via: session.via };
    },
    async peers() {
      return [...sessions.values()].flatMap(({ id, info, peer, pairing }) => info && !pairing
        ? [{ id, info: { ...info }, ...peer ? { peer: { name: peer.name, fingerprint: fingerprint(peer.publicKey), daemon: peer.daemon, via: sessions.get(id)!.via } } : {} }] : []);
    },
    async info(id) { return { ...requireSession(id).info! }; },
    async run(id, command, options, signal) {
      // Capture the session once; its ID is never reused, even after disconnect.
      const { remote } = requireSession(id);
      if (!signal) return await plain(remote.run(command, options));
      signal.throwIfAborted();
      const shell = await forkShell(remote);
      // Releasing the fork makes the peer kill the command.
      const release = () => shell[Symbol.dispose]();
      signal.addEventListener("abort", release, { once: true });
      try {
        // The signal may have fired while the fork was on its way.
        signal.throwIfAborted();
        return await plain(shell.run(command, options));
      } finally {
        signal.removeEventListener("abort", release);
        release();
      }
    },
    async exec(id, sink, command, options, input) {
      const { remote } = requireSession(id);
      return await plain(input ? remote.exec(sink, command, options, input) : remote.exec(sink, command, options));
    },
    async openPty(id, sink, options) {
      return await requireSession(id).remote.openPty(sink, options);
    },
    files(id) { return requireSession(id).remote; },
    async ptySessions(id) { return await plain(requireSession(id).remote.ptySessions()); },
    async startPtySession(id, name, options) {
      using session = await requireSession(id).remote.startPtySession(name, options);
      return await plain(session.info());
    },
    async ptySession(id, name) {
      return await requireSession(id).remote.ptySession(name) as unknown as RemoteNamedPty;
    },
    async shell(id) {
      return await forkShell(requireSession(id).remote);
    },
  };

  function disconnected(session: Session, code = oneShot || !session.info ? 1 : 0) {
    if (!sessions.has(session.id)) return;
    remove(session);
    if (!daemon) void stop(code);
  }

  function register(connection: { close(reason: string): void; outbound: boolean; via?: "direct" | "relay"; dialed?: string }, local: Session["local"], remote: RpcStub<ShellApi>, address: string, peer?: Session["peer"]): Session {
    const id = `p${nextId++}`;
    const session: Session = { id, address, close: connection.close, outbound: connection.outbound, via: connection.via ?? "direct", dialed: connection.dialed, local, remote, peer, since: Date.now(), borrowers: new Set(), timer: setTimeout(() => {
      if (!sessions.has(id)) return;
      console.error(`Handshake with ${describe(session)} timed out.`);
      disconnected(session, 1);
    }, HANDSHAKE_MS) };
    sessions.set(id, session);
    remote.onRpcBroken(() => disconnected(session));
    void (async () => {
      try {
        const info = await remote.info();
        try { session.info = infoSchema.parse(info); }
        finally { info[Symbol.dispose]?.(); }
        if (!sessions.has(id) || stopping) return;
        clearTimeout(session.timer);
        announce(`Connected to ${describe(session)} [${session.info.platform} / ${session.info.shell}, ${describeVersion(session.info.version)}].`);
        if (session.peer?.daemon) {
          void learnFromPeer(session);
          void exchangeMeshes(session).then(() => exchangeSecrets(session));
        }
        if (command) await stop(await runOneShot(command, controller, id, cancelled.signal));
      } catch (error) {
        if (!stopping && sessions.has(id)) {
          console.error(explainDenial(errorMessage(error), session.peer?.name));
          disconnected(session, authExitCode(error));
        }
      }
    })();
    return session;
  }

  /**
   * Ask a paired device on a standing link where it can be reached now, what it lets this
   * device do there and which network cards it has, and save them in its record: a device
   * that moved networks or changed relays is then dialed where it is rather than where it
   * was, the access `cns peers` shows follows grants changed on that device since pairing,
   * and cns wake knows its cards once it sleeps. A question that fails, as lan does on a cns
   * from before cns wake, leaves that part of the record as saved.
   */
  async function learnFromPeer(session: Session) {
    const peer = session.peer!;
    const remote = session.remote as unknown as RpcStub<{ addresses(): string[]; granted(): string[]; lan(): unknown[] }>;
    const ask = async <T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T | undefined> => {
      try {
        const parsed = schema.safeParse(await call());
        return parsed.success ? parsed.data : undefined;
      } catch { return undefined; }
    };
    const [advertised, granted, lan] = await Promise.all([ask(() => remote.addresses(), advertisedSchema), ask(() => remote.granted(), grantsSchema), ask(() => remote.lan(), lanSchema)]);
    if (!sessions.has(session.id) || stopping) return;
    try {
      // Found by key, so a renamed alias is still the one updated.
      const entry = findPairedPeer(peer.publicKey);
      if (!entry) return;
      // Nothing advertised, such as a daemon with no network yet, says nothing about where it is.
      const addresses = advertised?.length ? learnAddresses(entry.addresses, advertised, session.dialed) : entry.addresses;
      const outgoing = granted ?? entry.grants.outgoing;
      const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
      const movedTo = !same(addresses, entry.addresses);
      const regranted = !same(outgoing, entry.grants.outgoing);
      const cards = lan ?? entry.lan;
      const recarded = JSON.stringify(cards) !== JSON.stringify(entry.lan);
      if (!movedTo && !regranted && !recarded) return;
      updatePairedPeer(entry.name, (current) => current.publicKey === peer.publicKey ? { ...current, addresses, grants: { ...current.grants, outgoing }, ...cards ? { lan: cards } : {} } : current);
      if (movedTo) announce(`${entry.name} is reachable at ${addresses.join(", ")}; saved.`);
      if (regranted) announce(`${entry.name} lets this device use: ${describeGrants(outgoing)}; saved.`);
      if (recarded) announce(`${entry.name}'s network cards, for cns wake: ${cards!.map((card) => `${card.mac} (${card.cidr})`).join(", ") || "none"}; saved.`);
    } catch (error) {
      announce(`${peer.name}: could not update its saved record: ${errorMessage(error)}`);
    }
  }

  /**
   * Take the mesh member lists a device offered (mesh.ts): keep each that is newer than this
   * device's and signed by its mesh's admin, leave a mesh whose admin no longer offers it,
   * bring the records in line and pass any change on to every linked device. Answers with
   * the lists of the meshes the device is in. A mesh that cannot be read here fails the
   * whole answer, which the device then ignores, rather than seeming to have dropped it.
   */
  function meshesFrom(from: PublicKey, offered: unknown): SignedList[] {
    if (!daemon || stopping) return [];
    const states = listMeshes();
    const newer = newerLists(states, offered, revokedDevices());
    const dropped = droppedBy(from, identity.publicKey, states, offered);
    for (const state of newer) {
      if (state.list.members.some((member) => member.key === identity.publicKey)) {
        writeMesh(state);
        announce(`The mesh ${state.name} has a new member list, version ${state.list.version}.`);
      } else {
        removeMesh(state.name);
        announce(`The mesh ${state.name}'s admin removed this device from it; left the mesh.`);
      }
    }
    for (const name of dropped) {
      removeMesh(name);
      announce(`The admin of the mesh ${name} no longer lists this device; left the mesh.`);
    }
    if (newer.length || dropped.length) meshesChanged();
    return listsFor(from, listMeshes());
  }

  /**
   * Bring the records in line with every mesh saved here and act on the change: links to
   * devices that are no longer members end, changed grants apply as cns peer grant's do,
   * members are dialed, and every linked device is offered the lists it is in.
   */
  function meshesChanged() {
    const plan = applyMeshes(identity.publicKey);
    for (const { publicKey } of plan.remove) forget(publicKey);
    for (const { name } of plan.update) void pairing?.refresh(name);
    // Every member, not only new ones: a loop that stopped is started again.
    for (const entry of listPeers(() => {})) if (entry.mesh !== undefined) dial(entry.name);
    if (plan.create.length) announce(`Mesh members saved: ${plan.create.map(({ name }) => name).join(", ")}.`);
    if (plan.remove.length) announce(`Mesh members removed: ${plan.remove.map(({ name }) => name).join(", ")}.`);
    // Lists first, so a device that just joined is a member when it is offered secrets.
    for (const session of sessions.values()) if (session.peer?.daemon && session.info) void exchangeMeshes(session).then(() => exchangeSecrets(session));
  }

  /** A device's GrantedShell.meshes: what went wrong here is reported here, not to the device. */
  const answerMeshes = (from: PublicKey) => (offered: unknown) => {
    try { return meshesFrom(from, offered); }
    catch (error) {
      announce(`Mesh lists: ${errorMessage(error)}`);
      throw new Error("The device could not take or offer its mesh lists.");
    }
  };

  /** Swap member lists with a device on a standing link. A cns older than meshes answers nothing, and nothing changes. */
  async function exchangeMeshes(session: Session) {
    const peer = session.peer!;
    const remote = session.remote as unknown as RpcStub<{ meshes(offered: unknown): unknown[] }>;
    let answer: unknown;
    try {
      const offered = listsFor(peer.publicKey, listMeshes());
      try { answer = await remote.meshes(offered); } catch { return; }
      if (!sessions.has(session.id) || stopping) return;
      meshesFrom(peer.publicKey, answer);
    } catch (error) {
      announce(`Mesh lists: ${errorMessage(error)}`);
    }
  }

  /**
   * Take the mesh secrets a device offered (secrets.ts): keep each newer one this device may
   * read, and pass what changed on to every other linked device. Only names are announced,
   * never values.
   */
  function takeSecretsFrom(from: PublicKey, offered: unknown): void {
    if (!daemon || stopping) return;
    const kept = takeSecrets(from, identity, listMeshes(), offered);
    if (!kept.length) return;
    announce(`Mesh secrets updated: ${kept.map((record) => `${record.mesh}/${record.name}${record.value ? "" : " (removed)"}`).join(", ")}.`);
    for (const session of sessions.values()) if (session.peer?.daemon && session.info && session.peer.publicKey !== from) void exchangeSecrets(session);
  }

  /** A device's GrantedShell.secrets: what went wrong here is reported here, not to the device. */
  const answerSecrets = (from: PublicKey) => (offered: unknown): SecretCopy[] => {
    try {
      if (!daemon || stopping) return [];
      takeSecretsFrom(from, offered);
      return secretsFor(from, identity, listMeshes());
    } catch (error) {
      announce(`Mesh secrets: ${errorMessage(error)}`);
      throw new Error("The device could not take or offer its mesh secrets.");
    }
  };

  /** Swap mesh secrets with a device on a standing link. A cns older than mesh secrets answers nothing, and nothing changes. */
  async function exchangeSecrets(session: Session) {
    const peer = session.peer!;
    const remote = session.remote as unknown as RpcStub<{ secrets(offered: unknown): unknown[] }>;
    let answer: unknown;
    try {
      const offered = secretsFor(peer.publicKey, identity, listMeshes());
      try { answer = await remote.secrets(offered); } catch { return; }
      if (!sessions.has(session.id) || stopping) return;
      takeSecretsFrom(peer.publicKey, answer);
    } catch (error) {
      announce(`Mesh secrets: ${errorMessage(error)}`);
    }
  }

  /** The responder's view of who may connect: paired devices, and devices that hold a live invite, which may pair a removed one again. */
  function authorize(peer: PublicKey, invite?: { id: string }): Refusal | undefined {
    if (invite) return undefined;
    if (pairedHere(peer)) return undefined;
    return { code: "not-paired", reason: "Not paired with this device. Run cns pair on it and type the code it shows here with cns pair CODE." };
  }
  const secretFor = (id: string) => invites.secretFor(id);
  /** What an invited device gets instead of a shell: one chance to propose a pairing. */
  function pairingFor(inviteId: string, peer: PublicKey): PairingApi {
    // A device that leaves before the decision would never save its side: end the invite instead.
    return new PairingApi(async (proposal) => {
      const decided = invites.propose(inviteId, peer, proposal);
      announce(`Pairing proposal from ${proposal.name} (${fingerprint(peer)}); waiting for cns pair to decide.`);
      // The alias chosen here stays here.
      const { accept, granted, reason } = await decided;
      return { accept, ...granted ? { granted } : {}, ...reason ? { reason } : {} };
    }, () => invites.left(inviteId, peer));
  }
  const pairing: PairingController | undefined = daemon ? {
    identity: () => ({ publicKey: identity.publicKey, fingerprint: identity.fingerprint }),
    addresses: () => advertised(),
    relayRegistered: () => relay ? isRegistered(registration) : undefined,
    sessions: () => ptys.running,
    async invite(ttlMs) {
      const invite = createInvite(identity.publicKey, advertised(), ttlMs, suggestedName(os.hostname()));
      invites.open(invite.id, invite.secret, invite.expiresAt, ttlMs);
      return { id: invite.id, text: invite.text, expiresAt: invite.expiresAt };
    },
    awaitProposal: (id) => invites.awaitProposal(id),
    async decide(id, decision) {
      invites.proposal(id);
      const parsed = decisionSchema.parse(decision);
      // The device is answered either way, so neither side is left with half a pairing.
      const result = invites.decide(id, parsed, ({ peer, proposal }, name, granted) => {
        savePairedPeer(name, { publicKey: peer, addresses: proposal.addresses ?? [], pairedAt: new Date().toISOString(), grants: { incoming: granted, outgoing: proposal.offers } });
        announce(`Paired with ${name} (${fingerprint(peer)}).`);
      });
      if (result.accept && result.name) void dial(result.name);
      return result;
    },
    dial: async (name) => { dial(name); },
    async meshChanged() { meshesChanged(); },
    async refresh(name) {
      // Sessions are found by key, so a renamed alias still reaches its device's links.
      const entry = getPeer(name);
      if (!entry) return;
      const granted = entry.grants.incoming;
      const live = [...sessions.values()].filter((session) => session.peer?.publicKey === entry.publicKey);
      if (live.some((session) => session.grants?.current.some((permission) => !granted.includes(permission)))) {
        // Something was taken away: drop the links, ending commands and handles that used it, and dial again.
        forget(entry.publicKey);
      } else {
        // Only widened, or only addresses changed: apply in place, without interrupting anything.
        for (const session of live) {
          if (session.grants) session.grants.current = granted;
          session.peer!.name = name;
        }
        for (const [other, link] of [...links]) if (link.publicKey === entry.publicKey && other !== name) link.stop();
      }
      dial(name);
    },
    async forget(publicKey) { forget(publicKey); },
    cancel: (id) => invites.cancel(id),
  } : undefined;

  /** Keep a link to a paired device, redialing its saved addresses, and this daemon's relay, with backoff while this daemon runs. */
  function dial(name: string) {
    if (links.has(name) || stopping) return;
    const entry = getPeer(name);
    if (!entry || !worthDialing(entry, relay)) return;
    const expectedKey = entry.publicKey;
    let attempt = 0;
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One timer at a time: a link that ends while the loop already waits does not start a second loop.
    const schedule = () => {
      if (stopped || stopping) return;
      clearTimeout(timer);
      timer = setTimeout(() => void connect(), redialDelay(attempt));
      timer.unref?.();
      attempt++;
    };
    const handle = { stop: () => { stopped = true; clearTimeout(timer); if (links.get(name) === handle) links.delete(name); }, publicKey: expectedKey };
    const stop = handle.stop;
    // Any failure, such as an unreadable peer file, is reported and retried; the loop never dies quietly.
    async function connect() {
      // An attempt still dialing ends by scheduling the next one or by making a link.
      if (stopped || stopping || busy) return;
      busy = true;
      try { await attempt_(); }
      catch (error) {
        announce(`${name}: ${errorMessage(error)}`);
        schedule();
      } finally { busy = false; }
    }
    async function attempt_() {
      const current = getPeer(name);
      const addresses = current && worthDialing(current, relay) ? dialAddresses(current, relay) : [];
      // A device removed here is not dialed, even when a record of it is left or restored, as this
      // link would offer it what that record grants. Checked on every attempt, the first included.
      if (!current || current.publicKey !== expectedKey || !addresses.length || isRevoked(current.publicKey)) return stop();
      // With a link up, wait, unless it runs through the relay while a direct one may work (link-rules.ts).
      const existing = linkTo(current.publicKey);
      const turn = dialTurn(existing, addresses, Date.now());
      if (turn.action === "wait") return schedule();
      let channel: SecureChannel;
      let url: string;
      try {
        ({ channel, url } = await connectFirst(turn.addresses, identity, { expect: current.publicKey, mode: "daemon", signal: cancelled.signal }));
      } catch (error) {
        if (afterDialFailure(error instanceof AuthError ? error.code : undefined, turn.upgrade, current.mesh !== undefined) === "stop") {
          announce(`${name}: ${(error as Error).message}`);
          return stop();
        }
        return schedule();
      }
      if (stopped || stopping) { channel.close(); return; }
      // Replacing the relayed link this dial set out to replace, or both devices dialed at once.
      const other = linkTo(current.publicKey);
      const outcome = onDialed(other, turn.upgrade && other === existing, keepsOwnOutbound(current.publicKey));
      if (outcome === "drop") { channel.close("Duplicate link"); return schedule(); }
      if (outcome === "replace") remove(other!);
      attempt = 0;
      const via = isRelayAddress(url) ? "relay" : "direct";
      const grants: GrantHolder = { current: current.grants.incoming };
      const owner = fingerprint(current.publicKey);
      const local = new GrantedShell(new ShellApi(ptys, { owner }), grants, name, owner, advertisedToPeers, answerMeshes(current.publicKey), answerSecrets(current.publicKey), localSecrets, audit, lanFor(current, true, grants));
      const remote = rpcSession<ShellApi>(channel, local);
      const session = register({ close: (reason) => channel.close(reason), outbound: true, via, dialed: url }, local, remote, new URL(url).host, { name, publicKey: current.publicKey, daemon: true });
      session.grants = grants;
      void channel.done.then(() => { disconnected(session); schedule(); });
      // A relayed link keeps the loop going, to replace it once a direct one works.
      if (via === "relay") schedule();
    }
    links.set(name, handle);
    void connect();
  }

  /** Where this daemon's registration at the relay is (relay-registration.ts). */
  let registration: Registration | undefined;
  /** Answers to relay dialers in progress, by the relay's id, so a relay cannot make this daemon open connections without limit. */
  const relayAnswers = new Map<string, SecureChannel | undefined>();
  /** Log refusals at most a few times per window, so a flood cannot flood the log. */
  let refusalWindow = 0;
  let refusalsLogged = 0;
  const refused = (message: string) => {
    if (stopping) return;
    const now = Date.now();
    if (now - refusalWindow > 10_000) { refusalWindow = now; refusalsLogged = 0; }
    if (++refusalsLogged <= 5) announce(message);
    else if (refusalsLogged === 6) announce("More connections were refused; not logging them for a few seconds.");
  };
  /** What a paired device learns over a link: a daemon's addresses; a one-command process has none to offer. */
  function advertisedToPeers(): string[] { return daemon ? advertised() : []; }
  /** Where other devices can reach this daemon: its direct addresses, then its relay address. */
  function advertised(): string[] {
    if (!daemon) return [];
    const direct = listeningAddresses(daemon.bind, daemon.port);
    return relay ? [...direct, relayEndpoint(relay, "dial", identity.publicKey)] : direct;
  }

  /**
   * Stay registered at the relay: prove this device's key, answer each dialer it
   * announces with an encrypted inbound channel, and re-register with backoff when the
   * relay connection drops or stops answering pings. relay-registration.ts decides what
   * to do; this opens and closes the connections and runs the timers.
   */
  function registerAtRelay(base: string) {
    const url = relayEndpoint(base, "accept", identity.publicKey);
    const host = new URL(url).host;
    /** The open connection to the relay, if any. */
    let socket: WebSocket | undefined;
    const step = (event: RegistrationEvent) => {
      const next = stepRegistration(registration!, event, Date.now());
      registration = next.state;
      for (const effect of next.effects) carryOut(effect, socket);
    };
    function carryOut(effect: RegistrationEffect, current: WebSocket | undefined) {
      switch (effect.do) {
        case "connect": void connect(); break;
        case "wait": setTimeout(() => step({ t: "waited" }), effect.ms).unref?.(); break;
        case "say": announce(effect.message); break;
        case "close": if (current) closeSocket(current, effect.reason); break;
        case "ping": try { current?.send(JSON.stringify({ t: "ping" })); } catch { /* Closing follows. */ } break;
        case "prove":
          void challengeBytes(host, identity.publicKey, effect.nonce).then((bytes) => {
            current?.send(JSON.stringify({ t: "proof", sig: Buffer.from(identity.sign(bytes)).toString("base64url") }));
          }).catch(() => { if (current) closeSocket(current, "Invalid challenge"); });
          break;
        case "answer":
          if (relayAnswers.has(effect.id)) break;
          if (relayAnswers.size >= MAX_RELAY_ANSWERS) { refused(`Ignored a dialer at the relay ${host}: ${MAX_RELAY_ANSWERS} are already being answered.`); break; }
          void answerAtRelay(base, effect.id);
      }
    }
    async function connect() {
      let opened: WebSocket;
      try { opened = await openSocket(url, cancelled.signal); }
      catch (error) { return step({ t: "open-failed", error: errorMessage(error) }); }
      socket = opened;
      // Only the current connection speaks for the registration.
      const pinger = setInterval(() => { if (socket === opened) step({ t: "tick" }); }, RELAY_PING_MS);
      pinger.unref?.();
      opened.addEventListener("message", (event: MessageEvent) => { if (socket === opened) step({ t: "message", data: event.data }); });
      opened.addEventListener("close", (event: CloseEvent) => {
        clearInterval(pinger);
        if (socket !== opened) return;
        socket = undefined;
        step({ t: "closed", code: event.code, reason: event.reason });
      }, { once: true });
      step({ t: "opened" });
    }
    if (stopping) return;
    const started = startRegistration(host);
    registration = started.state;
    cancelled.signal.addEventListener("abort", () => step({ t: "stop" }), { once: true });
    for (const effect of started.effects) carryOut(effect, socket);
  }

  /** Answer one dialer the relay announced: the same as an inbound connection, through the relay. */
  async function answerAtRelay(base: string, id: string) {
    relayAnswers.set(id, undefined);
    let socket: WebSocket;
    try { socket = await openSocket(relayEndpoint(base, "answer", identity.publicKey, id), cancelled.signal); }
    catch { relayAnswers.delete(id); return; }
    if (stopping) { closeSocket(socket, "The daemon is stopping"); relayAnswers.delete(id); return; }
    const channel = SecureChannel.responder(clientWire(socket), identity, { authorize, secretFor });
    relayAnswers.set(id, channel);
    attachClientSocket(socket, channel);
    const address = `relay ${new URL(base).host}`;
    channel.ready.then((established) => { relayAnswers.delete(id); accept(channel, established, address, "relay"); },
      (error) => { relayAnswers.delete(id); refused(`Refused ${address}: ${printable(errorMessage(error))}`); });
  }

  /**
   * Take an authenticated, encrypted inbound channel: offer the device what it was
   * granted here, or a pairing proposal for an invite. Returns undefined when the
   * channel was not taken, such as the losing side of two daemons dialing at once.
   */
  function accept(channel: SecureChannel, { peer, invite, mode }: Established, address: string, via: "direct" | "relay" = "direct"): Session | undefined {
    if (stopping) { channel.close("The daemon is stopping."); return undefined; }
    try {
      // Both daemons dialed at once, or the other one lost the link this side holds (link-rules.ts).
      const held = linkTo(peer);
      const outcome = onInbound(held, !invite && mode === "daemon", keepsOwnOutbound(peer), Date.now());
      if (outcome === "refuse") {
        channel.close("Duplicate link");
        return undefined;
      }
      const offered = invite ? { local: pairingFor(invite.id, peer), name: undefined, grants: undefined } : offerTo(peer, mode === "daemon");
      if (outcome === "replace") remove(held!);
      const remote = rpcSession<ShellApi>(channel, offered.local);
      const session = register({ close: (reason) => channel.close(reason), outbound: false, via }, offered.local, remote, address,
        offered.name ? { name: offered.name, publicKey: peer, daemon: mode === "daemon" } : undefined);
      session.grants = offered.grants;
      if (invite) session.pairing = true;
      void channel.done.then(() => disconnected(session));
      return session;
    } catch (error) {
      // For example, the device was unpaired while it authenticated. Nothing was exported.
      announce(`Refused ${address}: ${errorMessage(error)}`);
      channel.close("Not accepted", 1011);
      return undefined;
    }
  }

  try {
    // After the signal handlers, so a signal during startup still stops cleanly.
    await secureReady();
    if (stopping) return;
    if (daemon) {
      if (tooLong) announce(tooLong);
      // Before any link, so that a reconnecting cns shell finds its session.
      if (holders) {
        await holders.adopt();
        if (holders.names.length) announce(`Adopted named sessions: ${holders.names.map(strictlyPrintable).join(", ")}.`);
        if (stopping) return;
      }
      // A port in use or one this user may not take: say so, and what to run next.
      listener = bound(daemon, () => serve<SocketData>({
        hostname: daemon.bind, port: daemon.port,
        fetch(request, server) {
          if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
          if (server.pendingWebSockets >= MAX_PEERS) return new Response("Peer limit reached", { status: 503 });
          const remote = server.requestIP(request);
          const address = remote
            ? `${remote.family === "IPv6" ? `[${remote.address}]` : remote.address}:${remote.port}`
            : "unknown address";
          if (server.upgrade(request, { data: { address } })) return;
          return new Response("WebSocket upgrade required", { status: 400 });
        },
        websocket: {
          idleTimeout: 0, maxPayloadLength: 8 * 1024 * 1024,
          open(ws) {
            if (stopping) { ws.close(); return; }
            // Nothing is exported until the device has authenticated, been authorized and the link is encrypted.
            const channel = SecureChannel.responder(serverWire(ws), identity, { authorize, secretFor });
            ws.data.channel = channel;
            channel.ready.then((established) => {
              const session = accept(channel, established, ws.data.address);
              if (session) ws.data.session = session;
            }, (error) => refused(`Refused ${ws.data.address}: ${printable(errorMessage(error))}`));
          },
          message(ws, message) {
            ws.data.channel?.deliver(typeof message === "string" ? message : new Uint8Array(message));
          },
          close(ws, _code, reason) {
            ws.data.channel?.closed(reason ? `The other side closed the connection: ${reason}` : "The connection closed.");
            if (ws.data.session) disconnected(ws.data.session);
          },
        },
      }));
      announce(`Paired devices only. This device is ${identity.fingerprint}; each paired device gets what you granted it, over an encrypted link.`);
      // A supervised daemon that crashed, or ran before a reboot, left its state behind. Its control
      // endpoint does not answer, and after a reboot its pid may belong to another process, so only
      // the endpoint decides. A state file whose daemon answers is kept, and this start then fails.
      if (daemon.service) await removeStaleState(daemon.state, { ignorePid: true });
      controlCleanup = await serveControl(controller, () => { void stop(); }, daemon.state,
        { url: daemon.url, bind: daemon.bind, port: daemon.port, remote: daemon.remote, service: daemon.service, keepsSessions: keeps, ...relay ? { relay } : {} }, pairing);
      if (stopping) { await Promise.all([controlCleanup(), listener.stop(true)]); return; }
      process.send?.({ ready: true });
      if (process.connected) process.disconnect?.();
      const label = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux";
      announce(`${label} listening at ${daemon.url}.`);
      if (relay) registerAtRelay(relay);
      for (const entry of listPeers()) dial(entry.name);
    } else if (command) {
      const { expect } = command;
      // The local daemon's standing link to the device, lent for this command, or else one
      // encrypted connection at the first of its addresses, or the relay, that answers as it.
      let link: DeviceLink;
      try {
        link = await openDeviceLink(expect, identity, cancelled.signal);
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new Error(`Cannot connect to ${expect.name}: ${errorMessage(error)}`, { cause: error });
      }
      // One command's connection only uses the other device, offering it a RefusingShell. The other
      // device uses this one through the daemons' standing link, whose grants revocation can reach.
      const local = new RefusingShell();
      const session = register({ close: (reason) => link.close(reason), outbound: true, via: link.via }, local, link.remote, link.address, { name: expect.name, publicKey: expect.publicKey, daemon: false });
      void link.done.then(() => disconnected(session));
    }
    await done;
  } catch (error) {
    await stop(authExitCode(error));
    throw error;
  }
}
