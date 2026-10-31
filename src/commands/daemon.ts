import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "bun";
import { newBunWebSocketRpcSession, newWebSocketRpcSession, RpcTarget, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { z } from "zod";
import { openConsole, type PeerController } from "../console.js";
import type { PeerConfig } from "../options.js";
import { selfInvocation } from "../runtime.js";
import type { PtyOptions, PtySessionOptions, PtySink, RunOptions, ShellApi } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";

/** The listener a daemon runs, as `status()` reports it. */
export interface ListenerInfo {
  url: string;
  bind: string;
  port: number;
  /** The listener accepts connections from other machines. */
  remote: boolean;
  /** Peers cannot use this machine's shell or files. */
  oneWay: boolean;
}
export interface DaemonStatus extends ListenerInfo {
  pid: number;
  /** Milliseconds since the epoch when the control endpoint started. */
  startedAt: number;
  /** Connected peers that completed their handshake. */
  peers: number;
}

const stateSchema = z.strictObject({
  version: z.literal(1),
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
type DaemonState = z.infer<typeof stateSchema>;
interface SocketData { transport?: BunWebSocketTransport<SocketData> }

export function daemonStatePath(value?: string): string {
  return path.resolve(value ?? path.join(os.homedir(), ".cns", "daemon.json"));
}

async function readState(file: string): Promise<DaemonState> {
  const stat = await lstat(file);
  if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error(`Daemon state must be a private file owned by your user: ${file}`);
  }
  return stateSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

async function removeOwnedState(file: string, token: string): Promise<void> {
  try {
    if ((await readState(file)).token === token) await unlink(file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/**
 * Remove the state file of a daemon that crashed: its control endpoint does not
 * answer and its process no longer exists. A daemon writes its state only once it
 * answers, so one that is starting is never mistaken for a crashed one; a file
 * that cannot be parsed yet may be one being written, and is left alone.
 * Returns whether the file was removed.
 */
export async function removeStaleState(statePath?: string): Promise<boolean> {
  const file = daemonStatePath(statePath);
  let state: DaemonState;
  try { state = await readState(file); }
  catch { return false; }
  try {
    (await connectToState(state)).close();
    return false;
  } catch {
    if (processExists(state.pid)) return false;
  }
  await removeOwnedState(file, state.token);
  return true;
}

/** Only this narrow local control surface is exported over Cap'n Web. */
class ControlApi extends RpcTarget {
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
export type DaemonConfig = Pick<PeerConfig, "bind" | "port" | "url" | "remote" | "state"> & Partial<Pick<PeerConfig, "oneWay">>;
export interface StartDaemonOptions {
  /** The executable and arguments that run `cns`; by default, this program. Embedders pass the cns executable. */
  invocation?: (args: string[]) => { file: string; args: string[] };
}
export interface StartedDaemon {
  url: string;
  pid: number;
  /** The private state file, which `attach`, `stop` and embedders use to find the daemon. */
  state: string;
  log: string;
}

/** Start a detached listener and return once it is ready. The state file arbitrates concurrent starts. */
export async function startDaemon(config: DaemonConfig, options: StartDaemonOptions = {}): Promise<StartedDaemon> {
  const file = daemonStatePath(config.state);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await removeStaleState(file);
  try {
    await lstat(file);
    throw new Error(`Daemon state already exists at ${file}. Use cns attach or cns stop with this --state path. If its process is gone but the file remains, remove the file.`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const token = randomBytes(32).toString("hex");
  const logPath = `${file}.${randomBytes(6).toString("hex")}.log`;
  const log = await open(logPath, "wx", 0o600);
  const args = ["listen", "--no-repl", "--state", file, "--bind", config.bind, "--port", String(config.port)];
  if (config.remote) args.push("--allow-remote");
  if (config.oneWay) args.push("--one-way");
  const invocation = (options.invocation ?? selfInvocation)(args);
  const child = spawn(invocation.file, invocation.args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd, "ipc"],
    env: { ...process.env, CNS_DAEMON_CHILD: "1", CNS_DAEMON_TOKEN: token },
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Daemon startup timed out. See ${logPath}`)), 10_000);
      const onMessage = (message: unknown) => {
        if (message && typeof message === "object" && "ready" in message && message.ready === true) finish();
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => finish(new Error(`Daemon exited during startup (${code}). See ${logPath}`));
      function finish(error?: Error) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error); else resolve();
      }
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    await Promise.all([ready, log.close()]);
    const state = await readState(file);
    if (state.token !== token || state.pid !== child.pid) throw new Error("Daemon startup state does not match the child process.");
    if (child.connected) child.disconnect();
    child.unref();
    return { url: config.url, pid: child.pid!, state: file, log: logPath };
  } catch (error) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
        child.kill("SIGTERM");
      });
    }
    if (child.connected) child.disconnect();
    await removeOwnedState(file, token);
    throw error;
  }
}

export async function connectControl(statePath?: string) {
  return connectToState(await readState(daemonStatePath(statePath)));
}

export interface ControlConnection {
  controller: PeerController;
  remote: RpcStub<ControlApi>;
  close(): void;
}

async function connectToState(state: DaemonState): Promise<ControlConnection> {
  const socket = new WebSocket(`ws://127.0.0.1:${state.port}`, { headers: { Authorization: `Bearer ${state.token}` } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Local daemon connection timed out.")), 5000);
      const onOpen = () => finish();
      const onError = () => finish(new Error("Cannot connect to the local daemon. Its state file may be stale."));
      function finish(error?: Error) {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        if (error) reject(error); else resolve();
      }
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  const remote = newWebSocketRpcSession<ControlApi>(socket);
  return {
    remote,
    controller: {
      peers: () => plain(remote.peers()),
      info: (id) => plain(remote.info(id)),
      run: (id, command, options) => plain(remote.run(id, command, options)),
      openPty: async (id, sink, options) => await remote.openPty(id, sink, options),
      ptySessions: (id) => plain(remote.ptySessions(id)),
      startPtySession: (id, name, options) => plain(remote.startPtySession(id, name, options)),
      ptySession: async (id, name) => await remote.ptySession(id, name) as unknown as RemoteNamedPty,
      shell: async (id) => await remote.shell(id) as unknown as RpcStub<ShellApi>,
    },
    close() {
      remote[Symbol.dispose]();
      socket.close();
      const timer = setTimeout(() => socket.terminate(), 750);
      timer.unref();
      socket.addEventListener("close", () => clearTimeout(timer), { once: true });
    },
  };
}

export async function attachDaemon(statePath?: string): Promise<void> {
  const connection = await connectControl(statePath);
  await new Promise<void>((resolve) => {
    let consoleSession: ReturnType<typeof openConsole> | undefined;
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      consoleSession?.close();
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      connection.close();
      resolve();
    }
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    connection.remote.onRpcBroken(close);
    consoleSession = openConsole(connection.controller, close);
  });
}

export async function stopDaemon(statePath?: string): Promise<void> {
  const file = daemonStatePath(statePath);
  const state = await readState(file);
  // Keep the authenticated target and cleanup ownership bound to the same snapshot.
  const connection = await connectToState(state);
  try { await connection.remote.stop(); }
  finally { connection.close(); }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await readState(file)).token !== state.token) break;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    if ((await readState(file)).token === state.token) throw new Error("Daemon acknowledged stop but has not removed its state file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  console.log("Daemon stopped.");
}
