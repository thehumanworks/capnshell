import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { RemoteFiles } from "../console.js";
import { errorMessage } from "../errors.js";
import { MAX_WRITE_BYTES, type ShellInfo } from "../shell.js";
import { plain } from "../terminal.js";

/** What cns cp copies: one file, from this device to the peer or back. */
export interface CopyRequest {
  direction: "upload" | "download";
  /** As typed: relative to this process's working directory unless absolute. */
  local: string;
  /** As typed after the colon: relative to the peer user's home unless absolute or starting with ~. */
  remote: string;
}

/** The peer's path style, from the platform its handshake reported. */
const pathsOf = (info: Pick<ShellInfo, "platform">) => info.platform === "win32" ? path.win32 : path.posix;
/** The path names a directory to copy into rather than a file, as `dir/` and an empty remote path do. */
const directoryIntent = (value: string, windows: boolean) => value === "" || value === "~" || (windows ? /[\\/]$/ : /\/$/).test(value);

/** Where `value` points on the peer, whose home is `info.cwd`: scp's rules, plus ~ and ~/ for that home. */
export function remotePath(info: Pick<ShellInfo, "platform" | "cwd">, value: string): string {
  const paths = pathsOf(info);
  if (value === "~") return info.cwd;
  if (/^~[\\/]/.test(value) && (info.platform === "win32" || value[1] === "/")) return paths.join(info.cwd, value.slice(2));
  return paths.isAbsolute(value) ? value : paths.join(info.cwd, value);
}

/** The peer predates the call: an older ShellApi lacks it, and an older GrantedShell refuses it as unknown. */
const unsupported = (error: unknown, method: string) =>
  (error instanceof TypeError && error.message === `'${method}' is not a function.`)
  || errorMessage(error).includes(`${method} is not available to peers`);

const missing = (error: unknown) => /^ENOENT\b/.test(errorMessage(error));

/** Copy one file between this device and the peer whose file operations are `files`. */
export async function copy(files: RemoteFiles, info: Pick<ShellInfo, "platform" | "cwd">, request: CopyRequest): Promise<void> {
  if (request.direction === "download") await download(files, info, request);
  else await upload(files, info, request);
}

async function download(files: RemoteFiles, info: Pick<ShellInfo, "platform" | "cwd">, request: CopyRequest) {
  const source = remotePath(info, request.remote);
  const described = await plain(files.stat(source));
  if (described.kind === "directory") throw new Error(`${source} is a directory; cns cp copies one file.`);
  if (described.kind !== "file") throw new Error(`${source} is not a regular file.`);
  let target = path.resolve(request.local);
  if (directoryIntent(request.local, process.platform === "win32") || await isLocalDirectory(target)) {
    target = path.join(target, pathsOf(info).basename(source));
  }
  // A new file gets the source's permission bits, less the umask; an existing one keeps its own.
  const handle = await open(target, "w", described.mode & 0o777);
  try {
    let offset = 0;
    let next = plain(files.readFile(source, { offset }));
    for (;;) {
      const chunk = await next;
      const data = chunk.data;
      // Ask for the next part while this one is written.
      if (!chunk.eof && data.byteLength) {
        next = plain(files.readFile(source, { offset: offset + data.byteLength }));
        next.catch(() => {});
      }
      for (let written = 0; written < data.byteLength;) {
        const { bytesWritten } = await handle.write(data, written, data.byteLength - written, offset + written);
        written += bytesWritten;
      }
      offset += data.byteLength;
      if (chunk.eof || !data.byteLength) break;
    }
  } finally {
    await handle.close();
  }
}

async function isLocalDirectory(target: string) {
  try { return (await stat(target)).isDirectory(); }
  catch (error) { if (missing(error)) return false; throw error; }
}

async function upload(files: RemoteFiles, info: Pick<ShellInfo, "platform" | "cwd">, request: CopyRequest) {
  const source = path.resolve(request.local);
  const described = await stat(source);
  if (described.isDirectory()) throw new Error(`${source} is a directory; cns cp copies one file.`);
  if (!described.isFile()) throw new Error(`${source} is not a regular file.`);
  const paths = pathsOf(info);
  let target = remotePath(info, request.remote);
  if (directoryIntent(request.remote, info.platform === "win32") || await isRemoteDirectory(files, target)) {
    target = paths.join(target, path.basename(source));
  }
  const handle = await open(source, "r");
  try {
    for (let offset = 0; ;) {
      const chunk = await readAt(handle, offset, MAX_WRITE_BYTES);
      if (offset === 0) {
        try {
          // A new file gets the source's permission bits, less the peer's umask.
          await files.writeFileAt(target, chunk, { offset: 0, truncate: true, mode: described.mode & 0o777 });
        } catch (error) {
          if (!unsupported(error, "writeFileAt")) throw error;
          // An older peer replaces whole files only, up to its write limit.
          if (described.size > MAX_WRITE_BYTES) {
            throw new Error(`The peer's cns accepts files of at most ${MAX_WRITE_BYTES / 1024 / 1024} MiB; update cns there to copy larger ones.`);
          }
          await files.writeFile(target, chunk);
          return;
        }
      } else {
        await files.writeFileAt(target, chunk, { offset });
      }
      offset += chunk.byteLength;
      if (chunk.byteLength < MAX_WRITE_BYTES) break;
    }
  } finally {
    await handle.close();
  }
}

async function isRemoteDirectory(files: RemoteFiles, target: string) {
  try { return (await plain(files.stat(target))).kind === "directory"; }
  catch (error) { if (missing(error)) return false; throw error; }
}

/** Up to `length` bytes from `offset`, fewer only at the end of the file. */
async function readAt(handle: Awaited<ReturnType<typeof open>>, offset: number, length: number): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
}
