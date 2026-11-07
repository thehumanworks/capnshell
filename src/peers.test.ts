import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAlias, listAliases, resolveAlias } from "./aliases.js";
import { generateIdentity } from "./identity.js";
import { describeGrants, expandGrants, explainDenial, grantWords, findPairedPeer, getPeer, listPeers, PRESETS, resolvePeer, savePairedPeer, updatePairedPeer } from "./peers.js";
import { peerNames } from "./aliases.js";

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
  expect(expandGrants(["none"])).toEqual([]);
  expect(grantWords(expandGrants(["shell", "sessions"]))).toBe("shell,sessions");
});

test("a refusal says which grant is missing and the command that adds it on the other device", () => {
  expect(explainDenial("Permission denied: shell not granted to reader.", "studio"))
    .toBe("Permission denied: shell not granted to reader. To allow it, run on studio: cns peer grant reader shell");
  expect(explainDenial("Permission denied: sessions:view, sessions:control not granted to laptop-2."))
    .toBe("Permission denied: sessions:view, sessions:control not granted to laptop-2. To allow it, run on the other device: cns peer grant laptop-2 sessions:view,sessions:control");
  // Explaining twice, other refusals and unknown permissions leave the message as it was.
  const explained = explainDenial("Permission denied: files not granted to a.", "b");
  expect(explainDenial(explained, "b")).toBe(explained);
  expect(explainDenial("Permission denied: kill is not available to peers.")).toBe("Permission denied: kill is not available to peers.");
  expect(explainDenial("Permission denied: root not granted to a.")).toBe("Permission denied: root not granted to a.");
  expect(explainDenial("Permission denied: shell not granted to $(rm -rf ~).")).toBe("Permission denied: shell not granted to $(rm -rf ~).");
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
  expect(resolvePeer("studio")).toEqual({ url: "ws://192.168.1.10:47381", peer: { name: "studio", publicKey: studio.publicKey, outgoing: expandGrants(["all"]), addresses: ["ws://192.168.1.10:47381"] } });
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

test.skipIf(process.platform === "win32")("stray and corrupt files in the peers directory are skipped, not fatal", () => {
  const studio = generateIdentity();
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://127.0.0.1:47381"], pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: [] } });
  const peers = path.join(dir, "peers");
  writeFileSync(path.join(peers, ".DS_Store"), "x", { mode: 0o600 });
  writeFileSync(path.join(peers, "broken"), "{ not json", { mode: 0o600 });
  writeFileSync(path.join(peers, "extra"), JSON.stringify({ version: 2, publicKey: generateIdentity().publicKey, fingerprint: "x", addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } }), { mode: 0o600 });
  expect(peerNames()).toEqual(["broken", "extra", "studio"]);
  const reported: string[] = [];
  expect(listPeers((name) => reported.push(name)).map((peer) => peer.name)).toEqual(["studio"]);
  expect(reported).toEqual(["broken", "extra"]);
  const error = console.error;
  console.error = () => {};
  try { expect(findPairedPeer(studio.publicKey)?.name).toBe("studio"); }
  finally { console.error = error; }
  // Looking one up by name stays strict.
  expect(() => getPeer("broken")).toThrow("not valid JSON");
  expect(() => getPeer("extra")).toThrow("not a valid paired-device record");
});

test.skipIf(process.platform === "win32")("changing a paired device replaces its file whole and privately", () => {
  const studio = generateIdentity();
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://127.0.0.1:47381"], pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: [] } });
  updatePairedPeer("studio", (peer) => ({ ...peer, addresses: ["ws://127.0.0.1:47382"] }));
  expect(readdirSync(path.join(dir, "peers"))).toEqual(["studio"]);
  expect(statSync(path.join(dir, "peers", "studio")).mode & 0o777).toBe(0o600);
  expect(resolvePeer("studio").url).toBe("ws://127.0.0.1:47382");
  expect(() => updatePairedPeer("missing", (peer) => peer)).toThrow("Unknown peer");
});
