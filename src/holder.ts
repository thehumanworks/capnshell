/**
 * One named session in a process of its own, `cns daemon hold NAME`, so that it outlives the
 * daemon: a restart, an upgrade or a crash leaves the program, its screen and its scrollback
 * running here, and the next daemon adopts it (held-sessions.ts). The holder runs the session
 * as the daemon used to (pty.ts), listens on a private socket and keeps a record of itself
 * beside the daemon's state. It imports only what that needs, to stay small.
 *
 *   daemon ──spawn; the session's options over IPC──▶ holder: starts the program, listens,
 *          ◀───────────── its record ───────────────         writes the record
 *   daemon ──socket: the record's token, then Cap'n Web──▶ holder
 *
 * The holder ends when its session is removed: killed, or an hour after its program ended
 * (FINISHED_SESSION_MS), as the daemon removed sessions before. It also ends on SIGTERM.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { RpcSession, RpcTarget, type RpcTransport } from "capnweb";
import { z } from "zod";
import { HandleScope, PtyRegistry, sessionNameSchema, type NamedPty, type PtyExit } from "./pty.js";
import { CNS_VERSION } from "./version.js";

/**
 * The holder protocol: the record below and HolderApi. A daemon speaks every version up to its
 * own, so that an upgraded daemon adopts the sessions of the release before it, and leaves a
 * holder of a newer version running. A Cap'n Web upgrade that changes its messages needs a new one.
 */
export const HOLDER_PROTOCOL = 1;

export const holderRecordSchema = z.object({
  protocol: z.literal(HOLDER_PROTOCOL),
  name: sessionNameSchema,
  /** Who started the session, as PtySessionInfo.owner says. */
  owner: z.string().nullable(),
  /** The holder's pid; the program's is in the session's info. */
  pid: z.int().positive(),
  startedAt: z.string(),
  socket: z.string().min(1),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  /** The cns the holder runs. */
  version: z.string(),
});
export type HolderRecord = z.infer<typeof holderRecordSchema>;

/** What the daemon sends a new holder over IPC, so that the program, its options and secrets are never on a command line. */
const startSchema = z.object({
  dir: z.string().min(1),
  name: sessionNameSchema,
  options: z.unknown(),
  owner: z.string().nullable(),
  finishedMs: z.int().positive(),
});
export type HolderStart = z.infer<typeof startSchema>;

/** What a daemon reaches on a holder: a handle of its own for each handle it issues. */
export class HolderApi extends RpcTarget {
  #registry: PtyRegistry;
  #name: string;
  #scope = new HandleScope();
  constructor(registry: PtyRegistry, name: string) { super(); this.#registry = registry; this.#name = name; }
  /** Releasing the handle ends its waits; its attachments detach once the daemon's connection closes. */
  handle(): NamedPty { return this.#registry.openSession(this.#name, this.#scope); }
  /** Resolves with how the program ended. */
  async exited(): Promise<PtyExit> { return await this.#registry.get(this.#name).exited; }
  /** Cap'n Web calls this when the daemon's connection closes. */
  [Symbol.dispose]() { this.#scope.close("The daemon's connection to this session closed."); }
}

/** Cap'n Web over a local socket, one message a line: its JSON messages never hold a raw newline. */
export class LineTransport implements RpcTransport {
  #socket: net.Socket;
  #buffer = "";
  #lines: string[] = [];
  #waiting?: { resolve(line: string): void; reject(error: Error): void };
  #error?: Error;
  constructor(socket: net.Socket, rest = "") {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#take(chunk));
    socket.on("error", () => {});
    socket.once("close", () => this.#fail(new Error("The connection to the session's holder closed.")));
    this.#take(rest);
  }
  #take(chunk: string) {
    this.#buffer += chunk;
    for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      if (this.#waiting) { this.#waiting.resolve(line); this.#waiting = undefined; } else this.#lines.push(line);
    }
  }
  #fail(error: Error) {
    this.#error ??= error;
    this.#waiting?.reject(this.#error);
    this.#waiting = undefined;
  }
  send(message: string) { if (!this.#error) this.#socket.write(`${message}\n`); }
  receive(): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.#error) return Promise.reject(this.#error);
    return new Promise((resolve, reject) => { this.#waiting = { resolve, reject }; });
  }
  abort() { this.#socket.destroy(); }
}

/** Serve a connection once its first line holds the record's token; any other caller is closed on, unanswered. */
function serve(connection: net.Socket, token: string, main: () => RpcTarget): void {
  const expected = Buffer.from(token);
  let buffer = "";
  const timer = setTimeout(() => connection.destroy(), 5000);
  connection.setEncoding("utf8");
  connection.on("error", () => {});
  const hello = (chunk: string) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) { if (buffer.length > 1024) connection.destroy(); return; }
    connection.off("data", hello);
    clearTimeout(timer);
    let given: unknown;
    try { given = (JSON.parse(buffer.slice(0, end)) as { token?: unknown }).token; } catch { /* Refused below. */ }
    const supplied = Buffer.from(typeof given === "string" ? given : "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { connection.destroy(); return; }
    connection.write(`${JSON.stringify({ protocol: HOLDER_PROTOCOL })}\n`);
    new RpcSession(new LineTransport(connection, buffer.slice(end + 1)), main());
  };
  connection.on("data", hello);
}

/** `cns daemon hold NAME`: run the session the daemon sends over IPC until it is removed. */
export async function hold(): Promise<void> {
  if (!process.send) {
    console.error("cns daemon hold runs a named session for the daemon, which starts it. Start sessions with cns shell DEVICE --name NAME.");
    process.exitCode = 2;
    return;
  }
  const message = await new Promise<unknown>((resolve) => {
    process.once("message", resolve);
    process.once("disconnect", () => resolve(undefined));
  });
  const parsed = startSchema.safeParse(message);
  if (!parsed.success) { process.exit(2); }
  const { dir, name, options, owner, finishedMs } = parsed.data;
  const id = randomBytes(8).toString("hex");
  const file = path.join(dir, `${id}.json`);
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\cns-${randomBytes(16).toString("hex")}` : path.join(dir, `${id}.sock`);
  const token = randomBytes(32).toString("hex");
  let server: net.Server | undefined;
  let ending = false;
  const end = async () => {
    if (ending) return;
    ending = true;
    server?.close();
    await Promise.all([unlink(file), process.platform === "win32" ? undefined : unlink(socket)].map((removed) => removed?.catch(() => {})));
    // Let the answer to a kill reach the daemon first.
    setTimeout(() => process.exit(0), 50);
  };
  const registry = new PtyRegistry({ finishedMs, onRemoved: (pty) => { void pty.exited.then(end); } });
  let exited: Promise<PtyExit>;
  try { exited = registry.start(name, options as never, owner).exited; }
  catch (error) {
    process.send({ error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
  const stop = () => { registry[Symbol.dispose](); void exited.then(end); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
  try {
    server = net.createServer((connection) => serve(connection, token, () => new HolderApi(registry, name)));
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socket, resolve); });
    if (process.platform !== "win32") await chmod(socket, 0o600);
    const record: HolderRecord = { protocol: HOLDER_PROTOCOL, name, owner, pid: process.pid, startedAt: new Date().toISOString(), socket, token, version: CNS_VERSION };
    // Written whole, then renamed, so that a daemon never reads half a record.
    await writeFile(`${file}.tmp`, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    await rename(`${file}.tmp`, file);
    process.send({ ready: record });
  } catch (error) {
    process.send({ error: `The session's holder could not start: ${error instanceof Error ? error.message : String(error)}` });
    stop();
  } finally {
    process.disconnect?.();
  }
}
