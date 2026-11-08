import os from "node:os";
import type { RpcStub } from "capnweb";
import { attachClientSocket, clientWire, connectFirst, rpcSession, secureReady, SecureChannel, serverWire, type Established } from "../secure.js";
import { challengeBytes, dialAddresses, isRelayAddress, relayEndpoint } from "../relay-hub.js";
import { builtInRelay } from "../relay-config.js";
import { serve, type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import { PtyRegistry, ShellApi, type ShellInfo } from "../shell.js";
import type { ConnectionController } from "../console.js";
import { errorMessage, printable } from "../errors.js";
import type { DaemonConfig, PeerConfig } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import { closeSocket, forkShell, openSocket } from "../connect.js";
import { AuthError, type Refusal } from "../auth.js";
import { ensureIdentity, fingerprint, type Identity, type PublicKey } from "../identity.js";
import { GrantedShell, type GrantHolder } from "../granted-shell.js";
import { createInvite, decisionSchema, PairingApi, suggestedName, type Decision, type Proposal } from "../pairing.js";
import { advertisedSchema, describeGrants, explainDenial, findPairedPeer, getPeer, grantsSchema, learnAddresses, listPeers, savePairedPeer, updatePairedPeer } from "../peers.js";
import { listeningAddresses } from "../addresses.js";
import { serveControl, type PairingController } from "./daemon-server.js";
import { removeStaleState } from "./daemon.js";
import { runOneShot } from "./one-shot.js";
import { infoSchema } from "./connect-device.js";

/** CLI exit statuses for failures, as docs/paired-peers.md lists them: 3 unpaired or changed device, 4 permission denied, else 1. */
export function authExitCode(error: unknown): number {
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) return 3;
  if (/^Permission denied/.test(errorMessage(error))) return 4;
  return 1;
}

export { commandExitCode } from "./one-shot.js";

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
}
interface PendingInvite {
  secret: Uint8Array;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  proposal?: { peer: PublicKey; proposal: Proposal };
  waiters: Array<{ resolve: (value: { peer: PublicKey; fingerprint: string; proposal: Proposal }) => void; reject: (error: Error) => void }>;
  decision: ReturnType<typeof Promise.withResolvers<Decision>>;
}
/** The most recent attempt is tried first, then every saved address in turn. */
const REDIAL_MIN_MS = 1000;
const REDIAL_MAX_MS = 30_000;
/** How long the person on the inviting device has to decide once a proposal arrives. */
const DECISION_MS = 10 * 60 * 1000;
/** A daemon registered at a relay pings it this often, and re-registers if it hears nothing for three times as long. */
const RELAY_PING_MS = 30_000;
/** Dialers the relay announced that the daemon is answering at once; more are ignored. */
const MAX_RELAY_ANSWERS = 32;
/** A registration that stayed up this long resets the backoff, so a relay that keeps dropping it is not hammered. */
const RELAY_STABLE_MS = 30_000;
/**
 * Daemon links made within this long of each other count as both devices dialing at
 * once, settled by the key rule. A daemon dials only when it has no link, so a dial
 * that arrives later means the link this side holds is dead on the other.
 */
const DIAL_RACE_MS = 5000;

/**
 * Run the paired daemon, or one command on a paired device: the same link machinery, the
 * daemon listening, registered at the relay and linked to every paired device, a command
 * holding one encrypted connection to the device it names.
 */
export async function startPeer(config: PeerConfig | DaemonConfig): Promise<void> {
  const daemon = config.role === "daemon" ? config : undefined;
  const command = config.role !== "daemon" ? config : undefined;
  const sessions = new Map<string, Session>();
  // Named PTY sessions outlive the connection that started them, but not this process.
  const ptys = new PtyRegistry();
  let nextId = 1;
  let listener: Server<SocketData> | undefined;
  let controlCleanup: (() => Promise<void>) | undefined;
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const oneShot = !daemon;
  const cancelled = new AbortController();
  // Machine-readable command output must contain only the remote command's streams.
  const announce = (message: string) => { if (daemon) console.log(message); };
  const identity: Identity = ensureIdentity().identity;
  // The relay built into cns: the daemon registers there, and paired devices are dialed there after their direct addresses.
  const relay = builtInRelay();
  /** What this device lets an authenticated paired device do here: exactly its saved incoming grants. */
  function offerTo(publicKey: PublicKey): { local: GrantedShell; name: string; grants: GrantHolder } {
    const entry = findPairedPeer(publicKey);
    if (!entry) throw new AuthError("not-paired", "Not paired with this device.");
    const grants: GrantHolder = { current: entry.grants.incoming };
    const owner = fingerprint(publicKey);
    return { local: new GrantedShell(new ShellApi(ptys, { owner }), grants, entry.name, owner, advertisedToPeers), name: entry.name, grants };
  }
  const invites = new Map<string, PendingInvite>();
  const links = new Map<string, { stop: () => void; publicKey: PublicKey }>();
  /** The standing daemon link to a paired device, if any, answered yet or not; one command's connection does not count. */
  const linkTo = (publicKey: PublicKey) => [...sessions.values()].find((session) => session.peer?.publicKey === publicKey && session.peer.daemon);
  /** Drop every link and dial loop for a device: its commands end and its handles are revoked. */
  function forget(publicKey: PublicKey) {
    for (const session of [...sessions.values()]) if (session.peer?.publicKey === publicKey) remove(session);
    for (const link of [...links.values()]) if (link.publicKey === publicKey) link.stop();
  }
  /** When both devices dialed each other, the one with the smaller key keeps its outbound link. */
  const keepsOutbound = (publicKey: PublicKey) => identity.publicKey < publicKey;

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
    for (const invite of invites.values()) expireInvite(invite, "The daemon stopped.");
    for (const session of sessions.values()) remove(session);
    ptys[Symbol.dispose]();
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
    const session: Session = { id, address, close: connection.close, outbound: connection.outbound, via: connection.via ?? "direct", dialed: connection.dialed, local, remote, peer, since: Date.now(), timer: setTimeout(() => {
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
        announce(`Connected to ${describe(session)} [${session.info.platform} / ${session.info.shell}].`);
        if (session.peer?.daemon) void learnFromPeer(session);
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
   * Ask a paired device on a standing link where it can be reached now and what it lets
   * this device do there, and save both in its record: a device that moved networks or
   * changed relays is then dialed where it is rather than where it was, and the access
   * `cns peers` shows follows grants changed on that device since pairing. A question that
   * fails leaves that part of the record as saved.
   */
  async function learnFromPeer(session: Session) {
    const peer = session.peer!;
    const remote = session.remote as unknown as RpcStub<{ addresses(): string[]; granted(): string[] }>;
    const ask = async <T>(call: () => Promise<unknown>, schema: z.ZodType<T>): Promise<T | undefined> => {
      try {
        const parsed = schema.safeParse(await call());
        return parsed.success ? parsed.data : undefined;
      } catch { return undefined; }
    };
    const [advertised, granted] = await Promise.all([ask(() => remote.addresses(), advertisedSchema), ask(() => remote.granted(), grantsSchema)]);
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
      if (!movedTo && !regranted) return;
      updatePairedPeer(entry.name, (current) => current.publicKey === peer.publicKey ? { ...current, addresses, grants: { ...current.grants, outgoing } } : current);
      if (movedTo) announce(`${entry.name} is reachable at ${addresses.join(", ")}; saved.`);
      if (regranted) announce(`${entry.name} lets this device use: ${describeGrants(outgoing)}; saved.`);
    } catch (error) {
      announce(`${peer.name}: could not update its saved record: ${errorMessage(error)}`);
    }
  }

  function expireInvite(invite: PendingInvite, why: string) {
    clearTimeout(invite.timer);
    for (const [id, pending] of invites) if (pending === invite) invites.delete(id);
    const error = new Error(why);
    for (const waiter of invite.waiters) waiter.reject(error);
    invite.waiters = [];
    invite.decision.reject(error);
    invite.decision.promise.catch(() => {});
  }
  /** The responder's view of who may connect: paired devices, and devices that hold a live invite. */
  function authorize(peer: PublicKey, invite?: { id: string }): Refusal | undefined {
    if (invite) return undefined;
    if (findPairedPeer(peer)) return undefined;
    return { code: "not-paired", reason: "Not paired with this device. Run cns pair on it and paste the invite here with cns pair <invite>." };
  }
  function secretFor(id: string): Uint8Array | undefined {
    const invite = invites.get(id);
    return invite && invite.expiresAt > Date.now() && !invite.proposal ? invite.secret : undefined;
  }
  /** What an invited device gets instead of a shell: one chance to propose a pairing. */
  function pairingFor(inviteId: string, peer: PublicKey): PairingApi {
    // A device that leaves before the decision would never save its side: end the invite instead.
    const left = () => {
      const invite = invites.get(inviteId);
      if (invite?.proposal?.peer === peer) expireInvite(invite, "The other device left before the pairing was decided.");
    };
    return new PairingApi(async (proposal) => {
      const invite = invites.get(inviteId);
      if (!invite || invite.proposal) throw new Error("This invite is no longer open.");
      invite.proposal = { peer, proposal };
      clearTimeout(invite.timer);
      invite.timer = setTimeout(() => expireInvite(invite, "Nobody answered the pairing proposal in time."), DECISION_MS);
      for (const waiter of invite.waiters) waiter.resolve({ peer, fingerprint: fingerprint(peer), proposal });
      invite.waiters = [];
      announce(`Pairing proposal from ${proposal.name} (${fingerprint(peer)}); waiting for cns pair to decide.`);
      // The alias chosen here stays here.
      const { accept, granted, reason } = await invite.decision.promise;
      return { accept, ...granted ? { granted } : {}, ...reason ? { reason } : {} };
    }, left);
  }
  const pairing: PairingController | undefined = daemon ? {
    identity: () => ({ publicKey: identity.publicKey, fingerprint: identity.fingerprint }),
    addresses: () => advertised(),
    relayRegistered: () => relay ? relayRegistered : undefined,
    async invite(ttlMs) {
      const invite = createInvite(identity.publicKey, advertised(), ttlMs, suggestedName(os.hostname()));
      const pending: PendingInvite = {
        secret: invite.secret, expiresAt: invite.expiresAt, waiters: [], decision: Promise.withResolvers<Decision>(),
        timer: setTimeout(() => expireInvite(pending, "The invite expired before another device used it."), ttlMs),
      };
      pending.timer.unref?.();
      invites.set(invite.id, pending);
      return { id: invite.id, text: invite.text, expiresAt: invite.expiresAt };
    },
    awaitProposal(id) {
      const invite = invites.get(id);
      if (!invite) return Promise.reject(new Error("Unknown or expired invite."));
      if (invite.proposal) return Promise.resolve({ ...invite.proposal, fingerprint: fingerprint(invite.proposal.peer) });
      return new Promise((resolve, reject) => invite.waiters.push({ resolve, reject }));
    },
    async decide(id, decision) {
      const invite = invites.get(id);
      if (!invite?.proposal) throw new Error("The other device left, or the invite expired; nothing was saved.");
      const parsed = decisionSchema.parse(decision);
      const { peer, proposal } = invite.proposal;
      let result: Decision = { accept: false, reason: parsed.reason ?? "The other device declined." };
      let failure: unknown;
      if (parsed.accept) {
        const name = parsed.name ?? proposal.name;
        const granted = (parsed.granted ?? []).filter((permission) => proposal.requests.includes(permission));
        try {
          savePairedPeer(name, { publicKey: peer, addresses: proposal.addresses ?? [], pairedAt: new Date().toISOString(), grants: { incoming: granted, outgoing: proposal.offers } });
          result = { accept: true, name, granted };
          announce(`Paired with ${name} (${fingerprint(peer)}).`);
        } catch (error) {
          // Answer the waiting device either way, so neither side is left with half a pairing.
          failure = error;
          result = { accept: false, reason: "The other device could not save the pairing." };
        }
      }
      clearTimeout(invite.timer);
      invites.delete(id);
      invite.decision.resolve(result);
      if (failure) throw failure;
      if (result.accept && result.name) void dial(result.name);
      return result;
    },
    dial: async (name) => { dial(name); },
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
    cancel(id) {
      const invite = invites.get(id);
      if (invite) expireInvite(invite, "The inviting device stopped waiting.");
    },
  } : undefined;

  /** Keep a link to a paired device, redialing its saved addresses, and this daemon's relay, with backoff while this daemon runs. */
  function dial(name: string) {
    if (links.has(name) || stopping) return;
    const entry = getPeer(name);
    if (!entry || !dialAddresses(entry, relay).length) return;
    const expectedKey = entry.publicKey;
    let attempt = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (stopped || stopping) return;
      timer = setTimeout(() => void connect(), Math.min(REDIAL_MAX_MS, REDIAL_MIN_MS * 2 ** Math.min(attempt, 5)));
      timer.unref?.();
      attempt++;
    };
    const handle = { stop: () => { stopped = true; clearTimeout(timer); if (links.get(name) === handle) links.delete(name); }, publicKey: expectedKey };
    const stop = handle.stop;
    // Any failure, such as an unreadable peer file, is reported and retried; the loop never dies quietly.
    async function connect() {
      if (stopped || stopping) return;
      try { await attempt_(); }
      catch (error) {
        announce(`${name}: ${errorMessage(error)}`);
        schedule();
      }
    }
    async function attempt_() {
      const current = getPeer(name);
      const addresses = current ? dialAddresses(current, relay) : [];
      if (!current || current.publicKey !== expectedKey || !addresses.length) return stop();
      // Skip while an inbound link from the same device is already up.
      if (linkTo(current.publicKey)) return schedule();
      let channel: SecureChannel;
      let url: string;
      try {
        ({ channel, url } = await connectFirst(addresses, identity, { expect: current.publicKey, mode: "daemon", signal: cancelled.signal }));
      } catch (error) {
        if (error instanceof AuthError && (error.code === "identity-changed" || error.code === "not-paired")) {
          announce(`${name}: ${error.message}`);
          return stop();
        }
        return schedule();
      }
      if (stopped || stopping) { channel.close(); return; }
      // Both devices dialed at once: exactly one link survives, chosen the same way on both sides.
      const inbound = linkTo(current.publicKey);
      if (inbound) {
        if (keepsOutbound(current.publicKey)) remove(inbound);
        else { channel.close("Duplicate link"); return schedule(); }
      }
      attempt = 0;
      const grants: GrantHolder = { current: current.grants.incoming };
      const owner = fingerprint(current.publicKey);
      const local = new GrantedShell(new ShellApi(ptys, { owner }), grants, name, owner, advertisedToPeers);
      const remote = rpcSession<ShellApi>(channel, local);
      const session = register({ close: (reason) => channel.close(reason), outbound: true, via: isRelayAddress(url) ? "relay" : "direct", dialed: url }, local, remote, new URL(url).host, { name, publicKey: current.publicKey, daemon: true });
      session.grants = grants;
      void channel.done.then(() => { disconnected(session); schedule(); });
    }
    links.set(name, handle);
    void connect();
  }

  let relayRegistered = false;
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
   * relay connection drops or stops answering pings.
   */
  function registerAtRelay(base: string) {
    let attempt = 0;
    const register_ = async () => {
      if (stopping) return;
      const url = relayEndpoint(base, "accept", identity.publicKey);
      let socket: WebSocket;
      try { socket = await openSocket(url, cancelled.signal); }
      catch { return retry(); }
      const host = new URL(url).host;
      let lastHeard = Date.now();
      let readyAt = 0;
      const pinger = setInterval(() => {
        if (Date.now() - lastHeard > 3 * RELAY_PING_MS) { closeSocket(socket, "The relay stopped answering"); return; }
        try { socket.send(JSON.stringify({ t: "ping" })); } catch { /* Closing follows. */ }
      }, RELAY_PING_MS);
      pinger.unref?.();
      socket.addEventListener("message", (event: MessageEvent) => {
        lastHeard = Date.now();
        if (typeof event.data !== "string") return;
        let message: { t?: string; nonce?: string; id?: string };
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.t === "challenge" && typeof message.nonce === "string" && /^[A-Za-z0-9_-]{22}$/.test(message.nonce)) {
          void challengeBytes(host, identity.publicKey, message.nonce).then((bytes) => {
            socket.send(JSON.stringify({ t: "proof", sig: Buffer.from(identity.sign(bytes)).toString("base64url") }));
          }).catch(() => closeSocket(socket, "Invalid challenge"));
        } else if (message.t === "challenge") {
          closeSocket(socket, "Invalid challenge");
        } else if (message.t === "ready" && !readyAt) {
          readyAt = Date.now();
          relayRegistered = true;
          announce(`Registered at the relay ${host}; devices that cannot reach this one directly can reach it there.`);
        } else if (message.t === "incoming" && typeof message.id === "string" && /^[A-Za-z0-9_-]{22}$/.test(message.id) && readyAt) {
          if (relayAnswers.has(message.id)) return;
          if (relayAnswers.size >= MAX_RELAY_ANSWERS) { refused(`Ignored a dialer at the relay ${host}: ${MAX_RELAY_ANSWERS} are already being answered.`); return; }
          void answerAtRelay(base, message.id);
        }
      });
      const onStop = () => closeSocket(socket, "The daemon is stopping");
      cancelled.signal.addEventListener("abort", onStop, { once: true });
      socket.addEventListener("close", (event: CloseEvent) => {
        clearInterval(pinger);
        cancelled.signal.removeEventListener("abort", onStop);
        if (relayRegistered && !stopping) announce(`Left the relay ${host}${event.reason ? `: ${printable(event.reason)}` : ""}; registering again.`);
        relayRegistered = false;
        if (readyAt && Date.now() - readyAt >= RELAY_STABLE_MS) attempt = 0;
        retry();
      }, { once: true });
    };
    const retry = () => {
      if (stopping) return;
      const timer = setTimeout(() => void register_(), Math.min(REDIAL_MAX_MS, REDIAL_MIN_MS * 2 ** Math.min(attempt++, 5)));
      timer.unref?.();
    };
    void register_();
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
      const existing = !invite && mode === "daemon" ? linkTo(peer) : undefined;
      // Both daemons dialed at once: the smaller key keeps the link it dialed. A link this
      // side dialed longer ago is dead on the other side, which only dials without one.
      if (existing && existing.outbound && keepsOutbound(peer) && Date.now() - existing.since < DIAL_RACE_MS) {
        channel.close("Duplicate link");
        return undefined;
      }
      const offered = invite ? { local: pairingFor(invite.id, peer), name: undefined, grants: undefined } : offerTo(peer);
      if (existing) remove(existing);
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
      announce(`Paired devices only. This device is ${identity.fingerprint}; each paired device gets what you granted it, over an encrypted link.`);
      listener = serve<SocketData>({
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
      });
      // A supervised daemon that crashed, or ran before a reboot, left its state behind. Its control
      // endpoint does not answer, and after a reboot its pid may belong to another process, so only
      // the endpoint decides. A state file whose daemon answers is kept, and this start then fails.
      if (daemon.service) await removeStaleState(daemon.state, { ignorePid: true });
      controlCleanup = await serveControl(controller, () => { void stop(); }, daemon.state,
        { url: daemon.url, bind: daemon.bind, port: daemon.port, remote: daemon.remote, ...relay ? { relay } : {} }, pairing);
      if (stopping) { await Promise.all([controlCleanup(), listener.stop(true)]); return; }
      process.send?.({ ready: true });
      if (process.connected) process.disconnect?.();
      const label = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux";
      announce(`${label} listening at ${daemon.url}.`);
      if (relay) registerAtRelay(relay);
      for (const entry of listPeers()) dial(entry.name);
    } else if (command) {
      const { expect } = command;
      // One encrypted connection to the paired device, at the first of its addresses, or the relay, that answers as it.
      let channel: SecureChannel;
      let url: string;
      try {
        ({ channel, url } = await connectFirst(dialAddresses(expect, relay), identity, { expect: expect.publicKey, signal: cancelled.signal }));
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new Error(`Cannot connect to ${expect.name}: ${errorMessage(error)}`, { cause: error });
      }
      // One command's connection only uses the other device. The other device uses this one through
      // the daemons' standing link, whose grants revocation can reach; this process it could not.
      const local = new RefusingShell();
      const remote = rpcSession<ShellApi>(channel, local);
      const session = register({ close: (reason) => channel.close(reason), outbound: true, via: isRelayAddress(url) ? "relay" : "direct" }, local, remote, new URL(url).host, { name: expect.name, publicKey: expect.publicKey, daemon: false });
      void channel.done.then(() => disconnected(session));
    }
    await done;
  } catch (error) {
    await stop(authExitCode(error));
    throw error;
  }
}
