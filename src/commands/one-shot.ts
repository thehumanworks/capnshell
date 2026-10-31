import type { PeerController } from "../console.js";
import type { PeerConfig } from "../options.js";
import type { PtyExit, PtyScreen, PtySessionInfo, RunResult } from "../shell.js";
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

export function describeExit(exit: PtyExit): string {
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

/** Run a connect-mode command against peer `id` and return the CLI exit status. */
export async function runOneShot(config: PeerConfig, controller: PeerController, id: string, signal: AbortSignal): Promise<number> {
  const { command, cwd, timeoutMs, cols, rows, term, name } = config;
  switch (config.role) {
    case "run": {
      const result = await controller.run(id, command!, { cwd, timeoutMs });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.truncated) console.error("cns: OUTPUT TRUNCATED at 1 MiB");
      if (result.timedOut) console.error("cns: command timed out");
      return commandExitCode(result);
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
