import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { AuthError } from "../auth.js";
import { strictlyPrintable } from "../errors.js";
import { ensureIdentity, generateIdentity, newKeyPair, type Identity } from "../identity.js";
import { applyMeshes, firstList, listMeshes, newerLists, nextList, readMesh, removeMesh, savedRecords, signList, writeMesh } from "../mesh.js";
import { mintBotToken, startAsBot } from "../mesh-token.js";
import { removePeerFile } from "../peer-files.js";
import { getPeer, listPeers, resolvePeer, revokedDevices, revokeDevice, savePairedPeer, type PeerEntry, type Permission } from "../peers.js";
import { keepSecret, sealSecret, secretsFor } from "../secrets.js";
import { secureReady } from "../secure.js";
import { allowMembers, listMeshesCommand } from "./mesh-cli.js";
import { peers, unpair } from "./pairing-cli.js";
import { answerPlaces, forgetAtGateway, gatewayPlace, readAnswer, refused, removeCommand, removeHere, removePeer, type Place } from "./remove-everywhere.js";

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
  // Only the CLI sets the exit status: one set here would fail the whole run after every test passed.
  assert.ok(!process.exitCode, `a test left process.exitCode at ${process.exitCode}`);
});

const hub = generateIdentity();
const phone = generateIdentity();
const quietly = async <T>(run: () => T | Promise<T>): Promise<{ value: T; out: string }> => {
  const log = console.log;
  let out = "";
  console.log = (...args: unknown[]) => { out += `${args.join(" ")}\n`; };
  try { return { value: await run(), out }; } finally { console.log = log; }
};
/** What `run` writes to stderr. */
const warned = async (run: () => unknown): Promise<string> => {
  const error = console.error;
  let out = "";
  console.error = (...args: unknown[]) => { out += `${args.join(" ")}\n`; };
  try { await run(); return out; } finally { console.error = error; }
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
function nextWith(name: string, admin: Identity, added: Identity, as = "late") {
  const current = readMesh(name)!;
  return signList(nextList(current.list, (members) => [...members, { key: added.publicKey, name: as }], Date.now()), admin);
}
const outcomes = (places: Place[]) => places.map((place) => [place.place, place.outcome]);
/** The saved record of the device with `who`'s key, whatever its name. */
const recordOf = (who: Identity) => listPeers(() => {}).find((peer) => peer.publicKey === who.publicKey);
/** What the device with `who`'s key may use here, and the mesh its record is for. */
const accessOf = (who: Identity) => { const found = recordOf(who); return found && [found.grants.incoming, found.mesh]; };
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
  assert.equal(out, `Removing member-0 (fingerprint ${tablet.fingerprint}) here:\n  removed        this device: its pairing: saved here as member-0; no mesh gives it a record here again, until this device pairs with it directly\n`);
  applyMeshes(self.publicKey);
  assert.equal(accessOf(tablet), undefined);
  // Running it again is safe, and says nothing more.
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

test("records follow the lists right after any removal, once the device is on the revoked list, also one with no record here yet", async () => {
  const tablet = generateIdentity();
  const tv = generateIdentity();
  pair("hub", hub);
  // hub's list names tablet and tv, and no apply has run since this device took it, as when one races the removal.
  mesh("home", hub, [tablet, tv], ["shell"]);
  assert.equal(accessOf(tv), undefined);
  const places = await removeHere(tablet.fingerprint, { state });
  assert.deepEqual(outcomes(places), [["its pairing", "already gone"]], "no record was made for it first");
  assert.ok(revoked(tablet), "a device with no record here is kept out all the same");
  assert.deepEqual(accessOf(tv), [["shell"], "home"], "the lists were applied, without --meshes too");
  assert.equal(accessOf(tablet), undefined);
});

test("applying the lists reads the revoked list after the records, so a device removed meanwhile gets no record", () => {
  const tablet = generateIdentity();
  pair("hub", hub);
  mesh("home", hub, [tablet], ["shell"]);
  applyMeshes(self.publicKey);
  const name = recordOf(tablet)!.name;
  // As removeHere does while another apply runs: the entry goes in first, then the record goes.
  let removing = true;
  applyMeshes(self.publicKey, Date.now(), () => {
    if (removing) { removing = false; revokeDevice(tablet.fingerprint, tablet.publicKey); removePeerFile(name); }
    return savedRecords();
  });
  assert.equal(accessOf(tablet), undefined);
});

test("a pairing that fails leaves a removed device on the revoked list", () => {
  pair("hub", hub);
  revokeDevice(phone.fingerprint, phone.publicKey);
  assert.throws(() => pair("hub", phone), /EEXIST/);
  assert.ok(revoked(phone));
  pair("phone", phone);
  assert.ok(!revoked(phone));
});

test("a plain removal narrows a mesh the device runs, and names the meshes here that list it, which give it no record now", async () => {
  pair("phone", phone);
  pair("hub", hub);
  mesh("work", phone, [], ["shell"]);
  mesh("home", self, [phone], []);
  mesh("club", hub, [phone], ["files"]);
  applyMeshes(self.publicKey);
  const { out } = await quietly(() => removePeer("phone", { state }));
  assert.equal(out, [
    "Removed phone.",
    "phone runs the mesh work, which this device is in. It stays at its last list here, version 2, which whoever has phone's key may have added devices to, so its members may now use nothing here. To finish, leave it: cns mesh leave work. To let its members use shell here again, only once cns mesh list work shows no device you do not know: cns mesh allow work shell.",
    "phone is listed in the mesh club, which hub runs; it gets no record here from that mesh until this device pairs with it directly.",
    `phone is still listed in the mesh home, which this device runs. To take it out: cns mesh remove home member-0, or cns peer remove --fingerprint ${phone.fingerprint} --everywhere.`,
  ].join("\n") + "\n");
  assert.deepEqual(readMesh("work")?.allow, []);
  // cns mesh allow undoes the narrowing, and warns that the list may name devices whoever has phone's key added; the mesh still takes no new list of phone's.
  assert.equal(await warned(() => quietly(() => allowMembers("work", ["shell"], { state }))), `Warning: the device with fingerprint ${phone.fingerprint}, which runs the mesh work, was removed from this device (cns peer remove), so its last list stays here, and that list may name devices whoever has its key added. Check that cns mesh list work shows no device you do not know; to end the mesh here instead: cns mesh leave work.\n`);
  assert.deepEqual(readMesh("work")?.allow, ["shell"]);
  assert.deepEqual(newerLists(listMeshes(), [nextWith("work", phone, generateIdentity())], revokedDevices()), []);
  assert.equal(await warned(() => quietly(() => allowMembers("club", ["shell"], { state }))), "", "hub was not removed");
  // Running the removal again is safe, but narrows the mesh again, and says what is left.
  const rerun = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, state }));
  assert.equal(rerun.value, 4);
  assert.match(rerun.out, /^ {2}already gone {3}this device: its pairing\n {2}narrowed {7}this device: mesh work: /m);
  assert.deepEqual(readMesh("work")?.allow, []);
  const listed = JSON.parse((await quietly(() => listMeshesCommand("home", { json: true }))).out) as Array<{ members: Array<{ name: string; revoked: boolean }> }>;
  assert.deepEqual(listed[0]!.members.map((member) => [member.name, member.revoked]), [["this device", false], ["member-0", true]]);
  assert.match((await quietly(() => listMeshesCommand("work", {}))).out, /^ {2}admin \(admin\) \(revoked\)\t/m);
});

test("a mesh the lost device runs is narrowed, so a device whoever has its key added gets nothing here, nor its secrets", async () => {
  await secureReady();
  const newLaptop = generateIdentity();
  pair("phone", phone, ["files"]);
  mesh("work", phone, [], ["shell"]);
  // Between the theft and the removal, whoever has phone's key adds new-laptop, and this device takes that list.
  const taken = newerLists(listMeshes(), [nextWith("work", phone, newLaptop)], revokedDevices());
  assert.equal(taken.length, 1);
  writeMesh(taken[0]!);
  applyMeshes(self.publicKey);
  assert.deepEqual(accessOf(newLaptop), [["shell"], "work"]);
  keepSecret(sealSecret(self, { mesh: "work", admin: phone.publicKey, name: "API_KEY", version: 1, setAt: new Date().toISOString() }, new TextEncoder().encode("value")));
  assert.equal(secretsFor(newLaptop.publicKey, self, listMeshes()).length, 1);

  const dry = await removeHere(phone.fingerprint, { meshes: true, dryRun: true, state });
  assert.deepEqual(outcomes(dry), [["its pairing", "would remove"], ["mesh work", "would narrow"]]);
  assert.equal(dry[1]!.next, "To finish, leave it: cns mesh leave work");
  assert.ok(getPeer("phone") && !revoked(phone) && readMesh("work")!.allow.length === 1, "a dry run changes nothing");

  const { value: status, out } = await quietly(() => removeCommand(undefined, { fingerprint: phone.fingerprint, meshes: true, json: true, state }));
  assert.equal(status, 4, "the mesh still needs leaving");
  const places = JSON.parse(out) as Place[];
  assert.deepEqual(outcomes(places), [["its pairing", "removed"], ["mesh work", "narrowed"]]);
  assert.equal(places[1]!.detail, "it runs this mesh, which stays at version 3 here, as this device takes no new list of it; that list may name devices whoever has its key added, so its members may now use nothing here (they could use shell), and get none of its secrets from here; the secrets held from it here may have been set by such a device, and cns mesh leave work drops them; a bot started from one of its tokens lets it in until it is removed there too");
  assert.equal(places[1]!.next, "To finish, leave it: cns mesh leave work. To let its members use shell here again, only once cns mesh list work shows no device you do not know: cns mesh allow work shell");
  assert.deepEqual(accessOf(newLaptop), [[], "work"]);
  assert.deepEqual(secretsFor(newLaptop.publicKey, self, listMeshes()), []);
  assert.deepEqual(newerLists(listMeshes(), [nextWith("work", phone, generateIdentity(), "later")], revokedDevices()), [], "its mesh stays at the last list taken");
  // Again, there is nothing left to narrow, only the mesh to leave.
  assert.deepEqual(outcomes(await removeHere(phone.fingerprint, { state })), [["its pairing", "already gone"], ["mesh work", "not permitted"]]);
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
  ], "said once");
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
  await assert.rejects(unpair("hub", phone.publicKey, state), /^Error: hub now names another device, or none, so it was left as it is\. Check cns peers\.$/);
  assert.ok(getPeer("hub") && !revoked(hub));
  await assert.rejects(removePeer("tv", { state }), /^Error: No paired device is saved as tv\. cns peers shows them\.$/);
  // A damaged record that names no device only goes.
  writeFileSync(path.join(dir, "peers", "junk"), "not a record", { mode: 0o600 });
  assert.equal((await quietly(() => removePeer("junk", { state }))).out, "Removed junk. It named no device, so nothing was put on the revoked list.\n");
  assert.ok(!existsSync(path.join(dir, "peers", "junk")));
});

test("a record that is not private, or is a link, still names the device to keep out", { skip: process.platform === "win32" }, async () => {
  pair("hub", hub);
  mesh("home", hub, [phone], ["shell"]);
  // Paired directly, its file at 644, as after a backup was restored.
  pair("phone", phone);
  chmodSync(path.join(dir, "peers", "phone"), 0o644);
  assert.equal((await quietly(() => removePeer("phone", { state }))).out, `The file saved as phone is not a private file, or is a link, so the key in it was read anyway: fingerprint ${phone.fingerprint}.\nRemoved phone.\nphone is listed in the mesh home, which hub runs; it gets no record here from that mesh until this device pairs with it directly.\n`);
  assert.ok(revoked(phone) && !existsSync(path.join(dir, "peers", "phone")));
  applyMeshes(self.publicKey);
  assert.equal(accessOf(phone), undefined, "before, hub's mesh gave it a record, with shell");
  // A link, as a dotfile manager makes: whoever may write where it links chose the key in it, so
  // --everywhere takes that key only when --fingerprint names it.
  const tablet = generateIdentity();
  pair("tablet", tablet, ["shell"]);
  renameSync(path.join(dir, "peers", "tablet"), path.join(dir, "tablet.json"));
  symlinkSync(path.join(dir, "tablet.json"), path.join(dir, "peers", "tablet"));
  await assert.rejects(removeCommand("tablet", { everywhere: true, dryRun: true, state }), { message: `The file saved as tablet is not a private file, or is a link, so the key in it was read anyway: fingerprint ${tablet.fingerprint}. A key read that way is not removed everywhere by name. If it is the lost device's, as cns peers on another of your devices shows, run: cns peer remove --fingerprint ${tablet.fingerprint} --everywhere` });
  const dry = await quietly(() => removeCommand(undefined, { fingerprint: tablet.fingerprint, everywhere: true, dryRun: true, json: true, state }));
  assert.deepEqual((JSON.parse(dry.out) as Place[])[0], { device: null, place: "its pairing", outcome: "would remove", detail: "saved here as tablet (not a private file, or a link, so its key was read anyway); no mesh would give it a record here again, until this device pairs with it directly" });
  const { out } = await quietly(() => removeCommand(undefined, { fingerprint: tablet.fingerprint, state }));
  assert.match(out, new RegExp(`^Removing tablet \\(fingerprint ${tablet.fingerprint}\\) here:\n {2}removed {8}this device: its pairing: saved here as tablet \\(not a private file`));
  assert.ok(revoked(tablet) && !existsSync(path.join(dir, "peers", "tablet")));
});

test("each record that names the device is named as it goes, and a removal that cannot finish says what changed", { skip: process.platform === "win32" }, async () => {
  pair("hub", hub, ["shell"]);
  // old-phone is a link to hub's record: removing it takes hub, and says so, and that the file was read loosely.
  symlinkSync(path.join(dir, "peers", "hub"), path.join(dir, "peers", "old-phone"));
  assert.deepEqual(await quietly(() => removePeer("old-phone", { state })), { value: 0, out: `The file saved as old-phone is not a private file, or is a link, so the key in it was read anyway: fingerprint ${hub.fingerprint}.\nRemoved old-phone and hub, which name the same device.\n` });
  assert.ok(revoked(hub) && !existsSync(path.join(dir, "peers", "hub")) && !existsSync(path.join(dir, "peers", "old-phone")));
  // b is a link to a, a loose record of phone: once a goes, b names nothing, and is left. phone's mesh is narrowed all the same.
  pair("phone", phone);
  mesh("work", phone, [], ["shell"]);
  removePeerFile("phone");
  writeFileSync(path.join(dir, "peers", "a"), JSON.stringify({ publicKey: phone.publicKey }), { mode: 0o644 });
  symlinkSync(path.join(dir, "peers", "a"), path.join(dir, "peers", "b"));
  const { value: status, out } = await quietly(() => removePeer("a", { state }));
  assert.equal(status, 1);
  assert.equal(out, [
    `The file saved as a is not a private file, or is a link, so the key in it was read anyway: fingerprint ${phone.fingerprint}.`,
    `Could not finish removing a here: a was removed, and its key is on the revoked list; b now names another device, or none, so it was left as it is. Check cns peers. Later, run: cns peer remove --fingerprint ${phone.fingerprint} --meshes.`,
    "a runs the mesh work, which this device is in. It stays at its last list here, version 2, which whoever has a's key may have added devices to, so its members may now use nothing here. To finish, leave it: cns mesh leave work. To let its members use shell here again, only once cns mesh list work shows no device you do not know: cns mesh allow work shell.",
  ].join("\n") + "\n");
  assert.ok(revoked(phone) && lstatSync(path.join(dir, "peers", "b")).isSymbolicLink(), "b is left");
  assert.deepEqual(readMesh("work")?.allow, []);
});

test("a record left of a device removed here is marked in cns peers, and cns does not connect to it", async () => {
  pair("phone", phone, ["shell"]);
  pair("hub", hub);
  // Removed, then its record restored, as from a backup.
  revokeDevice(phone.fingerprint, phone.publicKey);
  assert.throws(() => resolvePeer("phone"), { message: "phone was removed from this device (cns peer remove), so cns does not connect to it. To delete the record of it left here, run: cns peer remove phone. To use it again, pair with it again after that: cns pair." });
  assert.equal(resolvePeer("hub").publicKey, hub.publicKey);
  const listed = JSON.parse((await quietly(() => peers({ json: true, state }))).out) as Array<{ name: string; revoked: boolean }>;
  assert.deepEqual(listed.map((row) => [row.name, row.revoked]), [["hub", false], ["phone", true]]);
  let table = "";
  const hint = await warned(async () => { table = (await quietly(() => peers({ state }))).out; });
  assert.match(table, /^phone {2}removed {2}/m);
  assert.match(table, /^hub {4}offline {2}/m);
  assert.match(hint, /^phone was removed from this device \(cns peer remove\), so cns neither connects to it nor lets it in; its record is left over, as from a backup\. To delete it: cns peer remove phone\.$/m);
  assert.doesNotMatch(hint, /^phone grants this device no access/m);
});

test("a FIFO, a link to a device file or a file too large for a record in peers/ is neither waited on nor read", { skip: process.platform === "win32" }, () => {
  pair("hub", hub);
  const peers = path.join(dir, "peers");
  execFileSync("mkfifo", [path.join(peers, "fifo")]);
  symlinkSync("/dev/zero", path.join(peers, "zero"));
  writeFileSync(path.join(peers, "huge"), JSON.stringify({ publicKey: phone.publicKey, pad: "x".repeat(70_000) }), { mode: 0o644 });
  // In a process of its own, so that a read that waits fails the test rather than hanging it.
  const script = `const { getPeer, listPeers, savedKey } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "peers.ts"))});
    let strict = "read"; try { getPeer("fifo"); } catch (error) { strict = error.message; }
    console.log(JSON.stringify({ keys: ["fifo", "zero", "huge"].map((name) => savedKey(name)?.publicKey ?? null), strict, listed: listPeers(() => {}).map((peer) => peer.name) }));`;
  const ran = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, CNS_CONFIG_DIR: dir }, encoding: "utf8", timeout: 4_000 });
  assert.equal(ran.signal, null, `it waited: ${ran.stderr}`);
  const found = JSON.parse(ran.stdout) as { keys: unknown[]; strict: string; listed: string[] };
  assert.deepEqual(found.keys, [null, null, null], "no key is read from a FIFO, a device file or 70 KB");
  assert.match(found.strict, /^A saved peer must be a private file owned by your user: /);
  assert.deepEqual(found.listed, ["hub"]);
});

test("a revoked directory that is not private stops a removal before anything goes, and says how to fix it", { skip: process.platform === "win32" }, async () => {
  pair("phone", phone);
  const revokedDir = path.join(dir, "revoked");
  mkdirSync(revokedDir);
  chmodSync(revokedDir, 0o755);
  // The key goes on the list before the record goes, so a list that cannot be written leaves the record.
  const fix = { message: `Configuration directory must be private and owned by your user: ${revokedDir}. To make it private, run: chmod 700 '${revokedDir}'` };
  await assert.rejects(unpair("phone", phone.publicKey, state), fix);
  assert.ok(getPeer("phone"));
  // Where the daemon lets nothing in then, cns peers and cns run say what to run.
  await assert.rejects(peers({ state }), fix);
  assert.throws(() => resolvePeer("phone"), fix);
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

test("the gateway is not asked to run commands, nor a device that looks like one, and a refusal is told from a device out of reach", () => {
  const fp = phone.fingerprint;
  const entry = (name: string, extra: Partial<PeerEntry> = {}) => ({ name, fingerprint: name, addresses: ["ws://127.0.0.1:1/"], grants: { incoming: [], outgoing: ["shell" as Permission] }, ...extra });
  const bare = { addresses: [], grants: { incoming: ["shell" as Permission], outgoing: [] } };
  assert.equal(gatewayPlace(entry("studio"), undefined, fp), undefined);
  assert.deepEqual(gatewayPlace(entry("gate"), "gate", fp), { device: "gate", place: "", outcome: "not used", detail: "it is the gateway, which runs no commands: see the gateway line" }, "the gateway answered with its fingerprint");
  assert.equal(gatewayPlace(entry("c", { mesh: "home", gateway: true }), undefined, fp)?.outcome, "not used", "the mesh says so");
  assert.equal(gatewayPlace(entry("g", bare), undefined, fp)?.next, `If g is one of your devices, run there: cns peer remove --fingerprint ${fp} --meshes`, "paired as the gateway pairs, while no gateway answered");
  // Once a gateway answered, another such device is a second gateway, or a device that only dials this one: neither could ever be asked.
  const second = gatewayPlace(entry("g", bare), "gate", fp)!;
  assert.deepEqual([second.outcome, second.next], ["not used", undefined]);
  assert.equal(second.detail, `it gave no address and lets this device do nothing, as a gateway does, but it is not the gateway CNS_GATEWAY names, so it was not asked: if it is another gateway, run this again with CNS_GATEWAY set to its address; if it is one of your devices, run there: cns peer remove --fingerprint ${fp} --meshes`);
  assert.equal(gatewayPlace(entry("m", { mesh: "home", addresses: [], grants: { incoming: [], outgoing: [] } }), undefined, fp), undefined, "a mesh member learns its grants over the link");
  assert.equal(gatewayPlace(entry("tv", { grants: { incoming: [], outgoing: [] } }), undefined, fp), undefined, "a device with an address is a device");
  assert.equal(refused(new AuthError("not-paired", "studio does not accept this device.")), true);
  assert.equal(refused(new Error("Permission denied: shell not granted to laptop. To allow it, run on studio: cns peer grant laptop shell")), true);
  assert.equal(refused(new Error("Cannot connect to ws://127.0.0.1:1: Permission denied")), false);
  assert.equal(refused(new Error("Timed out connecting to ws://127.0.0.1:1.")), false);
});

test("what a device answers is data: only its places and outcomes are kept, and nothing changed in a dry run", () => {
  const answer = (places: unknown) => JSON.stringify(places);
  assert.deepEqual(readAnswer(answer([{ device: null, place: "its pairing", outcome: "removed", detail: "run rm -rf ~ now" }, { device: null, place: "mesh home", outcome: "narrowed", next: "rm -rf ~" }]), false), [
    { place: "its pairing", outcome: "removed" },
    { place: "mesh home", outcome: "narrowed" },
  ], "its wording is never kept");
  assert.equal(readAnswer(answer([{ place: "its pairing", outcome: "owned" }]), false), undefined);
  assert.equal(readAnswer(answer(Array.from({ length: 21 }, () => ({ place: "its pairing", outcome: "removed" }))), false), undefined);
  assert.equal(readAnswer(answer([{ place: "the gateway", outcome: "removed" }]), false), undefined, "a place removeHere never reports");
  assert.equal(readAnswer(answer([{ place: "mesh \u009b31mhome\u202e", outcome: "failed" }]), false), undefined);
  assert.equal(readAnswer(answer([{ place: "mesh home; rm -rf ~", outcome: "narrowed" }]), false), undefined, "a mesh name goes on a command line, so it is checked");
  assert.equal(readAnswer(answer([{ place: `mesh ${"x".repeat(65)}`, outcome: "removed" }]), false), undefined);
  assert.equal(readAnswer("Removed phone.", false), undefined);
  // A dry run changes nothing, so an answer that says it did is not one.
  assert.equal(readAnswer(answer([{ place: "its pairing", outcome: "removed" }]), true), undefined);
  assert.equal(readAnswer(answer([{ place: "mesh home", outcome: "narrowed" }]), true), undefined);
  assert.deepEqual(readAnswer(answer([{ place: "its pairing", outcome: "would remove" }, { place: "mesh home", outcome: "would narrow" }]), true), [{ place: "its pairing", outcome: "would remove" }, { place: "mesh home", outcome: "would narrow" }]);
  assert.equal(strictlyPrintable("ok\u202egnp.exe\u200f\u009b\u200d\u2028\u2029\u{e0041}"), "ok?gnp.exe??????");
});

test("what is left on a device is built here from each place and outcome alone: a mesh it runs there is left there, by name", () => {
  const fp = phone.fingerprint;
  const command = `cns peer remove --fingerprint ${fp} --meshes`;
  assert.deepEqual(answerPlaces("hub", fp, [{ place: "its pairing", outcome: "already gone" }, { place: "mesh home", outcome: "already gone" }]), [{ device: "hub", place: "", outcome: "already gone" }]);
  assert.deepEqual(answerPlaces("hub", fp, [
    { place: "its pairing", outcome: "removed" },
    { place: "mesh home", outcome: "already gone" },
    { place: "mesh work", outcome: "narrowed" },
    { place: "mesh club", outcome: "not permitted" },
    { place: "its meshes", outcome: "failed" },
    { place: "its pairing", outcome: "not permitted" },
  ]), [
    { device: "hub", place: "its pairing", outcome: "removed" },
    { device: "hub", place: "mesh work", outcome: "narrowed", detail: "it runs this mesh, so hub takes no new list of it, and its members may now use nothing there; only once cns mesh list work there shows no device you do not know, cns mesh allow work GRANTS there undoes that", next: "To finish, run: cns run hub -- cns mesh leave work" },
    { device: "hub", place: "mesh club", outcome: "not permitted", detail: "it runs this mesh, so hub takes no new list of it, and its members may use nothing there", next: "To finish, run: cns run hub -- cns mesh leave club" },
    { device: "hub", place: "its meshes", outcome: "failed", next: `Later, run: cns run hub -- ${command}` },
    { device: "hub", place: "its pairing", outcome: "not permitted", next: `To see what is left there, run: cns run hub -- ${command}` },
  ]);
  assert.equal(answerPlaces("hub", fp, [{ place: "mesh work", outcome: "would narrow" }])[0]!.next, "To finish, run: cns run hub -- cns mesh leave work");
});

test("a lost device the gateway cannot be asked about is reported as not used, unreachable, not permitted or failed, with what to run", async (t) => {
  const fp = "aaaa-bbbb-cccc-dddd-eeee-ffff";
  const later = `Later, run: cns peer remove --fingerprint ${fp} --everywhere`;
  // Said whatever the gateway answered: a lost owner the gateway never paired can still approve connectors.
  const owners = "; if it was one of the gateway's owners too, it can still approve connectors until its key is out of OWNER_KEYS (cd gateway && npx wrangler secret put OWNER_KEYS); cns gateway grants lists the connectors, and cns gateway revoke ID stops one";
  let asked = 0;
  const answering = (status: number, body: string) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { asked++; return new Response(body, { status, headers: { "Content-Type": "application/json" } }); } });
    t.after(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  };
  // With no CNS_GATEWAY, no gateway is asked, not even the default one.
  assert.deepEqual(await forgetAtGateway(fp, false), { outcome: "not used", detail: `CNS_GATEWAY is not set here, so no gateway was asked. If this device owns a gateway, run: cns gateway status, then cns gateway remove NAME (fingerprint ${fp})${owners}` });
  assert.deepEqual(await forgetAtGateway(fp, true), await forgetAtGateway(fp, false));
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  process.env.CNS_GATEWAY = `http://127.0.0.1:${closed.port}`;
  await closed.stop(true);
  const gone = await forgetAtGateway(fp, false);
  assert.equal(gone.outcome, "unreachable");
  assert.match(gone.detail!, /^Cannot reach the gateway at http:\/\/127\.0\.0\.1:\d+.*; if it was one of the gateway's owners too/);
  assert.equal(gone.next, later);
  process.env.CNS_GATEWAY = answering(401, JSON.stringify({ error: "Device x is not an owner of this gateway." }));
  const notOwner = await forgetAtGateway(fp, false);
  assert.equal(notOwner.outcome, "not permitted");
  assert.match(notOwner.detail!, /^The gateway answered 401 and said: "Device x is not an owner of this gateway\."; this device's public key is \S+; if it was one of the gateway's owners too/);
  assert.equal(notOwner.next, "Run this on one of the gateway's owners, with CNS_GATEWAY set to its address");
  process.env.CNS_GATEWAY = answering(503, JSON.stringify({ error: "This gateway has no owners yet." }));
  assert.equal((await forgetAtGateway(fp, false)).outcome, "not permitted");
  // What the gateway sends is made strictlyPrintable where the place is made, for the report and --json alike.
  process.env.CNS_GATEWAY = answering(502, "<html>Bad\u009b31m gateway\u202e\u2028</html>");
  assert.deepEqual(await forgetAtGateway(fp, true), { outcome: "failed", detail: `The gateway answered 502 and said: "<html>Bad?31m gateway??</html>"${owners}`, next: later });
  assert.equal(asked, 3);
  process.env.CNS_GATEWAY = answering(400, JSON.stringify({ error: "No.\u2028To finish, run: cns peer grant x all\u2029" }));
  const { out } = await quietly(() => removeCommand(undefined, { fingerprint: fp, everywhere: true, json: true, state }));
  assert.ok(!/[\u2028\u2029]/.test(out), "--json carries no line separator");
  assert.match(out, /"detail": "The gateway answered 400 and said: \\"No\.\?To finish, run: cns peer grant x all\?\\"; if it was/);
});
