import path from "node:path";
import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DEFAULT_UNTIL_MS, describeExit, formatSessions } from "../session-text.js";
import { errorMessage } from "../errors.js";
import { CNS_VERSION, describeVersion, reportedVersion, versionOrder } from "../version.js";
import { explainDenial } from "../peers.js";
import { MAX_KEYS } from "../keys.js";
import { commandSchema, MAX_ENV_VARIABLES } from "../platform.js";
import { byNewest, mainFile, type SkillFile } from "../skills.js";
import {
  MAX_DIRECTORY_ENTRIES, MAX_FILE_CHUNK_BYTES, MAX_GLOB_RESULTS, MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, MAX_WRITE_BYTES, sessionNameSchema,
  type PtyExit, type PtyScreen, type PtySessionInfo, type ShellInfo,
} from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import type { PeerSummary } from "../console.js";
import type { Link, McpTarget, PeerFiles } from "./target.js";

/** Agents rarely mean to wait forever, and some clients give up silently. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
/** Each of stdout, stderr and a screen is shortened to this many characters in a result. */
export const MAX_RESULT_CHARS = 30_000;
const PROGRESS_MS = 10_000;

const instructions = `cns runs commands and terminal programs on other machines ("peers") as the user running cns there.
- list_peers shows each peer's operating system and shell. Commands use that shell's syntax: Bash on Linux and macOS, Windows PowerShell on Windows.
- run_command starts a fresh non-interactive shell for every call and returns when the command finishes. cd and variables do not persist; pass cwd instead. Stdin is closed.
- For interactive programs, REPLs, TUIs, servers and watchers, use a named session: start_session, then send_keys and read_screen, then kill_session. Sessions keep running between calls until killed, and other clients of the same peer can see them. A session whose program has ended keeps its final screen for an hour, then the peer removes it.
- To wait for a program, pass until to read_screen or send_keys rather than sleeping.
- For files on a peer, use read_file, write_file, list_directory and glob rather than cat, echo or ls through run_command. Paths are in the peer's own syntax; relative ones start from the default working directory.
- Peers keep agent skills in ~/.agents/skills: list_skills shows each one's name and description, read_skill reads its SKILL.md and then the files it points to, and search_skills finds text in them. When a task matches a skill's description, read that skill first and follow it.
- For mesh secrets, such as API keys and tokens, list_secrets shows the names a peer holds. Pass names as secrets to run_command or start_session: the peer sets them as the program's environment variables, and their values never appear in results unless the program prints them. Do not print them.
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
const secrets = z.array(z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:)?[A-Za-z_][A-Za-z0-9_]{0,127}$/, "A secret is NAME, or MESH:NAME when two meshes hold the name."))
  .min(1).max(MAX_ENV_VARIABLES).optional()
  .describe("Mesh secrets the peer holds, such as API keys, to set as the program's environment variables: each NAME, or MESH:NAME, from list_secrets. " +
    "The peer opens its own copies, so values never pass through this server or show in results unless the program prints them.");

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
  viewers: z.int().describe("Terminals attached with cns shell --attach."),
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
  version: z.string().optional().describe("The cns version the peer runs; absent for a release too old to report it."),
});
const runInput = z.strictObject({
  command: commandSchema.describe("One command string in the peer shell's syntax, up to 8192 characters."),
  peer,
  cwd,
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).optional()
    .describe(`Kill the command's process tree after this many milliseconds. Default ${DEFAULT_RUN_TIMEOUT_MS}; 0 means no deadline.`),
  secrets,
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
  secrets,
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

interface FileCall {
  peerId: string;
  /** What to call the peer in results: its name, else its ID. */
  label: string;
  files: PeerFiles;
  paths: typeof path.posix;
  resolve(file: string | undefined): string;
}

/** The peer a file call uses, with its files and paths resolved against its working directory and home. */
async function fileCall(link: Link, target: McpTarget, requested: string | undefined): Promise<FileCall> {
  const peerId = await link.peer(requested);
  const summary = (await link.controller.peers()).find((candidate) => candidate.id === peerId);
  if (!summary) throw new Error(`Peer ${peerId} is no longer connected.`);
  return await callOn(link, target, summary);
}

/** A file call on the peer `summary` describes. */
async function callOn(link: Link, target: McpTarget, summary: PeerSummary): Promise<FileCall> {
  const peerId = summary.id;
  const { info } = summary;
  const paths = pathsOf(info);
  const base = target.cwd ?? info.cwd;
  const resolve = (file: string | undefined) => {
    if (file === undefined) return base;
    if (file === "~") return info.cwd;
    if (file.startsWith("~/") || (paths === path.win32 && file.startsWith("~\\"))) return paths.join(info.cwd, file.slice(2));
    return paths.resolve(base, file);
  };
  return { peerId, label: summary.peer?.name ?? peerId, files: await link.controller.files(peerId), paths, resolve };
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
export async function readLines(files: Pick<PeerFiles, "readFile">, file: string, offset: number, limit: number): Promise<ReadResult> {
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

/** The releases that first offer skills to paired devices, and secrets to the programs they start. */
const SKILLS_RELEASE = "2.2.0";
const SECRETS_RELEASE = "2.3.0";

/**
 * Say which cns to update when a call fails because the peer, or the local daemon between,
 * runs one from before `release`: it lacks the call, or refuses the secrets option, before
 * doing anything.
 */
async function older(error: unknown, link: Link, peerId: string, what: string, release: string): Promise<unknown> {
  const message = errorMessage(error);
  const missing = /^'\w+' is not a function\.$/.test(message);
  if (!missing && !(/unrecognized.key/i.test(message) && /\b(secrets|env)\b/.test(message))) return error;
  const summary = (await link.controller.peers().catch(() => [])).find((candidate) => candidate.id === peerId);
  const label = summary?.peer?.name ?? peerId;
  const version = reportedVersion(summary?.info.version);
  // A peer new enough that lacks the call was reached through a daemon that is not.
  if (missing && ["same", "newer"].includes(versionOrder(version, release))) {
    return new Error("The local daemon runs an older cns than this one, which does not pass this call on. Restart it: cns stop, then cns up.", { cause: error });
  }
  return new Error(`${label} runs ${describeVersion(version)}, from before ${what}, so nothing was done there. Update cns on ${label} to ${release} or later.`, { cause: error });
}

/** How long each peer gets to list its skills, so one offline peer does not hold up the others. */
const SKILLS_ANSWER_MS = 10_000;
/** Matches search_skills returns when the call does not say. */
const DEFAULT_MATCHES = 100;
/** Skill files larger than this are not searched; skills are text. */
const MAX_SEARCH_BYTES = 1024 * 1024;

/** One peer's copy of a skill. */
interface SkillCopy { call: FileCall; name: string; description: string; modifiedMs: number }
/** A peer whose skills were not listed, and why. */
interface Unlisted { peer: string; reason: string }

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** `promise`, or an error once `ms` pass. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The skills of the peer `requested`, or of every connected peer, asked at once. A named
 * peer's failure fails the call; with every peer, one that fails is reported in `unlisted`.
 */
async function gatherSkills(link: Link, target: McpTarget, requested: string | undefined): Promise<{ copies: SkillCopy[]; unlisted: Unlisted[] }> {
  const summaries = await link.controller.peers();
  const ids = requested === undefined ? summaries.map((summary) => summary.id) : [await link.peer(requested)];
  const answers = await Promise.all(ids.map(async (id): Promise<SkillCopy[] | Unlisted> => {
    const summary = summaries.find((candidate) => candidate.id === id);
    const label = summary?.peer?.name ?? id;
    try {
      if (!summary) throw new Error(`Peer ${id} is no longer connected.`);
      const call = await callOn(link, target, summary);
      try {
        const skills = await within(SKILLS_ANSWER_MS, plain(call.files.skills()));
        return skills.map((skill) => ({ call, name: skill.name, description: skill.description, modifiedMs: skill.modifiedMs }));
      } catch (error) { throw await older(error, link, id, "skills", SKILLS_RELEASE); }
    } catch (error) {
      if (requested !== undefined) throw error;
      return { peer: label, reason: explainDenial(errorMessage(error), target.device ?? summary?.peer?.name) };
    }
  }));
  return {
    copies: answers.flatMap((answer) => Array.isArray(answer) ? answer : []),
    unlisted: answers.filter((answer): answer is Unlisted => !Array.isArray(answer)),
  };
}

/** The copies of each skill, newest first, as cns skills list orders them. */
const newestSkills = (copies: readonly SkillCopy[]) => byNewest(copies.map((copy) => ({ ...copy, device: copy.call.label })));

/** Why a skill was not found, with the skills that were and the peers that were not asked. */
function noSkill(name: string, requested: string | undefined, copies: readonly SkillCopy[], unlisted: readonly Unlisted[]): Error {
  const names = [...new Set(copies.map((copy) => copy.name))];
  const where = requested === undefined ? "on the peers that answered" : `on ${requested}`;
  const known = names.length ? ` Skills there: ${names.join(", ")}.` : "";
  const missed = unlisted.length ? ` Not listed: ${unlisted.map((entry) => `${entry.peer} (${entry.reason})`).join("; ")}.` : "";
  return new Error(`No skill ${name} ${where}.${known}${missed}`);
}

/** The lines of a skill's file that match `expression`; none for a binary or very large file. */
async function searchSkillFile(copy: SkillCopy, file: SkillFile, expression: RegExp) {
  if (file.size > MAX_SEARCH_BYTES) return [];
  const parts: Uint8Array[] = [];
  for (let offset = 0; ;) {
    const chunk = await plain(copy.call.files.readSkillFile(copy.name, file.path, { offset }));
    const data = new Uint8Array(chunk.data);
    parts.push(data);
    offset += data.byteLength;
    if (chunk.eof || !data.byteLength || offset > MAX_SEARCH_BYTES) break;
  }
  const bytes = Buffer.concat(parts);
  if (bytes.includes(0)) return [];
  return bytes.toString("utf8").split(/\r?\n/).flatMap((text, index) => expression.test(text)
    ? [{ peer: copy.call.label, skill: copy.name, file: file.path, line: index + 1, text: text.length > 500 ? `${text.slice(0, 500)}...` : text }]
    : []);
}

/** Every tool the server offers. */
export const TOOL_NAMES = [
  "list_peers", "run_command", "start_session", "send_keys", "read_screen", "list_sessions", "kill_session",
  "read_file", "write_file", "list_directory", "glob", "list_skills", "read_skill", "search_skills", "list_secrets",
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
  /** Variables of this process that run_command and start_session may set for their programs, by name (cns mcp --env). */
  env?: readonly string[];
}

/** `names`' values in this process, for a program on a peer. */
function localEnv(names: readonly string[] | undefined): { env?: Record<string, string> } {
  if (!names?.length) return {};
  const unset = names.find((name) => process.env[name] === undefined);
  if (unset !== undefined) throw new Error(`${unset} is not set where cns mcp runs. Set it in the environment the MCP client starts cns mcp with.`);
  return { env: Object.fromEntries(names.map((name) => [name, process.env[name]!])) };
}

/** A fresh server for one MCP connection or HTTP request, with tools that reach `target`'s peers. */
export function createMcpServer(target: McpTarget, options: McpServerOptions = {}): McpServer {
  const { tools, onCall, env: names = [] } = options;
  // Only a server with variables to pass on offers env, listing their names.
  const env = names.length ? {
    env: z.array(z.enum(names as [string, ...string[]])).min(1).max(MAX_ENV_VARIABLES).optional()
      .describe(`Variables from where this MCP server runs to set for the program, by name: ${names.join(", ")}. ` +
        "The server sends their values over the encrypted link, so they never show in results unless the program prints them."),
  } : {};
  const passed = names.length ? `\n- Variables from where this server runs can be set for programs by name: pass env, such as ["${names[0]}"], to run_command or start_session. They are ${names.join(", ")}. Do not print them.` : "";
  const mcp = new McpServer({ name: "cns", title: "Cap'n Shell", version: CNS_VERSION }, { instructions: instructions + passed });
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
      // A device sends what it likes here; only a version is passed on.
      ...reportedVersion(info.version) ? { version: reportedVersion(info.version) } : {},
    }));
    const text = peers.length
      ? peers.map((p) => `${p.name ? `${p.name} (paired; ID ${p.id} until it reconnects)` : p.id}  ${p.hostname}  ${p.os}  ${p.shell}  home: ${p.home}  ${p.version ? `cns ${p.version}` : "older cns"}`).join("\n")
      : "No peers are connected.";
    return { text, structured: { peers } };
  }));

  server.registerTool("run_command", {
    title: "Run command",
    description: "Run one shell command on a peer and return its exit code, stdout and stderr when it finishes. " +
      "It runs in a fresh non-interactive shell, Bash or Windows PowerShell as list_peers shows, so use that shell's syntax. " +
      "Nothing persists between calls and stdin is closed. The peer keeps up to 1 MiB of output; long output is shortened " +
      "to its start and end here, so redirect to a file and read parts of it when you need all of it. " +
      "Pass secrets to give the command mesh secrets, such as API keys, as environment variables without their values passing through here. " +
      "For interactive programs or programs that keep running, use start_session.",
    inputSchema: runInput.extend(env),
    outputSchema: runOutput,
    annotations: destructive,
  }, async (args, ctx) => invoke(target, ctx, "Running", async (link) => {
    const peerId = await link.peer(args.peer);
    const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    // Only a call that names secrets sends the option, so every other call still runs on a peer with an older cns.
    const result = await link.controller.run(peerId, args.command, { cwd: args.cwd ?? target.cwd, timeoutMs, ...args.secrets ? { secrets: args.secrets } : {}, ...localEnv((args as { env?: string[] }).env) })
      .catch(async (error: unknown) => { throw await older(error, link, peerId, "secrets for agents", SECRETS_RELEASE); });
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
    inputSchema: startInput.extend(env),
    outputSchema: z.object({ session: sessionSchema, matched: viewSchema.matched, screen: screenSchema.optional() }),
    annotations: destructive,
  }, async (args, ctx) => invoke(target, ctx, args.until === undefined ? undefined : `Waiting for ${JSON.stringify(args.until)}`, async (link) => {
    const peerId = await link.peer(args.peer);
    const { command, cols, rows, term, timeoutMs } = args;
    let info = await link.controller.startPtySession(peerId, args.name, { command, cwd: args.cwd ?? target.cwd, cols, rows, term, timeoutMs, ...args.secrets ? { secrets: args.secrets } : {}, ...localEnv((args as { env?: string[] }).env) })
      .catch(async (error: unknown) => { throw await older(error, link, peerId, "secrets for agents", SECRETS_RELEASE); });
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

  server.registerTool("list_skills", {
    title: "List skills",
    description: "List the agent skills on the peers: each skill in a peer's ~/.agents/skills with its name, description and when it last changed. " +
      "A skill is instructions, and often scripts and references, for one kind of task; when a task matches a description, read the skill with read_skill and follow it. " +
      "Without peer, every connected peer is asked and each skill is listed once, from the peer with its newest copy.",
    inputSchema: z.strictObject({ peer }),
    outputSchema: z.object({
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        peer: z.string().describe("The peer with the newest copy, which read_skill reads by default."),
        modified: z.string(),
        alsoOn: z.array(z.string()).describe("Other peers with a copy of the same name."),
      })),
      unlisted: z.array(z.object({ peer: z.string(), reason: z.string() })).describe("Peers whose skills could not be listed, and why."),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const { copies, unlisted } = await gatherSkills(link, target, args.peer);
    const skills = [...newestSkills(copies)].map(([name, [newest, ...others]]) => ({
      name, description: newest!.description, peer: newest!.call.label, modified: new Date(newest!.modifiedMs).toISOString(), alsoOn: others.map((copy) => copy.call.label),
    }));
    const lines = skills.length
      ? skills.map((skill) => `${skill.name} (${skill.peer}${skill.alsoOn.length ? `; also on ${skill.alsoOn.join(", ")}` : ""}): ${skill.description || "no description"}`)
      : ["No skills on the peers that answered."];
    for (const entry of unlisted) lines.push(`[Not listed: ${entry.peer}: ${entry.reason}]`);
    return { text: clip(lines.join("\n")).text, structured: { skills, unlisted } };
  }));

  server.registerTool("read_skill", {
    title: "Read skill",
    description: "Read an agent skill from a peer: its SKILL.md by default, or another of its files, and the list of its files. " +
      `Returns up to ${DEFAULT_READ_LINES} lines from offset; when truncated, call again with nextOffset. ` +
      "SKILL.md says when and how to use the skill and names its other files; read those it points to with file. " +
      "Without peer, the newest copy on any connected peer is read.",
    inputSchema: z.strictObject({
      name: z.string().min(1).max(255).describe("The skill's name, as list_skills shows it."),
      file: z.string().min(1).max(4096).optional().describe("A file of the skill, relative to its directory with / between parts, such as references/api.md. Default SKILL.md."),
      peer,
      offset: readInput.shape.offset,
      limit: readInput.shape.limit,
    }),
    outputSchema: z.object({
      peer: z.string(),
      name: z.string(),
      file: z.string(),
      content: z.string(),
      startLine: z.int(),
      endLine: z.int(),
      totalLines: z.int().nullable(),
      size: z.int(),
      truncated: z.boolean(),
      nextOffset: z.int().nullable(),
      modified: z.string().describe("When the skill last changed: its newest file's time."),
      files: z.array(z.object({ path: z.string(), size: z.int() })).describe("Every file of the skill."),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const { copies, unlisted } = await gatherSkills(link, target, args.peer);
    const copy = newestSkills(copies).get(args.name)?.[0];
    if (!copy) throw noSkill(args.name, args.peer, copies, unlisted);
    const { call, name } = copy;
    const files = await plain(call.files.skillFiles(name));
    const file = args.file?.replaceAll("\\", "/") ?? mainFile(files)?.path;
    if (file === undefined) throw new Error(`The skill ${name} on ${call.label} has no SKILL.md.`);
    const offset = args.offset ?? 1;
    const read = await readLines({ readFile: (file, options) => call.files.readSkillFile(name, file, options) } as Pick<PeerFiles, "readFile">, file, offset, args.limit ?? DEFAULT_READ_LINES);
    const of = read.totalLines === null ? "" : ` of ${read.totalLines}`;
    const count = read.endLine - offset + 1;
    const range = read.totalLines === 0 ? "empty file" : count === 0 ? `no lines from line ${offset}${of}` : `lines ${offset}-${read.endLine}${of}`;
    const lines = [`[${name}/${file} on ${call.label}: ${range} · ${read.size} bytes · skill modified ${utc(copy.modifiedMs)}]`];
    if (count > 0) lines.push(read.content);
    if (read.nextOffset !== null) lines.push(`[More lines follow; pass offset ${read.nextOffset} to continue.]`);
    const others = files.map((entry) => entry.path).filter((entry) => entry !== file);
    if (others.length) lines.push(`[Other files of ${name}: ${others.length > 50 ? `${others.slice(0, 50).join(", ")} and ${others.length - 50} more` : others.join(", ")}. Read one with read_skill and file.]`);
    return {
      text: lines.join("\n"),
      structured: {
        peer: call.label, name, file, content: read.content, startLine: offset, endLine: read.endLine, totalLines: read.totalLines, size: read.size,
        truncated: read.nextOffset !== null, nextOffset: read.nextOffset, modified: new Date(copy.modifiedMs).toISOString(),
        files: files.map((entry) => ({ path: entry.path, size: entry.size })),
      },
    };
  }));

  server.registerTool("search_skills", {
    title: "Search skills",
    description: "Find the lines of agent skills that match a regular expression, as skill/file:line: text. " +
      "It searches every text file of the newest copy of each skill on the connected peers, or of the skills named, " +
      "so it finds a skill for a task when list_skills' descriptions do not settle it.",
    inputSchema: z.strictObject({
      pattern: z.string().min(1).max(1024).describe("A JavaScript regular expression, such as deploy|release. Put \\ before ( [ { . * + ? to match them as they are."),
      skills: z.array(z.string().min(1).max(255)).min(1).max(100).optional().describe("Search only these skills, by name. Default: every skill."),
      ignoreCase: z.boolean().optional().describe("Match letters in either case."),
      peer,
      limit: z.int().min(1).max(1000).optional().describe(`How many matching lines to return at most. Default ${DEFAULT_MATCHES}.`),
    }),
    outputSchema: z.object({
      matches: z.array(z.object({ peer: z.string(), skill: z.string(), file: z.string(), line: z.int(), text: z.string() })),
      truncated: z.boolean().describe("True when more lines match than were returned."),
      unlisted: z.array(z.object({ peer: z.string(), reason: z.string() })).describe("Peers whose skills could not be searched, and why."),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, "Searching", async (link) => {
    let expression: RegExp;
    try { expression = new RegExp(args.pattern, args.ignoreCase ? "i" : ""); }
    catch (error) { throw new Error(`${args.pattern} is not a regular expression (${errorMessage(error)}); put \\ before characters such as ( [ { . * + ? to match them as they are.`); }
    const { copies, unlisted } = await gatherSkills(link, target, args.peer);
    const newest = [...newestSkills(copies).values()].map((group) => group[0]!);
    const missing = args.skills?.find((name) => !newest.some((copy) => copy.name === name));
    if (missing !== undefined) throw noSkill(missing, args.peer, copies, unlisted);
    const chosen = args.skills ? newest.filter((copy) => args.skills!.includes(copy.name)) : newest;
    const limit = args.limit ?? DEFAULT_MATCHES;
    const all: Awaited<ReturnType<typeof searchSkillFile>> = [];
    // Skill by skill, until there is one match more than the limit.
    for (const copy of chosen) {
      const files = await plain(copy.call.files.skillFiles(copy.name));
      for (const lines of await Promise.all(files.map((file) => searchSkillFile(copy, file, expression)))) all.push(...lines);
      if (all.length > limit) break;
    }
    const matches = all.slice(0, limit);
    const truncated = all.length > limit;
    const several = new Set(matches.map((match) => match.peer)).size > 1;
    const lines = [`[${matches.length} matching ${matches.length === 1 ? "line" : "lines"} in ${chosen.length} ${chosen.length === 1 ? "skill" : "skills"}${truncated ? ", more not shown" : ""}]`];
    for (const match of matches) lines.push(`${several ? `${match.peer}:` : ""}${match.skill}/${match.file}:${match.line}: ${match.text}`);
    for (const entry of unlisted) lines.push(`[Not searched: ${entry.peer}: ${entry.reason}]`);
    return { text: clip(lines.join("\n")).text, structured: { matches, truncated, unlisted } };
  }));

  server.registerTool("list_secrets", {
    title: "List secrets",
    description: "List the mesh secrets a peer holds, such as API keys and tokens, by name: never their values. " +
      "Pass a name as secrets to run_command or start_session, and the peer sets it as an environment variable of that program. " +
      "Write MESH:NAME when two meshes hold the name. It needs the shell grant on the peer.",
    inputSchema: z.strictObject({ peer }),
    outputSchema: z.object({
      peer: z.string(),
      secrets: z.array(z.object({
        mesh: z.string(),
        name: z.string().describe("The secret's name, which is also the variable's."),
        readBy: z.string().describe("Who can read it: all members of the mesh, or this peer only."),
        setBy: z.array(z.string()).describe("The device that set it; two mean it cannot be used until one removes theirs."),
      })),
    }),
    annotations: observing,
  }, async (args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const peerId = await link.peer(args.peer);
    const found = await link.controller.secrets(peerId).catch(async (error: unknown) => { throw await older(error, link, peerId, "secrets for agents", SECRETS_RELEASE); });
    const label = (await link.controller.peers()).find((candidate) => candidate.id === peerId)?.peer?.name ?? peerId;
    // The peer names itself "this device".
    const own = (who: string) => who === "this device" ? label : who;
    const secrets = found.map((secret) => ({
      mesh: secret.mesh, name: secret.name, readBy: secret.readBy === "this device" ? `${label} only` : secret.readBy, setBy: secret.setBy.map(own),
    }));
    const lines = secrets.length
      ? [`[${label} holds ${secrets.length} mesh ${secrets.length === 1 ? "secret" : "secrets"}; pass names as secrets to run_command or start_session]`,
        ...secrets.map((secret) => `${secret.mesh}:${secret.name}  read by ${secret.readBy}  set by ${secret.setBy.join(" and ")}`)]
      : [`${label} holds no mesh secrets. A member of a mesh sets one with cns secret set MESH NAME.`];
    return { text: lines.join("\n"), structured: { peer: label, secrets } };
  }));

  return mcp;
}
