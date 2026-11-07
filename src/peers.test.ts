import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateIdentity } from "./identity.js";
import { describeGrants, expandGrants, explainDenial, grantWords, findPairedPeer, getPeer, learnAddresses, listPeers, PRESETS, resolvePeer, savePairedPeer, updatePairedPeer } from "./peers.js";
import { peerNames } from "./peer-files.js";

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

test.skipIf(process.platform === "win32")("paired devices are saved under a name and keyed by identity", () => {
  const studio = generateIdentity();
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://192.168.1.10:47381"], pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: expandGrants(["all"]) } });
  expect(listPeers().map((peer) => peer.name)).toEqual(["studio"]);
  expect(findPairedPeer(studio.publicKey)?.name).toBe("studio");
  expect(findPairedPeer(generateIdentity().publicKey)).toBeUndefined();
  expect(getPeer("studio")?.fingerprint).toBe(studio.fingerprint);
  // The same device cannot be saved twice, and a name is never replaced.
  expect(() => savePairedPeer("other", { publicKey: studio.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } })).toThrow("already paired as studio");
  expect(() => savePairedPeer("studio", { publicKey: generateIdentity().publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } })).toThrow();
  // A command's target: the identity to expect and every saved address.
  expect(resolvePeer("studio")).toEqual({ name: "studio", publicKey: studio.publicKey, outgoing: expandGrants(["all"]), addresses: ["ws://192.168.1.10:47381"] });
  expect(() => resolvePeer("missing")).toThrow("No paired device is saved as missing");
  // Grants and addresses change; the key never does.
  const updated = updatePairedPeer("studio", (peer) => ({ ...peer, grants: { ...peer.grants, incoming: [] }, addresses: [] }));
  expect(updated.grants.incoming).toEqual([]);
  // With no saved address, the relay is still tried.
  expect(resolvePeer("studio").addresses).toEqual([]);
  expect(() => updatePairedPeer("studio", (peer) => ({ ...peer, publicKey: generateIdentity().publicKey }))).toThrow("cannot change");
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
  expect(() => getPeer("broken")).toThrow("not a paired-device record");
  expect(() => getPeer("extra")).toThrow("not a valid paired-device record");
});

test.skipIf(process.platform === "win32")("changing a paired device replaces its file whole and privately", () => {
  const studio = generateIdentity();
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://127.0.0.1:47381"], pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: [] } });
  updatePairedPeer("studio", (peer) => ({ ...peer, addresses: ["ws://127.0.0.1:47382"] }));
  expect(readdirSync(path.join(dir, "peers"))).toEqual(["studio"]);
  expect(statSync(path.join(dir, "peers", "studio")).mode & 0o777).toBe(0o600);
  expect(resolvePeer("studio").addresses).toEqual(["ws://127.0.0.1:47382"]);
  expect(() => updatePairedPeer("missing", (peer) => peer)).toThrow("Unknown peer");
});

test("a device's advertised addresses replace the ones it advertised before, keeping what a person or a dial added", () => {
  const key = "A".repeat(43);
  const relay = (host: string) => `wss://${host}/v1/dial/${key}`;
  const saved = ["ws://192.168.1.10:47381", "ws://studio.example:9000", "ws://203.0.113.5:47381", relay("old.example")];
  // The old LAN address and relay go; the hostname a person added stays, and so does the port forward this side dialed.
  expect(learnAddresses(saved, ["ws://10.0.0.7:47381", "ws://100.64.0.3:47381", relay("new.example")], "ws://203.0.113.5:47381"))
    .toEqual(["ws://10.0.0.7:47381", "ws://100.64.0.3:47381", "ws://studio.example:9000", "ws://203.0.113.5:47381", relay("new.example")]);
  // Nothing changes when the device advertises what is saved, however it is written.
  expect(learnAddresses(["ws://10.0.0.7:47381/"], ["ws://10.0.0.7:47381"])).toEqual(["ws://10.0.0.7:47381"]);
  // Relays always come last, and a record never holds more than 16 addresses: direct ones give way to the relay.
  const many = Array.from({ length: 20 }, (_, index) => `ws://10.0.0.${index + 1}:1`);
  expect(learnAddresses([], [relay("r.example"), ...many])).toEqual([...many.slice(0, 15), relay("r.example")]);
  expect(learnAddresses(["ws://[fd00::1]:1"], ["ws://[fd00::2]:1"])).toEqual(["ws://[fd00::2]:1"]);
});
