import path from "node:path";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { DEFAULT_UNTIL_MS, describeExit, formatSessions } from "../session-text.js";
import { errorMessage } from "../errors.js";
import { explainDenial } from "../peers.js";
import { MAX_KEYS } from "../keys.js";
import { commandSchema } from "../platform.js";
import {
  MAX_DIRECTORY_ENTRIES, MAX_FILE_CHUNK_BYTES, MAX_GLOB_RESULTS, MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, MAX_WRITE_BYTES, sessionNameSchema,
  type PtyExit, type PtyScreen, type PtySessionInfo, type ShellInfo,
} from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import type { Link, McpTarget, PeerFiles } from "./target.js";

/** Agents rarely mean to wait forever, and some clients give up silently. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Each of stdout, stderr and a screen is shortened to this many characters in a result. */
export const MAX_RESULT_CHARS = 30_000;
const PROGRESS_MS = 10_000;

const instructions = `cns runs commands and terminal programs on other machines ("peers") as the user running cns there.
- list_peers shows each peer's operating system and shell. Commands use that shell's syntax: Bash on Linux and macOS, Windows PowerShell on Windows.
- run_command starts a fresh non-interactive shell for every call and returns when the command finishes. cd and variables do not persist; pass cwd instead. Stdin is closed.
- For interactive programs, REPLs, TUIs, servers and watchers, use a named session: start_session, then send_keys and read_screen, then kill_session. Sessions keep running between calls until killed, and other clients of the same peer can see them.
- To wait for a program, pass until to read_screen or send_keys rather than sleeping.
- For files on a peer, use read_file, write_file, list_directory and glob rather than cat, echo or ls through run_command. Paths are in the peer's own syntax; relative ones start from the default working directory.
- Name a peer by the name list_peers gives it. A paired device keeps its name, but its ID (such as p4) changes whenever it reconnects, so pass an ID only for a peer that has no name. When several peers are connected, pass peer to choose one.`;

const peer = z.string().min(1).max(64).optional()
  .describe("The peer's name from list_peers, such as studio. Pass its ID only when it has no name: a paired device's ID changes whenever it reconnects. May be omitted when only one peer is connected.");
const name = sessionNameSchema.describe("Session name: 1-64 letters, digits, '.', '_' or '-'.");
const cwd = z.string().min(1).max(4096).optional()
  .describe("Absolute working directory on the peer, in its own path syntax. Defaults to the peer user's home directory.");
const until = z.string().min(1).max(4096).optional()
  .describe("Wait until the visible screen contains this text, the program ends or waitMs passes, then return the screen.");
const waitMs = z.int().min(0).max(MAX_TIMEOUT_MS).optional()
  .describe(`With until, how long to wait in milliseconds. Default ${DEFAULT_UNTIL_MS}; 0 waits until the text appears or the program ends.`);
const dimension = z.int().min(1).max(1000);

const exitSchema = z.object({
  exitCode: z.int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  elapsedMs: z.number(),
  error: z.string().nullable().describe("Why cns ended the program, when it did not exit by itself."),
});
const screenSchema = z.object({
  text: z.string().describe("The rendered rows joined with newlines, without trailing spaces or blank rows at the bottom."),
  cols: z.int(),
  rows: z.int(),
  cursor: z.object({ x: z.int(), y: z.int() }).describe("Zero-based cursor column and row on the visible screen."),
  alternateScreen: z.boolean().describe("True while a full-screen program uses the alternate screen."),
  title: z.string(),
});
const sessionSchema = z.object({
  name: z.string(),
  command: z.string().nullable().describe("Null for a login shell."),
  cwd: z.string(),
  pid: z.int(),
  cols: z.int(),
  rows: z.int(),
  title: z.string(),
  startedAt: z.string(),
  running: z.boolean(),
  exit: exitSchema.nullable(),
  viewers: z.int().describe("Terminals attached with cns tty --attach."),
});
const viewSchema = {
  running: z.boolean(),
  exit: exitSchema.nullable(),
  matched: z.boolean().optional().describe("With until: whether the text appeared."),
  screen: screenSchema,
};

const peerSchema = z.object({
  id: z.string().describe("The peer's ID for now: it changes whenever the peer reconnects. Pass name as `peer` instead when there is one."),
  name: z.string().optional().describe("For a device paired with this one: its saved name, which stays the same across reconnects. Pass it as `peer`."),
  fingerprint: z.string().optional().describe("For a paired device: its identity's fingerprint."),
  hostname: z.string(),
  platform: z.string().describe("Node.js platform name, such as linux, darwin or win32."),
  os: z.string().describe("linux, mac, windows or wsl."),
  shell: z.string().describe("Bash or PowerShell: the syntax run_command and sessions use."),
  home: z.string().describe("The default working directory."),
  pid: z.int().describe("Process ID of cns on the peer."),
});
const runInput = z.strictObject({
  command: commandSchema.describe("One command string in the peer shell's syntax, up to 8192 characters."),
  peer,
  cwd,
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).optional()
    .describe(`Kill the command's process tree after this many milliseconds. Default ${DEFAULT_RUN_TIMEOUT_MS}; 0 means no deadline.`),
});
const runOutput = z.object({
  peer: z.string(),
  exitCode: z.int().nullable(),
  signal: z.string().nullable().describe("The signal that ended the command, if any."),
  timedOut: z.boolean(),
  elapsedMs: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean().describe("True when some output is missing: beyond the peer's 1 MiB limit, or shortened in this result."),
});
const startInput = z.strictObject({
  name,
  command: commandSchema.optional().describe("One command string in the peer shell's syntax. Omit for a login shell."),
  peer,
  cwd,
  cols: dimension.optional().describe("Terminal width. Default 80."),
  rows: dimension.optional().describe("Terminal height. Default 24."),
  term: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/).optional().describe("TERM for the program. Default xterm-256color."),
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).optional().describe("End the program after this many milliseconds. Default: no limit."),
  until,
  waitMs,
});
const keysInput = z.strictObject({
  name,
  keys: z.array(z.string().max(65_536)).min(1).max(MAX_KEYS).describe("Key names and text, sent in order."),
  literal: z.boolean().optional().describe("Type every item as text, without key names."),
  peer,
  until,
  waitMs,
});
const keysOutput = z.object({
  sent: z.int().describe("How many items were sent."),
  running: viewSchema.running.optional(),
  exit: viewSchema.exit.optional(),
  matched: viewSchema.matched,
  screen: screenSchema.optional(),
});
const screenInput = z.strictObject({
  name,
  peer,
  until,
  waitMs,
  history: z.int().min(0).max(MAX_SCREEN_HISTORY).optional().describe("Also return up to this many scrollback lines above the screen."),
});
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const observing = { readOnlyHint: true, openWorldHint: false };

type Exit = z.infer<typeof exitSchema>;
type Screen = z.infer<typeof screenSchema>;
interface View { running: boolean; exit: Exit | null; matched?: boolean; screen: Screen }

const toExit = ({ exitCode, signal, timedOut, elapsedMs, error }: PtyExit): Exit => ({ exitCode, signal, timedOut, elapsedMs, error });
const toSession = (info: PtySessionInfo): z.infer<typeof sessionSchema> => ({
  name: info.name, command: info.command, cwd: info.cwd, pid: info.pid, cols: info.cols, rows: info.rows, title: info.title,
  startedAt: info.startedAt, running: info.running, exit: info.exit && toExit(info.exit), viewers: info.viewers,
});

// Never cut between the two halves of a surrogate pair.
const isLowSurrogate = (text: string, index: number) => /[\uDC00-\uDFFF]/.test(text[index] ?? "");

/** Keep the start and the end of long text, where commands report what they did and how it ended. */
export function clip(text: string, limit = MAX_RESULT_CHARS): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false };
  let head = Math.floor(limit / 5);
  let tail = text.length - (limit - head);
  if (isLowSurrogate(text, head)) head--;
  if (isLowSurrogate(text, tail)) tail++;
  return { text: `${text.slice(0, head)}\n[... ${tail - head} characters omitted ...]\n${text.slice(tail)}`, clipped: true };
}

function toScreen(screen: PtyScreen): Screen {
  const { text } = clip(screen.text.replace(/\n+$/, ""));
  return { text, cols: screen.cols, rows: screen.rows, cursor: { x: screen.cursor.x, y: screen.cursor.y }, alternateScreen: screen.alternateScreen, title: screen.title };
}

/** Capture a session's screen, or first wait for some text to appear on it. */
async function look(session: RemoteNamedPty, options: { until?: string; waitMs?: number; history?: number }): Promise<View> {
  const history = options.history ?? 0;
  if (options.until === undefined) {
    const [screen, info] = await Promise.all([plain(session.capture({ history })), plain(session.info())]);
    return { running: info.running, exit: info.exit && toExit(info.exit), screen: toScreen(screen) };
  }
  const waited = await plain(session.wait({ text: options.until, timeoutMs: options.waitMs ?? DEFAULT_UNTIL_MS, history }));
  const exit = waited.running ? null : (await plain(session.info())).exit;
  return { running: waited.running, exit: exit && toExit(exit), matched: waited.matched, screen: toScreen(waited.screen) };
}

function describeView(sessionName: string, view: View, options: { until?: string; waitMs?: number }): string {
  const state = view.running ? "running" : view.exit ? describeExit(view.exit) : "ended";
  const quoted = JSON.stringify(options.until);
  let status = `${sessionName}: ${state}`;
  if (view.matched) status = `${sessionName}: showing ${quoted}; ${state}`;
  else if (view.matched === false) {
    status = view.running
      ? `${sessionName}: timed out after ${options.waitMs ?? DEFAULT_UNTIL_MS} ms waiting for ${quoted}; still running`
      : `${sessionName}: ${state} before showing ${quoted}`;
  }
  const title = view.screen.title ? ` · title ${JSON.stringify(view.screen.title)}` : "";
  return `[${status} · ${view.screen.cols}x${view.screen.rows}${title}]\n${view.screen.text}`;
}

/** Report elapsed time while a call runs, when the client asked for progress. */
function reportProgress(ctx: ServerContext, activity: string): () => void {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    ctx.mcpReq.notify({
      method: "notifications/progress",
      params: { progressToken: token, progress: seconds, message: `${activity} for ${seconds} s` },
    }).catch(() => { /* The request has ended. */ });
  }, PROGRESS_MS);
  return () => clearInterval(timer);
}

/**
 * Run one tool call on its own connection. Cancelling the call closes the
 * connection, which ends the remote work it started. Failures become error
 * results the agent can read, as the MCP spec asks for tool execution errors.
 */
async function invoke(target: McpTarget, ctx: ServerContext, activity: string | undefined,
  work: (link: Link) => Promise<{ text: string; structured: Record<string, unknown> }>): Promise<CallToolResult> {
  const signal = ctx.mcpReq.signal;
  let link: Link | undefined;
  const cancel = () => link?.close();
  signal.addEventListener("abort", cancel, { once: true });
  const stopProgress = activity === undefined ? () => {} : reportProgress(ctx, activity);
  try {
    link = await target.open(signal);
    // An abort while the connection opened found no link to close.
    signal.throwIfAborted();
    const { text, structured } = await work(link);
    return { content: [{ type: "text", text }], structuredContent: structured };
  } catch (error) {
    // The SDK sends nothing for a cancelled request.
    if (signal.aborted) throw error;
    const message = link?.lost ? `Lost the connection to ${target.label}: ${errorMessage(error)}` : explainDenial(errorMessage(error), target.device);
    return { content: [{ type: "text", text: message }], isError: true };
  } finally {
    stopProgress();
    signal.removeEventListener("abort", cancel);
    link?.close();
  }
}

/** Use a named session's handle for the length of one call. */
async function withSession<T>(link: Link, peerId: string, sessionName: string, use: (session: RemoteNamedPty) => Promise<T>): Promise<T> {
  const session = await link.controller.ptySession(peerId, sessionName);
  try { return await use(session); }
  finally { session[Symbol.dispose](); }
}

/** Lines read_file returns when the call does not say. */
export const DEFAULT_READ_LINES = 2000;
/** Entries list_directory and paths glob return when the call does not say. */
export const DEFAULT_LIST_LIMIT = 1000;
/** The furthest into a file read_file reads to reach the lines asked for. */
export const MAX_SCAN_BYTES = 64 * 1024 * 1024;
/** A NUL byte in this much of a file's start marks it as binary. */
const BINARY_SNIFF_BYTES = 8192;

const filePath = z.string().min(1).max(32768)
  .describe("Path on the peer, in its own syntax. Relative paths and ~ start from the default working directory and the peer user's home.");
const directoryPath = filePath.optional()
  .describe("Directory on the peer, in its own syntax. Defaults to the default working directory, else the peer user's home.");
const listLimit = z.int().min(1).max(MAX_GLOB_RESULTS).optional();
const kindSchema = z.enum(["file", "directory", "symlink", "other"]);
const readInput = z.strictObject({
  path: filePath,
  peer,
  offset: z.int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("First line to return, counting from 1. Default 1."),
  limit: z.int().min(1).max(1_000_000).optional().describe(`How many lines to return at most. Default ${DEFAULT_READ_LINES}.`),
});
const readOutput = z.object({
  peer: z.string(),
  path: z.string().describe("The absolute path read."),
  content: z.string().describe("The lines returned, exactly as in the file, joined with newlines."),
  startLine: z.int(),
  endLine: z.int().describe("The last line returned; startLine - 1 when none were."),
  totalLines: z.int().nullable().describe("Lines in the file, when the read reached its end."),
  size: z.int().describe("The file's size in bytes."),
  truncated: z.boolean().describe("True when the file goes on beyond endLine."),
  nextOffset: z.int().nullable().describe("The offset that continues the read, when truncated."),
});
const writeInput = z.strictObject({
  path: filePath,
  content: z.string().max(MAX_WRITE_BYTES).describe(`The whole new content, written as UTF-8, up to ${MAX_WRITE_BYTES / 1024 / 1024} MiB.`),
  peer,
});
const listInput = z.strictObject({
  path: directoryPath,
  peer,
  limit: listLimit.describe(`How many entries to return at most. Default ${DEFAULT_LIST_LIMIT}.`),
});
const globInput = z.strictObject({
  pattern: z.string().min(1).max(1024).describe("Glob pattern matched against paths relative to path, such as **/*.ts or src/*.{js,json}."),
  path: directoryPath,
  ignore: z.array(z.string().min(1).max(1024)).max(64).optional()
    .describe("Glob patterns of paths to leave out, relative to path. One ending in /**, such as **/node_modules/**, also skips searching that directory."),
  peer,
  limit: listLimit.describe(`How many paths to return at most. Default ${DEFAULT_LIST_LIMIT}.`),
});

/** The peer's path rules: Windows peers use backslashes and drive letters. */
const pathsOf = (info: ShellInfo) => info.platform === "win32" ? path.win32 : path.posix;

interface FileCall { peerId: string; files: PeerFiles; paths: typeof path.posix; resolve(file: string | undefined): string }

/** The peer a file call uses, with its files and paths resolved against its working directory and home. */
async function fileCall(link: Link, target: McpTarget, requested: string | undefined): Promise<FileCall> {
  const peerId = await link.peer(requested);
  const summary = (await link.controller.peers()).find((candidate) => candidate.id === peerId);
  if (!summary) throw new Error(`Peer ${peerId} is no longer connected.`);
  const { info } = summary;
  const paths = pathsOf(info);
  const base = target.cwd ?? info.cwd;
  const resolve = (file: string | undefined) => {
    if (file === undefined) return base;
    if (file === "~") return info.cwd;
    if (file.startsWith("~/") || (paths === path.win32 && file.startsWith("~\\"))) return paths.join(info.cwd, file.slice(2));
    return paths.resolve(base, file);
  };
  return { peerId, files: await link.controller.files(peerId), paths, resolve };
}

const isMissing = (error: unknown) => /^ENOENT\b/.test(errorMessage(error)) || (error instanceof Error && "code" in error && error.code === "ENOENT");

interface ReadResult {
  content: string;
  endLine: number;
  totalLines: number | null;
  size: number;
  /** The first line not returned whole, when there is one. */
  nextOffset: number | null;
}

/** The start of a line too long for a result, cut between characters. */
function cutLine(text: string): string {
  let end = MAX_RESULT_CHARS - 64;
  if (isLowSurrogate(text, end)) end--;
  return `${text.slice(0, end)}[... line shortened ...]`;
}

/**
 * Lines `offset` to `offset + limit - 1` of a text file, read in chunks from its
 * start. A result ends early, on a line boundary, rather than exceed
 * MAX_RESULT_CHARS; a single longer line comes back shortened.
 */
export async function readLines(files: PeerFiles, file: string, offset: number, limit: number): Promise<ReadResult> {
  const decoder = new TextDecoder("utf-8");
  const last = offset + limit - 1;
  const lines: string[] = [];
  let seen = 0; // Complete lines so far.
  let chars = 0;
  let partial = "";
  let position = 0;
  let size = 0;
  /** Take line `seen + 1`; returns the next offset once the result is full. */
  const take = (text: string): number | undefined => {
    const number = ++seen;
    if (number < offset) return undefined;
    if (number > last) return number;
    const added = text.length + (lines.length ? 1 : 0);
    if (chars + added <= MAX_RESULT_CHARS) {
      lines.push(text);
      chars += added;
      return undefined;
    }
    if (lines.length) return number;
    lines.push(cutLine(text));
    return number + 1;
  };
  const result = (nextOffset: number | null, totalLines: number | null): ReadResult =>
    ({ content: lines.join("\n"), endLine: offset + lines.length - 1, totalLines, size, nextOffset });
  for (;;) {
    if (position >= MAX_SCAN_BYTES) {
      throw new Error(`Line ${offset} is beyond the first ${MAX_SCAN_BYTES / 1024 / 1024} MiB of ${file}; use run_command with tail, sed or Get-Content to reach it.`);
    }
    const chunk = await plain(files.readFile(file, { offset: position, length: MAX_FILE_CHUNK_BYTES }));
    const data = new Uint8Array(chunk.data);
    if (position === 0 && data.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
      throw new Error(`${file} is a binary file (${chunk.size} bytes); read_file reads text. Use run_command, for example with base64 or xxd, to see its bytes.`);
    }
    size = chunk.size;
    position += data.byteLength;
    const eof = chunk.eof || data.byteLength === 0;
    const parts = (partial + decoder.decode(data, { stream: !eof })).split("\n");
    partial = parts.pop()!;
    for (const part of parts) {
      const next = take(part);
      if (next !== undefined) return result(next, null);
    }
    if (eof) {
      if (partial !== "") {
        const next = take(partial);
        if (next !== undefined) return result(next > seen ? null : next, next > seen ? seen : null);
      }
      return result(null, seen);
    }
    // A line too long to return whole need not be read to its end.
    if (seen + 1 >= offset && seen + 1 <= last && partial.length > MAX_RESULT_CHARS) {
      const next = take(partial);
      if (next !== undefined) return result(next, null);
    }
  }
}

/** Every tool the server offers. */
export const TOOL_NAMES = [
  "list_peers", "run_command", "start_session", "send_keys", "read_screen", "list_sessions", "kill_session",
  "read_file", "write_file", "list_directory", "glob",
] as const;
export type ToolName = typeof TOOL_NAMES[number];

/** One finished tool call, for an audit log. */
export interface ToolCall {
  tool: ToolName;
  /** The arguments as the client sent them, after validation. */
  args: Record<string, unknown>;
  /** False for an error result, or a call that was cancelled or threw. */
  ok: boolean;
  elapsedMs: number;
}

export interface McpServerOptions {
  /** Offer only these tools; by default every tool. */
  tools?: readonly ToolName[];
  /** Called once each call ends. */
  onCall?: (call: ToolCall) => void;
}

/** A fresh server for one MCP connection or HTTP request, with tools that reach `target`'s peers. */
export function createMcpServer(target: McpTarget, options: McpServerOptions = {}): McpServer {
  const mcp = new McpServer({ name: "cns", title: "Cap'n Shell", version: manifest.version }, { instructions });
  const { tools, onCall } = options;
  // Tools left out are never registered, so a client cannot list or call them.
  const server = {
    registerTool: ((name: ToolName, config: never, handler: (args: Record<string, unknown>, ctx: ServerContext) => Promise<CallToolResult>) => {
      if (tools && !tools.includes(name)) return undefined;
      if (!onCall) return mcp.registerTool(name, config, handler as never);
      return mcp.registerTool(name, config, (async (args: Record<string, unknown>, ctx: ServerContext) => {
        const started = Date.now();
        let ok = false;
        try {
          const result = await handler(args, ctx);
          ok = !result.isError;
          return result;
        } finally {
          try { onCall({ tool: name, args, ok, elapsedMs: Date.now() - started }); } catch { /* An audit failure never fails the call. */ }
        }
      }) as never);
    }) as unknown as McpServer["registerTool"],
  };

  server.registerTool("list_peers", {
    title: "List peers",
    description: "List the peers this server reaches, with each one's name (for a paired device), ID, hostname, operating system, shell and home directory. " +
      "Other tools take the name as `peer`; a peer's ID changes whenever it reconnects, so use the ID only for a peer without a name.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ peers: z.array(peerSchema) }),
    annotations: observing,
  }, async (_args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const peers = (await link.controller.peers()).map(({ id, info, peer }) => ({
      id, hostname: info.hostname, platform: info.platform, os: info.name, shell: info.shell, home: info.cwd, pid: info.pid,
      ...peer ? { name: peer.name, fingerprint: peer.fingerprint } : {},
    }));
    const text = peers.length
      ? peers.map((p) => `${p.name ? `${p.name} (paired; ID ${p.id} until it reconnects)` : p.id}  ${p.hostname}  ${p.os}  ${p.shell}  home: ${p.home}`).join("\n")
      : "No peers are connected.";
    return { text, structured: { peers } };
  }));

  server.registerTool("run_command", {
    title: "Run command",
    description: "Run one shell command on a peer and return its exit code, stdout and stderr when it finishes. " +
      "It runs in a fresh non-interactive shell, Bash or Windows PowerShell as list_peers shows, so use that shell's syntax. " +
      "Nothing persists between calls and stdin is closed. The peer keeps up to 1 MiB of output; long output is shortened " +
      "to its start and end here, so redirect to a file and read parts of it when you need all of it. " +
      "For interactive programs or programs that keep running, use start_session.",
    inputSchema: runInput,
    outputSchema: runOutput,
    annotations: destructive,
  }, async (args, ctx) => invoke(target, ctx, "Running", async (link) => {
    const peerId = await link.peer(args.peer);
    const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const result = await link.controller.run(peerId, args.command, { cwd: args.cwd ?? target.cwd, timeoutMs });
    const stdout = clip(result.stdout);
    const stderr = clip(result.stderr);
    const status = result.timedOut ? `Timed out after ${timeoutMs} ms; its processes were killed`
      : result.exitCode !== null ? `Exit code ${result.exitCode}` : `Killed by ${result.signal ?? "a signal"}`;
    const lines = [`${status} (${result.elapsedMs} ms).`];
    if (stdout.text) lines.push("--- stdout ---", stdout.text);
    if (stderr.text) lines.push("--- stderr ---", stderr.text);
    if (!stdout.text && !stderr.text) lines.push("(no output)");
    if (result.truncated) lines.push("[The peer discarded output beyond 1 MiB.]");
    return {
      text: lines.join("\n"),
      structured: {
        peer: peerId, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, elapsedMs: result.elapsedMs,
        stdout: stdout.text, stderr: stderr.text, truncated: result.truncated || stdout.clipped || stderr.clipped,
      },
    };
  }));

  server.registerTool("start_session", {
    title: "Start terminal session",
    description: "Start a program in a named terminal session (PTY) on a peer and leave it running between calls. " +
      "Use it for interactive programs, REPLs, TUIs, servers and watchers. Type into it with send_keys and read its rendered " +
      "screen with read_screen. It lasts until kill_session, or until cns stops on the peer. Without command it starts the " +
      "peer user's login shell. Pass until to wait for the program's first prompt.",
    inputSchema: startInput,
    outputSchema: z.object({ session: sessionSchema, matched: viewSchema.matched, screen: screenSchema.optional() }),
    annotations: destructive,
  }, async (args, ctx) => invoke(target, ctx, args.until === undefined ? undefined : `Waiting for ${JSON.stringify(args.until)}`, async (link) => {
    const peerId = await link.peer(args.peer);
    const { command, cols, rows, term, timeoutMs } = args;
    let info = await link.controller.startPtySession(peerId, args.name, { command, cwd: args.cwd ?? target.cwd, cols, rows, term, timeoutMs });
    const started = `Started session ${args.name} (pid ${info.pid}, ${info.cols}x${info.rows}).`;
    if (args.until === undefined) return { text: started, structured: { session: toSession(info) } };
    const view = await withSession(link, peerId, args.name, async (session) => {
      const seen = await look(session, args);
      if (!seen.running) info = await plain(session.info());
      return seen;
    });
    return {
      text: `${started}\n${describeView(args.name, view, args)}`,
      structured: { session: toSession(info), matched: view.matched, screen: view.screen },
    };
  }));

  server.registerTool("send_keys", {
    title: "Send keys",
    description: "Type into a named session. Each item is a tmux-style key name or literal text: Enter, Tab, BTab, Escape, " +
      "Space, BSpace, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, Delete and F1-F12, with C-, M- and S- " +
      "prefixes such as C-c, M-x or C-Left. Items that are not key names are typed as they are, so [\"git status\", \"Enter\"] " +
      "runs a command in a shell. Pass until to wait for the result and return the screen; choose text that appears only " +
      "once the keys have taken effect.",
    inputSchema: keysInput,
    outputSchema: keysOutput,
    annotations: destructive,
  }, async (args, ctx) => invoke(target, ctx, args.until === undefined ? undefined : `Waiting for ${JSON.stringify(args.until)}`, async (link) => {
    const peerId = await link.peer(args.peer);
    return await withSession(link, peerId, args.name, async (session) => {
      await session.keys(args.keys, { literal: args.literal });
      const sent = `Sent ${args.keys.length} item${args.keys.length === 1 ? "" : "s"} to ${args.name}.`;
      if (args.until === undefined) return { text: sent, structured: { sent: args.keys.length } };
      const view = await look(session, args);
      return { text: `${sent}\n${describeView(args.name, view, args)}`, structured: { sent: args.keys.length, ...view } };
    });
  }));

  server.registerTool("read_screen", {
    title: "Read screen",
    description: "Return a named session's rendered terminal screen, as tmux capture-pane prints it. Pass until to first wait " +
      "for some text to appear, checked after every chunk of output, instead of sleeping.",
    inputSchema: screenInput,
    outputSchema: z.object(viewSchema),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, args.until === undefined ? undefined : `Waiting for ${JSON.stringify(args.until)}`, async (link) => {
    const peerId = await link.peer(args.peer);
    const view = await withSession(link, peerId, args.name, (session) => look(session, args));
    return { text: describeView(args.name, view, args), structured: { ...view } };
  }));

  server.registerTool("list_sessions", {
    title: "List sessions",
    description: "List a peer's named sessions with their status, size, attached terminals and command.",
    inputSchema: z.strictObject({ peer }),
    outputSchema: z.object({ sessions: z.array(sessionSchema) }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const sessions = await link.controller.ptySessions(await link.peer(args.peer));
    return { text: sessions.length ? formatSessions(sessions) : "No named sessions.", structured: { sessions: sessions.map(toSession) } };
  }));

  server.registerTool("kill_session", {
    title: "Kill session",
    description: "End a named session: hang up its program if it is still running, then remove the session and its screen.",
    inputSchema: z.strictObject({ name, peer }),
    outputSchema: z.object({ exit: exitSchema }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const peerId = await link.peer(args.peer);
    const exit = await withSession(link, peerId, args.name, (session) => plain(session.kill()));
    return { text: `Removed session ${args.name} (${describeExit(exit)}).`, structured: { exit: toExit(exit) } };
  }));

  server.registerTool("read_file", {
    title: "Read file",
    description: "Read a text file on a peer and return its lines exactly as they are, without line numbers. " +
      `Returns up to ${DEFAULT_READ_LINES} lines from offset by default and at most ${MAX_RESULT_CHARS} characters; ` +
      "when truncated, call again with nextOffset to continue. Binary files are refused.",
    inputSchema: readInput,
    outputSchema: readOutput,
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const call = await fileCall(link, target, args.peer);
    const file = call.resolve(args.path);
    const offset = args.offset ?? 1;
    const read = await readLines(call.files, file, offset, args.limit ?? DEFAULT_READ_LINES);
    const count = read.endLine - offset + 1;
    const of = read.totalLines === null ? "" : ` of ${read.totalLines}`;
    let header: string;
    if (read.totalLines === 0) header = `${file}: empty file`;
    else if (count === 0) header = `${file}: no lines from line ${offset}${of}`;
    else header = `${file}: lines ${offset}-${read.endLine}${of}`;
    const lines = [`[${header} · ${read.size} bytes]`];
    if (count > 0) lines.push(read.content);
    if (read.nextOffset !== null) lines.push(`[More lines follow; pass offset ${read.nextOffset} to continue.]`);
    return {
      text: lines.join("\n"),
      structured: {
        peer: call.peerId, path: file, content: read.content, startLine: offset, endLine: read.endLine, totalLines: read.totalLines,
        size: read.size, truncated: read.nextOffset !== null, nextOffset: read.nextOffset,
      },
    };
  }));

  server.registerTool("write_file", {
    title: "Write file",
    description: "Create or replace a file on a peer with the given text, written as UTF-8. Missing parent directories are created. " +
      "An existing file is overwritten in place, keeping its permissions; links are followed. " +
      `The content can be up to ${MAX_WRITE_BYTES / 1024 / 1024} MiB. To change part of a file, read it, edit the text and write it back.`,
    inputSchema: writeInput,
    outputSchema: z.object({ peer: z.string(), path: z.string(), bytes: z.int(), created: z.boolean().describe("True when the file did not exist before.") }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const call = await fileCall(link, target, args.peer);
    const file = call.resolve(args.path);
    const data = Buffer.from(args.content, "utf8");
    if (data.byteLength > MAX_WRITE_BYTES) {
      throw new Error(`The content is ${data.byteLength} bytes as UTF-8; write_file accepts at most ${MAX_WRITE_BYTES}.`);
    }
    let created = false;
    try {
      const existing = await plain(call.files.stat(file));
      if (existing.kind === "directory") throw new Error(`${file} is a directory.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      created = true;
      await call.files.mkdir(call.paths.dirname(file));
    }
    await call.files.writeFile(file, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    return {
      text: `${created ? "Created" : "Wrote"} ${file} (${data.byteLength} bytes).`,
      structured: { peer: call.peerId, path: file, bytes: data.byteLength, created },
    };
  }));

  server.registerTool("list_directory", {
    title: "List directory",
    description: "List a directory on a peer: each entry's name and whether it is a file, directory, symbolic link or other. " +
      "Directories are shown with a trailing slash in the text. Hidden entries are included.",
    inputSchema: listInput,
    outputSchema: z.object({
      peer: z.string(),
      path: z.string(),
      entries: z.array(z.object({ name: z.string(), kind: kindSchema })),
      truncated: z.boolean().describe("True when the directory has more entries than were returned."),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const call = await fileCall(link, target, args.peer);
    const directory = call.resolve(args.path);
    const limit = args.limit ?? DEFAULT_LIST_LIMIT;
    const all = await plain(call.files.readdir(directory));
    all.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const entries = all.slice(0, limit);
    const truncated = all.length > limit || all.length >= MAX_DIRECTORY_ENTRIES;
    const listing = entries.map((entry) => entry.kind === "directory" ? `${entry.name}/` : entry.name).join("\n");
    const lines = [`[${directory}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}${truncated ? ", more not shown" : ""}]`];
    if (listing) lines.push(clip(listing).text);
    return { text: lines.join("\n"), structured: { peer: call.peerId, path: directory, entries, truncated } };
  }));

  server.registerTool("glob", {
    title: "Find files",
    description: "Find files on a peer whose path relative to a directory matches a glob pattern, such as **/*.ts, and return " +
      "their absolute paths. * and ? stay within one path segment, ** crosses directories, {a,b} picks alternatives. " +
      "Hidden files are included and symbolic links are not followed. Pass ignore, such as **/node_modules/**, to skip " +
      "large directories.",
    inputSchema: globInput,
    outputSchema: z.object({
      peer: z.string(),
      path: z.string(),
      paths: z.array(z.string()),
      truncated: z.boolean().describe("True when more paths match than were returned."),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, "Searching", async (link) => {
    const call = await fileCall(link, target, args.peer);
    const directory = call.resolve(args.path);
    const limit = args.limit ?? DEFAULT_LIST_LIMIT;
    // One more than the limit tells whether there are more.
    const found = await plain(call.files.glob(args.pattern, directory, { ignore: args.ignore ?? [], limit: Math.min(limit + 1, MAX_GLOB_RESULTS) }));
    const paths = found.slice(0, limit);
    const truncated = found.length > limit || found.length >= MAX_GLOB_RESULTS;
    const lines = [`[${paths.length} ${paths.length === 1 ? "match" : "matches"} for ${args.pattern} in ${directory}${truncated ? ", more not shown" : ""}]`];
    if (paths.length) lines.push(clip(paths.join("\n")).text);
    return { text: lines.join("\n"), structured: { peer: call.peerId, path: directory, paths, truncated } };
  }));

  return mcp;
}
