import { RpcTarget } from "capnweb";
import type { ConnectionController } from "../console.js";
import type { PeerConfig } from "../options.js";
import { MAX_EXEC_CHUNK_BYTES, type ExecInput, type ExecSink, type PtyExit, type PtyScreen, type PtySessionInfo, type RunResult } from "../shell.js";
import { attachSession, attachTerminal, plain } from "../terminal.js";

/** Wait this long for --until text unless --timeout says otherwise. */
export const DEFAULT_UNTIL_MS = 30_000;

export function commandExitCode(result: Pick<RunResult, "exitCode" | "signalNumber" | "timedOut">): number {
  if (result.timedOut) return 124;
  if (result.exitCode !== null) return result.exitCode;
  return result.signalNumber != null ? 128 + result.signalNumber : 1;
}

// Like tmux capture-pane, but without the blank rows below the last output.
function printScreen(screen: PtyScreen) {
  process.stdout.write(screen.text.replace(/\n+$/, "") + "\n");
}

export function describeExit(exit: Pick<PtyExit, "exitCode" | "signal" | "timedOut">): string {
  if (exit.timedOut) return "timed out";
  if (exit.exitCode !== null) return `exited ${exit.exitCode}`;
  return exit.signal ? `killed by ${exit.signal}` : "ended";
}

export function formatSessions(sessions: PtySessionInfo[]): string {
  const rows = sessions.map((session) => [
    session.name, session.exit ? describeExit(session.exit) : "running", `${session.cols}x${session.rows}`,
    `${session.viewers} attached`, session.command ?? "(login shell)",
  ]);
  const widths = rows.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  return rows.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n");
}

/** Writes a command's output to this process's stdout and stderr; each chunk is acknowledged once written. */
class StdioSink extends RpcTarget implements ExecSink {
  /** A local stream closed, as stdout does under `| head`: the peer then ends the command, as SIGPIPE would. */
  broken = false;
  constructor() {
    super();
    // Streams report a closed pipe as an error event too; without a listener it would end this process.
    for (const target of [process.stdout, process.stderr]) target.on("error", () => { this.broken = true; });
  }
  output(stream: "stdout" | "stderr", data: Uint8Array): Promise<void> {
    if (this.broken) return Promise.reject(new Error("The local output closed."));
    const target = stream === "stdout" ? process.stdout : process.stderr;
    return new Promise((resolve, reject) => {
      try {
        target.write(data, (error) => {
          if (!error) return resolve();
          this.broken = true;
          reject(error);
        });
      } catch (error) {
        this.broken = true;
        reject(error);
      }
    });
  }
}

/** This process's stdin, read when the peer asks for more, in chunks it accepts. */
export class StdinSource extends RpcTarget implements ExecInput {
  #input: NodeJS.ReadableStream;
  #chunks: AsyncIterator<Buffer | string>;
  #rest = Buffer.alloc(0);
  #ended = false;
  constructor(input: NodeJS.ReadableStream = process.stdin) {
    super();
    this.#input = input;
    this.#chunks = input[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>;
  }
  async read(): Promise<Uint8Array | null> {
    while (!this.#rest.length) {
      if (this.#ended) return null;
      const next = await this.#chunks.next();
      if (next.done) { this.#ended = true; return null; }
      this.#rest = Buffer.from(next.value as Uint8Array | string);
    }
    const chunk = this.#rest.subarray(0, MAX_EXEC_CHUNK_BYTES);
    this.#rest = this.#rest.subarray(chunk.length);
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length);
  }
  /** Stop reading, so an open pipe that never ends does not keep this process alive. */
  close() {
    this.#ended = true;
    void this.#chunks.return?.();
    (this.#input as { destroy?(): void }).destroy?.();
  }
}

/** Run a connect-mode command against peer `id` and return the CLI exit status. */
export async function runOneShot(config: PeerConfig, controller: ConnectionController, id: string, signal: AbortSignal): Promise<number> {
  const { command, cwd, timeoutMs, cols, rows, term, name } = config;
  switch (config.role) {
    case "run": {
      // Like ssh: piped or redirected input reaches the command, a terminal's does not; --no-stdin closes it.
      const input = config.stdin !== false && !process.stdin.isTTY ? new StdinSource() : undefined;
      const sink = new StdioSink();
      try {
        const result = await controller.exec(id, sink, command!, { cwd, timeoutMs }, input);
        if (result.timedOut) console.error("cns: command timed out");
        return commandExitCode(result);
      } catch (error) {
        // The status a local command gets when its reader goes away: 128 + SIGPIPE.
        if (sink.broken) return 141;
        throw error;
      } finally {
        input?.close();
      }
    }
    case "tty": {
      if (name && !config.attach) {
        await controller.startPtySession(id, name, { command, cwd, timeoutMs, cols, rows, term });
        return 0;
      }
      if (name) {
        const result = await attachSession(controller, id, name, { cols, rows, signal });
        if (result.exit) {
          // Leaving the alternate screen hid the final screen; cns screen NAME still shows it.
          if (process.stdout.isTTY) console.error(`[${name} ${describeExit(result.exit)}]`);
          return commandExitCode(result.exit);
        }
        if (result.detached) {
          console.error(`cns: ${result.detached}`);
          return 1;
        }
        if (process.stdout.isTTY) console.error(`[detached from ${name}]`);
        return 0;
      }
      const result = await attachTerminal((sink, options) => controller.openPty(id, sink, options),
        { command, cwd, timeoutMs, cols, rows, term }, { signal, screen: config.screen });
      // An unnamed session ends with its program, so it never detaches.
      const exit = result.exit!;
      if ("screen" in result && result.screen) printScreen(result.screen);
      if (exit.error) console.error(`cns: ${exit.error}`);
      if (exit.timedOut) console.error("cns: command timed out");
      return commandExitCode(exit);
    }
    case "cp": {
      const { copy } = await import("./copy.js");
      await copy(controller.files(id), await controller.info(id), config.copy!);
      return 0;
    }
    case "sessions": {
      const sessions = await controller.ptySessions(id);
      if (config.json) process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
      else if (sessions.length) process.stdout.write(formatSessions(sessions) + "\n");
      return 0;
    }
    default: break;
  }
  const session = await controller.ptySession(id, name!);
  try {
    switch (config.role) {
      case "keys":
        await session.keys(config.keys!, { literal: config.literal });
        return 0;
      case "kill":
        await plain(session.kill());
        return 0;
      case "screen": {
        const history = config.screen?.history ?? 0;
        if (config.until === undefined) {
          printScreen(await plain(session.capture({ history })));
          return 0;
        }
        const result = await plain(session.wait({ text: config.until, history, timeoutMs: timeoutMs ?? DEFAULT_UNTIL_MS }));
        printScreen(result.screen);
        if (result.matched) return 0;
        if (!result.running) {
          console.error(`cns: session ${name} ended before the text appeared`);
          return 1;
        }
        console.error("cns: timed out waiting for the text");
        return 124;
      }
      default: throw new Error(`Unsupported command ${config.role}.`);
    }
  } finally {
    session[Symbol.dispose]();
  }
}
