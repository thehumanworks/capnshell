import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serve } from "bun";
import { newBunWebSocketRpcSession, RpcTarget, type BunWebSocketTransport } from "capnweb";
import type { PeerController } from "../console.js";
import type { PtyOptions, PtySessionOptions, PtySink, RunOptions } from "../shell.js";
import { daemonStatePath, removeOwnedState, stateSchema, type DaemonStatus, type ListenerInfo } from "./daemon.js";

interface SocketData { transport?: BunWebSocketTransport<SocketData> }

/** Only this narrow local control surface is exported over Cap'n Web. */
export class ControlApi extends RpcTarget {
  #controller: PeerController;
  #stop: () => void;
  #listener: ListenerInfo | undefined;
  #startedAt: number;
  #closed = new AbortController();
  constructor(controller: PeerController, stop: () => void, listener: ListenerInfo | undefined, startedAt: number) {
    super();
    this.#controller = controller;
    this.#stop = stop;
    this.#listener = listener;
    this.#startedAt = startedAt;
  }
  /** The daemon's listener and how many peers it has, for clients that found its state file. */
  async status(): Promise<DaemonStatus> {
    const peers = (await this.#controller.peers()).length;
    return { ...(this.#listener ?? { url: "", bind: "", port: 0, remote: false, oneWay: false }), pid: process.pid, startedAt: this.#startedAt, peers };
  }
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
  stop() {
    // Let Cap'n Web send the successful result before closing the transport.
    setTimeout(this.#stop, 25);
  }
  /** Cap'n Web calls this when the control connection ends. */
  [Symbol.dispose]() { this.#closed.abort(new Error("The control connection closed.")); }
}

export async function serveControl(controller: PeerController, stop: () => void, statePath?: string, listener?: ListenerInfo): Promise<() => Promise<void>> {
  const token = process.env.CNS_DAEMON_TOKEN ?? randomBytes(32).toString("hex");
  const startedAt = Date.now();
  delete process.env.CNS_DAEMON_TOKEN;
  const file = daemonStatePath(statePath);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const authorization = Buffer.from(`Bearer ${token}`);
  const server = serve<SocketData>({
    hostname: "127.0.0.1",
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
        ws.data.transport = newBunWebSocketRpcSession(ws, new ControlApi(controller, stop, listener, startedAt)).transport;
      },
      message(ws, message) { ws.data.transport?.dispatchMessage(message); },
      close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
    },
  });
  const state = stateSchema.parse({ version: 1, pid: process.pid, port: server.port, token });
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

/** What `startDaemon` needs of a listen configuration. */
