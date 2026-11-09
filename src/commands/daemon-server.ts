import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Bun from "bun";
import { newBunWebSocketRpcSession, RpcTarget, type BunWebSocketTransport } from "capnweb";
import type { ConnectionController, PeerController } from "../console.js";
import type { Decision, Proposal } from "../pairing.js";
import type { AccessOptions, GlobOptions, PtyOptions, PtySessionOptions, PtySink, ReadFileOptions, RunOptions, ShellApi } from "../shell.js";

/** What the daemon offers local clients for pairing and links. */
export interface PairingController {
  identity(): { publicKey: string; fingerprint: string };
  addresses(): string[];
  /** Whether the daemon is registered at its relay, when it has one. */
  relayRegistered(): boolean | undefined;
  /** A single-use invite for another device, valid for `ttlMs`. */
  invite(ttlMs: number): Promise<{ id: string; text: string; expiresAt: number }>;
  /** Resolves once a device has authenticated with the invite and proposed a pairing. */
  awaitProposal(id: string): Promise<{ peer: string; fingerprint: string; proposal: Proposal }>;
  /** Answer a proposal; accepting saves the device and starts dialing it. */
  decide(id: string, decision: Decision): Promise<Decision>;
  /** Start, or restart, dialing a saved paired device. */
  dial(name: string): Promise<void>;
  /** Apply a changed record: widened grants and new addresses apply in place; narrowed grants drop the device's links and remake them. */
  refresh(name: string): Promise<void>;
  /** Drop every link and dial loop for a device that is no longer paired. */
  forget(publicKey: string): Promise<void>;
  /** End an invite nobody will decide on, telling a waiting device so. */
  cancel(id: string): void;
}
import { daemonStatePath, removeOwnedState, stateSchema, type DaemonStatus, type ListenerInfo } from "./daemon.js";

interface SocketData { transport?: BunWebSocketTransport<SocketData> }

/**
 * A peer's file operations for a local client, such as the MCP file tools. Calls go to the
 * peer's own shell rather than a fork of it, so a paired device that grants only `files`
 * allows them; forking needs `shell`.
 */
class PeerFiles extends RpcTarget {
  #files: ReturnType<ConnectionController["files"]>;
  constructor(files: ReturnType<ConnectionController["files"]>) { super(); this.#files = files; }
  #shell() { return this.#files as unknown as ShellApi; }
  async stat(file: string) { return await this.#shell().stat(file); }
  async access(file: string, options?: AccessOptions) { return await this.#shell().access(file, options); }
  async readdir(directory: string) { return await this.#shell().readdir(directory); }
  async mkdir(directory: string) { return await this.#shell().mkdir(directory); }
  async glob(pattern: string, cwd: string, options?: GlobOptions) { return await this.#shell().glob(pattern, cwd, options); }
  async readFile(file: string, options?: ReadFileOptions) { return await this.#shell().readFile(file, options); }
  async writeFile(file: string, data: Uint8Array) { return await this.#shell().writeFile(file, data); }
}

/** Only this narrow local control surface is exported over Cap'n Web. */
export class ControlApi extends RpcTarget {
  #controller: PeerController;
  #stop: () => void;
  #listener: ListenerInfo | undefined;
  #startedAt: number;
  #pairing: PairingController | undefined;
  /** Invites made through this control connection that are not decided yet. */
  #invites = new Set<string>();
  #closed = new AbortController();
  constructor(controller: PeerController, stop: () => void, listener: ListenerInfo | undefined, startedAt: number, pairing?: PairingController) {
    super();
    this.#controller = controller;
    this.#stop = stop;
    this.#listener = listener;
    this.#startedAt = startedAt;
    this.#pairing = pairing;
  }
  /** The daemon's listener and how many peers it has, for clients that found its state file. */
  async status(): Promise<DaemonStatus> {
    const peers = (await this.#controller.peers()).length;
    return {
      ...(this.#listener ?? { url: "", bind: "", port: 0, remote: false }), pid: process.pid, startedAt: this.#startedAt, peers,
      ...this.#pairing ? { identity: this.#pairing.identity(), addresses: this.#pairing.addresses(), relayRegistered: this.#pairing.relayRegistered() } : {},
    };
  }
  #paired(): PairingController {
    if (!this.#pairing) throw new Error("This control endpoint does not manage pairing.");
    return this.#pairing;
  }
  async invite(ttlMs: number) {
    const created = await this.#paired().invite(ttlMs);
    this.#invites.add(created.id);
    return created;
  }
  awaitProposal(id: string) { return this.#paired().awaitProposal(id); }
  async decide(id: string, decision: Decision) {
    const result = await this.#paired().decide(id, decision);
    this.#invites.delete(id);
    return result;
  }
  dial(name: string) { return this.#paired().dial(name); }
  refresh(name: string) { return this.#paired().refresh(name); }
  forget(publicKey: string) { return this.#paired().forget(publicKey); }
  peers() { return this.#controller.peers(); }
  info(id: string) { return this.#controller.info(id); }
  /** Pending commands keep running when an attached console detaches. */
  run(id: string, command: string, options: RunOptions = {}) { return this.#controller.run(id, command, options); }
  /** Like run, but the peer kills the command if this control connection closes first. */
  runWhileConnected(id: string, command: string, options: RunOptions = {}) {
    return this.#controller.run(id, command, options, this.#closed.signal);
  }
  /** The attached console's sink and the peer's session stub are proxied by reference. */
  openPty(id: string, sink: PtySink, options: PtyOptions = {}) { return this.#controller.openPty(id, sink, options); }
  ptySessions(id: string) { return this.#controller.ptySessions(id); }
  startPtySession(id: string, name: string, options: PtySessionOptions = {}) { return this.#controller.startPtySession(id, name, options); }
  /** The peer's session handle is proxied by reference. */
  ptySession(id: string, name: string) { return this.#controller.ptySession(id, name); }
  /** A fork of the peer's whole shell, proxied by reference; releasing it kills its commands. */
  shell(id: string) { return this.#controller.shell(id); }
  /** The peer's file operations, which need only the files grant on a paired device. */
  files(id: string) {
    const files = (this.#controller as Partial<Pick<ConnectionController, "files">>).files;
    if (!files) throw new Error("This daemon offers no file access.");
    return new PeerFiles(files.call(this.#controller, id));
  }
  stop() {
    // Let Cap'n Web send the successful result before closing the transport.
    setTimeout(this.#stop, 25);
  }
  /** Cap'n Web calls this when the control connection ends. */
  [Symbol.dispose]() {
    this.#closed.abort(new Error("The control connection closed."));
    // A cns pair that went away leaves nobody to decide: end its invites, so no device waits for an answer.
    for (const id of this.#invites) this.#pairing?.cancel(id);
    this.#invites.clear();
  }
}

export async function serveControl(controller: PeerController, stop: () => void, statePath?: string, listener?: ListenerInfo, pairing?: PairingController): Promise<() => Promise<void>> {
  const token = process.env.CNS_DAEMON_TOKEN ?? randomBytes(32).toString("hex");
  const startedAt = Date.now();
  delete process.env.CNS_DAEMON_TOKEN;
  const file = daemonStatePath(statePath);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const authorization = Buffer.from(`Bearer ${token}`);
  const listen = (hostname: "::1" | "127.0.0.1") => Bun.serve<SocketData>({
    hostname,
    port: 0,
    fetch(request, server) {
      const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
      if (request.headers.has("Origin") || supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (server.upgrade(request, { data: {} })) return;
      return new Response("WebSocket upgrade required", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
        ws.data.transport = newBunWebSocketRpcSession(ws, new ControlApi(controller, stop, listener, startedAt, pairing)).transport;
      },
      message(ws, message) { ws.data.transport?.dispatchMessage(message); },
      close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
    },
  });
  // WSL mirrored networking can route IPv4 localhost through a broken host path
  // while IPv6 loopback still works. Prefer IPv6, without requiring it on hosts
  // where it is disabled. Do not hide unrelated listener failures.
  let host: "::1" | "127.0.0.1" = "::1";
  let server: ReturnType<typeof listen>;
  try { server = listen(host); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && ["EAFNOSUPPORT", "EPROTONOSUPPORT", "EADDRNOTAVAIL"].includes(String(error.code)))) throw error;
    host = "127.0.0.1";
    server = listen(host);
  }
  const state = stateSchema.parse({ version: 2, pid: process.pid, host, port: server.port, token });
  try {
    // Exclusive creation also arbitrates concurrent starts. Never replace another daemon's state.
    await writeFile(file, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    await server.stop(true);
    throw new Error(`Cannot create daemon state at ${file}. Another daemon may already use it.`, { cause: error });
  }
  return async () => {
    await server.stop(true);
    await removeOwnedState(file, token);
  };
}
