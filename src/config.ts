import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where this user's cns keeps its private local state: saved peers, the device
 * identity and the daemon state. `CNS_CONFIG_DIR` overrides the default `~/.cns`.
 * The directory and its whole path must be trusted: these checks are best-effort
 * safeguards against misconfiguration, not a filesystem security boundary.
 */
export function configDirectory(): string { return path.resolve(process.env.CNS_CONFIG_DIR ?? path.join(os.homedir(), ".cns")); }

/** A directory that only this user can read, not a link. On Windows its ACL is checked instead of Unix mode bits. */
export function checkPrivateDirectory(target: string): void {
  const stat = lstatSync(target);
  const message = `Configuration directory must be private and owned by your user: ${target}`;
  if (!stat.isDirectory()) throw new Error(message);
  if (process.platform === "win32") {
    const others = windowsOthers(target);
    if (others.length) throw new Error(`${message}. Its ACL also lets ${others.join(", ")} in. To make it private, run: ${windowsHardenCommand(target)}`);
  } else if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error(message);
}

// Windows: a directory is private when its DACL allows nobody but this user, SYSTEM and
// the Administrators group, as Windows OpenSSH requires of ~/.ssh. `icacls /save` gives the
// DACL as SDDL, with SIDs rather than account names, which Windows translates.
const system32 = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
/** Trustees allowed in a private directory's DACL besides the user: SYSTEM, Administrators, and OWNER RIGHTS. */
const WINDOWS_TRUSTED = new Set(["SY", "S-1-5-18", "BA", "S-1-5-32-544", "OW", "S-1-3-4"]);
let userSid: string | undefined;
/** Directories whose ACL this process already found private. Spawning icacls on every check would block the daemon. */
const privateOnWindows = new Set<string>();

function run(file: string, args: string[]): string {
  const result = spawnSync(path.join(system32(), file), args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw new Error(`Cannot run ${file}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed: ${`${result.stdout}${result.stderr}`.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** This user's SID, such as S-1-5-21-...-1001. */
export function windowsUserSid(): string {
  if (userSid) return userSid;
  // CSV quotes both columns: "host\user","S-1-5-21-...". The SID does not depend on the language.
  const sid = /"(S-1-[0-9-]+)"/.exec(run("whoami.exe", ["/user", "/fo", "csv", "/nh"]))?.[1];
  if (!sid) throw new Error("Cannot read this user's SID from whoami /user.");
  return userSid = sid;
}

/**
 * The trustees, other than `user`, SYSTEM and Administrators, that a DACL in SDDL allows any
 * access. A missing or null DACL allows everyone. Deny entries take nothing away from privacy,
 * and CREATOR OWNER entries that only apply to new children stand for the user who creates them.
 */
export function sddlOthers(sddl: string, user: string): string[] {
  const dacl = /D:([^(]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl || /NO_ACCESS_CONTROL/.test(dacl[1]!)) return ["Everyone (no access control list)"];
  const others = new Set<string>();
  for (const [, ace] of dacl[2]!.matchAll(/\(([^)]*)\)/g)) {
    const [type = "", flags = "", , , , trustee = ""] = ace!.split(";");
    if (type === "D" || type === "OD" || type === "XD") continue;
    if (trustee === user || WINDOWS_TRUSTED.has(trustee)) continue;
    if ((trustee === "CO" || trustee === "S-1-3-0") && flags.includes("IO")) continue;
    others.add(trustee);
  }
  return [...others];
}

function windowsSddl(target: string): string {
  const out = path.join(os.tmpdir(), `cns-acl-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    run("icacls.exe", [target, "/save", out, "/q"]);
    // Two UTF-16 lines: the object's name, then its DACL. A name could contain "D:", so take the last line.
    const lines = readFileSync(out).toString("utf16le").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    return lines.at(-1) ?? "";
  } finally { if (existsSync(out)) rmSync(out, { force: true }); }
}

/** Who else a directory's ACL lets in. Empty for a private one. */
function windowsOthers(target: string): string[] {
  const key = path.resolve(target).toLowerCase();
  if (privateOnWindows.has(key)) return [];
  const others = sddlOthers(windowsSddl(target), windowsUserSid());
  if (!others.length) privateOnWindows.add(key);
  return others;
}

function windowsGrants(): string[] {
  return [`*${windowsUserSid()}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"];
}

/** The icacls command that makes a directory private, for an error message. */
function windowsHardenCommand(target: string): string {
  return `icacls "${target}" /inheritance:r /grant:r ${windowsGrants().join(" ")}`;
}

/** Make a directory cns just created private: no inherited entries, only this user, SYSTEM and Administrators. */
function hardenWindowsDirectory(target: string): void {
  run("icacls.exe", [target, "/inheritance:r", "/grant:r", ...windowsGrants(), "/q"]);
  privateOnWindows.delete(path.resolve(target).toLowerCase());
}

/** Create a private directory, if it is missing; on Windows, also restrict its ACL. */
export function makePrivateDirectory(target: string): void {
  if (existsSync(target)) return;
  mkdirSync(target, { mode: 0o700, recursive: true });
  if (process.platform === "win32") hardenWindowsDirectory(target);
}

/** Every ancestor is owned by this user or root, and none is writable by others unless it is a root-owned sticky directory. */
export function checkAncestors(target: string): void {
  // On Windows, the profile's ACLs keep other users out of it; the directory's own ACL is checked.
  if (process.platform === "win32") return;
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
    makePrivateDirectory(directory);
  }
  checkPrivateDirectory(directory);
  checkAncestors(directory);
  return directory;
}

/** A private file owned by this user, as `fstat` describes an opened one. */
export function isPrivateFile(stat: { isFile(): boolean; mode: number; uid: number }): boolean {
  return stat.isFile() && (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()));
}
