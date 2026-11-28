import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makePrivateDirectory } from "./config.js";
import { generateIdentity, type Identity } from "./identity.js";
import { firstList, nextList, signList, type MemberList, type MeshState } from "./mesh.js";
import { heldSecrets, keepSecret, openSecret, pruneSecrets, sealSecret, secretsFor, takeSecrets, type SecretCopy } from "./secrets.js";
import { secureReady } from "./secure.js";

const admin = generateIdentity();
const laptop = generateIdentity();
const studio = generateIdentity();
const stranger = generateIdentity();
const NOW = Date.parse("2026-11-23T12:00:00Z");
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
const value = (words: string) => new TextEncoder().encode(words);

/** The mesh home with the admin, laptop and studio, or the members given, at `version`. */
function home(version = 2, members = [laptop, studio]): MeshState {
  let list: MemberList = firstList("home", { key: admin.publicKey, name: "admin" }, NOW);
  while (list.version < version) list = nextList(list, (current) => list.version === version - 1 ? [current[0]!, ...members.map((device, n) => ({ key: device.publicKey, name: `device${n}` }))] : current, NOW);
  return { name: "home", admin: admin.publicKey, allow: [], signed: signList(list, admin), list };
}

/** Each device keeps its secrets in a configuration directory of its own; `on` runs with one. */
async function devices(t: test.TestContext) {
  await secureReady();
  const root = await mkdtemp(path.join(os.tmpdir(), "cns-secrets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = new Map<Identity, string>();
  return function on<T>(device: Identity, use: () => T): T {
    if (!dirs.has(device)) { dirs.set(device, path.join(root, String(dirs.size))); makePrivateDirectory(dirs.get(device)!); }
    const saved = process.env.CNS_CONFIG_DIR;
    process.env.CNS_CONFIG_DIR = dirs.get(device)!;
    try { return use(); } finally { if (saved === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = saved; }
  };
}

const fields = (name: string, version: number, device?: Identity) => ({ mesh: "home", admin: admin.publicKey, name, ...device ? { device: device.publicKey } : {}, version, setAt: new Date(NOW).toISOString() });
/** What `device` reads for `name`, if it holds it and it has a value. */
const read = (device: Identity, states: MeshState[], name: string) => {
  const held = heldSecrets(device.publicKey, states).find(({ record }) => record.name === name && record.value);
  return held && text(openSecret(device, held));
};

test("a secret for the whole mesh reaches every member through any reader, only as its owner signed it", async (t) => {
  const on = await devices(t);
  const states = [home()];
  on(laptop, () => keepSecret(sealSecret(laptop, fields("API_KEY", 1), value("value one"))));
  assert.equal(on(laptop, () => read(laptop, states, "API_KEY")), "value one");
  // The file holds ciphertext only. A space never occurs in base64url, so the check cannot match by chance, as a bare "one" did in 1 run of about 2,000.
  const offered = on(laptop, () => secretsFor(studio.publicKey, laptop, states));
  assert.equal(offered.length, 1);
  assert.ok(!JSON.stringify(offered).includes("value one"));
  assert.deepEqual(on(laptop, () => secretsFor(stranger.publicKey, laptop, states)), []);
  assert.equal(on(studio, () => takeSecrets(laptop.publicKey, studio, states, offered)).length, 1);
  assert.equal(on(studio, () => read(studio, states, "API_KEY")), "value one");
  // studio, not its owner, seals it for the admin.
  const passed = on(studio, () => secretsFor(admin.publicKey, studio, states));
  assert.equal(on(admin, () => takeSecrets(studio.publicKey, admin, states, passed)).length, 1);
  assert.equal(on(admin, () => read(admin, states, "API_KEY")), "value one");
  // Nothing is taken twice, or from a device outside the mesh, or for a device outside it.
  assert.deepEqual(on(studio, () => takeSecrets(laptop.publicKey, studio, states, offered)), []);
  const fresh = generateIdentity();
  assert.deepEqual(on(fresh, () => takeSecrets(laptop.publicKey, fresh, states, on(laptop, () => secretsFor(studio.publicKey, laptop, states)))), []);

  // A newer version replaces it everywhere it goes; an older one never comes back.
  on(laptop, () => keepSecret(sealSecret(laptop, fields("API_KEY", 2), value("two"))));
  const newer = on(laptop, () => secretsFor(studio.publicKey, laptop, states));
  // Only a member passes secrets on, even a copy that would open.
  assert.deepEqual(on(studio, () => takeSecrets(stranger.publicKey, studio, states, newer)), []);
  assert.equal(on(studio, () => takeSecrets(laptop.publicKey, studio, states, newer)).length, 1);
  assert.equal(on(studio, () => read(studio, states, "API_KEY")), "two");
  assert.deepEqual(on(studio, () => takeSecrets(admin.publicKey, studio, states, passed)), []);
  assert.equal(on(studio, () => read(studio, states, "API_KEY")), "two");
});

test("a mesh's gateway is offered no secret, and none it offers or is named for is kept", async (t) => {
  const on = await devices(t);
  const gateway = generateIdentity();
  const plain = home();
  const list = nextList(plain.list, (members) => [...members, { key: gateway.publicKey, name: "gateway", gateway: true }], NOW);
  const states = [{ ...plain, signed: signList(list, admin), list }];
  on(laptop, () => keepSecret(sealSecret(laptop, fields("API_KEY", 1), value("one"))));
  assert.equal(on(laptop, () => secretsFor(studio.publicKey, laptop, states)).length, 1);
  assert.deepEqual(on(laptop, () => secretsFor(gateway.publicKey, laptop, states)), []);
  // A record the gateway signs, or one set for it alone, is kept by no member.
  const fromGateway = on(gateway, () => { keepSecret(sealSecret(gateway, fields("TOKEN", 1), value("x"))); return secretsFor(studio.publicKey, gateway, states); });
  assert.deepEqual(on(studio, () => takeSecrets(gateway.publicKey, studio, states, fromGateway)), []);
  on(laptop, () => keepSecret(sealSecret(laptop, fields("FOR_GATEWAY", 1, gateway), value("y"))));
  assert.deepEqual(on(laptop, () => heldSecrets(laptop.publicKey, states).map(({ record }) => record.name)), ["API_KEY"]);
});

test("a member keeps only what its owner signed, with a key that opens it", async (t) => {
  const on = await devices(t);
  const states = [home()];
  on(laptop, () => keepSecret(sealSecret(laptop, fields("API_KEY", 3), value("real"))));
  const [good] = on(laptop, () => secretsFor(studio.publicKey, laptop, states)) as [SecretCopy];
  const record = JSON.parse(good.text);
  // Changed text, a newer version nobody signed, or one signed by another member, is refused.
  const byAdmin = sealSecret(admin, fields("API_KEY", 9), value("admin's"));
  const forged = [
    { ...good, text: JSON.stringify({ ...record, version: 4 }) },
    { ...good, text: JSON.stringify({ ...record, setAt: new Date(NOW + 1).toISOString() }) },
    { ...byAdmin, text: JSON.stringify({ ...JSON.parse(byAdmin.text), owner: laptop.publicKey }) },
  ];
  assert.deepEqual(on(studio, () => takeSecrets(laptop.publicKey, studio, states, forged)), []);
  // A key sealed to someone else is refused, so the good copy that follows still counts.
  const misdirected = on(laptop, () => secretsFor(admin.publicKey, laptop, states));
  assert.deepEqual(on(studio, () => takeSecrets(laptop.publicKey, studio, states, misdirected)), []);
  assert.equal(on(studio, () => takeSecrets(laptop.publicKey, studio, states, [good])).length, 1);
  assert.equal(on(studio, () => read(studio, states, "API_KEY")), "real");
  // An owner outside the mesh counts for nothing.
  on(stranger, () => keepSecret(sealSecret(stranger, fields("OTHER", 1), value("x"))));
  const outside = on(stranger, () => heldSecrets(stranger.publicKey, states));
  assert.deepEqual(outside, []);
});

test("a secret for one member reaches only it and its owner", async (t) => {
  const on = await devices(t);
  const states = [home()];
  on(laptop, () => keepSecret(sealSecret(laptop, fields("DB_URL", 1, studio), value("studio's"))));
  assert.deepEqual(on(laptop, () => secretsFor(admin.publicKey, laptop, states)), []);
  const offered = on(laptop, () => secretsFor(studio.publicKey, laptop, states));
  assert.equal(on(studio, () => takeSecrets(laptop.publicKey, studio, states, offered)).length, 1);
  assert.equal(on(studio, () => read(studio, states, "DB_URL")), "studio's");
  // studio passes it to nobody else, and nobody else would keep it.
  assert.deepEqual(on(studio, () => secretsFor(admin.publicKey, studio, states)), []);
  assert.deepEqual(on(admin, () => takeSecrets(laptop.publicKey, admin, states, offered)), []);
});

test("a removed secret stays removed, and members drop the secrets of whoever leaves", async (t) => {
  const on = await devices(t);
  const states = [home()];
  on(laptop, () => {
    keepSecret(sealSecret(laptop, fields("API_KEY", 1), value("one")));
    keepSecret(sealSecret(laptop, fields("API_KEY", 2)));
  });
  const removal = on(laptop, () => secretsFor(studio.publicKey, laptop, states));
  assert.equal(removal[0]!.key, undefined);
  on(studio, () => takeSecrets(laptop.publicKey, studio, states, removal));
  assert.equal(on(studio, () => read(studio, states, "API_KEY")), undefined);
  // The removal outranks the old value, which an out-of-date member might still offer.
  const old = sealSecret(laptop, fields("API_KEY", 1), value("one"));
  on(admin, () => keepSecret(old));
  assert.deepEqual(on(studio, () => takeSecrets(admin.publicKey, studio, states, on(admin, () => secretsFor(studio.publicKey, admin, states)))), []);

  // studio keeps a secret of laptop's until the admin's list drops laptop.
  on(laptop, () => keepSecret(sealSecret(laptop, fields("TOKEN", 1), value("t"))));
  on(studio, () => takeSecrets(laptop.publicKey, studio, states, on(laptop, () => secretsFor(studio.publicKey, laptop, states))));
  assert.equal(on(studio, () => read(studio, states, "TOKEN")), "t");
  const without = [home(3, [studio])];
  assert.ok(on(studio, () => pruneSecrets(studio.publicKey, without)) >= 1);
  assert.equal(on(studio, () => read(studio, states, "TOKEN")), undefined);
  // A device that leaves the mesh keeps none of it.
  assert.ok(on(admin, () => heldSecrets(admin.publicKey, states).length) > 0);
  on(admin, () => pruneSecrets(admin.publicKey, []));
  assert.equal(on(admin, () => heldSecrets(admin.publicKey, states).length), 0);
});
