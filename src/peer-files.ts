import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkConfigDirectory, checkPrivateDirectory, configDirectory, isPrivateFile, requirePrivateStateSupport } from "./config.js";

// One private file per paired device, named by this user's alias for it. peers.ts reads
// and writes the JSON records; this module only handles the files.
export const peerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** The directory of saved peers, one file per name. */
export function peersDirectory(): string {
  requirePrivateStateSupport("Saved peers");
  return path.join(configDirectory(), "peers");
}
/** The configuration and peers directories are private and on a trusted path. */
export function checkPeerDirectories(): void { checkConfigDirectory(); checkPrivateDirectory(peersDirectory()); }
const directory = peersDirectory;
const checkDirectories = checkPeerDirectories;
const namePattern = peerNamePattern;
/** The file for a saved peer name, after validating the name. */
export function peerFile(name: string): string {
  if (!namePattern.test(name)) throw new Error("A peer name must contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  return path.join(directory(), name);
}
const file = peerFile;

/** Create the peers directory if needed, with the default configuration directory. */
export function preparePeersDirectory(): void {
  checkConfigDirectory(true); // A custom configuration directory must already exist.
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  checkDirectories();
}

/** Create a private peer file that must not exist yet. */
export function createPeerFile(name: string, content: string): void {
  const target = file(name);
  preparePeersDirectory();
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
}

/**
 * Replace a saved peer file's contents. The new contents go to a private temporary
 * file that is then renamed over the old one, so a crash leaves either version whole.
 * The temporary name starts with a dot, which peerNames never lists.
 */
export function rewritePeerFile(name: string, content: string): void {
  const target = file(name);
  if (readPeerFile(name) === undefined) throw new Error(`Unknown peer: ${name}`);
  const temporary = path.join(directory(), `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Whether any file, valid or not, is saved under this name. */
export function peerFileExists(name: string): boolean {
  const target = file(name);
  try { checkDirectories(); lstatSync(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Read a saved peer's file, which must be a private regular file; undefined when there is none. */
export function readPeerFile(name: string): string | undefined {
  const target = file(name);
  let fd: number;
  try { checkDirectories(); fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!isPrivateFile(fstatSync(fd))) throw new Error(`A saved peer must be a private file owned by your user: ${target}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/**
 * The names of every saved peer, sorted; [] when nothing has been saved yet. Files
 * whose names cannot be peer names, such as .DS_Store or a temporary file, are not peers.
 */
export function peerNames(): string[] {
  const peerDirectory = directory(); // Fail closed on unsupported platforms even when config is absent.
  try { checkDirectories(); return readdirSync(peerDirectory).filter((name) => namePattern.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function validatePeerUrl(value: string): string {
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
  }
  return parsed.href;
}
/** Remove a saved peer's file. */
export function removePeerFile(name: string): void { const target = file(name); checkDirectories(); unlinkSync(target); }
