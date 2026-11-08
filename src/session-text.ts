import type { PtyExit, PtySessionInfo } from "./shell.js";

/*
 * How sessions and their exits read as text, shared by the commands and the MCP tools.
 * It imports no commands, so the MCP tools bundle for the gateway Worker without them.
 */

/** Wait this long for --until text unless --timeout says otherwise. */
export const DEFAULT_UNTIL_MS = 30_000;

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
