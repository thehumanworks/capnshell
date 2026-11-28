import { auditPath, readAuditLog, type AuditEntry } from "../audit.js";
import { printable } from "../errors.js";
import { describeExit } from "../session-text.js";

export interface AuditOptions { peer?: string; since?: string; limit?: string; json?: boolean }

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** The time --since names: so long before `now`, such as 30m, or a date and time. */
export function sinceTime(value: string, now = Date.now()): number {
  const ago = /^(\d+)([smhd])$/.exec(value.trim());
  const time = ago ? now - Number(ago[1]) * UNITS[ago[2]!]! : Date.parse(value);
  if (Number.isNaN(time)) throw new Error("--since takes a time ago, such as 30m, 2h or 7d, or a date such as 2026-11-28 or 2026-11-28T09:00Z.");
  return time;
}

/** How long something took, roughly. */
function span(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 2 * 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 2 * 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function result(entry: AuditEntry): string {
  if (entry.error !== undefined) return "failed";
  if (entry.exitCode === undefined && entry.signal === undefined) return "ok";
  const exit = describeExit({ exitCode: entry.exitCode ?? null, signal: entry.signal ?? null, timedOut: entry.timedOut === true });
  const took = entry.end ? Date.parse(entry.end) - Date.parse(entry.start) : NaN;
  return Number.isNaN(took) ? exit : `${exit} after ${span(took)}`;
}

/** The target as people read it: a command with where it ran and the secrets it got, and why it failed. */
function target(entry: AuditEntry): string {
  const program = entry.action === "session.start" ? `${entry.target}: ${entry.command ?? "(login shell)"}` : entry.target;
  const secrets = Array.isArray(entry.secrets) ? ` with secrets ${entry.secrets.join(", ")}` : "";
  return `${program}${entry.cwd ? ` (in ${entry.cwd})` : ""}${secrets}${entry.error === undefined ? "" : `: ${entry.error}`}`;
}

/** Entries as a table, every value made safe to print: a device chose the commands and paths. */
export function formatAudit(entries: readonly AuditEntry[]): string {
  const table = [["STARTED (UTC)", "PEER", "ACTION", "RESULT", "TARGET"], ...entries.map((entry) => [
    entry.start.slice(0, 19).replace("T", " "), entry.peer, entry.action, result(entry), target(entry),
  ].map(printable))];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  return table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n");
}

/**
 * `cns audit`: the newest entries of this device's audit log, newest first: what paired devices
 * did here. `--peer` takes a device's name here or its fingerprint; `--since` keeps what ended
 * since then, or, for what has no end, started since then.
 */
export function audit(options: AuditOptions): void {
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit takes a number of entries, such as 100.");
  const since = options.since === undefined ? undefined : sinceTime(options.since);
  const entries = readAuditLog().filter((entry) =>
    (options.peer === undefined || entry.peer === options.peer || entry.fingerprint === options.peer)
    && (since === undefined || Date.parse(entry.end ?? entry.start) >= since)).reverse().slice(0, limit);
  if (options.json) { console.log(JSON.stringify(entries, null, 2)); return; }
  if (entries.length) { console.log(formatAudit(entries)); return; }
  const filtered = options.peer !== undefined || since !== undefined;
  console.error(filtered ? "No entries match. Run cns audit without --peer and --since to see them all."
    : `Nothing recorded yet in ${auditPath()}: the daemon records there what paired devices do on this device.`);
}
