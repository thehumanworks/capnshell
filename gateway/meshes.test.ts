import assert from "node:assert/strict";
import test from "node:test";
import { generateIdentity, type Identity } from "../src/identity.js";
import { firstList, nextList, signList, type Member, type MemberList } from "../src/mesh.js";
import { gatewayObject, meshMembers, pairDevice } from "./test-object.js";

/**
 * The gateway as a member of meshes (object.ts): it takes a member list only from the device
 * that runs that mesh, only when the list names it as the gateway, and drops it when that
 * device stops offering it. Connectors approved for all devices then reach the members.
 */

const studio = generateIdentity();
const laptop = generateIdentity();
const NOW = Date.parse("2026-11-27T12:00:00Z");

/** The mesh `mesh` run by `admin`, listing `members` after it, signed. */
function listOf(admin: Identity, members: Member[], { mesh = "home", version = 2 } = {}): { list: MemberList; signed: ReturnType<typeof signList> } {
  let list = firstList(mesh, { key: admin.publicKey, name: "studio" }, NOW);
  while (list.version < version) list = nextList(list, ([first]) => [first!, ...members], NOW);
  return { list, signed: signList(list, admin) };
}

async function setup() {
  const { object, exec } = await gatewayObject();
  const self = object.status().publicKey;
  pairDevice(exec, "studio", studio.publicKey);
  pairDevice(exec, "laptop", laptop.publicKey);
  const nas = generateIdentity().publicKey;
  const pi = generateIdentity().publicKey;
  const asGateway = { key: self, name: "gateway", gateway: true as const, limit: ["shell" as const] };
  return { object, self, nas, pi, asGateway };
}

const names = (devices: { name: string }[]) => devices.map((device) => device.name);

test("a list from the device that runs the mesh, naming the gateway as its gateway, brings its members to connectors approved for all devices", async () => {
  const { object, nas, pi, asGateway } = await setup();
  const home = listOf(studio, [member(nas, "nas", ["ws://192.0.2.9:47381"]), member(laptop.publicKey, "laptop"), asGateway]);
  object.takeLists(studio.publicKey, [home.signed]);
  // laptop is paired with the gateway directly, so it is reached as that pairing; studio runs the mesh.
  assert.deepEqual(names(object.connectorDevices("all")), ["laptop", "studio", "nas"]);
  assert.deepEqual(object.connectorDevices("all").at(-1), { name: "nas", publicKey: nas, addresses: ["ws://192.0.2.9:47381"], mesh: "home" });
  assert.deepEqual(names(object.connectorDevices([studio.publicKey, nas])), ["studio"], "an approval for named devices reaches only devices paired with the gateway");
  assert.deepEqual(object.status().meshes, [{ name: "home", admin: "studio", version: 2, members: ["nas", "laptop"] }]);

  // A newer list adds and removes members; an older one offered again changes nothing.
  const newer = listOf(studio, [member(pi, "pi"), asGateway], { version: 3 });
  object.takeLists(studio.publicKey, [newer.signed]);
  assert.deepEqual(names(object.connectorDevices("all")), ["laptop", "studio", "pi"]);
  object.takeLists(studio.publicKey, [home.signed]);
  assert.deepEqual(names(object.connectorDevices("all")), ["laptop", "studio", "pi"]);

  // When studio offers it no more, as after cns mesh remove home gateway, the mesh is gone.
  object.takeLists(studio.publicKey, []);
  assert.deepEqual([names(object.connectorDevices("all")), object.status().meshes], [["laptop", "studio"], []]);
});

test("the gateway takes no list another device offers for a mesh it does not run, nor one naming the gateway as a plain member", async () => {
  const { object, self, nas, asGateway } = await setup();
  const home = listOf(studio, [member(nas, "nas"), asGateway]);
  object.takeLists(laptop.publicKey, [home.signed]);
  assert.deepEqual(object.status().meshes, []);
  // A plain member would be dialed by members and sealed their secrets.
  object.takeLists(studio.publicKey, [listOf(studio, [member(nas, "nas"), member(self, "gateway")]).signed]);
  assert.deepEqual(object.status().meshes, []);
  // Removing the device that runs a mesh removes the mesh.
  object.takeLists(studio.publicKey, [home.signed]);
  assert.equal(object.status().meshes.length, 1);
  assert.ok(object.removeDevice("studio"));
  assert.deepEqual([names(object.connectorDevices("all")), object.status().meshes], [["laptop"], []]);
});

test("mesh members are reached once each, renamed when a device paired with the gateway has their name", () => {
  const self = generateIdentity().publicKey;
  const [nas, other] = [generateIdentity().publicKey, generateIdentity().publicKey];
  const paired = ["studio", "nas", "pi"].map((name) => ({ name, publicKey: name === "studio" ? studio.publicKey : generateIdentity().publicKey, addresses: [] }));
  const home = listOf(studio, [member(nas, "nas"), { key: self, name: "gateway", gateway: true }]).list;
  const work = listOf(studio, [member(nas, "nas"), member(other, "pi"), { key: self, name: "gateway", gateway: true }], { mesh: "work" }).list;
  assert.deepEqual(meshMembers(self, paired, [home, work]).map((device) => [device.name, device.publicKey, device.mesh]), [["nas-2", nas, "home"], ["pi-2", other, "work"]]);
});

function member(key: string, name: string, addresses?: string[]): Member {
  return { key, name, ...addresses ? { addresses } : {} };
}
