import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Screen } from "@xterm/headless";
import { RpcTarget } from "capnweb";
import treeKill from "tree-kill";
import { z } from "zod";
import { encodeKeys, MAX_KEYS } from "./keys.js";
import { bash, commandSchema, MAX_TIMEOUT_MS, optionsSchema, powershell, powershellArgs } from "./platform.js";

export const MAX_PTY_INPUT_BYTES = 64 * 1024;
// Bun cannot pause PTY reads. A caller that stops acknowledging output ends its
// session rather than growing this process's memory without bound.
export const MAX_PTY_BACKLOG_BYTES = 8 * 1024 * 1024;
const PTY_CHUNK_BYTES = 64 * 1024;
/** Unnamed PTYs per connection. */
export const MAX_PTYS = 4;
/** Named PTY sessions per process, running or finished. */
export const MAX_NAMED_PTYS = 16;
/** Lines of scrollback each PTY's screen keeps for capture(). */
export const MAX_SCREEN_HISTORY = 1000;
const MAX_WAITERS = 8;
const MAX_VIEWERS = 8;

const dimension = z.int().min(1).max(1000);
const programOptionsSchema = optionsSchema.extend({
  /** Omit to start the executing user's login shell. */
  command: commandSchema.optional(),
  cols: dimension.default(80),
  rows: dimension.default(24),
  term: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "term must be a terminfo name.").default("xterm-256color"),
});
export const ptyOptionsSchema = programOptionsSchema.extend({
  /** Push raw output to the sink. Disable when the caller only reads the screen. */
  stream: z.boolean().default(true),
  /**
   * Answer terminal queries (cursor position, device attributes) from the screen.
   * Enable when no real terminal receives the output to answer them.
   */
  respond: z.boolean().default(false),
});
export type PtyOptions = z.input<typeof ptyOptionsSchema>;
export type PtySessionOptions = z.input<typeof programOptionsSchema>;
export const sessionNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "Session names have 1-64 letters, digits, '.', '_' or '-', and start with a letter or digit.");
const captureOptionsSchema = z.strictObject({
  /** Scrollback lines to include above the visible screen. */
  history: z.int().min(0).max(MAX_SCREEN_HISTORY).default(0),
});
export type CaptureOptions = z.input<typeof captureOptionsSchema>;
const waitOptionsSchema = captureOptionsSchema.extend({
  text: z.string().min(1).max(4096),
  /** Zero waits until the text appears or the program ends. */
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).default(0),
});
export type WaitOptions = z.input<typeof waitOptionsSchema>;
const keysSchema = z.array(z.string().max(MAX_PTY_INPUT_BYTES)).min(1).max(MAX_KEYS);
const keysOptionsSchema = z.strictObject({ literal: z.boolean().default(false) });
export type KeysOptions = z.input<typeof keysOptionsSchema>;
const attachOptionsSchema = z.strictObject({
  /** Resize the session to the viewer's terminal first. */
  cols: dimension.optional(),
  rows: dimension.optional(),
  /** The viewer's own terminal answers queries, so the screen stops answering them. */
  answers: z.boolean().default(false),
});
export type AttachOptions = z.input<typeof attachOptionsSchema>;
const ptyInputSchema = z.union([z.string(), z.instanceof(Uint8Array)])
  .refine((data) => Buffer.byteLength(data) <= MAX_PTY_INPUT_BYTES, `PTY input must be at most ${MAX_PTY_INPUT_BYTES} bytes per write.`);

/** The rendered terminal, as `tmux capture-pane -p` prints it. */
export interface PtyScreen {
  /** One line per row, trailing spaces removed, joined with \n. */
  text: string;
  cols: number;
  rows: number;
  /** Zero-based cursor position on the visible screen. */
  cursor: { x: number; y: number };
  /** True while a full-screen program uses the alternate screen. */
  alternateScreen: boolean;
  title: string;
}
export interface PtyWait {
  /** False when the deadline passed or the program ended first. */
  matched: boolean;
  running: boolean;
  /** The screen that matched, or the screen when waiting stopped. */
  screen: PtyScreen;
}
export interface PtyExit {
  exitCode: number | null;
  signal: string | null;
  signalNumber: number | null;
  timedOut: boolean;
  elapsedMs: number;
  /** Why the executor ended the session, when it was not the program's own exit. */
  error: string | null;
}
export interface PtySessionInfo {
  name: string;
  /** Null for a login shell. */
  command: string | null;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  title: string;
  startedAt: string;
  running: boolean;
  exit: PtyExit | null;
  /** Callers currently attached and receiving output. */
  viewers: number;
}
/**
 * Implemented by the caller and passed by reference. The executor pushes terminal
 * output to it and waits for each acknowledgement before sending more.
 */
export interface PtySink {
  output(data: Uint8Array): void | Promise<void>;
  exit(result: PtyExit): void | Promise<void>;
  /** A named session detached this viewer while its program keeps running. */
  detached?(reason: string): void | Promise<void>;
}
type SinkStub = PtySink & { dup?(): SinkStub; [Symbol.dispose]?(): void };

interface Viewer {
  sink: SinkStub;
  stream: boolean;
  answers: boolean;
  queue: Uint8Array[];
  queued: number;
  pump?: Promise<void>;
  /** Resolves once the replay, if any, is queued ahead of live output. */
  ready: Promise<void>;
  paused: boolean;
  gone: boolean;
  /** An unnamed session's only viewer owns it: losing the viewer hangs up the program. */
  owner: boolean;
}
interface Waiter { check(): void; abort(error: Error): void }

const encoder = new TextEncoder();

/** The program a PTY runs: the user's interactive shell, or one command in the platform's shell. */
function ptyProgram(command: string | undefined): string[] {
  if (process.platform === "win32") {
    return command === undefined ? [powershell(), "-NoLogo"] : [powershell(), ...powershellArgs(command, true)];
  }
  if (command !== undefined) return [bash, "--noprofile", "--norc", "-c", command];
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) && existsSync(process.env.SHELL) ? process.env.SHELL : bash;
  return [shell, "-l"];
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* The group has already exited. */ }
}

/**
 * A program on a pseudo-terminal and the screen it draws. The renderer only renders:
 * it tracks the screen for whenever a caller asks. Viewers receive raw output.
 */
class Pty {
  readonly command: string | null;
  readonly cwd: string;
  readonly startedAt = new Date();
  readonly exited: Promise<PtyExit>;
  #process: Bun.Subprocess;
  #terminal: Bun.Terminal;
  #screen: Screen;
  #serializer = new SerializeAddon();
  #title = "";
  #viewers = new Set<Viewer>();
  #waiters = new Set<Waiter>();
  #exit: PtyExit | null = null;
  #error: string | null = null;
  #ended = false;
  #hungUp = false;
  #disposed = false;
  #killTimer?: ReturnType<typeof setTimeout>;

  constructor(options: z.output<typeof programOptionsSchema>) {
    const { command, cwd, cols, rows, term, timeoutMs } = options;
    this.command = command ?? null;
    this.cwd = cwd;
    this.#screen = new Screen({ cols, rows, scrollback: MAX_SCREEN_HISTORY, allowProposedApi: true });
    this.#screen.loadAddon(this.#serializer as never);
    this.#screen.onTitleChange((title) => { this.#title = title; });
    // Someone must answer queries such as cursor-position reports, or TUIs wait for them.
    this.#screen.onData((reply) => {
      if (![...this.#viewers].some((viewer) => viewer.answers) && !this.#ended && !this.#terminal.closed) this.#terminal.write(reply);
    });
    let eof!: () => void;
    const drained = new Promise<void>((resolve) => { eof = resolve; });
    const started = Date.now();
    try {
      this.#process = Bun.spawn(ptyProgram(command), {
        cwd,
        env: { ...process.env, TERM: term },
        terminal: {
          cols, rows, name: term,
          data: (_terminal, data) => this.#push(data.slice()),
          exit: () => eof(),
        },
      });
    } catch (error) {
      this.#screen.dispose();
      // posix_spawn reports a missing cwd as a missing program.
      if (!existsSync(cwd)) throw new Error(`cwd does not exist on the executing peer: ${cwd}`, { cause: error });
      throw error;
    }
    this.#terminal = this.#process.terminal!;
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      this.hangUp();
    }, timeoutMs) : undefined;
    this.exited = this.#process.exited.then(async () => {
      clearTimeout(timer);
      clearTimeout(this.#killTimer);
      // Output written just before exit can still be in the PTY buffer.
      await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 250))]);
      this.#ended = true;
      this.#terminal.close();
      const code = this.#process.signalCode;
      const signal = typeof code === "string" ? code : null;
      const exit: PtyExit = {
        exitCode: this.#process.exitCode, signal,
        signalNumber: signal ? os.constants.signals[signal as NodeJS.Signals] ?? null : null,
        timedOut, elapsedMs: Date.now() - started, error: this.#error,
      };
      this.#exit = exit;
      if (!this.#disposed) this.#screen.write("", () => { for (const waiter of [...this.#waiters]) waiter.check(); });
      for (const viewer of this.#viewers) void this.#finish(viewer, exit);
      return exit;
    });
  }

  get pid() { return this.#process.pid; }
  get exit() { return this.#exit; }
  get title() { return this.#title; }
  get size() { return { cols: this.#screen.cols, rows: this.#screen.rows }; }
  get viewers() { return [...this.#viewers].filter((viewer) => viewer.stream).length; }

  write(data: string | Uint8Array): void {
    ptyInputSchema.parse(data);
    this.#live();
    if (!this.#ended && !this.#terminal.closed) this.#terminal.write(data);
  }

  keys(keys: string[], options: KeysOptions = {}): void {
    const { literal } = keysOptionsSchema.parse(options);
    const data = encodeKeys(keysSchema.parse(keys), { literal, applicationCursor: this.#screen.modes.applicationCursorKeysMode });
    this.write(data);
  }

  resize(cols: number, rows: number): void {
    dimension.parse(cols);
    dimension.parse(rows);
    this.#live();
    if (!this.#ended && !this.#terminal.closed) {
      this.#terminal.resize(cols, rows);
      this.#screen.resize(cols, rows);
    }
  }

  /** Render the screen now. The last screen remains after the program ends. */
  async capture(options: CaptureOptions = {}): Promise<PtyScreen> {
    const { history } = captureOptionsSchema.parse(options);
    await this.#flush();
    return this.#render(history);
  }

  /** Wait until the screen shows some text, checking after every chunk of output. */
  async wait(options: WaitOptions): Promise<PtyWait> {
    const { text, timeoutMs, history } = waitOptionsSchema.parse(options);
    await this.#flush();
    const screen = this.#render(history);
    if (screen.text.includes(text)) return { matched: true, running: !this.#exit, screen };
    if (this.#exit) return { matched: false, running: false, screen };
    if (this.#waiters.size >= MAX_WAITERS) throw new Error("Too many callers are waiting on this PTY session.");
    return await new Promise<PtyWait>((resolve, reject) => {
      const finish = (result: PtyWait) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        resolve(result);
      };
      const waiter: Waiter = {
        check: () => {
          const current = this.#render(history);
          if (current.text.includes(text)) finish({ matched: true, running: !this.#exit, screen: current });
          else if (this.#exit) finish({ matched: false, running: false, screen: current });
        },
        abort: (error) => {
          clearTimeout(timer);
          this.#waiters.delete(waiter);
          reject(error);
        },
      };
      const timer = timeoutMs > 0 ? setTimeout(() => finish({ matched: false, running: !this.#exit, screen: this.#render(history) }), timeoutMs) : undefined;
      this.#waiters.add(waiter);
    });
  }

  /**
   * Add a viewer. A replay first draws the current screen, so a terminal attaching
   * mid-session shows what the program has drawn so far.
   */
  view(sink: SinkStub, { stream, answers, replay, owner }: { stream: boolean; answers: boolean; replay: boolean; owner: boolean }): Viewer {
    this.#live();
    if (this.#viewers.size >= MAX_VIEWERS) throw new Error("Too many viewers are attached to this PTY session.");
    let ready!: () => void;
    const viewer: Viewer = {
      // Parameters are released after the call returns; keep our own reference.
      sink: sink.dup?.() ?? sink, stream, answers, owner, queue: [], queued: 0,
      ready: new Promise((resolve) => { ready = resolve; }), paused: replay, gone: false,
    };
    this.#viewers.add(viewer);
    if (replay) {
      // Writes parse in order and run their callbacks before the next one, so the
      // replay holds exactly the output received before this viewer was added.
      this.#screen.write("", () => {
        if (!viewer.gone) {
          const data = encoder.encode(this.#replay());
          viewer.queue.unshift(data);
          viewer.queued += data.length;
          viewer.paused = false;
          viewer.pump ??= this.#drain(viewer);
        }
        ready();
      });
    } else ready();
    if (this.#exit) void this.#finish(viewer, this.#exit);
    return viewer;
  }

  /** Stop sending output to a viewer. Its sink receives nothing further. */
  unview(viewer: Viewer): void {
    if (viewer.gone) return;
    viewer.gone = true;
    viewer.queue = [];
    viewer.queued = 0;
    this.#viewers.delete(viewer);
    if (viewer.owner) this.hangUp();
    viewer.sink[Symbol.dispose]?.();
  }

  /** Hang up, as when a terminal window closes. Viewers still receive exit(). */
  hangUp(error?: string) {
    if (error && !this.#error) this.#error = error;
    if (this.#ended || this.#hungUp) return;
    this.#hungUp = true;
    if (process.platform === "win32") {
      // ConPTY has no hang-up signal, and closing it can block until its programs
      // exit on Windows before 11 24H2. End the process tree first.
      treeKill(this.#process.pid, "SIGKILL", () => { if (!this.#terminal.closed) this.#terminal.close(); });
      return;
    }
    // A PTY's process group is its session leader's. Jobs started by an interactive
    // shell receive SIGHUP from the shell and the closing terminal.
    signalGroup(this.#process.pid, "SIGHUP");
    this.#terminal.close();
    this.#killTimer = setTimeout(() => signalGroup(this.#process.pid, "SIGKILL"), 1000);
  }

  /** Hang up and free the screen once the program has ended. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const waiter of [...this.#waiters]) waiter.abort(new Error("This PTY session has been released."));
    this.hangUp();
    void this.exited.then(() => this.#screen.dispose());
  }

  #live() {
    if (this.#disposed) throw new Error("This PTY session has been released.");
  }

  async #flush() {
    this.#live();
    // Writes are parsed asynchronously; wait for everything received so far.
    await new Promise<void>((resolve) => this.#screen.write("", resolve));
    this.#live();
  }

  #render(history: number): PtyScreen {
    const buffer = this.#screen.buffer.active;
    const lines: string[] = [];
    for (let y = Math.max(0, buffer.viewportY - history); y < buffer.viewportY + this.#screen.rows; y++) {
      // trimRight keeps spaces a program wrote explicitly, as many TUIs do to clear rows.
      lines.push(buffer.getLine(y)?.translateToString(true).replace(/ +$/, "") ?? "");
    }
    return {
      text: lines.join("\n"),
      cols: this.#screen.cols, rows: this.#screen.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      alternateScreen: buffer.type === "alternate",
      title: this.#title,
    };
  }

  /** Escape sequences that redraw this screen and its input modes on a cleared terminal. */
  #replay(): string {
    // xterm keeps cursor visibility internal; the serializer does not restore it.
    const core = (this.#screen as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
    const hidden = core?.coreService?.isCursorHidden ? "\x1b[?25l" : "";
    return "\x1b[0m\x1b[H\x1b[2J" + this.#serializer.serialize({ scrollback: 0 }) + hidden;
  }

  #push(data: Uint8Array) {
    if (this.#error) return;
    this.#screen.write(data, this.#waiters.size ? () => { for (const waiter of [...this.#waiters]) waiter.check(); } : undefined);
    for (const viewer of this.#viewers) {
      if (!viewer.stream || viewer.gone) continue;
      viewer.queue.push(data);
      viewer.queued += data.length;
      if (viewer.queued > MAX_PTY_BACKLOG_BYTES) this.#lose(viewer, "PTY output backlog exceeded; the caller stopped reading.");
      else if (!viewer.paused) viewer.pump ??= this.#drain(viewer);
    }
  }

  /** A viewer that cannot keep up is dropped; an owner takes its program with it. */
  #lose(viewer: Viewer, reason: string) {
    if (viewer.gone) return;
    viewer.queue = [];
    viewer.queued = 0;
    if (viewer.owner) {
      // The owner's sink still receives exit() with the reason.
      this.hangUp(reason);
      viewer.stream = false;
      return;
    }
    const { sink } = viewer;
    this.unview(viewer);
    void (async () => {
      try { await sink.detached?.(reason); } catch { /* The caller has gone. */ }
    })();
  }

  async #drain(viewer: Viewer) {
    while (viewer.queue.length && !viewer.gone) {
      // Coalesce small reads so a fast program does not cost one round trip per read.
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (viewer.queue.length && length + viewer.queue[0]!.length <= PTY_CHUNK_BYTES) {
        length += viewer.queue[0]!.length;
        chunks.push(viewer.queue.shift()!);
      }
      if (!chunks.length) {
        const first = viewer.queue[0]!;
        chunks.push(first.subarray(0, PTY_CHUNK_BYTES));
        viewer.queue[0] = first.subarray(PTY_CHUNK_BYTES);
        length = PTY_CHUNK_BYTES;
      }
      viewer.queued -= length;
      try {
        await viewer.sink.output(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
      } catch {
        this.#lose(viewer, "The caller stopped receiving PTY output.");
      }
    }
    viewer.pump = undefined;
  }

  async #finish(viewer: Viewer, exit: PtyExit) {
    await viewer.ready;
    // A stalled caller may never acknowledge its pending output.
    if (viewer.stream) await viewer.pump;
    if (viewer.gone) return;
    try { await viewer.sink.exit(exit); } catch { /* The caller has gone; nothing is waiting for the result. */ }
    viewer.gone = true;
    this.#viewers.delete(viewer);
    viewer.sink[Symbol.dispose]?.();
  }
}

/** Input, size and screen controls shared by every handle on a PTY. */
class PtyControls extends RpcTarget {
  #pty: () => Pty;
  constructor(pty: () => Pty) {
    super();
    this.#pty = pty;
  }
  /** Send keystrokes or other input bytes to the program. */
  write(data: string | Uint8Array): void { this.#pty().write(data); }
  /** Send tmux-style key names such as Enter, C-c or Up, and literal text. */
  keys(keys: string[], options: KeysOptions = {}): void { this.#pty().keys(keys, options); }
  resize(cols: number, rows: number): void { this.#pty().resize(cols, rows); }
  /** Render the screen now, while the program runs or after it ends. */
  async capture(options: CaptureOptions = {}): Promise<PtyScreen> { return await this.#pty().capture(options); }
  /** Wait until the screen shows some text, the deadline passes or the program ends. */
  async wait(options: WaitOptions): Promise<PtyWait> { return await this.#pty().wait(options); }
}

/** An unnamed PTY, owned by the caller that opened it. */
export class PtySession extends PtyControls {
  #pty: Pty;
  #onRelease: () => void;
  #released = false;
  constructor(pty: Pty, onRelease: () => void) {
    super(() => pty);
    this.#pty = pty;
    this.#onRelease = onRelease;
  }
  /** Hang up, as when a terminal window closes. The sink still receives exit(). */
  close(): void { this.#pty.hangUp(); }
  /** Releasing the session hangs up and frees its screen once the program has ended. */
  [Symbol.dispose]() {
    if (this.#released) return;
    this.#released = true;
    this.#pty.dispose();
    if (this.#pty.exit) this.#onRelease();
    else void this.#pty.exited.then(this.#onRelease);
  }
}

/** One caller's attachment to a named session. Releasing it detaches; the program keeps running. */
export class PtyAttachment extends PtyControls {
  #pty: Pty;
  #viewer: Viewer;
  constructor(pty: () => Pty, viewer: Viewer) {
    super(pty);
    this.#pty = pty();
    this.#viewer = viewer;
  }
  detach(): void { this.#pty.unview(this.#viewer); }
  [Symbol.dispose]() { this.detach(); }
}

/** A handle on a named session. Releasing the handle leaves the session running. */
export class NamedPty extends PtyControls {
  #registry: PtyRegistry;
  #name: string;
  #lookup: () => Pty;
  constructor(registry: PtyRegistry, name: string, pty: Pty) {
    super(() => registry.resolve(name, pty));
    this.#registry = registry;
    this.#name = name;
    this.#lookup = () => registry.resolve(name, pty);
  }
  info(): PtySessionInfo { return describe(this.#name, this.#lookup()); }
  /**
   * Receive the session's output, starting with a redraw of its current screen. A
   * finished session's sink receives its redraw and exit() at once.
   */
  attach(sink: PtySink, options: AttachOptions = {}): PtyAttachment {
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A PTY sink is required.");
    const { cols, rows, answers } = attachOptionsSchema.parse(options);
    const pty = this.#lookup();
    // The latest viewer's terminal size wins, as in tmux.
    if (cols !== undefined || rows !== undefined) pty.resize(cols ?? pty.size.cols, rows ?? pty.size.rows);
    return new PtyAttachment(this.#lookup, pty.view(sink as SinkStub, { stream: true, answers, replay: true, owner: false }));
  }
  /** Hang up if still running and remove the session. Resolves with how it ended. */
  kill(): Promise<PtyExit> { return this.#registry.kill(this.#name, this.#lookup()); }
}

function describe(name: string, pty: Pty): PtySessionInfo {
  return {
    name, command: pty.command, cwd: pty.cwd, pid: pty.pid, ...pty.size, title: pty.title,
    startedAt: pty.startedAt.toISOString(), running: !pty.exit, exit: pty.exit, viewers: pty.viewers,
  };
}

/**
 * Named sessions belong to this process, not to a connection, so later commands and
 * other peers can reach them. They last until killed or this process stops.
 */
export class PtyRegistry {
  #sessions = new Map<string, Pty>();

  start(name: string, options: PtySessionOptions = {}): Pty {
    sessionNameSchema.parse(name);
    const parsed = programOptionsSchema.parse(options);
    if (this.#sessions.has(name)) throw new Error(`A PTY session named ${name} already exists. Kill it first.`);
    if (this.#sessions.size >= MAX_NAMED_PTYS) throw new Error("Too many named PTY sessions; kill finished ones first.");
    const pty = new Pty(parsed);
    this.#sessions.set(name, pty);
    return pty;
  }

  get(name: string): Pty {
    sessionNameSchema.parse(name);
    const pty = this.#sessions.get(name);
    if (!pty) throw new Error(`No PTY session named ${name}.`);
    return pty;
  }

  /** A handle only controls the session it was issued for, never a later one with its name. */
  resolve(name: string, pty: Pty): Pty {
    if (this.#sessions.get(name) !== pty) throw new Error(`PTY session ${name} no longer exists.`);
    return pty;
  }

  list(): PtySessionInfo[] {
    return [...this.#sessions].map(([name, pty]) => describe(name, pty));
  }

  async kill(name: string, pty: Pty): Promise<PtyExit> {
    this.resolve(name, pty);
    this.#sessions.delete(name);
    pty.dispose();
    return await pty.exited;
  }

  [Symbol.dispose]() {
    for (const pty of this.#sessions.values()) pty.dispose();
    this.#sessions.clear();
  }
}

/** Start an unnamed PTY whose only viewer is the caller. */
export function openUnnamedPty(sink: PtySink, options: z.output<typeof ptyOptionsSchema>, onRelease: (session: PtySession) => void): PtySession {
  const { stream, respond, ...program } = options;
  const pty = new Pty(program);
  pty.view(sink as SinkStub, { stream, answers: !respond, replay: false, owner: true });
  const session: PtySession = new PtySession(pty, () => onRelease(session));
  return session;
}
