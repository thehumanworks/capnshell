import { McpServer, type CallToolResult, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { DEFAULT_UNTIL_MS, describeExit, formatSessions } from "../commands/one-shot.js";
import { errorMessage } from "../errors.js";
import { MAX_KEYS } from "../keys.js";
import { commandSchema } from "../platform.js";
import { MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, sessionNameSchema, type PtyExit, type PtyScreen, type PtySessionInfo } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import type { Link, McpTarget } from "./target.js";

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
- When several peers are connected, pass peer to choose one.`;

const peer = z.string().min(1).max(64).optional()
  .describe("Peer ID from list_peers. May be omitted when only one peer is connected.");
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
  id: z.string(),
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
    const message = link?.lost ? `Lost the connection to ${target.label}: ${errorMessage(error)}` : errorMessage(error);
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

/** A fresh server for one MCP connection or HTTP request, with tools that reach `target`'s peers. */
export function createMcpServer(target: McpTarget): McpServer {
  const server = new McpServer({ name: "cns", title: "Cap'n Shell", version: manifest.version }, { instructions });

  server.registerTool("list_peers", {
    title: "List peers",
    description: "List the peers this server reaches, with their ID, hostname, operating system, shell and home directory.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ peers: z.array(peerSchema) }),
    annotations: observing,
  }, async (_args, ctx) => invoke(target, ctx, undefined, async (link) => {
    const peers = (await link.controller.peers()).map(({ id, info }) => ({
      id, hostname: info.hostname, platform: info.platform, os: info.name, shell: info.shell, home: info.cwd, pid: info.pid,
    }));
    const text = peers.length
      ? peers.map((p) => `${p.id}  ${p.hostname}  ${p.os}  ${p.shell}  home: ${p.home}`).join("\n")
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

  return server;
}
