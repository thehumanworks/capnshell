import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAlias, listAliases, resolveAlias } from "./aliases.js";
import { generateIdentity } from "./identity.js";
import { describeGrants, expandGrants, findPairedPeer, getPeer, listPeers, PRESETS, resolvePeer, savePairedPeer, updatePairedPeer } from "./peers.js";

let dir: string;
const previous = process.env.CNS_CONFIG_DIR;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "cns-peers-")); process.env.CNS_CONFIG_DIR = dir; });
afterEach(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; rmSync(dir, { recursive: true, force: true }); });

test("grants expand from presets into a canonical list and read back as presets", () => {
  expect(expandGrants(["sessions", "shell", "shell"])).toEqual(["shell", ...PRESETS.sessions]);
  expect(expandGrants(["all"])).toEqual([...PRESETS.all]);
  expect(expandGrants([])).toEqual([]);
  expect(() => expandGrants(["root"])).toThrow();
  expect(describeGrants(expandGrants(["files", "sessions"]))).toBe("files, sessions");
  expect(describeGrants(["sessions:list", "shell"])).toBe("shell, sessions:list");
  expect(describeGrants([])).toBe("none");
});

test.skipIf(process.platform === "win32")("paired devices live beside address aliases and are keyed by identity", () => {
  const studio = generateIdentity();
  addAlias("build", "ws://127.0.0.1:47381");
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://192.168.1.10:47381"], pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: expandGrants(["all"]) } });
  expect(listPeers().map((peer) => [peer.name, peer.kind])).toEqual([["build", "address"], ["studio", "paired"]]);
  expect(listAliases()).toEqual([{ name: "build", url: "ws://127.0.0.1:47381/" }]);
  expect(findPairedPeer(studio.publicKey)?.name).toBe("studio");
  expect(findPairedPeer(generateIdentity().publicKey)).toBeUndefined();
  const entry = getPeer("studio");
  expect(entry?.kind).toBe("paired");
  if (entry?.kind === "paired") expect(entry.fingerprint).toBe(studio.fingerprint);
  // The same device cannot be saved twice, and an alias is never replaced.
  expect(() => savePairedPeer("other", { publicKey: studio.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } })).toThrow("already paired as studio");
  expect(() => savePairedPeer("studio", { publicKey: generateIdentity().publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } })).toThrow();
  // Targets: a paired device resolves to its address and expected identity; an alias to its URL alone.
  expect(resolvePeer("studio")).toEqual({ url: "ws://192.168.1.10:47381", peer: { name: "studio", publicKey: studio.publicKey, outgoing: expandGrants(["all"]) } });
  expect(resolvePeer("build")).toEqual({ url: "ws://127.0.0.1:47381/" });
  expect(() => resolvePeer("missing")).toThrow("Unknown peer alias");
  expect(() => resolveAlias("studio")).toThrow("paired device");
  // Grants and addresses change; the key never does.
  const updated = updatePairedPeer("studio", (peer) => ({ ...peer, grants: { ...peer.grants, incoming: [] }, addresses: [] }));
  expect(updated.grants.incoming).toEqual([]);
  expect(() => resolvePeer("studio")).toThrow("no saved address");
  expect(() => updatePairedPeer("studio", (peer) => ({ ...peer, publicKey: generateIdentity().publicKey }))).toThrow("cannot change");
  expect(() => updatePairedPeer("build", (peer) => peer)).toThrow("saved address");
});
