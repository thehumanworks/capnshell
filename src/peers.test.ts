import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { generateIdentity } from "./identity.js";
import { describeGrants, expandGrants, explainDenial, grantWords, findPairedPeer, getPeer, learnAddresses, listPeers, pairedPeerSchema, PEER_FIELDS, PRESETS, resolvePeer, savePairedPeer, UnreadablePeer, updatePairedPeer } from "./peers.js";
import { peerNames } from "./peer-files.js";
import { CNS_VERSION } from "./version.js";

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
  // A grant word this cns does not know makes the whole record unreadable, as it always has.
  writeFileSync(path.join(peers, "extra"), JSON.stringify({ version: 2, publicKey: generateIdentity().publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: ["shell", "root"], outgoing: [] } }), { mode: 0o600 });
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

/** Write a record into the peers directory as another cns would. */
const writeRecord = (name: string, record: unknown) => {
  if (!peerNames().length) savePairedPeer("placeholder", { publicKey: generateIdentity().publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: [], outgoing: [] } });
  writeFileSync(path.join(dir, "peers", name), typeof record === "string" ? record : JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
};
const PAIRED_AT = "2026-11-28T12:00:00.000Z";
const readRecord = (name: string) => readFileSync(path.join(dir, "peers", name), "utf8");

test.skipIf(process.platform === "win32")("records 2.4.0 writes read unchanged, and a record that needs nothing is written as 2.4.0 writes it", () => {
  const studio = generateIdentity();
  const laptop = generateIdentity();
  // Exactly what 2.4.0 writes for a device paired directly and for a mesh member.
  const direct = `{\n  "version": 2,\n  "publicKey": "${studio.publicKey}",\n  "addresses": [\n    "ws://192.168.1.10:47381"\n  ],\n  "pairedAt": "${PAIRED_AT}",\n  "grants": {\n    "incoming": [\n      "shell"\n    ],\n    "outgoing": []\n  }\n}\n`;
  const member = `{\n  "version": 2,\n  "publicKey": "${laptop.publicKey}",\n  "addresses": [],\n  "pairedAt": "${PAIRED_AT}",\n  "grants": {\n    "incoming": [\n      "files"\n    ],\n    "outgoing": []\n  },\n  "mesh": "home"\n}\n`;
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://192.168.1.10:47381"], pairedAt: PAIRED_AT, grants: { incoming: ["shell"], outgoing: [] } });
  savePairedPeer("laptop", { publicKey: laptop.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: ["files"], outgoing: [] }, mesh: "home" });
  expect(readRecord("studio")).toBe(direct);
  expect(readRecord("laptop")).toBe(member);
  expect(getPeer("laptop")).toEqual({ name: "laptop", fingerprint: laptop.fingerprint, version: 2, publicKey: laptop.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: ["files"], outgoing: [] }, mesh: "home" });
  // A rewrite that changes nothing leaves the bytes as they were.
  updatePairedPeer("studio", (peer) => peer);
  updatePairedPeer("laptop", (peer) => peer);
  expect([readRecord("studio"), readRecord("laptop")]).toEqual([direct, member]);
  // An empty needs list needs nothing, and is not written back.
  writeRecord("studio", { ...JSON.parse(direct), needs: [] });
  expect(getPeer("studio")?.grants.incoming).toEqual(["shell"]);
  updatePairedPeer("studio", (peer) => peer);
  expect(readRecord("studio")).toBe(direct);
});

test.skipIf(process.platform === "win32")("fields this cns does not know are ignored, and kept when it rewrites the record", () => {
  const studio = generateIdentity();
  // Such as a newer cns's label and last-seen time, here and in grants. Nothing in the
  // record replaces what cns works out itself, such as the alias and the fingerprint.
  writeRecord("studio", { version: 2, publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: ["shell"], outgoing: [], note: "until Friday" }, label: "Mac Studio", lastSeen: PAIRED_AT, name: "other", fingerprint: "x" });
  const entry = getPeer("studio");
  expect(entry).toEqual({ name: "studio", fingerprint: studio.fingerprint, version: 2, publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: ["shell"], outgoing: [] } });
  expect(findPairedPeer(studio.publicKey)?.name).toBe("studio");
  updatePairedPeer("studio", (peer) => ({ ...peer, grants: { ...peer.grants, incoming: [] } }));
  expect(JSON.parse(readRecord("studio"))).toEqual({ version: 2, publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: [], outgoing: [], note: "until Friday" }, label: "Mac Studio", lastSeen: PAIRED_AT, name: "other", fingerprint: "x" });
  // Grant words this cns does not know are still refused, in either direction, never dropped.
  writeRecord("laptop", { version: 2, publicKey: generateIdentity().publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: [], outgoing: ["ports"] } });
  expect(() => getPeer("laptop")).toThrow("not a valid paired-device record");
});

test.skipIf(process.platform === "win32")("a device's network cards are kept in its record, and a value this cns cannot read is dropped, never refused", () => {
  const studio = generateIdentity();
  const lan = [{ mac: "3c:22:fb:12:34:56", cidr: "192.168.1.23/24" }];
  savePairedPeer("studio", { publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: [], outgoing: ["shell"] }, lan });
  expect(JSON.parse(readRecord("studio"))).toEqual({ version: 2, publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: [], outgoing: ["shell"] }, lan });
  // Other changes keep it, as cns peer grant's does.
  updatePairedPeer("studio", (peer) => ({ ...peer, grants: { ...peer.grants, incoming: ["files"] } }));
  expect(getPeer("studio")?.lan).toEqual(lan);
  // It needs nothing, so a cns that knows needs but not lan reads the record.
  expect(JSON.parse(readRecord("studio")).needs).toBeUndefined();
  for (const bad of [[{ mac: "3C:22:FB:12:34:56", cidr: "192.168.1.23/24" }], [{ mac: "3c:22:fb:12:34:56", cidr: "192.168.1.23/33" }], [{ mac: "3c:22:fb:12:34:56; id", cidr: "192.168.1.23/24" }], "3c:22:fb:12:34:56", Array.from({ length: 17 }, () => lan[0])]) {
    writeRecord("studio", { ...JSON.parse(readRecord("studio")), lan: bad });
    expect(getPeer("studio")?.lan).toBeUndefined();
    expect(getPeer("studio")?.grants.incoming).toEqual(["files"]);
  }
});

test.skipIf(process.platform === "win32")("a record that needs a feature this cns does not have is refused, naming it and what to run", () => {
  const studio = generateIdentity();
  const record = { version: 2, needs: ["expiry"], publicKey: studio.publicKey, addresses: [], pairedAt: PAIRED_AT, grants: { incoming: ["shell"], outgoing: [] }, expiresAt: PAIRED_AT };
  writeRecord("studio", record);
  const which = process.platform === "win32" ? "Get-Command cns" : "command -v cns";
  const message = `Saved peer studio needs the feature expiry, which this cns (${CNS_VERSION}) does not have, so it leaves studio out: a newer cns saved it. ` +
    `Update cns on this device, then restart its daemon: cns daemon restart. If the newer cns is installed already, ${which} shows which one a shell runs.`;
  expect(() => getPeer("studio")).toThrow(message);
  // The device is not let in, and its record is reported, never rewritten.
  const reported: unknown[] = [];
  expect(listPeers((name, error) => reported.push([name, error])).map((peer) => peer.name)).toEqual(["placeholder"]);
  expect(reported).toEqual([["studio", new UnreadablePeer(message, studio.publicKey)]]);
  expect((reported[0] as [string, UnreadablePeer])[1].publicKey).toBe(studio.publicKey);
  expect(findPairedPeer(studio.publicKey)).toBeUndefined();
  const before = readRecord("studio");
  expect(() => updatePairedPeer("studio", (peer) => ({ ...peer, grants: { incoming: ["shell"], outgoing: [] } }))).toThrow("needs the feature expiry");
  expect(readRecord("studio")).toBe(before);
  // The feature is what it names first, even when other fields are ones this cns cannot read either.
  writeRecord("studio", { ...record, needs: ["labels", "expiry"], grants: { incoming: ["ports"], outgoing: [] } });
  expect(() => getPeer("studio")).toThrow("Saved peer studio needs the features labels, expiry, which this cns");
  // A feature listed twice is named once.
  writeRecord("studio", { ...record, needs: ["expiry", "expiry"] });
  expect(() => getPeer("studio")).toThrow("Saved peer studio needs the feature expiry, which this cns");
  // A needs list that is not one is refused too.
  for (const needs of ["expiry", ["Expiry"], ["$(rm -rf ~)"], Array.from({ length: 17 }, (_, index) => `f${index}`)]) {
    writeRecord("studio", { ...record, needs });
    expect(() => getPeer("studio")).toThrow("not a valid paired-device record");
  }
  // And this cns never writes a feature it does not have.
  expect(() => updatePairedPeer("placeholder", (peer) => ({ ...peer, needs: ["expiry"] }))).toThrow("needs a feature this cns does not know");
});

test("every field of a record says what a cns that does not know it does with it", () => {
  // A field added to the record is classified in PEER_FIELDS: informational, which a cns that
  // does not know it ignores, or a feature, which makes such a cns refuse the record. Only the
  // fields from before needs are base: every cns that reads needs knows them.
  expect(Object.keys(pairedPeerSchema.shape).sort()).toEqual(Object.keys(PEER_FIELDS.record).sort());
  expect(Object.keys(pairedPeerSchema.shape.grants.shape).sort()).toEqual(Object.keys(PEER_FIELDS.grants).sort());
  const base = (fields: Record<string, string>) => Object.keys(fields).filter((key) => fields[key] === "base").sort();
  expect(base(PEER_FIELDS.record)).toEqual(["addresses", "grants", "mesh", "needs", "pairedAt", "publicKey", "version"]);
  expect(base(PEER_FIELDS.grants)).toEqual(["incoming", "outgoing"]);
  // An object inside a record needs a table of its own, as grants has, unless the whole field is
  // informational, as lan is (below). The walk looks through every wrapper, and stops at a kind of
  // schema it does not know.
  type Def = { type: string; shape?: Record<string, z.core.$ZodType>; innerType?: z.core.$ZodType; element?: z.core.$ZodType; options?: z.core.$ZodType[]; in?: z.core.$ZodType; out?: z.core.$ZodType };
  const objects = (schema: z.core.$ZodType, at: string): string[] => {
    const def = schema._zod.def as Def;
    switch (def.type) {
      case "object": return [at, ...Object.entries(def.shape!).flatMap(([key, field]) => objects(field, `${at}.${key}`))];
      case "optional": case "nullable": case "default": case "prefault": case "readonly": case "catch": case "nonoptional": return objects(def.innerType!, at);
      case "array": return objects(def.element!, at);
      case "union": return def.options!.flatMap((option) => objects(option, at));
      case "pipe": return [...objects(def.in!, at), ...objects(def.out!, at)];
      case "string": case "literal": case "enum": case "number": case "boolean": return [];
      default: throw new Error(`${at} is a ${def.type} schema; teach this test to look inside it.`);
    }
  };
  // lan's cards need none: lan is informational, so a cns that does not know it keeps it whole,
  // and a field a newer cns adds to a card can only be lost until the device says it again, as
  // lan itself can go stale. No field in it changes what a device may do.
  expect(PEER_FIELDS.record.lan).toBe("informational");
  expect(objects(pairedPeerSchema, "record")).toEqual(["record", "record.grants", "record.lan"]);
  // The walk itself finds objects behind wrappers and refuses what it cannot see into.
  expect(objects(z.object({ a: z.object({}).nullable().optional(), b: z.union([z.string(), z.array(z.object({}))]), c: z.string().pipe(z.string()) }), "x")).toEqual(["x", "x.a", "x.b"]);
  expect(() => objects(z.object({ m: z.map(z.string(), z.object({})) }), "x")).toThrow("x.m is a map schema");
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
