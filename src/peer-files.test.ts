import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, chmodSync, symlinkSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateIdentity } from "./identity.js";
import { peerNames, removePeerFile } from "./peer-files.js";
import { getPeer, listPeers, savePairedPeer } from "./peers.js";

let dir: string;
const previous = process.env.CNS_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cns-peer-files-")); process.env.CNS_CONFIG_DIR = dir; });
afterEach(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });

const save = (name: string) => savePairedPeer(name, { publicKey: generateIdentity().publicKey, addresses: ["ws://127.0.0.1:47381"], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } });

test.skipIf(process.platform === "win32")("a paired device is one private file under its name, and removing it forgets it", () => {
  save("studio");
  expect(peerNames()).toEqual(["studio"]);
  expect(getPeer("studio")?.name).toBe("studio");
  removePeerFile("studio");
  expect(getPeer("studio")).toBeUndefined();
  expect(listPeers()).toEqual([]);
});

test.skipIf(process.platform === "win32")("names are validated, and a saved name is never replaced", () => {
  save("studio");
  expect(() => save("studio")).toThrow();
  expect(() => save("../other")).toThrow("peer name");
  expect(() => removePeerFile("../other")).toThrow("peer name");
});

test.skipIf(process.platform === "win32")("rejects peer files readable by other users", () => {
  save("studio");
  chmodSync(path.join(dir, "peers", "studio"), 0o644);
  expect(() => getPeer("studio")).toThrow("private file");
});

test.skipIf(process.platform === "win32")("rejects unsafe directories and symlinked peer files", () => {
  save("studio");
  chmodSync(path.join(dir, "peers"), 0o777);
  expect(() => getPeer("studio")).toThrow("directory must be private");
  chmodSync(path.join(dir, "peers"), 0o700);
  symlinkSync(path.join(dir, "peers", "studio"), path.join(dir, "peers", "link"));
  expect(() => getPeer("link")).toThrow();
});

test.skipIf(process.platform === "win32")("rejects a shared-writable non-sticky ancestor", () => {
  const parent = path.join(dir, "shared");
  mkdirSync(parent, { mode: 0o777 });
  chmodSync(parent, 0o777);
  process.env.CNS_CONFIG_DIR = path.join(parent, "config");
  mkdirSync(process.env.CNS_CONFIG_DIR, { mode: 0o700 });
  expect(() => save("studio")).toThrow("shared-writable ancestor");
});

test.skipIf(process.platform === "win32")("custom configuration directory must already exist", () => {
  process.env.CNS_CONFIG_DIR = path.join(dir, "missing");
  expect(() => save("studio")).toThrow();
});

test.skipIf(process.platform === "win32")("rejects a symlink as the custom configuration directory", () => {
  const target = path.join(dir, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = path.join(dir, "config-link");
  symlinkSync(target, link);
  process.env.CNS_CONFIG_DIR = link;
  expect(() => save("studio")).toThrow("directory must be private");
});

test.skipIf(process.platform !== "win32")("on Windows, a paired device is saved in a private directory and loads back", () => {
  save("studio");
  expect(peerNames()).toEqual(["studio"]);
  expect(getPeer("studio")?.name).toBe("studio");
  removePeerFile("studio");
  expect(getPeer("studio")).toBeUndefined();
});
