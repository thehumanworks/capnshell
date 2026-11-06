import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// These are address-book entries, not authenticated identities.
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function configDirectory(): string { return path.resolve(process.env.CNS_CONFIG_DIR ?? path.join(os.homedir(), ".cns")); }
function directory(): string {
  if (process.platform === "win32") throw new Error("Saved peer aliases are not available on Windows until filesystem ACL checks are supported. Use an explicit URL.");
  return path.join(configDirectory(), "peers");
}
function checkDirectory(target: string): void {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error(`Peer configuration directory must be private and owned by your user: ${target}`);
}
function checkAncestors(target: string): void {
  if (process.platform === "win32") return; // ACLs cannot be assessed by Unix mode bits.
  // Best-effort pathname checks; the entire configuration path must be trusted.
  for (const start of [path.resolve(target), realpathSync(target)]) {
    let current = start;
    for (;;) {
      const entry = lstatSync(current);
      if (entry.uid !== 0 && entry.uid !== process.getuid?.()) throw new Error(`Peer configuration has an untrusted owner: ${current}`);
      if (!entry.isSymbolicLink()) {
        const stat = statSync(current);
        if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0)) throw new Error(`Peer configuration has a shared-writable ancestor: ${current}`);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}
function checkDirectories(): void { checkDirectory(configDirectory()); checkAncestors(configDirectory()); checkDirectory(directory()); }
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
  if (process.env.CNS_CONFIG_DIR === undefined) {
    checkAncestors(path.dirname(configDirectory()));
    mkdirSync(configDirectory(), { mode: 0o700, recursive: true });
  } // A custom configuration directory must already exist.
  checkDirectory(configDirectory());
  checkAncestors(configDirectory());
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
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error(`Peer alias must be a private file owned by your user: ${target}`);
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
