import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkConfigDirectory, checkPrivateDirectory, configDirectory, isPrivateFile, makePrivateDirectory } from "./config.js";

// One private file per paired device, named by this user's alias for it. peers.ts reads
// and writes the JSON records; this module only handles the files. Meshes (mesh.ts) keep
// their state the same way, in a directory of their own.
export const peerNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const namePattern = peerNamePattern;

/** A private directory under the configuration directory, holding one private file per name. */
function privateFiles(directory: () => string, what: string) {
  /** The configuration directory and this one are private and on a trusted path. */
  const checkDirectories = () => { checkConfigDirectory(); checkPrivateDirectory(directory()); };
  /** The file for a name, after validating the name. */
  const file = (name: string) => {
    if (!namePattern.test(name)) throw new Error(`A ${what} name must contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.`);
    return path.join(directory(), name);
  };
  /** Create the directory if needed, with the default configuration directory. */
  const prepare = () => {
    checkConfigDirectory(true); // A custom configuration directory must already exist.
    makePrivateDirectory(directory());
    checkDirectories();
  };
  /** A file's contents, which must be a private regular file; undefined when there is none. */
  const read = (name: string): string | undefined => {
    const target = file(name);
    let fd: number;
    try { checkDirectories(); fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      if (!isPrivateFile(fstatSync(fd))) throw new Error(`A saved ${what} must be a private file owned by your user: ${target}`);
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  };
  return {
    checkDirectories, file, prepare, read,
    /** Create a private file that must not exist yet. */
    create(name: string, content: string): void {
      const target = file(name);
      prepare();
      const fd = openSync(target, "wx", 0o600);
      try { writeFileSync(fd, content); } finally { closeSync(fd); }
    },
    /**
     * Replace a file's contents. The new contents go to a private temporary file that is
     * then renamed over the old one, so a crash leaves either version whole. The temporary
     * name starts with a dot, which `names` never lists.
     */
    rewrite(name: string, content: string): void {
      const target = file(name);
      if (read(name) === undefined) throw new Error(`Unknown ${what}: ${name}`);
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
    },
    /** Whether any file, valid or not, is saved under this name. */
    exists(name: string): boolean {
      const target = file(name);
      try { checkDirectories(); lstatSync(target); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    },
    /**
     * Every saved name, sorted; [] when nothing has been saved yet. Files whose names
     * cannot be names, such as .DS_Store or a temporary file, are left out.
     */
    names(): string[] {
      const saved = directory(); // Fail closed on unsupported platforms even when config is absent.
      try { checkDirectories(); return readdirSync(saved).filter((name) => namePattern.test(name)).sort(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
    /** Remove a saved file. */
    remove(name: string): void { const target = file(name); checkDirectories(); unlinkSync(target); },
  };
}

/** The directory of saved peers, one file per name. */
export function peersDirectory(): string {
  return path.join(configDirectory(), "peers");
}
const peers = privateFiles(peersDirectory, "peer");
/** The configuration and peers directories are private and on a trusted path. */
export const checkPeerDirectories: () => void = peers.checkDirectories;
/** The file for a saved peer name, after validating the name. */
export const peerFile: (name: string) => string = peers.file;
/** Create the peers directory if needed, with the default configuration directory. */
export const preparePeersDirectory: () => void = peers.prepare;
/** Create a private peer file that must not exist yet. */
export const createPeerFile: (name: string, content: string) => void = peers.create;
/** Replace a saved peer file's contents, whole or not at all. */
export const rewritePeerFile: (name: string, content: string) => void = peers.rewrite;
/** Whether any file, valid or not, is saved under this name. */
export const peerFileExists: (name: string) => boolean = peers.exists;
/** Read a saved peer's file, which must be a private regular file; undefined when there is none. */
export const readPeerFile: (name: string) => string | undefined = peers.read;
/** The names of every saved peer, sorted; [] when nothing has been saved yet. */
export const peerNames: () => string[] = peers.names;
/** Remove a saved peer's file. */
export const removePeerFile: (name: string) => void = peers.remove;

/** The meshes this device has made or joined, one file per mesh name (mesh.ts). */
export const meshFiles = privateFiles(() => path.join(configDirectory(), "meshes"), "mesh");
/** The last member list version of each mesh this device ran and deleted, one file per mesh name (mesh.ts). */
export const endedMeshFiles = privateFiles(() => path.join(configDirectory(), "meshes-ended"), "mesh");
/** The mesh secrets this device keeps, one file per secret, named by its id (secrets.ts). */
export const secretFiles = privateFiles(() => path.join(configDirectory(), "secrets"), "secret");
/** The devices removed here, which no mesh gives a record, one file per fingerprint (peers.ts). */
export const revokedFiles = privateFiles(() => path.join(configDirectory(), "revoked"), "revoked device");

export function validatePeerUrl(value: string): string {
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
  }
  return parsed.href;
}
