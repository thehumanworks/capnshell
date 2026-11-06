import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkConfigDirectory, checkPrivateDirectory, configDirectory, isPrivateFile, requirePrivateStateSupport } from "./config.js";

// These are address-book entries, not authenticated identities.
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function directory(): string {
  requirePrivateStateSupport("Saved peer aliases");
  return path.join(configDirectory(), "peers");
}
function checkDirectories(): void { checkConfigDirectory(); checkPrivateDirectory(directory()); }
function file(name: string): string {
  if (!namePattern.test(name)) throw new Error("Peer alias must contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  return path.join(directory(), name);
}
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
  const target = file(name);
  const address = validateAliasUrl(url);
  checkConfigDirectory(true); // A custom configuration directory must already exist.
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  checkDirectories();
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, address + "\n"); } finally { closeSync(fd); }
}
export function removeAlias(name: string): void { const target = file(name); checkDirectories(); unlinkSync(target); }
export function resolveAlias(name: string): string {
  const target = file(name);
  let fd: number;
  try { checkDirectories(); fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown peer alias: ${name}`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!isPrivateFile(stat)) throw new Error(`Peer alias must be a private file owned by your user: ${target}`);
    return validateAliasUrl(readFileSync(fd, "utf8").trim());
  } finally { closeSync(fd); }
}
export function listAliases(): Array<{ name: string; url: string }> {
  const peerDirectory = directory(); // Fail closed on unsupported platforms even when config is absent.
  let names: string[];
  try { checkDirectories(); names = readdirSync(peerDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.sort().map((name) => ({ name, url: resolveAlias(name) }));
}
