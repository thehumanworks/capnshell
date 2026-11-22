import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { settledLink, testDevices, type TestDevice } from "./test-support.js";

/** Wait until `check` holds, as lists and links take a moment to reach every daemon. */
async function eventually(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("mesh members reach each other as far as each allows, and the admin's list adds and removes them", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-mesh-");
  const hub = await devices.device("hub");
  const laptop = await devices.device("laptop");
  const studio = await devices.device("studio");
  for (const device of [hub, laptop, studio]) await devices.up(device);
  // laptop and studio are each paired with hub, not with each other.
  await devices.pair(hub, laptop);
  await devices.pair(hub, studio);
  const mesh = (device: TestDevice, args: string[]) => devices.cli(device, ["mesh", ...args, ...args[0] === "list" ? [] : ["--state", device.state]]);
  const has = (device: TestDevice, kind: "peers" | "meshes", name: string) => existsSync(path.join(device.dir, kind, name));

  // A device can join only a mesh that the device it names runs and lists it in.
  const early = await mesh(laptop, ["join", "home", "--via", "hub"]);
  assert.equal(early.code, 1, early.output);
  assert.match(early.stderr, /hub runs no mesh home with this device in it\. On hub, run: cns mesh add home DEVICE/);

  assert.equal((await mesh(hub, ["create", "home"])).code, 0);
  const added = await mesh(hub, ["add", "home", "laptop"]);
  assert.equal(added.code, 0, added.output);
  assert.match(added.stdout, /The mesh home lists laptop \(version 2\)\.\nOn each, run: cns mesh join home --via DEVICE/);
  assert.equal((await mesh(hub, ["add", "home", "studio", "--limit", "shell,files"])).code, 0);

  const joined = await mesh(laptop, ["join", "home", "--via", "hub", "--allow", "shell"]);
  assert.equal(joined.code, 0, joined.output);
  assert.match(joined.stdout, /Joined the mesh home, run by hub\. Other members: studio\.\nMembers may use here: shell\./);
  assert.equal((await mesh(studio, ["join", "home", "--via", "hub", "--allow", "all"])).code, 0);
  const again = await mesh(studio, ["join", "home", "--via", "hub"]);
  assert.match(again.stderr, /already has a mesh named home/);
  // Only the admin changes who is in it.
  const outsider = await mesh(studio, ["add", "home", "laptop"]);
  assert.match(outsider.stderr, /Only the mesh's admin changes who is in it: run this on hub\./);

  // Each saved the other as a member, though they never paired; hub keeps no member records.
  assert.ok(has(laptop, "peers", "studio") && has(studio, "peers", "laptop"));
  const peers = JSON.parse((await devices.cli(laptop, ["peers", "--json"])).stdout) as Array<{ name: string; mesh: string | null; grants: string[] }>;
  assert.deepEqual(peers.map((peer) => [peer.name, peer.mesh, peer.grants.join()]), [["hub", null, ""], ["studio", "home", "shell"]]);
  assert.deepEqual(JSON.parse((await devices.cli(hub, ["peers", "--json"])).stdout).map((peer: { name: string }) => peer.name), ["laptop", "studio"]);

  // laptop uses all of studio, which allows members everything.
  const ran = await devices.cli(laptop, ["run", "studio", "--", "echo", "from laptop"]);
  assert.equal(ran.code, 0, ran.output);
  assert.equal(ran.stdout, "from laptop\n");
  // studio uses laptop's shell, all laptop allows; files are refused, with what to run there.
  const back = await devices.cli(studio, ["run", "laptop", "--", "echo", "from studio"]);
  assert.equal(back.code, 0, back.output);
  assert.equal(back.stdout, "from studio\n");
  const file = path.join(laptop.dir, "note.txt");
  await writeFile(file, "laptop's\n");
  const copied = await devices.cli(studio, ["cp", `laptop:${file}`, path.join(os.tmpdir(), `cns-mesh-${process.pid}`)]);
  assert.equal(copied.code, 4, copied.output);
  assert.match(copied.stderr, /files not granted to studio\. laptop gives members of the mesh home what cns mesh allow set there\. To allow it, run on laptop: cns mesh allow home (shell,)?files/);
  // A member's record follows the mesh, not cns peer grant.
  const granted = await devices.cli(laptop, ["peer", "grant", "studio", "files"]);
  assert.equal(granted.code, 1);
  assert.match(granted.stderr, /studio is here as a member of the mesh home, so cns mesh allow home sets what it may use here/);

  // Allowing members less applies at once.
  assert.equal((await mesh(laptop, ["allow", "home", "none"])).code, 0);
  const narrowed = await devices.cli(studio, ["run", "laptop", "--", "true"]);
  assert.equal(narrowed.code, 4, narrowed.output);
  assert.equal((await mesh(laptop, ["allow", "home", "shell"])).code, 0);

  const listed = JSON.parse((await mesh(laptop, ["list", "--json"])).stdout);
  assert.deepEqual(listed.map((entry: { name: string; admin: string; version: number; allow: string[]; members: Array<{ name: string; limit: string[] | null }> }) =>
    [entry.name, entry.admin, entry.version, entry.allow, entry.members.map((member) => [member.name, member.limit])]),
  [["home", "hub", 3, ["shell"], [["hub", null], ["this device", null], ["studio", ["shell", "files"]]]]]);

  // The admin removes studio, which does not hear of it, having unpaired hub: laptop drops
  // its record and ends the link it holds to it, so studio can use laptop no more.
  const control = await connectControl(laptop.state);
  try {
    await settledLink(control, "studio");
    assert.equal((await devices.cli(studio, ["peer", "remove", "hub", "--state", studio.state])).code, 0);
    const removed = await mesh(hub, ["remove", "home", "studio"]);
    assert.equal(removed.code, 0, removed.output);
    assert.match(removed.stdout, /Removed studio from the mesh home \(version 4\)\./);
    await eventually("laptop drops studio", () => !has(laptop, "peers", "studio"));
    await eventually("laptop ends its link to studio", async () => !(await control.controller.peers()).some((peer) => peer.peer?.name === "studio"));
  } finally { control.close(); }
  assert.ok(has(studio, "meshes", "home"), "studio never heard");
  const refused = await devices.cli(studio, ["run", "laptop", "--", "true"]);
  assert.equal(refused.code, 3, refused.output);

  // Ending the mesh on the admin ends it on every member it reaches; each keeps its own pairing.
  assert.equal((await mesh(hub, ["leave", "home"])).code, 0);
  await eventually("laptop leaves the ended mesh", () => !has(laptop, "meshes", "home"));
  assert.ok(has(laptop, "peers", "hub"));
});

test("a mesh bot token makes a machine nobody sits at a member that others reach, until the admin removes it", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-mesh-bot-");
  const hub = await devices.device("hub");
  const laptop = await devices.device("laptop");
  for (const device of [hub, laptop]) await devices.up(device);
  await devices.pair(hub, laptop);
  const mesh = (device: TestDevice, args: string[]) => devices.cli(device, ["mesh", ...args, "--state", device.state]);
  const has = (device: TestDevice, kind: "peers" | "meshes", name: string) => existsSync(path.join(device.dir, kind, name));
  assert.equal((await mesh(hub, ["create", "home"])).code, 0);
  assert.equal((await mesh(hub, ["add", "home", "laptop"])).code, 0);
  assert.equal((await mesh(laptop, ["join", "home", "--via", "hub", "--allow", "shell"])).code, 0);

  // The admin says what members may use on the bot, and prints the token alone on stdout.
  const unsaid = await mesh(hub, ["token", "home", "ci"]);
  assert.equal(unsaid.code, 1);
  assert.match(unsaid.stderr, /Say what other members may use on the bot: --allow/);
  const minted = await mesh(hub, ["token", "home", "ci", "--allow", "shell"]);
  assert.equal(minted.code, 0, minted.output);
  assert.match(minted.stdout, /^cnsbot1:[A-Za-z0-9_-]+\n$/);
  assert.match(minted.stderr, /Token for ci \(fingerprint [a-z2-7-]+\), a member of home \(version 3\)\. Members may use there: shell\./);
  const token = minted.stdout.trim();
  // hub keeps the bot's public key only, and members learn of the bot from hub.
  assert.ok(!(await readFile(path.join(hub.dir, "peers", "ci"), "utf8")).includes(token.slice(20, 60)));
  await eventually("laptop saves the bot", () => has(laptop, "peers", "ci"));

  // On a machine with nothing of cns's, the token makes it the bot, which runs as a member.
  const bot = await devices.device("bot", { CNS_TOKEN: `"${token}"\r\n` });
  await devices.up(bot);
  assert.ok(has(bot, "meshes", "home") && has(bot, "peers", "laptop"));
  const ran = await devices.cli(bot, ["run", "laptop", "--", "echo", "from the bot"]);
  assert.equal(ran.code, 0, ran.output);
  assert.equal(ran.stdout, "from the bot\n");
  // laptop reaches the bot over the link the bot's daemon made, as far as the token allows.
  const control = await connectControl(laptop.state);
  try { await settledLink(control, "ci"); } finally { control.close(); }
  const back = await devices.cli(laptop, ["run", "ci", "--", "echo", "from laptop"]);
  assert.equal(back.code, 0, back.output);
  assert.equal(back.stdout, "from laptop\n");

  // The token works again on another new machine, and never on a device that is already one.
  const again = await devices.device("again", { CNS_TOKEN: token });
  const reused = await devices.cli(again, ["run", "laptop", "--", "echo", "again"]);
  assert.equal(reused.code, 0, reused.output);
  assert.equal(reused.stdout, "again\n");
  const taken = await devices.cli({ ...laptop, env: { ...laptop.env, CNS_TOKEN: token } }, ["peers"]);
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /CNS_TOKEN makes this machine a mesh bot, but it is already another device/);
  const garbled = await devices.cli({ ...again, env: { ...again.env, CNS_TOKEN: token.slice(0, -10) } }, ["peers"]);
  assert.match(garbled.stderr, /Invalid CNS_TOKEN.*incomplete or damaged/);
  const empty = await devices.device("empty", { CNS_TOKEN: "" });
  assert.match((await devices.cli(empty, ["mesh", "list"])).stderr, /CNS_TOKEN is set but empty/);
  assert.ok(!existsSync(path.join(empty.dir, "identity.json")));

  // A plain remove leaves the direct pairing on the admin; another member drops the old key.
  const removed = await mesh(hub, ["remove", "home", "ci"]);
  assert.equal(removed.code, 0, removed.output);
  assert.match(removed.stdout, /cns peer remove ci\b/);
  const collision = await mesh(hub, ["token", "home", "ci", "--allow", "shell"]);
  assert.equal(collision.code, 1);
  assert.match(collision.stderr, /still paired.*cns peer remove ci/);
  await eventually("laptop drops the bot", () => !has(laptop, "peers", "ci"));
  await eventually("the bot leaves the mesh", () => !has(bot, "meshes", "home"));
  const fresh = await devices.device("fresh", { CNS_TOKEN: token });
  const refused = await devices.cli(fresh, ["run", "laptop", "--", "true"]);
  assert.equal(refused.code, 3, refused.output);

  // Free the existing 1.7 pairing, then exercise single-command revocation with live links.
  const keyOf = async () => JSON.parse(await readFile(path.join(hub.dir, "peers", "ci"), "utf8")).publicKey as string;
  const oldKey = await keyOf();
  assert.equal((await devices.cli(hub, ["peer", "remove", "ci", "--state", hub.state])).code, 0);
  const replacement = await mesh(hub, ["token", "home", "ci", "--allow", "none"]);
  assert.equal(replacement.code, 0, replacement.stderr);
  const newKey = await keyOf();
  assert.notEqual(newKey, oldKey);
  const runner = await devices.device("replacement", { CNS_TOKEN: replacement.stdout.trim() });
  await devices.up(runner);
  const adminControl = await connectControl(hub.state);
  try {
    await settledLink(adminControl, "ci");
    const revoked = await mesh(hub, ["remove", "home", "ci", "--unpair"]);
    assert.equal(revoked.code, 0, revoked.output);
    assert.ok(!has(hub, "peers", "ci"));
    assert.ok(!(await adminControl.controller.peers()).some((entry) => entry.peer?.name === "ci"));
  } finally { adminControl.close(); }
  const reissued = await mesh(hub, ["token", "home", "ci", "--allow", "none"]);
  assert.equal(reissued.code, 0, reissued.stderr);
  assert.notEqual(await keyOf(), newKey);
});

test("unpairing on mesh removal will not break another mesh's pairing", async (t) => {
  const devices = await testDevices(t, "cns-mesh-unpair-");
  const hub = await devices.device("hub");
  const mesh = (...args: string[]) => devices.cli(hub, ["mesh", ...args, "--state", hub.state]);
  for (const name of ["home", "work"]) assert.equal((await mesh("create", name)).code, 0);
  assert.equal((await mesh("token", "home", "ci", "--allow", "none")).code, 0);
  assert.equal((await mesh("add", "work", "ci")).code, 0);
  const blocked = await mesh("remove", "home", "ci", "--unpair");
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /also listed in.*work/);
  assert.ok(existsSync(path.join(hub.dir, "peers", "ci")));
  // The failed command changed neither list. Dropping membership alone is still allowed.
  assert.equal((await mesh("remove", "home", "ci")).code, 0);
  assert.equal((await mesh("remove", "work", "ci", "--unpair")).code, 0);
  assert.equal((await mesh("token", "home", "ci", "--allow", "none")).code, 0);
});
