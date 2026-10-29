import { spawn, type ChildProcess } from "node:child_process";
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

const commandSchema = z.string().max(8192, "Command must be at most 8192 characters.")
  .refine((value) => value.trim().length > 0, "Command must be nonempty.");
const optionsSchema = z.strictObject({
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).default(0),
  cwd: z.string().refine(path.isAbsolute, "cwd must be an absolute path on the executing peer.")
    .default(() => os.homedir()),
});
export type RunOptions = z.input<typeof optionsSchema>;
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
          timedOut,
          truncated,
          elapsedMs: Date.now() - started,
        });
      });
    });
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) killTree(child);
  }
}
