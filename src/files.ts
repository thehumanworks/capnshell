import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Bytes one readFile call returns at most. Larger files are read in several calls. */
export const MAX_FILE_CHUNK_BYTES = 1024 * 1024;
/** Bytes one writeFile call accepts. Larger files are not written over RPC. */
export const MAX_WRITE_BYTES = 4 * 1024 * 1024;
/** Entries readdir returns at most. */
export const MAX_DIRECTORY_ENTRIES = 10_000;
/** Paths glob returns at most. */
export const MAX_GLOB_RESULTS = 10_000;

// RPC callers are not necessarily TypeScript: validate at the trust boundary.
const pathSchema = z.string().min(1).max(32768)
  .refine((value) => path.isAbsolute(value), "path must be an absolute path on the executing peer.");
const readOptionsSchema = z.strictObject({
  offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  length: z.int().min(1).max(MAX_FILE_CHUNK_BYTES).default(MAX_FILE_CHUNK_BYTES),
});
const accessOptionsSchema = z.strictObject({ write: z.boolean().default(false) });
const globOptionsSchema = z.strictObject({
  /** Glob patterns, relative to cwd, whose matches are left out. */
  ignore: z.array(z.string().min(1).max(1024)).max(64).default([]),
  limit: z.int().min(1).max(MAX_GLOB_RESULTS).default(MAX_GLOB_RESULTS),
});
const globPatternSchema = z.string().min(1).max(1024);
const dataSchema = z.instanceof(Uint8Array, { message: "data must be a Uint8Array." })
  .refine((data) => data.byteLength <= MAX_WRITE_BYTES, `writeFile accepts at most ${MAX_WRITE_BYTES} bytes.`);

export type ReadFileOptions = z.input<typeof readOptionsSchema>;
export type AccessOptions = z.input<typeof accessOptionsSchema>;
export type GlobOptions = z.input<typeof globOptionsSchema>;
export type FileKind = "file" | "directory" | "symlink" | "other";
export interface FileStat {
  /** The kind of the path's target; `symlink` only for a dangling link. */
  kind: FileKind;
  /** The path itself is a symbolic link. */
  symlink: boolean;
  size: number;
  mtimeMs: number;
  /** Permission bits. */
  mode: number;
}
export interface DirectoryEntry { name: string; kind: FileKind }
export interface FileChunk {
  data: Uint8Array;
  /** The file's size when the chunk was read. */
  size: number;
  /** The chunk ends at the end of the file. */
  eof: boolean;
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

/** Describe a path, following a symbolic link to its target when it has one. */
export async function statPath(file: string): Promise<FileStat> {
  const target = pathSchema.parse(file);
  const link = await lstat(target);
  if (!link.isSymbolicLink()) {
    return { kind: kindOf(link), symlink: false, size: link.size, mtimeMs: link.mtimeMs, mode: link.mode & 0o7777 };
  }
  try {
    const stats = await stat(target);
    return { kind: kindOf(stats), symlink: true, size: stats.size, mtimeMs: stats.mtimeMs, mode: stats.mode & 0o7777 };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return { kind: "symlink", symlink: true, size: link.size, mtimeMs: link.mtimeMs, mode: link.mode & 0o7777 };
  }
}

/** Resolve when the path can be read (and written, with `write`); reject with the system error otherwise. */
export async function accessPath(file: string, options: AccessOptions = {}): Promise<void> {
  const { write } = accessOptionsSchema.parse(options);
  await access(pathSchema.parse(file), write ? constants.R_OK | constants.W_OK : constants.R_OK);
}

export async function readDirectory(directory: string): Promise<DirectoryEntry[]> {
  const entries = await readdir(pathSchema.parse(directory), { withFileTypes: true });
  return entries.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
}

export async function makeDirectory(directory: string): Promise<void> {
  await mkdir(pathSchema.parse(directory), { recursive: true });
}

/**
 * Files and symbolic links under `cwd` whose path relative to it matches `pattern`,
 * as absolute paths. Hidden entries are included and links are not followed. A
 * directory is not entered when an ignore pattern ending in `/**` covers all of it,
 * as one ignoring every node_modules directory does; unreadable directories below `cwd` are skipped.
 */
export async function globFiles(pattern: string, cwd: string, options: GlobOptions = {}): Promise<string[]> {
  const root = pathSchema.parse(cwd);
  const { ignore, limit } = globOptionsSchema.parse(options);
  const glob = new Bun.Glob(globPatternSchema.parse(pattern));
  const ignored = ignore.map((entry) => new Bun.Glob(entry));
  const pruned = ignore.filter((entry) => entry.endsWith("/**")).map((entry) => new Bun.Glob(entry.slice(0, -3)));
  const results: string[] = [];
  const pending = [""];
  for (let next = pending.shift(); next !== undefined && results.length < limit; next = pending.shift()) {
    let entries;
    try { entries = await readdir(path.join(root, next), { withFileTypes: true }); }
    catch (error) {
      if (next === "") throw error;
      continue;
    }
    for (const entry of entries) {
      const relative = next ? `${next}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!pruned.some((directory) => directory.match(relative))) pending.push(relative);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && glob.match(relative) && !ignored.some((match) => match.match(relative))) {
        results.push(path.join(root, relative));
        if (results.length >= limit) break;
      }
    }
  }
  return results;
}

/** Read up to `length` bytes of a file from `offset`. */
export async function readFileChunk(file: string, options: ReadFileOptions = {}): Promise<FileChunk> {
  const target = pathSchema.parse(file);
  const { offset, length } = readOptionsSchema.parse(options);
  const handle = await open(target, "r");
  try {
    const stats = await handle.stat();
    if (stats.isDirectory()) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read ${target}`), { code: "EISDIR" });
    const wanted = Math.max(0, Math.min(length, stats.size - offset));
    const buffer = Buffer.alloc(wanted);
    let read = 0;
    while (read < wanted) {
      const { bytesRead } = await handle.read(buffer, read, wanted - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const data = new Uint8Array(buffer.buffer, buffer.byteOffset, read);
    return { data, size: stats.size, eof: offset + read >= stats.size };
  } finally {
    await handle.close();
  }
}

/**
 * Replace a file's contents with up to MAX_WRITE_BYTES, in place, as a local
 * writeFile does: links are followed and the file keeps its inode, owner and
 * permissions; a new file gets the default permissions. The data arrives whole
 * before anything is written, so a broken connection never leaves part of it.
 */
export async function writeWholeFile(file: string, data: Uint8Array): Promise<void> {
  await writeFile(pathSchema.parse(file), dataSchema.parse(data));
}
