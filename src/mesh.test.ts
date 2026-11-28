import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateIdentity, fingerprint, type PublicKey } from "./identity.js";
import { applyMeshes, droppedBy, firstList, listsFor, memberGrants, newerLists, nextList, openList, planMesh, signList, writeMesh, type Member, type MemberList, type MeshState } from "./mesh.js";
import { peerNames } from "./peer-files.js";
import { savePairedPeer, type PeerEntry, type Permission } from "./peers.js";

const admin = generateIdentity();
const laptop = generateIdentity();
const studio = generateIdentity();
const stranger = generateIdentity();
const NOW = Date.parse("2026-11-15T12:00:00Z");

const member = (key: PublicKey, name: string, extra: Partial<Member> = {}): Member => ({ key, name, ...extra });
/** A list of the mesh home with the admin, laptop and studio, at `version`. */
function homeList(version = 2, members: Member[] = [member(laptop.publicKey, "laptop"), member(studio.publicKey, "studio")]): MemberList {
  let list = firstList("home", { key: admin.publicKey, name: "admin" }, NOW);
  for (let v = 1; v < version; v++) list = nextList(list, (current) => v === version - 1 ? [current[0]!, ...members] : current, NOW);
  return list;
}
const stateOf = (list: MemberList, allow: Permission[] = ["shell"]): MeshState => ({ name: list.mesh, admin: list.admin, allow, signed: signList(list, admin), list });
const record = (name: string, key: PublicKey, extra: Partial<PeerEntry> = {}): PeerEntry => ({
  name, fingerprint: fingerprint(key), version: 2, publicKey: key, addresses: [], pairedAt: new Date(NOW).toISOString(), grants: { incoming: [], outgoing: [] }, ...extra,
});

test("a member list opens only with its admin's signature over exactly its text", () => {
  const list = homeList();
  const signed = signList(list, admin);
  assert.deepEqual(openList(signed), list);
  assert.deepEqual(openList(signed, admin.publicKey), list);
  assert.throws(() => openList(signed, laptop.publicKey), /another admin's/);
  // Changed text, a signature by anyone else, or a list that is not one, is refused.
  assert.throws(() => openList({ ...signed, text: signed.text.replace('"laptop"', '"laptop2"') }), /signature is not its admin's/);
  const forged = { ...list, admin: stranger.publicKey, members: [...list.members, member(stranger.publicKey, "stranger")] };
  assert.throws(() => openList({ text: JSON.stringify(forged), sig: signed.sig }), /signature is not its admin's/);
  assert.throws(() => openList({ text: "{", sig: signed.sig }), /Not a mesh member list/);
  assert.throws(() => openList("cns-mesh"), /Not a mesh member list/);
  // Only the admin signs, and only a list that holds itself and no device twice.
  assert.throws(() => signList(list, laptop), /Only the mesh's admin/);
  assert.throws(() => nextList(list, (members) => [...members, member(laptop.publicKey, "again")], NOW), /listed twice/);
  assert.throws(() => nextList(list, (members) => members.slice(1), NOW), /admin is not a member/);
});

test("a member's grants are what the device allows members, within the member's limit", () => {
  assert.deepEqual(memberGrants(["shell", "files"]), ["shell", "files"]);
  assert.deepEqual(memberGrants(["shell", "files"], ["files", "sessions:view"]), ["files"]);
  assert.deepEqual(memberGrants([], ["shell"]), []);
});

test("a member's records follow the list: created, renamed when taken, regranted and removed, never over a direct pairing", () => {
  const list = homeList(2, [member(laptop.publicKey, "laptop"), member(studio.publicKey, "studio", { limit: ["files"], addresses: ["ws://192.0.2.7:47381"] }), member(stranger.publicKey, "spare")]);
  const plan = (self: PublicKey, records: PeerEntry[], allow: Permission[] = ["shell", "files"]) => planMesh({ self, mesh: "home", allow, list, records, now: NOW });

  // On laptop, paired with the admin directly: studio gets a record, under studio-2 since a
  // device there is already called studio, with the limit applied and the admin's addresses.
  const onLaptop = plan(laptop.publicKey, [record("admin", admin.publicKey), record("studio", generateIdentity().publicKey)]);
  assert.deepEqual(onLaptop.create.map(({ name, record: saved }) => [name, saved.publicKey, saved.grants.incoming, saved.addresses, saved.mesh]), [
    ["studio-2", studio.publicKey, ["files"], ["ws://192.0.2.7:47381"], "home"],
    ["spare", stranger.publicKey, ["shell", "files"], [], "home"],
  ]);
  assert.deepEqual([onLaptop.update, onLaptop.remove], [[], []]);

  // A device paired directly, or known through another mesh, keeps its record and grants.
  const direct = plan(laptop.publicKey, [record("admin", admin.publicKey), record("st", studio.publicKey, { grants: { incoming: ["sessions:view"], outgoing: [] } }), record("spare", stranger.publicKey, { mesh: "work" })]);
  assert.deepEqual([direct.create, direct.update, direct.remove], [[], [], []]);

  // A changed allow regrants the mesh's records; a device no longer listed loses its record.
  const gone = generateIdentity().publicKey;
  const changed = plan(laptop.publicKey, [record("studio", studio.publicKey, { mesh: "home", grants: { incoming: ["files"], outgoing: [] } }), record("spare", stranger.publicKey, { mesh: "home", grants: { incoming: ["shell", "files"], outgoing: [] } }), record("old", gone, { mesh: "home" })], ["shell"]);
  assert.deepEqual(changed.update, [{ name: "studio", incoming: [] }, { name: "spare", incoming: ["shell"] }]);
  assert.deepEqual(changed.remove, [{ name: "old", publicKey: gone }]);
  assert.deepEqual(changed.create, []);

  // A device the list no longer holds drops every record of the mesh; the admin keeps none.
  const outsider = generateIdentity().publicKey;
  assert.deepEqual(plan(outsider, [record("studio", studio.publicKey, { mesh: "home" }), record("admin", admin.publicKey)]).remove, [{ name: "studio", publicKey: studio.publicKey }]);
  const onAdmin = plan(admin.publicKey, [record("laptop", laptop.publicKey)]);
  assert.deepEqual([onAdmin.create, onAdmin.update, onAdmin.remove], [[], [], []]);
});

test("a list that names the gateway is of v 2, and members save it as a gateway they never dial", () => {
  const gateway = generateIdentity();
  const plain = homeList();
  assert.equal(plain.v, 1);
  const withGateway = nextList(plain, (members) => [...members, member(gateway.publicKey, "gateway", { gateway: true, limit: ["shell"] })], NOW);
  assert.equal(withGateway.v, 2);
  assert.deepEqual(openList(signList(withGateway, admin)), withGateway);
  // A v 1 list cannot name it, a v 2 list must, and the admin is never the gateway.
  assert.throws(() => signList({ ...withGateway, v: 1 }, admin), /exactly when it is of v 2/);
  assert.throws(() => signList({ ...plain, v: 2 }, admin), /exactly when it is of v 2/);
  assert.throws(() => nextList(plain, ([first, ...rest]) => [{ ...first!, gateway: true }, ...rest], NOW), /admin is not a gateway/);
  // Taking it out again makes the list v 1, which members on any cns read.
  assert.equal(nextList(withGateway, (members) => members.filter((entry) => !entry.gateway), NOW).v, 1);

  const plan = (list: MemberList, records: PeerEntry[]) => planMesh({ self: laptop.publicKey, mesh: "home", allow: ["shell", "files"], list, records, now: NOW });
  const added = plan(withGateway, [record("admin", admin.publicKey)]);
  assert.deepEqual(added.create.map(({ name, record: saved }) => [name, saved.grants.incoming, saved.gateway]), [["studio", ["shell", "files"], undefined], ["gateway", ["shell"], true]]);
  // A member that becomes the gateway, or stops being it, is saved again under its name.
  const asMember = record("gateway", gateway.publicKey, { mesh: "home", grants: { incoming: ["shell"], outgoing: [] } });
  const became = plan(withGateway, [record("admin", admin.publicKey), record("studio", studio.publicKey, { mesh: "home", grants: { incoming: ["shell", "files"], outgoing: [] } }), asMember]);
  assert.deepEqual([became.remove, became.create.map(({ name, record: saved }) => [name, saved.gateway])], [[{ name: "gateway", publicKey: gateway.publicKey }], [["gateway", true]]]);
});

test("a member that missed the removal reuses the bot's alias for its replacement key", () => {
  const list = homeList();
  const oldKey = generateIdentity().publicKey;
  const plan = planMesh({ self: laptop.publicKey, mesh: "home", list, allow: [], now: NOW, records: [record("studio", oldKey, { mesh: "home" })] });
  assert.deepEqual(plan.remove, [{ name: "studio", publicKey: oldKey }]);
  assert.deepEqual(plan.create.map(({ name, record }) => [name, record.publicKey]), [["studio", studio.publicKey]]);
});

test("a member whose saved record this cns cannot read gets no mesh record beside it", () => {
  const list = homeList(2, [member(laptop.publicKey, "laptop"), member(studio.publicKey, "studio"), member(stranger.publicKey, "spare")]);
  // studio's record needs a feature from a newer cns, such as an expiry that narrows what it
  // may do; spare's file cannot be read at all, so it names no key but keeps its name.
  const unreadable = [{ name: "st", publicKey: studio.publicKey }, { name: "spare" }];
  const plan = planMesh({ self: laptop.publicKey, mesh: "home", list, allow: ["shell"], now: NOW, records: [], unreadable });
  assert.deepEqual(plan.create.map(({ name, record }) => [name, record.publicKey]), [["spare-2", stranger.publicKey]]);
  // A mesh record this cns can read still follows the list, so a narrower allow reaches it.
  const held = planMesh({ self: laptop.publicKey, mesh: "home", list, allow: [], now: NOW, records: [record("studio", studio.publicKey, { mesh: "home", grants: { incoming: ["shell"], outgoing: [] } })], unreadable });
  assert.deepEqual(held.update, [{ name: "studio", incoming: [] }]);
});

test("applying a mesh leaves a member alone when a newer cns saved its record", { skip: process.platform === "win32" }, () => {
  const previous = process.env.CNS_CONFIG_DIR;
  const dir = mkdtempSync(path.join(os.tmpdir(), "cns-mesh-"));
  process.env.CNS_CONFIG_DIR = dir;
  try {
    savePairedPeer("admin", { publicKey: admin.publicKey, addresses: [], pairedAt: new Date(NOW).toISOString(), grants: { incoming: [], outgoing: [] } });
    writeFileSync(path.join(dir, "peers", "st"), JSON.stringify({ version: 2, needs: ["expiry"], publicKey: studio.publicKey, addresses: [], pairedAt: new Date(NOW).toISOString(), grants: { incoming: [], outgoing: [] } }), { mode: 0o600 });
    writeMesh({ name: "home", admin: admin.publicKey, allow: ["shell"], signed: signList(homeList(), admin) });
    const plan = applyMeshes(laptop.publicKey, NOW);
    assert.deepEqual([plan.create, plan.update, plan.remove], [[], [], []]);
    assert.deepEqual(peerNames(), ["admin", "st"]);
  } finally {
    if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a device takes only a newer list its mesh's admin signed, for a mesh it is in", () => {
  const held = stateOf(homeList(2));
  const v3 = signList(homeList(3), admin);
  const v4 = signList(homeList(4), admin);
  assert.deepEqual(newerLists([held], [v3]).map((state) => [state.list.version, state.allow]), [[3, ["shell"]]]);
  // The newest of several, whatever their order.
  assert.deepEqual(newerLists([held], [v4, v3]).map((state) => state.list.version), [4]);
  // Not the version it has or an older one.
  assert.deepEqual(newerLists([stateOf(homeList(3))], [signList(homeList(2), admin), v3]), []);
  // Not one signed by someone else as admin of a mesh of the same name.
  let other = firstList("home", { key: stranger.publicKey, name: "stranger" }, NOW);
  for (let v = 1; v < 9; v++) other = nextList(other, (members) => members, NOW);
  assert.deepEqual(newerLists([held], [signList(other, stranger)]), []);
  // Not a mesh it is not in, or anything that is not a list.
  assert.deepEqual(newerLists([], [v3]), []);
  assert.deepEqual(newerLists([held], "not lists"), []);
  assert.deepEqual(newerLists([held], [{ text: v3.text, sig: v4.sig }]), []);
});

test("a mesh made again under a deleted one's name takes none of the old one's lists", () => {
  // A device that was offline when it was removed still holds the old mesh's list, version 4.
  const old = signList(homeList(4), admin);
  // Made from version 1 again, the new mesh would take that list as its newer one, members and all.
  const fromOne = stateOf(firstList("home", { key: admin.publicKey, name: "admin" }, NOW));
  assert.deepEqual(newerLists([fromOne], [old]).map((state) => state.list.version), [4]);
  // Made above the old mesh's last version, it and every later list of it are newer than any old one.
  const made = firstList("home", { key: admin.publicKey, name: "admin" }, NOW, 4);
  assert.equal(made.version, 5);
  assert.deepEqual(newerLists([stateOf(made)], [old]), []);
  assert.deepEqual(newerLists([stateOf(nextList(made, (members) => members, NOW))], [old, signList(homeList(3), admin)]), []);
});

test("a device is offered only the lists of meshes it is in, and leaves a mesh its admin stops offering", () => {
  const home = stateOf(homeList(2));
  assert.deepEqual(listsFor(laptop.publicKey, [home]), [home.signed]);
  assert.deepEqual(listsFor(stranger.publicKey, [home]), []);
  // The admin offering the list: stay. Offering none: the device was removed, or the mesh ended.
  assert.deepEqual(droppedBy(admin.publicKey, laptop.publicKey, [home], [home.signed]), []);
  assert.deepEqual(droppedBy(admin.publicKey, laptop.publicKey, [home], []), ["home"]);
  // Anyone else offering nothing says nothing, nor does the admin answering with no list at all.
  assert.deepEqual(droppedBy(studio.publicKey, laptop.publicKey, [home], []), []);
  assert.deepEqual(droppedBy(admin.publicKey, admin.publicKey, [home], []), []);
});
