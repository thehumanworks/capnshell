import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { z } from "zod";
import { closeSocket, terminateSocket } from "../connect.js";
import { openConsole, type PeerController } from "../console.js";
import { strictlyPrintable } from "../errors.js";
import { selfInvocation } from "../runtime.js";
import type { ShellApi } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
// The control server needs Bun's capnweb build; clients of the daemon, such as
// the Pi extension, load this module on Node too.
import type { ControlApi } from "./daemon-server.js";

/** The listener a daemon runs, as `status()` reports it. */
export interface ListenerInfo {
  url: string;
  bind: string;
  port: number;
  /** The listener accepts connections from other machines. */
  remote: boolean;
  /** The relay this daemon registers at: the built-in one, unless CNS_RELAY=off. */
  relay?: string;
  /** The daemon runs under a service manager: cns daemon --service, as cns up --install and the Nix modules start it. */
  service?: boolean;
  /** Named sessions outlive the daemon, in holder processes of their own; absent from daemons before them (held-sessions.ts). */
  keepsSessions?: boolean;
}

/** What the daemon and cns stop say about the named sessions that keep running once the daemon has stopped. */
export function keptSessions(names: string[]): string {
  return `Named sessions keep running: ${names.join(", ")}. Once the daemon runs again, cns kill DEVICE NAME on a paired device ends one.`;
}
export interface DaemonStatus extends ListenerInfo {
  pid: number;
  /** Milliseconds since the epoch when the control endpoint started. */
  startedAt: number;
  /** Connected peers that completed their handshake. */
  peers: number;
  /** This device's identity, which paired devices authenticate. */
  identity?: { publicKey: string; fingerprint: string };
  /** The URLs other devices can use to reach this listener: direct ones, then its relay address. */
  addresses?: string[];
  /** Whether the daemon is registered at its relay right now. */
  relayRegistered?: boolean;
  /** The cns version the daemon runs; absent from daemons before it was reported. */
  version?: string;
  /** The executable the daemon runs, or its script when run from source. */
  executable?: string;
  /** The names of the named sessions whose program runs, which a restart ends; absent from daemons before they were reported. */
  sessions?: string[];
}

const legacyStateSchema = z.strictObject({
  version: z.literal(1),
  pid: z.int().positive(),
  port: z.int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
// Old daemons always bound IPv4. New state records the literal loopback address;
// never accept an arbitrary host that could receive the local control token.
export const stateSchema = z.discriminatedUnion("version", [
  legacyStateSchema,
  legacyStateSchema.extend({ version: z.literal(2), host: z.enum(["::1", "127.0.0.1"]) }),
]);
type DaemonState = z.infer<typeof stateSchema>;

export function daemonStatePath(value?: string): string {
  return path.resolve(value ?? path.join(os.homedir(), ".cns", "daemon.json"));
}

async function readState(file: string): Promise<DaemonState> {
  const invalid = () => new Error(`Daemon state must be a private file owned by your user: ${file}`);
  // Retain the symlink check on platforms without O_NOFOLLOW. O_NONBLOCK avoids
  // waiting on a FIFO substituted between this check and the open.
  if (!(await lstat(file)).isFile()) throw invalid();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw invalid();
    return stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
  } finally {
    await handle.close();
  }
}

/**
 * What a failure to read daemon state says about its removal: "gone" once the file no longer
 * exists, "going" while Windows still holds it for deletion, undefined for any other failure.
 * Windows keeps a removed file "delete pending" until every handle to it closes, and opening it
 * meanwhile fails with EPERM instead of ENOENT.
 */
export function stateRemoval(error: unknown, platform: NodeJS.Platform = process.platform): "gone" | "going" | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "gone";
  return code === "EPERM" && platform === "win32" ? "going" : undefined;
}

export async function removeOwnedState(file: string, token: string): Promise<void> {
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

/** Wait until process `pid` has exited, for at most `timeoutMs`. Returns whether it did. */
export async function processExited(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * Whether process `pid` is this one's parent, its parent's parent and so on, as the daemon is for a
 * command that a paired device runs through it. Undefined when ps cannot tell, as on Windows.
 */
export function runsUnder(pid: number, listing = processListing()): boolean | undefined {
  if (listing === undefined) return undefined;
  const parents = new Map<number, number>();
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(child) && Number.isInteger(parent)) parents.set(child!, parent!);
  }
  if (!parents.has(process.pid)) return undefined;
  for (let at = parents.get(process.pid), steps = 0; at !== undefined && at > 1 && steps < 1000; at = parents.get(at), steps++) {
    if (at === pid) return true;
  }
  return false;
}

/** Each process's pid and its parent's, a pair to a line, as ps lists them; undefined without ps. */
function processListing(): string | undefined {
  if (process.platform === "win32") return undefined;
  const listed = spawnSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  return listed.status === 0 ? listed.stdout : undefined;
}

/**
 * Remove the state file of a daemon that crashed: its control endpoint does not
 * answer and its process no longer exists. A daemon writes its state only once it
 * answers, so one that is starting is never mistaken for a crashed one; a file
 * that cannot be parsed yet may be one being written, and is left alone.
 * Returns whether the file was removed.
 */
export async function removeStaleState(statePath?: string, options: { ignorePid?: boolean } = {}): Promise<boolean> {
  const file = daemonStatePath(statePath);
  let state: DaemonState;
  try { state = await readState(file); }
  catch { return false; }
  try {
    (await connectToState(state)).close();
    return false;
  } catch {
    if (!options.ignorePid && processExists(state.pid)) return false;
  }
  await removeOwnedState(file, state.token);
  return true;
}

/** Where the daemon listens, and its state file: by default ~/.cns/daemon.json. */
export interface DaemonSettings { bind: string; port: number; url: string; state?: string }
export interface StartDaemonOptions {
  /** The executable and arguments that run `cns`; by default, this program. Embedders pass the cns executable. */
  invocation?: (args: string[]) => { file: string; args: string[] };
  /** How long the daemon has to be ready; 10 seconds by default. */
  readyMs?: number;
}
export interface StartedDaemon {
  url: string;
  pid: number;
  /** The private state file, which `attach`, `stop` and embedders use to find the daemon. */
  state: string;
  log: string;
}

/** Start the paired daemon detached and return once it is ready. The state file arbitrates concurrent starts. */
export async function startDaemon(config: DaemonSettings, options: StartDaemonOptions = {}): Promise<StartedDaemon> {
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
  const args = ["daemon", "--state", file, "--bind", config.bind, "--port", String(config.port)];
  const invocation = (options.invocation ?? selfInvocation)(args);
  const child = spawn(invocation.file, invocation.args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd, "ipc"],
    env: { ...process.env, CNS_DAEMON_TOKEN: token },
  });
  // A daemon that exits or hangs before it is ready says why at the end of its log.
  let logged = false;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { logged = true; finish(new Error(`Daemon startup timed out. See ${logPath}`)); }, options.readyMs ?? 10_000);
      const onMessage = (message: unknown) => {
        if (message && typeof message === "object" && "ready" in message && message.ready === true) finish();
      };
      const onError = (error: Error) => finish(error);
      const onExit = (code: number | null) => { logged = true; finish(new Error(`Daemon exited during startup (${code}). See ${logPath}`)); };
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
    const ending = logged ? await logEnding(logPath) : "";
    throw ending && error instanceof Error ? new Error(`${error.message}\n${ending}`, { cause: error }) : error;
  }
}

/**
 * The last lines a daemon wrote to its log, which say why it stopped: at most three, of about 500
 * characters in all, each safe to print; empty when the log cannot be read. The daemon has exited,
 * but on Windows the file may stay open a moment longer: opening it to read takes no lock there,
 * and a failed read only leaves the lines out.
 */
export async function logEnding(logPath: string): Promise<string> {
  let text: string;
  try {
    const handle = await open(logPath, "r");
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - 2048);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
      text = buffer.subarray(0, bytesRead).toString("utf8");
      // Leave out a line cut off where the read began.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally { await handle.close(); }
  } catch { return ""; }
  const lines = text.split(/\r?\n/).map((line) => strictlyPrintable(line.trim())).filter(Boolean).slice(-3);
  // The last line is the daemon's error, whose start says what went wrong; earlier lines fill what room is left.
  let ending = lines.pop() ?? "";
  if (ending.length > 500) ending = `${ending.slice(0, 500)}...`;
  for (let line = lines.pop(); line !== undefined && line.length + 1 + ending.length <= 500; line = lines.pop()) ending = `${line}\n${ending}`;
  return ending;
}

/**
 * Why the daemon cannot listen at its address, and what to run next; undefined for other failures.
 * The command it suggests can be pasted: a value that is not plainly one word is single-quoted, for
 * a POSIX shell or, on Windows, for PowerShell.
 */
export function listenFailure(error: unknown, daemon: { bind: string; port: number; state: string; service: boolean }, platform: NodeJS.Platform = process.platform): string | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code !== "EADDRINUSE" && code !== "EACCES") return undefined;
  const word = (value: string) => (platform === "win32" ? /^[\w./:\\@+=~-]+$/ : /^[\w./:@+,=~-]+$/).test(value) ? value
    // PowerShell also ends a string at the typographic single quotes, U+2018 to U+201B; doubling escapes each, as shellWord does.
    : platform === "win32" ? `'${value.replace(/['‘-‛]/g, "$&$&")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const options = `${daemon.bind === "0.0.0.0" ? "" : ` --bind ${word(daemon.bind)}`}${daemon.state === daemonStatePath() ? "" : ` --state ${word(daemon.state)}`}`;
  // A service, which cns up --install or a NixOS or Home Manager module sets up, has its port where it is configured.
  const instead = daemon.service ? "change the port where its service is configured (cns up --install --port PORT if cns installed it)"
    : `start cns on another port: cns up${options} --port PORT`;
  if (code === "EACCES") {
    // Windows has no privileged ports, but it reserves ranges of them, as for Hyper-V.
    const why = platform === "win32" ? "Windows may reserve or block it (netsh interface ipv4 show excludedportrange protocol=tcp lists the reserved ranges)"
      : daemon.port < 1024 ? "ports below 1024 need extra rights" : "this user may not listen there";
    return `Cannot listen on port ${daemon.port} on ${daemon.bind}: ${why}. ${instead[0]!.toUpperCase()}${instead.slice(1)}.`;
  }
  return `Port ${daemon.port} on ${daemon.bind} is in use. Stop what uses it, or ${instead}. If it is this device's cns daemon, cns status shows it and cns stop stops it.`;
}

/** Connect to the local daemon whose state is at `statePath`, giving up after `timeoutMs`. */
export async function connectControl(statePath?: string, timeoutMs = 5000) {
  return connectToState(await readState(daemonStatePath(statePath)), timeoutMs);
}

export interface ControlConnection {
  controller: PeerController;
  remote: RpcStub<ControlApi>;
  close(): void;
}

async function connectToState(state: DaemonState, timeoutMs = 5000): Promise<ControlConnection> {
  const host = state.version === 1 ? "127.0.0.1" : state.host;
  const socket = new WebSocket(`ws://${host === "::1" ? "[::1]" : host}:${state.port}`, { headers: { Authorization: `Bearer ${state.token}` } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Local daemon connection timed out.")), timeoutMs);
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
    terminateSocket(socket);
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
      closeSocket(socket);
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

/**
 * Stop the daemon once it has removed its state. Returns its pid, what it said of itself, and its
 * named sessions whose program ran: those that keep running without it, and those that end with it.
 */
export async function stopDaemon(statePath?: string): Promise<{ pid: number; status: DaemonStatus; kept: string[]; ended: string[] }> {
  const file = daemonStatePath(statePath);
  const state = await readState(file);
  // Keep the authenticated target and cleanup ownership bound to the same snapshot.
  const connection = await connectToState(state);
  let status: DaemonStatus;
  try {
    status = await connection.remote.status();
    await connection.remote.stop();
  } finally { connection.close(); }
  // Absent from a daemon too old to name them.
  const sessions = Array.isArray(status.sessions) ? status.sessions.filter((name) => typeof name === "string").map(strictlyPrintable) : [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await readState(file)).token !== state.token) break;
    } catch (error) {
      const removal = stateRemoval(error);
      if (removal === "gone") break;
      // Windows still holds the removed file for deletion: wait until it is gone.
      if (removal !== "going") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    if ((await readState(file)).token === state.token) throw new Error("Daemon acknowledged stop but has not removed its state file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return { pid: state.pid, status, kept: status.keepsSessions ? sessions : [], ended: status.keepsSessions ? [] : sessions };
}
