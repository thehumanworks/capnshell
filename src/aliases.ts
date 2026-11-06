import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkConfigDirectory, checkPrivateDirectory, configDirectory, isPrivateFile, requirePrivateStateSupport } from "./config.js";

// Plain files here are address-book entries, not authenticated identities; paired
// devices are JSON files in the same directory, read by peers.ts.
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
  if (!namePattern.test(name)) throw new Error("Peer alias must contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
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

/** Replace a private peer file's contents in place. */
export function rewritePeerFile(name: string, content: string): void {
  const target = file(name);
  checkDirectories();
  const fd = openSync(target, constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!isPrivateFile(fstatSync(fd))) throw new Error(`Peer file must be a private file owned by your user: ${target}`);
    writeFileSync(fd, content);
  } finally { closeSync(fd); }
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
    if (!isPrivateFile(fstatSync(fd))) throw new Error(`Peer alias must be a private file owned by your user: ${target}`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** The names of every saved peer, sorted; [] when nothing has been saved yet. */
export function peerNames(): string[] {
  const peerDirectory = directory(); // Fail closed on unsupported platforms even when config is absent.
  try { checkDirectories(); return readdirSync(peerDirectory).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Whether a peer file holds a paired device rather than a plain address. */
export const isPairedEntry = (content: string) => content.trimStart().startsWith("{");
export function validatePeerUrl(value: string): string {
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
  }
  return parsed.href;
}
function validateAliasUrl(value: string): string {
  const url = validatePeerUrl(value);
  const parsed = new URL(url);
  if (parsed.pathname !== "/" || parsed.search) throw new Error("Saved peer addresses cannot include a path or query. Use an explicit URL instead.");
  return url;
}
export function addAlias(name: string, url: string): void {
  file(name);
  const address = validateAliasUrl(url);
  createPeerFile(name, address + "\n");
}
export function removeAlias(name: string): void { const target = file(name); checkDirectories(); unlinkSync(target); }
/** The URL saved under an address alias. A paired device is not an address alias; peers.ts resolves it. */
export function resolveAlias(name: string): string {
  const content = readPeerFile(name);
  if (content === undefined) throw new Error(`Unknown peer alias: ${name}`);
  if (isPairedEntry(content)) throw new Error(`${name} is a paired device, not a saved address. Name it as the target instead: cns run ${name} -- '...'`);
  return validateAliasUrl(content.trim());
}
/** Saved address aliases only; see peers.ts for paired devices. */
export function listAliases(): Array<{ name: string; url: string }> {
  return peerNames().flatMap((name) => {
    const content = readPeerFile(name);
    return content === undefined || isPairedEntry(content) ? [] : [{ name, url: validateAliasUrl(content.trim()) }];
  });
}
