import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, renameSync, writeSync } from "node:fs";
import path from "node:path";
import { configDirectory, isPrivateFile } from "./config.js";
import { errorMessage } from "./errors.js";

/*
 * The audit log: one JSON line for each thing a paired device did on this device, which the
 * daemon appends to audit.log in the configuration directory (granted-shell.ts writes them).
 * It keeps command lines, paths, session names and secret names, never file contents, typed
 * input, environment variables or secret values.
 */

export type AuditAction = "run" | "terminal" | "session.start" | "session.attach" | "session.end" | "session.kill" | "file.read" | "file.write" | "file.mkdir" | "skill.read" | "port.forward";

export interface AuditEntry {
  /** When it started, as an ISO time. */
  start: string;
  /** When it ended, for a command, a terminal, a session's end and a forward. */
  end?: string;
  /**
   * "start" on the line a command, terminal or forward gets as it starts. The line that ends it follows,
   * with the same action, target and start; without one, it is still running or its daemon stopped.
   */
  phase?: "start";
  /** Shared by a command's, terminal's or forward's start line and the line that ends it. */
  id?: string;
  /** The device's name on this device, when it acted. */
  peer: string;
  /** The device's key fingerprint, which a rename does not change. */
  fingerprint: string | null;
  action: AuditAction;
  /** The command line, path, session name, skill/file, or localhost:PORT. */
  target: string;
  /** Where a program ran, when the device chose. */
  cwd?: string;
  /** The program a session started; none for a login shell. */
  command?: string;
  /** The mesh secrets a program got here, by name. */
  secrets?: string[];
  /** The names of the variables the device gave a program, such as secrets cns run --secret opened there; never their values. */
  variables?: string[];
  exitCode?: number | null;
  signal?: string;
  timedOut?: boolean;
  /** On a forward's end line: the TCP connections it carried, the bytes the device sent to the port, and those the port sent back. */
  connections?: number;
  bytesIn?: number;
  bytesOut?: number;
  /** Why it failed, such as a grant the device lacks. */
  error?: string;
}
export type AuditLog = (entry: AuditEntry) => void;

/** Past this size the log moves to audit.log.1, replacing the one there, so the two take at most twice this. */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024;
/** Characters kept of one value: as many as a command holds, so that a few long values cannot push the rest out. */
const MAX_FIELD = 8192;

/** `value` cut to `limit` characters, marked when it was cut. */
export function clip(value: string, limit = MAX_FIELD): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

export function auditPath(): string { return path.join(configDirectory(), "audit.log"); }

const notPrivate = (file: string) => new Error(`The audit log must be a private file owned by your user: ${file}. To make it one, run: chmod 600 ${file}`);

/** Open the log to append to it, created private when it is missing, and say how large it is. */
function openLog(file: string): { fd: number; size: number } {
  const fd = openSync(file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  const stat = fstatSync(fd);
  if (isPrivateFile(stat)) return { fd, size: stat.size };
  closeSync(fd);
  throw notPrivate(file);
}

/** Whether the file ends in the middle of a line, as when a write was cut short. */
function cutShort(fd: number, size: number): boolean {
  const last = Buffer.alloc(1);
  return size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
}

/**
 * Append entries to the audit log at `file`, first moving it to FILE.1 when an entry would take it
 * past `maxBytes`. It never throws, so that no peer's action fails because its entry could not be
 * written: a failure is reported once, until a write works again.
 */
export function auditLog({ file = auditPath(), maxBytes = AUDIT_MAX_BYTES, report = (message: string) => console.error(message) } = {}): AuditLog {
  let reported = false;
  return (entry) => {
    try {
      const clipped = JSON.stringify(entry, (_key, value: unknown) => typeof value === "string" ? clip(value) : value);
      const line = Buffer.from(`${clipped}\n`);
      let { fd, size } = openLog(file);
      try {
        if (size > 0 && size + line.length > maxBytes) {
          closeSync(fd);
          fd = -1;
          renameSync(file, `${file}.1`);
          ({ fd, size } = openLog(file));
        }
        // A line cut short ends here, so that it does not take this entry with it.
        writeSync(fd, cutShort(fd, size) ? Buffer.concat([Buffer.from("\n"), line]) : line);
      } finally { if (fd !== -1) closeSync(fd); }
      reported = false;
    } catch (error) {
      if (reported) return;
      reported = true;
      report(`Cannot write the audit log, so what paired devices do here goes unrecorded until it can be written (reported once until then): ${errorMessage(error)}`);
    }
  };
}

function readPrivate(file: string): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!isPrivateFile(fstatSync(fd))) throw notPrivate(file);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

const isEntry = (value: unknown): value is AuditEntry => {
  const entry = value as Partial<Record<keyof AuditEntry, unknown>> | null;
  return typeof entry === "object" && entry !== null && [entry.start, entry.peer, entry.action, entry.target].every((field) => typeof field === "string");
};

/** The entries of the audit log at `file` and of the one before it, oldest first. A line that is not an entry, such as one cut short, is skipped. */
export function readAuditLog(file = auditPath()): AuditEntry[] {
  return [`${file}.1`, file].flatMap((name) => (readPrivate(name) ?? "").split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return isEntry(entry) ? [entry] : [];
    } catch { return []; }
  }));
}
