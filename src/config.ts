import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where this user's cns keeps its private local state: saved peers, the device
 * identity and the daemon state. `CNS_CONFIG_DIR` overrides the default `~/.cns`.
 * The directory and its whole path must be trusted: these checks are best-effort
 * safeguards against misconfiguration, not a filesystem security boundary.
 */
export function configDirectory(): string { return path.resolve(process.env.CNS_CONFIG_DIR ?? path.join(os.homedir(), ".cns")); }

/** Private state is unavailable on Windows until filesystem ACL checks are supported. */
export function requirePrivateStateSupport(what: string): void {
  if (process.platform === "win32") throw new Error(`${what} are not available on Windows until filesystem ACL checks are supported.`);
}

/** A directory that only this user can read, not a link. */
export function checkPrivateDirectory(target: string): void {
  const stat = lstatSync(target);
  if (!stat.isDirectory() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error(`Configuration directory must be private and owned by your user: ${target}`);
  }
}

/** Every ancestor is owned by this user or root, and none is writable by others unless it is a root-owned sticky directory. */
export function checkAncestors(target: string): void {
  if (process.platform === "win32") return; // ACLs cannot be assessed by Unix mode bits.
  for (const start of [path.resolve(target), realpathSync(target)]) {
    let current = start;
    for (;;) {
      const entry = lstatSync(current);
      if (entry.uid !== 0 && entry.uid !== process.getuid?.()) throw new Error(`Configuration has an untrusted owner: ${current}`);
      if (!entry.isSymbolicLink()) {
        const stat = statSync(current);
        if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0)) throw new Error(`Configuration has a shared-writable ancestor: ${current}`);
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}

/** Check the configuration directory, and with `create`, make the default one if it is missing. A custom one must already exist. */
export function checkConfigDirectory(create = false): string {
  const directory = configDirectory();
  if (create && process.env.CNS_CONFIG_DIR === undefined) {
    checkAncestors(path.dirname(directory));
    mkdirSync(directory, { mode: 0o700, recursive: true });
  }
  checkPrivateDirectory(directory);
  checkAncestors(directory);
  return directory;
}

/** A private file owned by this user, as `fstat` describes an opened one. */
export function isPrivateFile(stat: { isFile(): boolean; mode: number; uid: number }): boolean {
  return stat.isFile() && (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()));
}
