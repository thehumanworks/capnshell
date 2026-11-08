import { mkdir, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { RemoteFiles } from "../console.js";
import { errorMessage } from "../errors.js";
import { MAX_DIRECTORY_ENTRIES, type FileKind } from "../files.js";
import { explainDenial } from "../peers.js";
import { MAX_WRITE_BYTES, type ShellInfo } from "../shell.js";
import { plain } from "../terminal.js";

/** One end of a copy: a path on this device, or on the paired device `device` names. */
export interface CopyEnd {
  /** As typed: on this device relative to the working directory, on a paired device after the colon. */
  path: string;
  /** The paired device's name; absent for a path on this device. */
  device?: string;
}

/** What cns cp copies: a file, or with `recursive` a directory, between any two ends. */
export interface CopyRequest {
  source: CopyEnd;
  destination: CopyEnd;
  recursive: boolean;
}

/** The peer's path style, from the platform its handshake reported. */
const pathsOf = (info: Pick<ShellInfo, "platform">) => info.platform === "win32" ? path.win32 : path.posix;

/** Where `value` points on the peer, whose home is `info.cwd`: scp's rules, plus ~ and ~/ for that home. */
export function remotePath(info: Pick<ShellInfo, "platform" | "cwd">, value: string): string {
  const paths = pathsOf(info);
  if (value === "~") return info.cwd;
  if (/^~[\\/]/.test(value) && (info.platform === "win32" || value[1] === "/")) return paths.join(info.cwd, value.slice(2));
  return paths.isAbsolute(value) ? value : paths.join(info.cwd, value);
}

const missing = (error: unknown) => /^ENOENT\b/.test(errorMessage(error));

/** Bytes a local read asks for at once; a remote read returns what its peer allows. */
const LOCAL_CHUNK_BYTES = MAX_WRITE_BYTES;
/** Files of a directory copied at once, so many small files are not one round trip after another. */
export const PARALLEL_FILES = 8;

interface Reader {
  /** Bytes from `offset`; `eof` once the end of the file is reached. */
  read(offset: number): Promise<{ data: Uint8Array; eof: boolean }>;
  close(): Promise<void>;
}
interface Writer {
  write(data: Uint8Array, offset: number): Promise<void>;
  close(): Promise<void>;
}

/** The file operations a copy uses on one device. */
export interface Side {
  /** For messages: `studio:` for a paired device, nothing for this one. */
  readonly prefix: string;
  readonly paths: typeof path.posix;
  /** The largest write this side accepts at once. */
  readonly writeLimit: number;
  /** An absolute path for `value` as typed. */
  resolve(value: string): string;
  /** `value` as typed names a directory to copy into, as `dir/` and an empty remote path do. */
  directoryIntent(value: string): boolean;
  /** What the path is, following links, with its permission bits; undefined when nothing is there. */
  stat(target: string): Promise<{ kind: FileKind; mode: number } | undefined>;
  /** A directory's entries; a link is reported as a link. */
  list(directory: string): Promise<Array<{ name: string; kind: FileKind }>>;
  /** Create a directory and its missing parents. */
  mkdir(directory: string): Promise<void>;
  openRead(file: string): Promise<Reader>;
  /** Create or truncate `file`; a new file gets `mode`, less the umask. */
  openWrite(file: string, mode: number): Promise<Writer>;
}

const kindOf = (stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind =>
  stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other";

/** This device's files, as this process sees them. */
export function localSide(): Side {
  const windows = process.platform === "win32";
  return {
    prefix: "",
    paths: path,
    writeLimit: Number.MAX_SAFE_INTEGER,
    resolve: (value) => path.resolve(value),
    directoryIntent: (value) => (windows ? /[\\/]$/ : /\/$/).test(value),
    async stat(target) {
      try {
        const described = await stat(target);
        return { kind: kindOf(described), mode: described.mode & 0o7777 };
      } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    async list(directory) {
      return (await readdir(directory, { withFileTypes: true })).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
    },
    async mkdir(directory) { await mkdir(directory, { recursive: true }); },
    async openRead(file) {
      const handle = await open(file, "r");
      return {
        async read(offset) {
          const buffer = Buffer.alloc(LOCAL_CHUNK_BYTES);
          let read = 0;
          while (read < buffer.length) {
            const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
            if (bytesRead === 0) break;
            read += bytesRead;
          }
          return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, read), eof: read < buffer.length };
        },
        close: () => handle.close(),
      };
    },
    async openWrite(file, mode) {
      // An existing file keeps its own permission bits, as with scp.
      const handle = await open(file, "w", mode);
      return {
        async write(data, offset) {
          for (let written = 0; written < data.byteLength;) {
            const { bytesWritten } = await handle.write(data, written, data.byteLength - written, offset + written);
            written += bytesWritten;
          }
        },
        close: () => handle.close(),
      };
    },
  };
}

/** A refusal from `device`, with the grant to give there; other errors are left as they are. */
function explained(error: unknown, device: string): unknown {
  const message = errorMessage(error);
  const explanation = explainDenial(message, device);
  return explanation === message ? error : new Error(explanation, { cause: error });
}

/** The files of paired device `device`, whose file operations are `files` and handshake `info`. */
export function remoteSide(device: string, files: RemoteFiles, info: Pick<ShellInfo, "platform" | "cwd">): Side {
  const paths = pathsOf(info);
  const windows = info.platform === "win32";
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw explained(error, device); }
  };
  return {
    prefix: `${device}:`,
    paths,
    writeLimit: MAX_WRITE_BYTES,
    resolve: (value) => remotePath(info, value),
    directoryIntent: (value) => value === "" || value === "~" || (windows ? /[\\/]$/ : /\/$/).test(value),
    async stat(target) {
      try {
        const described = await call(() => plain(files.stat(target)));
        return { kind: described.kind, mode: described.mode };
      } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    list: (directory) => call(() => plain(files.readdir(directory))),
    mkdir: (directory) => call(async () => { await files.mkdir(directory); }),
    async openRead(file) {
      return {
        read: (offset) => call(() => plain(files.readFile(file, { offset }))),
        async close() {},
      };
    },
    async openWrite(file, mode) {
      // The first write creates or truncates the file; an empty file is created on close.
      let started = false;
      const write = (data: Uint8Array, offset: number) => {
        const first = !started;
        started = true;
        return call(async () => { await files.writeFileAt(file, data, first ? { offset: 0, truncate: true, mode } : { offset }); });
      };
      return {
        write,
        async close() { if (!started) await write(new Uint8Array(0), 0); },
      };
    },
  };
}

/** Copy one file's bytes, asking for the next part while the last one is written. */
async function copyFile(from: Side, source: string, to: Side, target: string, mode: number) {
  const reader = await from.openRead(source);
  try {
    const writer = await to.openWrite(target, mode & 0o777);
    try {
      let offset = 0;
      let next = reader.read(offset);
      for (;;) {
        const { data, eof } = await next;
        if (!eof && data.byteLength) {
          next = reader.read(offset + data.byteLength);
          next.catch(() => {});
        }
        for (let part = 0; part < data.byteLength; part += to.writeLimit) {
          await writer.write(data.subarray(part, part + to.writeLimit), offset + part);
        }
        offset += data.byteLength;
        if (eof || !data.byteLength) break;
      }
    } finally {
      await writer.close();
    }
  } finally {
    await reader.close();
  }
}

/** Run at most `limit` tasks at once; `drain` waits for the rest and throws the first failure. */
function pool(limit: number) {
  const running = new Set<Promise<void>>();
  const failures: unknown[] = [];
  return {
    async add(task: () => Promise<void>) {
      if (failures.length) throw failures[0];
      while (running.size >= limit) await Promise.race(running);
      if (failures.length) throw failures[0];
      const promise: Promise<void> = task().catch((error: unknown) => { failures.push(error); })
        .finally(() => { running.delete(promise); });
      running.add(promise);
    },
    async drain() {
      await Promise.all(running);
      if (failures.length) throw failures[0];
    },
  };
}

export interface CopyOptions {
  recursive?: boolean;
  /** Told about each entry of a directory that is not copied. */
  skipped?: (path: string, reason: string) => void;
}

/**
 * Copy `sourceValue` on `from` to `targetValue` on `to`, with scp's rules: a destination that
 * is a directory, or ends with /, receives the source under its own name; a directory needs
 * `recursive`. Returns how many entries were skipped: links to directories, broken links and
 * special files, which a directory copy does not follow or recreate.
 */
export async function copy(from: Side, sourceValue: string, to: Side, targetValue: string, options: CopyOptions = {}): Promise<number> {
  const source = from.resolve(sourceValue);
  const described = await from.stat(source);
  if (!described) throw new Error(`${from.prefix}${source}: No such file or directory.`);
  if (described.kind === "directory" && !options.recursive) throw new Error(`${from.prefix}${source} is a directory; copy it with cns cp -r.`);
  if (described.kind !== "file" && described.kind !== "directory") throw new Error(`${from.prefix}${source} is not a regular file.`);
  let target = to.resolve(targetValue);
  const existing = await to.stat(target);
  if (to.directoryIntent(targetValue) || existing?.kind === "directory") {
    target = to.paths.join(target, from.paths.basename(source));
  } else if (existing && described.kind === "directory") {
    throw new Error(`${to.prefix}${target} exists and is not a directory.`);
  }
  if (from === to) {
    const relative = from.paths.relative(source, target);
    if (relative === "") throw new Error(`${from.prefix}${source} and ${to.prefix}${target} are the same file.`);
    if (described.kind === "directory" && relative !== ".." && !relative.startsWith(`..${from.paths.sep}`) && !from.paths.isAbsolute(relative)) {
      throw new Error(`Cannot copy ${from.prefix}${source} into itself, ${to.prefix}${target}.`);
    }
  }
  if (described.kind === "file") {
    await copyFile(from, source, to, target, described.mode);
    return 0;
  }
  let skips = 0;
  const skip = (entry: string, reason: string) => { skips++; options.skipped?.(`${from.prefix}${entry}`, reason); };
  const files = pool(PARALLEL_FILES);
  // Directories are walked in order and created before their entries; their files are copied a few at a time.
  const walk = async (directory: string, into: string): Promise<void> => {
    await to.mkdir(into);
    const entries = await from.list(directory);
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      throw new Error(`${from.prefix}${directory} has ${MAX_DIRECTORY_ENTRIES} entries or more; cns cp -r copies directories with fewer.`);
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = from.paths.join(directory, entry.name);
      const copyTo = to.paths.join(into, entry.name);
      if (entry.kind === "directory") { await walk(child, copyTo); continue; }
      if (entry.kind === "file" || entry.kind === "symlink") {
        await files.add(async () => {
          // A link to a file is copied as the file; the mode is the target's.
          const current = await from.stat(child);
          if (current?.kind === "file") return copyFile(from, child, to, copyTo, current.mode);
          if (!current) skip(child, entry.kind === "symlink" ? "a broken link" : "removed during the copy");
          else skip(child, current.kind === "directory" ? "a link to a directory, which is not followed" : "not a regular file");
        });
        continue;
      }
      skip(child, "not a regular file");
    }
  };
  try {
    await walk(source, target);
  } catch (error) {
    // Let the copies in flight finish before reporting, so nothing writes after this returns.
    await files.drain().catch(() => {});
    throw error;
  }
  await files.drain();
  return skips;
}
