import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { RpcTarget } from "capnweb";
import treeKill from "tree-kill";
import { bash, commandSchema, optionsSchema, powershell, powershellArgs, type RunOptions } from "./platform.js";
import {
  MAX_PTYS, NamedPty, openUnnamedPty, ptyOptionsSchema, PtyRegistry,
  type PtyOptions, type PtySession, type PtySessionInfo, type PtySessionOptions, type PtySink,
} from "./pty.js";

export { MAX_TIMEOUT_MS, type RunOptions } from "./platform.js";
export {
  MAX_NAMED_PTYS, MAX_PTY_BACKLOG_BYTES, MAX_PTY_INPUT_BYTES, MAX_SCREEN_HISTORY, sessionNameSchema,
  type AttachOptions, type CaptureOptions, type KeysOptions, type PtyExit, type PtyOptions, type PtyScreen,
  type PtySessionInfo, type PtySessionOptions, type PtySink, type PtyWait, type WaitOptions,
  NamedPty, PtyAttachment, PtyRegistry, PtySession,
} from "./pty.js";

export const MAX_OUTPUT_BYTES = 1024 * 1024;

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

// Only these prototype methods are exported. Internal state uses JS #private fields.
export class ShellApi extends RpcTarget {
  #children = new Set<ChildProcess>();
  #ptys = new Set<PtySession>();
  #registry: PtyRegistry;
  #closed = false;

  /** Named PTY sessions live in the registry, shared by this process's connections. */
  constructor(registry = new PtyRegistry()) {
    super();
    this.#registry = registry;
  }

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
    const executable = windows ? powershell() : bash;
    const args = windows ? powershellArgs(command, false) : ["--noprofile", "--norc", "-c", command];
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
   * input, resizes, renders its screen on request and hangs up. Release the session
   * when done with it: that also hangs up and frees its screen.
   */
  openPty(sink: PtySink, options: PtyOptions = {}): PtySession {
    if (this.#closed) throw new Error("This shell session is closed.");
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A PTY sink is required.");
    const parsed = ptyOptionsSchema.parse(options);
    // Sessions count until released, because their screens remain capturable.
    if (this.#ptys.size >= MAX_PTYS) throw new Error("Too many PTY sessions; release finished ones first.");
    const session = openUnnamedPty(sink, parsed, (released) => this.#ptys.delete(released));
    this.#ptys.add(session);
    return session;
  }

  /**
   * Start a named PTY session without a viewer. It belongs to this process rather
   * than the connection, so later connections can reach it with ptySession(name).
   */
  startPtySession(name: string, options: PtySessionOptions = {}): NamedPty {
    if (this.#closed) throw new Error("This shell session is closed.");
    return new NamedPty(this.#registry, name, this.#registry.start(name, options));
  }

  /** A handle on a named session. Releasing the handle leaves the session running. */
  ptySession(name: string): NamedPty {
    if (this.#closed) throw new Error("This shell session is closed.");
    return new NamedPty(this.#registry, name, this.#registry.get(name));
  }

  ptySessions(): PtySessionInfo[] {
    if (this.#closed) throw new Error("This shell session is closed.");
    return this.#registry.list();
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) killTree(child);
    for (const pty of this.#ptys) pty[Symbol.dispose]();
  }
}
