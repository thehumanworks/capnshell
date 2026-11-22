import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, fingerprint, type PublicKey } from "./identity.js";
import { droppedBy, firstList, listsFor, memberGrants, newerLists, nextList, openList, planMesh, signList, type Member, type MemberList, type MeshState } from "./mesh.js";
import type { PeerEntry, Permission } from "./peers.js";

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
