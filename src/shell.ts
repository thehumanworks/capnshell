import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcTarget } from "capnweb";
import treeKill from "tree-kill";
import { z } from "zod";

// Nix supplies an absolute Bash path without changing the commands’ PATH.
declare const CAPNWEB_DEFAULT_BASH: string;
const bash = typeof CAPNWEB_DEFAULT_BASH === "string" ? CAPNWEB_DEFAULT_BASH : "bash";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
// Largest delay supported by Node timers without overflowing. Zero means no deadline.
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const MAX_PTY_INPUT_BYTES = 64 * 1024;
// Bun cannot pause PTY reads. A caller that stops acknowledging output ends its
// session rather than growing this process's memory without bound.
export const MAX_PTY_BACKLOG_BYTES = 8 * 1024 * 1024;
const PTY_CHUNK_BYTES = 64 * 1024;
const MAX_PTYS = 4;

const commandSchema = z.string().max(8192, "Command must be at most 8192 characters.")
  .refine((value) => value.trim().length > 0, "Command must be nonempty.");
const optionsSchema = z.strictObject({
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).default(0),
  cwd: z.string().refine(path.isAbsolute, "cwd must be an absolute path on the executing peer.")
    .default(() => os.homedir()),
});
export type RunOptions = z.input<typeof optionsSchema>;
const dimension = z.int().min(1).max(1000);
const ptyOptionsSchema = optionsSchema.extend({
  /** Omit to start the executing user's login shell. */
  command: commandSchema.optional(),
  cols: dimension.default(80),
  rows: dimension.default(24),
  term: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "term must be a terminfo name.").default("xterm-256color"),
});
export type PtyOptions = z.input<typeof ptyOptionsSchema>;
const ptyInputSchema = z.union([z.string(), z.instanceof(Uint8Array)])
  .refine((data) => Buffer.byteLength(data) <= MAX_PTY_INPUT_BYTES, `PTY input must be at most ${MAX_PTY_INPUT_BYTES} bytes per write.`);
export interface ShellInfo {
  platform: NodeJS.Platform;
  name: string;
  shell: "PowerShell" | "Bash";
  hostname: string;
  cwd: string;
  pid: number;
}
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Signal numbers differ across operating systems; report the executor's value. */
  signalNumber: number | null;
  timedOut: boolean;
  truncated: boolean;
  elapsedMs: number;
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
/**
 * Implemented by the caller and passed by reference. The executor pushes terminal
 * output to it and waits for each acknowledgement before sending more.
 */
export interface PtySink {
  output(data: Uint8Array): void | Promise<void>;
  exit(result: PtyExit): void | Promise<void>;
}
type SinkStub = PtySink & { dup?(): SinkStub; [Symbol.dispose]?(): void };

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* The group has already exited. */ }
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    treeKill(child.pid, "SIGKILL", (error) => { if (error) child.kill(); });
  } else {
    // The detached spawn gives this command its own POSIX process group.
    // Signal the group atomically rather than racing a userspace PID-tree walk.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) child.kill("SIGKILL");
    }
  }
}

/** An interactive program on a pseudo-terminal, controlled by reference over RPC. */
export class PtySession extends RpcTarget {
  #process: Bun.Subprocess;
  #terminal: Bun.Terminal;
  #sink: SinkStub;
  #queue: Uint8Array[] = [];
  #queued = 0;
  #pump?: Promise<void>;
  #error: string | null = null;
  #ended = false;
  #killTimer?: ReturnType<typeof setTimeout>;

  constructor(sink: SinkStub, options: z.output<typeof ptyOptionsSchema>, onEnd: (session: PtySession) => void) {
    super();
    const { command, cwd, cols, rows, term, timeoutMs } = options;
    let eof!: () => void;
    const drained = new Promise<void>((resolve) => { eof = resolve; });
    const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) && existsSync(process.env.SHELL) ? process.env.SHELL : bash;
    const started = Date.now();
    this.#process = Bun.spawn(command === undefined ? [shell, "-l"] : [bash, "--noprofile", "--norc", "-c", command], {
      cwd,
      env: { ...process.env, TERM: term },
      terminal: {
        cols, rows, name: term,
        data: (_terminal, data) => this.#push(data.slice()),
        exit: () => eof(),
      },
    });
    this.#terminal = this.#process.terminal!;
    // Parameters are released after the call returns; keep our own reference.
    this.#sink = sink.dup?.() ?? sink;
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      this.#hangUp();
    }, timeoutMs) : undefined;
    void this.#process.exited.then(async () => {
      clearTimeout(timer);
      clearTimeout(this.#killTimer);
      // Output written just before exit can still be in the PTY buffer.
      await Promise.race([drained, new Promise((resolve) => setTimeout(resolve, 250))]);
      this.#ended = true;
      this.#terminal.close();
      onEnd(this);
      // A stalled caller may never acknowledge its pending output.
      if (!this.#error) await this.#pump;
      const code = this.#process.signalCode;
      const signal = typeof code === "string" ? code : null;
      try {
        await this.#sink.exit({
          exitCode: this.#process.exitCode, signal,
          signalNumber: signal ? os.constants.signals[signal as NodeJS.Signals] ?? null : null,
          timedOut, elapsedMs: Date.now() - started, error: this.#error,
        });
      } catch { /* The caller has gone; nothing is waiting for the result. */ }
      this.#sink[Symbol.dispose]?.();
    });
  }

  /** Send keystrokes or other input bytes to the program. */
  write(data: string | Uint8Array): void {
    ptyInputSchema.parse(data);
    if (!this.#ended && !this.#terminal.closed) this.#terminal.write(data);
  }

  resize(cols: number, rows: number): void {
    dimension.parse(cols);
    dimension.parse(rows);
    if (!this.#ended && !this.#terminal.closed) this.#terminal.resize(cols, rows);
  }

  /** Hang up, as when a terminal window closes. The sink still receives exit(). */
  close(): void { this.#hangUp(); }

  [Symbol.dispose]() { this.#hangUp(); }

  #hangUp(error?: string) {
    if (error && !this.#error) this.#error = error;
    if (this.#ended || this.#killTimer) return;
    // A PTY's process group is its session leader's. Jobs started by an interactive
    // shell receive SIGHUP from the shell and the closing terminal.
    signalGroup(this.#process.pid, "SIGHUP");
    this.#terminal.close();
    this.#killTimer = setTimeout(() => signalGroup(this.#process.pid, "SIGKILL"), 1000);
  }

  #push(data: Uint8Array) {
    if (this.#error) return;
    this.#queue.push(data);
    this.#queued += data.length;
    if (this.#queued > MAX_PTY_BACKLOG_BYTES) {
      this.#queue = [];
      this.#queued = 0;
      this.#hangUp("PTY output backlog exceeded; the caller stopped reading.");
      return;
    }
    this.#pump ??= this.#drain();
  }

  async #drain() {
    while (this.#queue.length) {
      // Coalesce small reads so a fast program does not cost one round trip per read.
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (this.#queue.length && length + this.#queue[0]!.length <= PTY_CHUNK_BYTES) {
        length += this.#queue[0]!.length;
        chunks.push(this.#queue.shift()!);
      }
      if (!chunks.length) {
        const first = this.#queue[0]!;
        chunks.push(first.subarray(0, PTY_CHUNK_BYTES));
        this.#queue[0] = first.subarray(PTY_CHUNK_BYTES);
        length = PTY_CHUNK_BYTES;
      }
      this.#queued -= length;
      try {
        await this.#sink.output(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
      } catch {
        this.#queue = [];
        this.#queued = 0;
        this.#hangUp("The caller stopped receiving PTY output.");
      }
    }
    this.#pump = undefined;
  }
}

// Only these prototype methods are exported. Internal state uses JS #private fields.
export class ShellApi extends RpcTarget {
  #children = new Set<ChildProcess>();
  #ptys = new Set<PtySession>();
  #closed = false;

  info(): ShellInfo {
    return {
      platform: process.platform,
      name: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : process.env.WSL_DISTRO_NAME ? "wsl" : process.platform,
      shell: process.platform === "win32" ? "PowerShell" : "Bash",
      hostname: os.hostname(),
      cwd: os.homedir(),
      pid: process.pid,
    };
  }

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    if (this.#closed) throw new Error("This shell session is closed.");
    // RPC callers are not necessarily TypeScript: validate at the trust boundary.
    // Stay below Windows' command-line limit after UTF-16/base64 encoding.
    commandSchema.parse(command);
    const { timeoutMs, cwd } = optionsSchema.parse(options);
    if (this.#children.size >= 4) throw new Error("Too many simultaneous commands.");

    const windows = process.platform === "win32";
    const executable = windows
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : bash;
    // Base64 preserves quoting/Unicode. Use -Command, not -EncodedCommand:
    // Windows PowerShell 5 serializes stderr as CLIXML with -EncodedCommand.
    const preamble = "$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n";
    const encoded = Buffer.from(preamble + command, "utf16le").toString("base64");
    const powershellCommand = `& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
    const args = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", powershellCommand]
      : ["--noprofile", "--norc", "-c", command];
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !windows,
    });
    this.#children.add(child);

    return new Promise<RunResult>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let remaining = MAX_OUTPUT_BYTES;
      let truncated = false;
      let timedOut = false;
      // Keep draining after the shared cap; max-buffer helpers usually kill the
      // process instead, which would change the shell's exit status and semantics.
      const capture = (chunks: Buffer[], data: Buffer) => {
        const length = Math.min(remaining, data.length);
        if (length) chunks.push(data.subarray(0, length));
        remaining -= length;
        if (length < data.length) truncated = true;
      };
      child.stdout.on("data", (data) => capture(stdout, data));
      child.stderr.on("data", (data) => capture(stderr, data));
      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs) : undefined;
      const cleanup = () => {
        clearTimeout(timer);
        this.#children.delete(child);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        cleanup();
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
          signal,
          signalNumber: signal ? os.constants.signals[signal] ?? null : null,
          timedOut,
          truncated,
          elapsedMs: Date.now() - started,
        });
      });
    });
  }

  /**
   * Start a program on a pseudo-terminal so interactive CLIs and TUIs render. Output
   * and the final status are pushed to the caller's sink; the returned session takes
   * input, resizes and hangs up. Disposing the session also hangs up.
   */
  openPty(sink: PtySink, options: PtyOptions = {}): PtySession {
    if (this.#closed) throw new Error("This shell session is closed.");
    if (process.platform === "win32") throw new Error("PTY sessions require a Linux or macOS peer.");
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A PTY sink is required.");
    const parsed = ptyOptionsSchema.parse(options);
    if (this.#ptys.size >= MAX_PTYS) throw new Error("Too many simultaneous PTY sessions.");
    const session = new PtySession(sink, parsed, (ended) => this.#ptys.delete(ended));
    this.#ptys.add(session);
    return session;
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) killTree(child);
    for (const pty of this.#ptys) pty.close();
  }
}
