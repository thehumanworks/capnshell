import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { testDevices, type TestDevice } from "./test-support.js";

/** Wait until `check` holds, as secrets take a moment to reach every daemon. */
async function eventually(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test("mesh secrets reach the members that may read them, set once on any member, and leave with them", { skip: process.platform === "win32", timeout: 180000 }, async (t) => {
  const devices = await testDevices(t, "cns-secrets-");
  const hub = await devices.device("hub");
  const laptop = await devices.device("laptop");
  const studio = await devices.device("studio");
  for (const device of [hub, laptop, studio]) await devices.up(device);
  await devices.pair(hub, laptop);
  await devices.pair(hub, studio);
  const mesh = (device: TestDevice, args: string[]) => devices.cli(device, ["mesh", ...args, "--state", device.state]);
  const secret = (device: TestDevice, args: string[], input = "") => devices.cli(device, ["secret", ...args, ...["set", "rm"].includes(args[0]!) ? ["--state", device.state] : []], input);
  const reads = async (device: TestDevice, args: string[], expected: string) => {
    const got = await secret(device, ["get", "home", ...args]);
    return got.code === 0 && got.stdout === expected;
  };
  assert.equal((await mesh(hub, ["create", "home"])).code, 0);
  assert.equal((await mesh(hub, ["add", "home", "laptop", "studio"])).code, 0);
  assert.equal((await mesh(laptop, ["join", "home", "--via", "hub"])).code, 0);

  // A value is never an argument; it comes from stdin here, less its final line break.
  const inArgs = await secret(laptop, ["set", "home", "API_KEY", "sk-oops"]);
  assert.notEqual(inArgs.code, 0);
  const set = await secret(laptop, ["set", "home", "API_KEY"], "sk-one\n");
  assert.equal(set.code, 0, set.output);
  assert.match(set.stdout, /Set API_KEY in the mesh home, readable by every member of home, now and later\./);
  await eventually("hub reads laptop's secret", () => reads(hub, ["API_KEY"], "sk-one"));
  // Every copy on disk is encrypted.
  for (const device of [laptop, hub]) {
    for (const file of readdirSync(path.join(device.dir, "secrets"))) assert.ok(!readFileSync(path.join(device.dir, "secrets", file), "utf8").includes("sk-one"));
  }

  // studio joins while laptop is off: hub, a reader, seals it for studio.
  assert.equal((await devices.cli(laptop, ["stop", "--state", laptop.state])).code, 0);
  assert.equal((await mesh(studio, ["join", "home", "--via", "hub"])).code, 0);
  await eventually("studio, which joined later, reads it", () => reads(studio, ["API_KEY"], "sk-one"));

  // Only the device that set a secret changes it.
  const taken = await secret(hub, ["set", "home", "API_KEY"], "sk-hub\n");
  assert.equal(taken.code, 1);
  assert.match(taken.stderr, /API_KEY in home was set by laptop, and only laptop changes it\. On laptop, run: cns secret set home API_KEY/);

  // A secret for studio alone comes before the mesh's on studio, and reaches nobody else.
  assert.equal((await secret(hub, ["set", "home", "DB_URL"], "postgres://all\n")).code, 0);
  const forStudio = await secret(hub, ["set", "home", "DB_URL", "--device", "studio"], "postgres://studio");
  assert.equal(forStudio.code, 0, forStudio.output);
  assert.match(forStudio.stdout, /readable by studio and this device only/);
  await eventually("studio reads its own DB_URL", () => reads(studio, ["DB_URL"], "postgres://studio"));
  assert.ok(await reads(studio, ["DB_URL", "--device", "studio"], "postgres://studio"));
  assert.ok(await reads(hub, ["DB_URL"], "postgres://all"));
  assert.ok(await reads(hub, ["DB_URL", "--device", "studio"], "postgres://studio"));
  const unknown = await secret(hub, ["get", "home", "DB_URL", "--device", "nobody"]);
  assert.match(unknown.stderr, /nobody is not a member of the mesh home/);

  // A change reaches studio; list shows names, never values.
  assert.equal((await secret(hub, ["set", "home", "DB_URL", "--device", "studio"], "postgres://studio-2\n")).code, 0);
  await eventually("studio reads the new value", () => reads(studio, ["DB_URL"], "postgres://studio-2"));
  const listed = await secret(studio, ["list", "home", "--json"]);
  assert.ok(!listed.stdout.includes("postgres") && !listed.stdout.includes("sk-one"));
  assert.deepEqual(JSON.parse(listed.stdout).map((row: { name: string; for: string | null; setBy: string }) => [row.name, row.for, row.setBy]),
    [["API_KEY", null, "laptop"], ["DB_URL", null, "hub"], ["DB_URL", "this device", "hub"]]);

  // Removing studio's own falls back to the mesh's; removing studio from the mesh takes all.
  assert.equal((await secret(hub, ["rm", "home", "DB_URL", "--device", "studio"])).code, 0);
  await eventually("studio falls back to the mesh's DB_URL", () => reads(studio, ["DB_URL"], "postgres://all"));
  assert.equal((await mesh(hub, ["remove", "home", "studio"])).code, 0);
  await eventually("studio drops the mesh's secrets", () => !existsSync(path.join(studio.dir, "meshes", "home")) && readdirSync(path.join(studio.dir, "secrets")).length === 0);
  const gone = await secret(studio, ["get", "home", "API_KEY"]);
  assert.match(gone.stderr, /This device has no mesh named home/);
});
