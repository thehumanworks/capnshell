import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { AuthError } from "../auth.js";
import { printable } from "../errors.js";
import { ensureIdentity, generateIdentity, newKeyPair, type Identity } from "../identity.js";
import { applyMeshes, firstList, listMeshes, newerLists, nextList, readMesh, removeMesh, signList, writeMesh } from "../mesh.js";
import { mintBotToken, startAsBot } from "../mesh-token.js";
import { removePeerFile } from "../peer-files.js";
import { getPeer, listPeers, revokedDevices, savePairedPeer, type PeerEntry, type Permission } from "../peers.js";
import { listMeshesCommand } from "./mesh-cli.js";
import { unpair } from "./pairing-cli.js";
import { gatewayLike, readAnswer, refused, removeCommand, removeHere, removePeer, type Place } from "./remove-everywhere.js";

// Each test has a configuration of its own, no daemon (the state file named is never there), and no gateway.
let dir = "";
let state = "";
let self: Identity;
const previous = { config: process.env.CNS_CONFIG_DIR, gateway: process.env.CNS_GATEWAY };
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cns-remove-"));
  process.env.CNS_CONFIG_DIR = dir;
  delete process.env.CNS_GATEWAY;
  state = path.join(dir, "no-daemon.json");
  self = ensureIdentity().identity;
});
afterEach(async () => {
  for (const [name, value] of [["CNS_CONFIG_DIR", previous.config], ["CNS_GATEWAY", previous.gateway]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

const hub = generateIdentity();
const phone = generateIdentity();
const quietly = async <T>(run: () => T | Promise<T>): Promise<{ value: T; out: string }> => {
  const log = console.log;
  let out = "";
  console.log = (...args: unknown[]) => { out += `${args.join(" ")}\n`; };
  try { return { value: await run(), out }; } finally { console.log = log; }
};
/** Pair with `who` directly, letting it use `incoming` here. */
const pair = (name: string, who: Identity, incoming: Permission[] = []) => savePairedPeer(name, { publicKey: who.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming, outgoing: [] } });
/** A mesh `admin` runs, with this device and `others` in it, where members may use `allow` here. */
function mesh(name: string, admin: Identity, others: Identity[], allow: Permission[]) {
  const first = firstList(name, { key: admin.publicKey, name: admin === self ? "laptop" : "admin" }, Date.now());
  const list = nextList(first, (members) => [...members, ...admin === self ? [] : [{ key: self.publicKey, name: "laptop" }], ...others.map((other, index) => ({ key: other.publicKey, name: `member-${index}` }))], Date.now());
  writeMesh({ name, admin: admin.publicKey, allow, signed: signList(list, admin) });
}
/** The next list of `admin`'s mesh, with `added` in it too. */
function nextWith(name: string, admin: Identity, added: Identity) {
  const current = readMesh(name)!;
  return signList(nextList(current.list, (members) => [...members, { key: added.publicKey, name: "late" }], Date.now()), admin);
}
const outcomes = (places: Place[]) => places.map((place) => [place.place, place.outcome]);
/** What the device with `who`'s key may use here, and the mesh its record is for, whatever its name. */
const accessOf = (who: Identity) => { const found = listPeers(() => {}).find((peer) => peer.publicKey === who.publicKey); return found && [found.grants.incoming, found.mesh]; };
const revoked = (who: Identity) => existsSync(path.join(dir, "revoked", who.fingerprint));

test("a removed device gets no record here from any mesh, even one that lists it later, until this device pairs with it directly", async () => {
  const tablet = generateIdentity();
  pair("hub", hub, ["shell"]);
  pair("phone", phone, ["files"]);
  mesh("home", hub, [tablet], ["shell"]);
  applyMeshes(self.publicKey);
  assert.deepEqual(accessOf(tablet), [["shell"], "home"]);
  assert.equal((await quietly(() => removePeer("phone", { state }))).out, "Removed phone.\n");
  assert.equal(getPeer("phone"), undefined);
  assert.ok(revoked(phone));
  if (process.platform !== "win32") assert.equal(statSync(path.join(dir, "revoked", phone.fingerprint)).mode & 0o777, 0o600);
  // Before, the next list of hub's mesh that named phone gave it a member record, with shell.
  writeMesh({ ...readMesh("home")!, signed: nextWith("home", hub, phone) });
  applyMeshes(self.publicKey);
  assert.equal(accessOf(phone), undefined);
  // A record a mesh would save does not take it off the list; only a direct pairing does.
  savePairedPeer("phone-mesh", { publicKey: phone.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] }, mesh: "home" });
  assert.ok(revoked(phone));
  removePeerFile("phone-mesh");
  // A member record goes the same way, and its mesh does not bring it back.
  const { value: status, out } = await quietly(() => removeCommand(undefined, { fingerprint: tablet.fingerprint, state }));
  assert.equal(status, 0);
  assert.equal(out, `Removing member-0 (fingerprint ${tablet.fingerprint}) here:\n  removed        this device: its pairing: no mesh gives it a record here again, until this device pairs with it directly\n`);
  applyMeshes(self.publicKey);
  assert.equal(accessOf(tablet), undefined);
  // Running it again is harmless, and says nothing more.
  const again = await quietly(() => removeCommand(undefined, { fingerprint: tablet.fingerprint, json: true, state }));
  assert.equal(again.value, 0);
  assert.deepEqual(JSON.parse(again.out), [{ device: null, place: "its pairing", outcome: "already gone" }]);
  // Pairing with it directly again is the way back, with what that pairing grants.
  pair("phone", phone, ["files"]);
  assert.ok(!revoked(phone));
  applyMeshes(self.publicKey);
  assert.deepEqual(accessOf(phone), [["files"], undefined]);
  assert.equal(accessOf(tablet), undefined, "the other stays out");
});

test("a plain removal says which meshes the device can still change, and cns mesh list marks it", async () => {
  pair("phone", phone);
  mesh("work", phone, [], ["shell"]);
  mesh("home", self, [phone], []);
  const { out } = await quietly(() => removePeer("phone", { state }));
  const everywhere = `cns peer remove --fingerprint ${phone.fingerprint} --everywhere`;
  assert.equal(out, [
    "Removed phone.",
    `phone runs the mesh work, which this device is in. To shut it out of that too: cns mesh leave work, or ${everywhere}.`,
    `phone is still listed in the mesh home, which this device runs. To take it out: cns mesh remove home member-0, or ${everywhere}.`,
  ].join("\n") + "\n");
  assert.deepEqual(readMesh("work")?.allow, ["shell"], "a plain removal leaves the meshes as they are");
  const listed = JSON.parse((await quietly(() => listMeshesCommand("home", { json: true }))).out) as Array<{ members: Array<{ name: string; revoked: boolean }> }>;
  assert.deepEqual(listed[0]!.members.map((member) => [member.name, member.revoked]), [["this device", false], ["member-0", true]]);
  assert.match((await quietly(() => listMeshesCommand("work", {}))).out, /^ {2}admin \(admin\) \(revoked\)\t/m);
});

test("a mesh the lost device runs takes no new list from it, and stays until this device leaves it", async () => {
  pair("phone", phone, ["files"]);
  mesh("work", phone, [], ["shell", "files"]);
  const later = nextWith("work", phone, generateIdentity());
  assert.equal(newerLists(listMeshes(), [later], revokedDevices()).length, 1, "taken before the removal");
  const dry = await removeHere(phone.fingerprint, { meshes: true, dryRun: true, state });
  assert.deepEqual(outcomes(dry), [["its pairing", "would remove"], ["mesh work", "not permitted"]]);
  assert.equal(dry[0]!.detail, "no mesh would give it a record here again, until this device pairs with it directly");
  assert.ok(getPeer("phone") && !revoked(phone), "a dry run changes nothing");
  const { value: status, out } = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, meshes: true, json: true, state }));
  assert.equal(status, 4, "the mesh still needs leaving");
  const places = JSON.parse(out) as Place[];
  assert.deepEqual(outcomes(places), [["its pairing", "removed"], ["mesh work", "not permitted"]]);
  assert.equal(places[1]!.detail, "it runs this mesh, so this device takes no new list of it, but the members its last list names keep what members may use here, and the mesh's secrets");
  assert.equal(places[1]!.next, "To finish, leave it: cns mesh leave work");
  assert.deepEqual(readMesh("work")?.allow, ["shell", "files"], "nothing is narrowed");
  assert.deepEqual(newerLists(listMeshes(), [later], revokedDevices()), [], "its mesh stays at the last list taken");
  assert.equal(getPeer("phone"), undefined);
  // Without --meshes, its meshes are left as they are.
  assert.deepEqual(outcomes(await removeHere(phone.fingerprint, { state })), [["its pairing", "already gone"]]);
});

test("this device never removes itself, and a place that fails is reported while the others go on", async () => {
  await assert.rejects(removeHere(self.fingerprint, { meshes: true, state }), /^Error: That is this device's own fingerprint\. Run this on another of your devices\.$/);
  await assert.rejects(removeCommand(undefined, { fingerprint: self.fingerprint, everywhere: true, state }), /own fingerprint/);
  pair("phone", phone, ["shell"]);
  // A mesh file this cns cannot read: the pairing goes all the same, as the revoked list covers every mesh.
  mesh("home", hub, [phone], ["shell"]);
  await Bun.write(path.join(dir, "meshes", "home"), "not a mesh");
  const places = await removeHere(phone.fingerprint, { meshes: true, state });
  assert.deepEqual(places.map((place) => [place.place, place.outcome, place.next]), [
    ["its pairing", "removed", undefined],
    ["its meshes", "failed", `Later, run: cns peer remove --fingerprint ${phone.fingerprint} --meshes`],
    ["its meshes", "failed", `Later, run: cns peer remove --fingerprint ${phone.fingerprint} --meshes`],
  ]);
  assert.match(places[1]!.detail!, /^The mesh home saved here cannot be read/);
  assert.equal(getPeer("phone"), undefined);
  assert.ok(revoked(phone));
});

test("a record this cns cannot read is found by its key, and the pairing re-checks the key before it removes anything", async () => {
  pair("hub", hub);
  // A record from a newer cns, which this one leaves out of listings but still knows the key of.
  writeFileSync(path.join(dir, "peers", "phone"), JSON.stringify({ version: 2, publicKey: phone.publicKey, needs: ["teleport"], addresses: [], pairedAt: "", grants: { incoming: [], outgoing: [] } }), { mode: 0o600 });
  assert.equal(listPeers(() => {}).length, 1);
  const { out } = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, state }));
  assert.match(out, new RegExp(`^Removing phone \\(fingerprint ${phone.fingerprint}\\) here:\n {2}removed {8}this device: its pairing`));
  assert.ok(!existsSync(path.join(dir, "peers", "phone")) && revoked(phone));
  // The key saved under a name is checked again as it is removed, so another device saved there since stays, and is not revoked.
  await assert.rejects(unpair("hub", phone.publicKey, state), /^Error: The pairing for hub changed; it was not removed\. Check cns peer list\.$/);
  assert.ok(getPeer("hub") && !revoked(hub));
  await assert.rejects(removePeer("tv", { state }), /^Error: No paired device is saved as tv\. cns peers shows them\.$/);
});

test("--everywhere reports the records it cannot read, and a device paired as the gateway is, while no gateway answered", async () => {
  const gw = generateIdentity();
  pair("phone", phone);
  pair("gw", gw);
  const first = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, everywhere: true, json: true, state }));
  assert.equal(first.value, 4, "it may be a device, so it counts");
  const places = JSON.parse(first.out) as Place[];
  assert.deepEqual(places.map((place) => [place.device, place.outcome]), [[null, "removed"], ["gw", "not used"], [null, "not used"]]);
  assert.equal(places[1]!.next, `If gw is one of your devices, run there: cns peer remove --fingerprint ${phone.fingerprint} --meshes`);
  assert.match(places[2]!.detail!, /^CNS_GATEWAY is not set here, so no gateway was asked\. If this device owns a gateway, run: cns gateway status, then cns gateway remove NAME \(fingerprint [a-z2-7-]+\); if it was one of the gateway's owners too, it can still approve connectors until its key is out of OWNER_KEYS/);
  writeFileSync(path.join(dir, "peers", "tv"), JSON.stringify({ version: 2, publicKey: generateIdentity().publicKey, needs: ["teleport"] }), { mode: 0o600 });
  const second = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, everywhere: true, json: true, state }));
  assert.equal(second.value, 1);
  assert.deepEqual((JSON.parse(second.out) as Place[]).find((place) => place.device === "tv"), {
    device: "tv", place: "", outcome: "failed", detail: "this cns cannot read its record here, so it was not asked; cns peers says why", next: `On tv, run: cns peer remove --fingerprint ${phone.fingerprint} --meshes`,
  });
});

test("a dry run on a device with no identity changes nothing, not even to make one", async () => {
  await rm(path.join(dir, "identity.json"));
  const { value: status, out } = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, everywhere: true, dryRun: true, json: true, state }));
  assert.equal(status, 0);
  assert.deepEqual((JSON.parse(out) as Place[]).map((place) => [place.place, place.outcome, place.detail?.slice(0, 40)]), [
    ["its pairing", "already gone", "no mesh would give it a record here agai"],
    ["the gateway", "not used", "CNS_GATEWAY is not set here, so no gatew"],
  ]);
  assert.ok(!existsSync(path.join(dir, "identity.json")) && !existsSync(path.join(dir, "revoked")));
});

test("a bot token never brings back an admin removed here", async () => {
  await rm(path.join(dir, "identity.json"));
  const keys = newKeyPair();
  const list = signList(nextList(firstList("home", { key: hub.publicKey, name: "hub" }, Date.now()), (members) => [...members, { key: keys.publicKey, name: "ci" }], Date.now()), hub);
  const token = mintBotToken(keys.privateKey, list, [], ["shell"]);
  startAsBot(token);
  assert.deepEqual(accessOf(hub), [["shell"], undefined]);
  await quietly(() => removePeer("hub", { state }));
  removeMesh("home"); // As cns mesh leave does.
  // Before, the next start paired with hub again, with the token's grants, cleared the entry and rejoined the mesh.
  assert.throws(() => startAsBot(token), new RegExp(`^Error: CNS_TOKEN is for a mesh run by the device with fingerprint ${hub.fingerprint}, which was removed from this machine, so it is refused\\. Get a new token from an admin you trust, or unset CNS_TOKEN\\.$`));
  assert.throws(() => startAsBot(token, "token file"), /^Error: The token file is for .* Get a new token from an admin you trust, or delete the token file\.$/);
  assert.equal(accessOf(hub), undefined);
  assert.ok(revoked(hub) && !readMesh("home"));
});

test("the gateway is not asked to run commands, and a refusal is told from a device that is out of reach", () => {
  const entry = (fingerprint: string, extra: Partial<PeerEntry> = {}) => ({ fingerprint, addresses: ["ws://127.0.0.1:1/"], grants: { incoming: [], outgoing: ["shell" as Permission] }, ...extra });
  const bare = { addresses: [], grants: { incoming: ["shell" as Permission], outgoing: [] } };
  assert.equal(gatewayLike(entry("studio"), undefined), false);
  assert.equal(gatewayLike(entry("gate"), "gate"), true, "the gateway answered with its fingerprint");
  assert.equal(gatewayLike(entry("c", { mesh: "home", gateway: true }), undefined), true, "the mesh says so");
  assert.equal(gatewayLike(entry("g", bare), undefined), true, "paired as the gateway pairs, while no gateway answered");
  assert.equal(gatewayLike(entry("g", bare), "gate"), false, "the gateway answered, and it is another");
  assert.equal(gatewayLike(entry("m", { mesh: "home", addresses: [], grants: { incoming: [], outgoing: [] } }), undefined), false, "a mesh member learns its grants over the link");
  assert.equal(gatewayLike(entry("tv", { grants: { incoming: [], outgoing: [] } }), undefined), false, "a device with an address is a device");
  assert.equal(refused(new AuthError("not-paired", "studio does not accept this device.")), true);
  assert.equal(refused(new Error("Permission denied: shell not granted to laptop. To allow it, run on studio: cns peer grant laptop shell")), true);
  assert.equal(refused(new Error("Cannot connect to ws://127.0.0.1:1: Permission denied")), false);
  assert.equal(refused(new Error("Timed out connecting to ws://127.0.0.1:1.")), false);
});

test("what a device answers is data: only its places and outcomes are kept, and nothing removed in a dry run", () => {
  const answer = (places: unknown) => JSON.stringify(places);
  assert.deepEqual(readAnswer(answer([{ device: null, place: "its pairing", outcome: "removed", detail: "run rm -rf ~ now" }, { device: null, place: "mesh home", outcome: "not permitted", detail: "it runs this mesh", next: "rm -rf ~" }]), false), [
    { place: "its pairing", outcome: "removed", left: false },
    { place: "mesh home", outcome: "not permitted", left: true },
  ], "its wording is never kept, only that it had something left to do");
  assert.equal(readAnswer(answer([{ place: "its pairing", outcome: "owned" }]), false), undefined);
  assert.equal(readAnswer(answer([{ place: "mesh home", outcome: "narrowed" }]), false), undefined);
  assert.equal(readAnswer(answer(Array.from({ length: 21 }, () => ({ place: "its pairing", outcome: "removed" }))), false), undefined);
  assert.equal(readAnswer(answer([{ place: "the gateway", outcome: "removed" }]), false), undefined, "a place removeHere never reports");
  assert.equal(readAnswer(answer([{ place: "mesh \u009b31mhome\u202e", outcome: "failed" }]), false), undefined);
  assert.equal(readAnswer(answer([{ place: `mesh ${"x".repeat(65)}`, outcome: "removed" }]), false), undefined);
  assert.equal(readAnswer("Removed phone.", false), undefined);
  // A dry run changes nothing, so an answer that says it did is not one.
  assert.equal(readAnswer(answer([{ place: "its pairing", outcome: "removed" }]), true), undefined);
  assert.deepEqual(readAnswer(answer([{ place: "its pairing", outcome: "would remove" }]), true), [{ place: "its pairing", outcome: "would remove", left: false }]);
  assert.equal(printable("ok\u202egnp.exe\u200f\u009b"), "ok?gnp.exe??");
});
