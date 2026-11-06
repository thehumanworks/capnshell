import os from "node:os";
import { newBunWebSocketRpcSession, newWebSocketRpcSession, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { serve, type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import { PtyRegistry, ShellApi, type ShellInfo } from "../shell.js";
import { openConsole, type PeerController } from "../console.js";
import { errorMessage } from "../errors.js";
import type { PeerConfig } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import { closeSocket, forkShell, openSocket } from "../connect.js";
import { AuthError, type Refusal } from "../auth.js";
import { ensureIdentity, fingerprint, type Identity, type PublicKey } from "../identity.js";
import { GrantedShell } from "../granted-shell.js";
import { authenticateClient, ServerHandshake } from "../link.js";
import { createInvite, decisionSchema, PairingApi, suggestedName, type Decision, type Proposal } from "../pairing.js";
import { findPairedPeer, getPeer, listPeers, savePairedPeer } from "../peers.js";
import { listeningAddresses } from "../addresses.js";
import { serveControl, type PairingController } from "./daemon-server.js";
import { runOneShot } from "./one-shot.js";

/** CLI exit statuses for failures, as docs/paired-peers.md lists them: 3 unpaired or changed device, 4 permission denied, else 1. */
export function authExitCode(error: unknown): number {
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) return 3;
  if (/^Permission denied/.test(errorMessage(error))) return 4;
  return 1;
}

export { commandExitCode } from "./one-shot.js";

// Bound unauthenticated connections, including peers that never complete the RPC handshake.
export const MAX_PEERS = 32;
const HANDSHAKE_MS = 5000;
const infoSchema = z.object({
  platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
  name: z.string().max(128), shell: z.enum(["PowerShell", "Bash"]),
  hostname: z.string().max(256), cwd: z.string().max(32768), pid: z.int().positive(),
});
interface SocketData { address: string; transport?: BunWebSocketTransport<SocketData>; session?: Session; handshake?: ServerHandshake<SocketData> }
interface Session {
  id: string;
  address: string;
  socket: WebSocket | ServerWebSocket<SocketData>;
  local: { [Symbol.dispose](): void };
  remote: RpcStub<ShellApi>;
  timer: ReturnType<typeof setTimeout>;
  info?: ShellInfo;
  /** The authenticated paired device on the other end; `daemon` marks a standing link between daemons. */
  peer?: { name: string; publicKey: PublicKey; daemon: boolean };
  /** A device that arrived with an invite and may only propose a pairing; not a peer to select. */
  pairing?: boolean;
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

export async function startPeer(config: PeerConfig): Promise<void> {
  const daemonChild = process.env.CNS_DAEMON_CHILD === "1";
  delete process.env.CNS_DAEMON_CHILD;
  const sessions = new Map<string, Session>();
  // Named PTY sessions outlive the connection that started them, but not this process.
  const ptys = new PtyRegistry();
  let nextId = 1;
  let listener: Server<SocketData> | undefined;
  let input: ReturnType<typeof openConsole> | undefined;
  let controlCleanup: (() => Promise<void>) | undefined;
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const oneShot = config.role !== "listen" && config.role !== "connect";
  const cancelled = new AbortController();
  const announce = (message: string) => { if (!oneShot) console.log(message); };
  // A paired listener, or a connection to a paired device, needs this device's identity.
  const identity: Identity | undefined = config.paired || config.expect ? ensureIdentity().identity : undefined;
  // What this process offers each peer: its shell, or with --one-way only the handshake.
  const offer = () => config.oneWay ? new RefusingShell() : new ShellApi(ptys);
  /** What this device lets an authenticated paired device do here: exactly its saved incoming grants. */
  function offerTo(publicKey: PublicKey): { local: GrantedShell; name: string } {
    const entry = findPairedPeer(publicKey);
    if (!entry) throw new AuthError("not-paired", "Not paired with this device.");
    return { local: new GrantedShell(new ShellApi(ptys), entry.grants.incoming, entry.name), name: entry.name };
  }
  const invites = new Map<string, PendingInvite>();
  const links = new Map<string, { stop: () => void }>();
  /** The standing daemon link to a paired device, if any; one command's connection does not count. */
  const linkTo = (publicKey: PublicKey) => [...sessions.values()].find((session) => session.peer?.publicKey === publicKey && session.peer.daemon && session.info);
  /** When both devices dialed each other, the one with the smaller key keeps its outbound link. */
  const keepsOutbound = (publicKey: PublicKey) => identity!.publicKey < publicKey;

  function describe(session: Session): string {
    const who = session.peer ? `${session.peer.name} (paired)` : session.info?.hostname;
    const endpoint = who ? `${who} (${session.address})` : session.address;
    return config.noRepl ? endpoint : `${session.id}: ${endpoint}`;
  }

  function remove(session: Session) {
    if (!sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    session.local[Symbol.dispose]();
    session.remote[Symbol.dispose]();
    session.socket.close(1000, "Shell session ended");
    const timer = setTimeout(() => session.socket.terminate(), 750);
    timer.unref();
    if (!stopping) {
      announce(`Disconnected from ${describe(session)}.`);
      void input?.refresh();
    }
  }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    cancelled.abort();
    input?.close();
    for (const link of links.values()) link.stop();
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
  const controller: PeerController = {
    async peers() {
      return [...sessions.values()].flatMap(({ id, info, peer, pairing }) => info && !pairing
        ? [{ id, info: { ...info }, ...peer ? { peer: { name: peer.name, fingerprint: fingerprint(peer.publicKey) } } : {} }] : []);
    },
    async info(id) { return { ...requireSession(id).info! }; },
    async run(id, command, options, signal) {
      // Capture the session once; its ID is never reused, even after disconnect.
      const { remote } = requireSession(id);
      if (!signal) return await plain(remote.run(command, options));
      signal.throwIfAborted();
      const shell = await forkShell(remote);
      if (!shell) return await plain(remote.run(command, options));
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
    async openPty(id, sink, options) {
      return await requireSession(id).remote.openPty(sink, options);
    },
    async ptySessions(id) { return await plain(requireSession(id).remote.ptySessions()); },
    async startPtySession(id, name, options) {
      using session = await requireSession(id).remote.startPtySession(name, options);
      return await plain(session.info());
    },
    async ptySession(id, name) {
      return await requireSession(id).remote.ptySession(name) as unknown as RemoteNamedPty;
    },
    async shell(id) {
      const shell = await forkShell(requireSession(id).remote);
      if (!shell) throw new Error(`Peer ${id} runs a cns without fork; update it to use its shell this way.`);
      return shell;
    },
  };

  function disconnected(session: Session, code = oneShot || !session.info ? 1 : 0) {
    if (!sessions.has(session.id)) return;
    remove(session);
    if (config.mode === "connect") void stop(code);
  }

  function register(socket: Session["socket"], local: Session["local"], remote: RpcStub<ShellApi>, address: string, peer?: Session["peer"]): Session {
    const id = `p${nextId++}`;
    const session: Session = { id, address, socket, local, remote, peer, timer: setTimeout(() => {
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
        if (config.mode === "connect") {
          if (oneShot) await stop(await runOneShot(config, controller, id, cancelled.signal));
          else if (!config.noRepl) input = openConsole(controller, () => { void stop(); });
        } else void input?.refresh();
      } catch (error) {
        if (!stopping && sessions.has(id)) {
          console.error(errorMessage(error));
          disconnected(session, authExitCode(error));
        }
      }
    })();
    return session;
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
    });
  }
  const pairing: PairingController | undefined = identity && config.mode === "listen" ? {
    identity: () => ({ publicKey: identity.publicKey, fingerprint: identity.fingerprint }),
    addresses: () => listeningAddresses(config.bind, config.port),
    async invite(ttlMs) {
      const invite = createInvite(identity.publicKey, listeningAddresses(config.bind, config.port), ttlMs, suggestedName(os.hostname()));
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
      if (!invite?.proposal) throw new Error("No proposal to decide on for this invite.");
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
      // Grants and addresses are read when a link is made, so remake the device's links.
      for (const session of [...sessions.values()]) if (session.peer?.name === name) remove(session);
      links.get(name)?.stop();
      dial(name);
    },
    cancel(id) {
      const invite = invites.get(id);
      if (invite) expireInvite(invite, "The inviting device stopped waiting.");
    },
  } : undefined;

  /** Keep a link to a paired device, redialing its saved addresses with backoff while this daemon runs. */
  function dial(name: string) {
    if (!identity || links.has(name) || stopping) return;
    const entry = getPeer(name);
    if (entry?.kind !== "paired" || !entry.addresses.length) return;
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
    const stop = () => { stopped = true; clearTimeout(timer); links.delete(name); };
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
      if (current?.kind !== "paired" || current.publicKey !== expectedKey || !current.addresses.length) return stop();
      // Skip while an inbound link from the same device is already up.
      if (linkTo(current.publicKey)) return schedule();
      const url = current.addresses[attempt % current.addresses.length]!;
      let socket: WebSocket;
      try {
        socket = await openSocket(url, cancelled.signal);
        await authenticateClient(socket, identity!, { expect: current.publicKey, mode: "daemon" });
      } catch (error) {
        if (error instanceof AuthError && (error.code === "identity-changed" || error.code === "not-paired")) {
          announce(`${name}: ${error.message}`);
          return stop();
        }
        return schedule();
      }
      if (stopped || stopping) { closeSocket(socket); return; }
      // Both devices dialed at once: exactly one link survives, chosen the same way on both sides.
      const inbound = linkTo(current.publicKey);
      if (inbound) {
        if (keepsOutbound(current.publicKey)) remove(inbound);
        else { closeSocket(socket, "Duplicate link"); return schedule(); }
      }
      attempt = 0;
      const local = new GrantedShell(new ShellApi(ptys), current.grants.incoming, name);
      const remote = newWebSocketRpcSession<ShellApi>(socket, local);
      const session = register(socket, local, remote, new URL(url).host, { name, publicKey: current.publicKey, daemon: true });
      socket.addEventListener("close", () => { disconnected(session); schedule(); });
      socket.addEventListener("error", () => { disconnected(session); });
    }
    links.set(name, { stop });
    void connect();
  }

  try {
    // Machine-readable run output must contain only the remote command's streams.
    announce(identity && config.mode === "listen"
      ? `Paired devices only. This device is ${identity.fingerprint}; each paired device gets what you granted it. The link is authenticated, not encrypted: trusted LAN/VPN only.`
      : config.expect
        ? `Connecting to ${config.expect.name} as ${identity!.fingerprint}.`
        : config.oneWay
          ? `No authentication. One-way: peers cannot run commands or read files here${config.remote ? "; anyone who can reach this listener can connect" : ""}.`
          : config.remote
            ? "WARNING: unauthenticated remote shell access. Trusted LAN/VPN only; both peers can execute commands as your user."
            : "No authentication. Local shell access only.");
    if (config.mode === "listen") {
      listener = serve<SocketData>({
        hostname: config.bind, port: config.port,
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
            if (!identity) {
              const local = offer();
              const { stub, transport } = newBunWebSocketRpcSession<ShellApi, SocketData>(ws, local);
              ws.data.transport = transport;
              ws.data.session = register(ws, local, stub, ws.data.address);
              return;
            }
            // Nothing is exported until the device has authenticated and been authorized.
            const handshake = new ServerHandshake(ws, identity, { authorize, secretFor });
            ws.data.handshake = handshake;
            handshake.done.then(({ peer, invite, mode }) => {
              if (stopping) { ws.close(); return; }
              try {
                if (!invite && mode === "daemon") {
                  const existing = linkTo(peer);
                  if (existing) {
                    if (existing.socket instanceof WebSocket && keepsOutbound(peer)) { ws.close(1000, "Duplicate link"); return; }
                    remove(existing);
                  }
                }
                const offered = invite ? { local: pairingFor(invite.id, peer), name: undefined } : offerTo(peer);
                const { stub, transport } = newBunWebSocketRpcSession<ShellApi, SocketData>(ws, offered.local);
                ws.data.transport = transport;
                ws.data.session = register(ws, offered.local, stub, ws.data.address, offered.name ? { name: offered.name, publicKey: peer, daemon: mode === "daemon" } : undefined);
                if (invite) ws.data.session.pairing = true;
              } catch (error) {
                // For example, the device was unpaired while it authenticated. Nothing was exported.
                announce(`Refused ${ws.data.address}: ${errorMessage(error)}`);
                try { ws.close(1011, "Not accepted"); } catch { /* Already closed. */ }
              }
            }, (error) => { if (!stopping) announce(`Refused ${ws.data.address}: ${errorMessage(error)}`); });
          },
          message(ws, message) {
            if (ws.data.handshake && !ws.data.handshake.settled) ws.data.handshake.message(message);
            else ws.data.transport?.dispatchMessage(message);
          },
          close(ws, code, reason) {
            ws.data.handshake?.closed();
            ws.data.transport?.dispatchClose(code, reason);
            if (ws.data.session) disconnected(ws.data.session);
          },
        },
      });
      if (daemonChild) {
        controlCleanup = await serveControl(controller, () => { void stop(); }, config.state,
          { url: config.url, bind: config.bind, port: config.port, remote: config.remote, oneWay: config.oneWay, paired: !!identity }, pairing);
        if (stopping) { await controlCleanup(); return; }
        process.send?.({ ready: true });
        if (process.connected) process.disconnect?.();
      }
      if (!config.noRepl) input = openConsole(controller, () => { void stop(); });
      const label = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux";
      announce(`${label} listening at ${config.url}.`);
      if (identity) for (const entry of listPeers()) if (entry.kind === "paired") dial(entry.name);
    } else if (config.expect) {
      // One connection to a paired device: authenticate first, then offer it what it was granted here.
      let socket: WebSocket;
      try {
        socket = await openSocket(config.url, cancelled.signal);
        await authenticateClient(socket, identity!, { expect: config.expect.publicKey });
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new Error(`Cannot connect to ${config.expect.name} at ${config.url}: ${errorMessage(error)}`, { cause: error });
      }
      const local = config.oneWay ? new RefusingShell() : offerTo(config.expect.publicKey).local;
      const remote = newWebSocketRpcSession<ShellApi>(socket, local);
      const session = register(socket, local, remote, new URL(config.url).host, { name: config.expect.name, publicKey: config.expect.publicKey, daemon: false });
      socket.addEventListener("error", () => disconnected(session, 1));
      socket.addEventListener("close", () => disconnected(session));
    } else {
      const socket = new WebSocket(config.url);
      const local = offer();
      const remote = newWebSocketRpcSession<ShellApi>(socket, local);
      const session = register(socket, local, remote, new URL(config.url).host);
      socket.addEventListener("error", () => {
        if (!stopping) console.error(`Cannot connect to ${config.url}. Check that the listener is running and reachable.`);
        disconnected(session, 1);
      });
      socket.addEventListener("close", () => disconnected(session));
    }
    await done;
  } catch (error) {
    await stop(authExitCode(error));
    throw error;
  }
}
