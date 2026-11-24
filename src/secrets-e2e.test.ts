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

test("a secret is named without its mesh unless two hold the name, and commands here and on other devices run with secrets as variables", { skip: process.platform === "win32", timeout: 180000 }, async (t) => {
  const devices = await testDevices(t, "cns-secret-run-");
  const hub = await devices.device("hub");
  const laptop = await devices.device("laptop");
  for (const device of [hub, laptop]) await devices.up(device);
  await devices.pair(hub, laptop);
  const mesh = (device: TestDevice, args: string[]) => devices.cli(device, ["mesh", ...args, "--state", device.state]);
  const secret = (device: TestDevice, args: string[], input = "") => devices.cli(device, ["secret", ...args, ...["set", "rm"].includes(args[0]!) ? ["--state", device.state] : []], input);
  const fails = async (device: TestDevice, args: string[], message: RegExp) => {
    const result = await devices.cli(device, args);
    assert.equal(result.code, 1, result.output);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "");
  };
  assert.equal((await mesh(hub, ["create", "home"])).code, 0);
  assert.equal((await mesh(hub, ["add", "home", "laptop"])).code, 0);
  assert.equal((await mesh(laptop, ["join", "home", "--via", "hub"])).code, 0);

  // In one mesh, no command needs its name.
  await fails(laptop, ["secret", "run", "--", "true"], /This device holds no secrets to run the command with\./);
  const set = await secret(laptop, ["set", "API_KEY"], "sk-home\n");
  assert.equal(set.code, 0, set.output);
  assert.match(set.stdout, /Set API_KEY in the mesh home, readable by every member of home, now and later\./);
  for (const name of [["API_KEY"], ["home:API_KEY"], ["home", "API_KEY"]]) {
    const got = await secret(laptop, ["get", ...name]);
    assert.deepEqual([got.code, got.stdout, got.stderr], [0, "sk-home", ""]);
  }
  await fails(laptop, ["secret", "get", "MISSING"], /This device holds no secret MISSING\. cns secret list shows the ones here\./);
  await fails(laptop, ["secret", "get", "nowhere:API_KEY"], /This device has no mesh named nowhere\./);
  await fails(laptop, ["secret", "get", ":API_KEY"], /:API_KEY names no mesh before its colon\. Write MESH:NAME, such as home:API_KEY\./);
  await eventually("hub reads laptop's secret", async () => (await secret(hub, ["get", "API_KEY"])).stdout === "sk-home");

  // A second mesh: a new secret must say where it goes, and a name both hold must say which is meant.
  assert.equal((await mesh(laptop, ["create", "work"])).code, 0);
  const where = await secret(laptop, ["set", "TOKEN"], "t\n");
  assert.equal(where.code, 1);
  assert.match(where.stderr, /This device is in the meshes home and work\. Say which gets TOKEN: cns secret set home:TOKEN, or cns secret set work:TOKEN\./);
  assert.equal((await secret(laptop, ["set", "work:API_KEY"], "sk-work\n")).code, 0);
  assert.equal((await secret(laptop, ["set", "work:TOKEN"], "t-work\n")).code, 0);
  await fails(laptop, ["secret", "get", "API_KEY"], /API_KEY is in the meshes home and work\. Say which: cns secret get home:API_KEY, or cns secret get work:API_KEY\./);
  assert.equal((await secret(laptop, ["get", "work:API_KEY"])).stdout, "sk-work");
  assert.equal((await secret(laptop, ["get", "home:API_KEY"])).stdout, "sk-home");
  assert.equal((await secret(laptop, ["get", "TOKEN"])).stdout, "t-work");

  // secret run: every secret this device reads, or the ones --only names, or all but the ones --exclude names.
  const show = `printf '%s|%s' "\${API_KEY-unset}" "\${TOKEN-unset}"`;
  const run = (...args: string[]) => devices.cli(laptop, ["secret", "run", ...args]);
  await fails(laptop, ["secret", "run", "--", show], /API_KEY is in the meshes home and work, and the variable API_KEY holds one value\. Leave all but one out: --exclude home:API_KEY, or --exclude work:API_KEY\./);
  await fails(laptop, ["secret", "run", "--only", "API_KEY", "--", show], /Say which: --only home:API_KEY, or --only work:API_KEY\./);
  assert.deepEqual([(await run("--only", "TOKEN", "--", show)).stdout, (await run("--exclude", "work:API_KEY", "--", show)).stdout, (await run("--exclude", "API_KEY", "--", show)).stdout],
    ["unset|t-work", "sk-home|t-work", "unset|t-work"]);
  assert.equal((await run("--only", "work:API_KEY,TOKEN", "--", show)).stdout, "sk-work|t-work");
  assert.equal((await run("--only", "home:API_KEY", "--only", "TOKEN", "--", show)).stdout, "sk-home|t-work");
  // The command is the shell's, as with cns run: words are joined, its input and status are its own.
  const piped = await devices.cli(laptop, ["secret", "run", "--only", "TOKEN", "--", "read", "-r", "line;", "printf", "'%s:%s'", '"$line"', '"$TOKEN";', "exit", "7"], "typed\n");
  assert.deepEqual([piped.code, piped.stdout], [7, "typed:t-work"]);
  await fails(laptop, ["secret", "run", "--only", "NOPE", "--", "true"], /--only names NOPE, which this device does not hold\./);
  await fails(laptop, ["secret", "run", "--only", "TOKEN", "--exclude", "API_KEY", "--", "true"], /Use --only or --exclude, not both\./);
  await fails(laptop, ["secret", "run", "--only", "TOKEN", "true"], /secret run requires -- before its command: cns secret run -- command\./);
  // Any member can set a secret of any name. Without --only, one that tells programs what to run
  // stops the command when another device set it; one this device set, or named with --only, is set.
  assert.equal((await secret(hub, ["set", "home:BASH_ENV"], "/dev/null\n")).code, 0);
  assert.equal((await secret(laptop, ["set", "work:PAGER"], "cat\n")).code, 0);
  await eventually("laptop reads hub's secret", async () => (await secret(laptop, ["get", "BASH_ENV"])).stdout === "/dev/null");
  const steered = /hub set home:BASH_ENV, and the variable BASH_ENV tells programs what to run or where to connect, so it is set only when you name it\. Leave it out: --exclude home:BASH_ENV\. To set it, name what the command gets: --only home:BASH_ENV\./;
  await fails(laptop, ["secret", "run", "--exclude", "work:API_KEY", "--", show], steered);
  const names = `printf '%s|%s|%s' "\${BASH_ENV-unset}" "\${PAGER-unset}" "\${TOKEN-unset}"`;
  assert.equal((await run("--exclude", "work:API_KEY,home:BASH_ENV", "--", names)).stdout, "unset|cat|t-work");
  assert.equal((await run("--only", "BASH_ENV,TOKEN", "--", names)).stdout, "/dev/null|unset|t-work");
  assert.equal((await secret(hub, ["rm", "home:BASH_ENV"])).code, 0);
  await eventually("laptop drops hub's secret", async () => (await secret(laptop, ["get", "BASH_ENV"])).code === 1);
  // The secrets go to the command and stay out of this device's own environment.
  assert.equal((await devices.cli(laptop, ["run", "hub", "--", show])).stdout, "unset|unset");

  // --secret: a command on another device gets the secrets this device reads, whether or not that device is in their mesh.
  const remote = await devices.cli(laptop, ["run", "hub", "--secret", "TOKEN", "--secret", "home:API_KEY", "--", show]);
  assert.deepEqual([remote.code, remote.stdout, remote.stderr], [0, "sk-home|t-work", ""]);
  assert.equal((await devices.cli(laptop, ["run", "hub", "--secret", "work:API_KEY,TOKEN", "--", show])).stdout, "sk-work|t-work");
  await fails(laptop, ["run", "hub", "--secret", "API_KEY", "--", show], /API_KEY is in the meshes home and work\. Say which: --secret home:API_KEY, or --secret work:API_KEY\./);
  await fails(laptop, ["run", "hub", "--secret", "home:API_KEY,work:API_KEY", "--", show], /--secret names API_KEY in both home and work, and the variable API_KEY holds one value\./);
  await fails(laptop, ["run", "hub", "--secret", "NOPE", "--", show], /This device holds no secret NOPE\./);
  // A terminal's program gets them too, and a session keeps them without showing them in its listing.
  const terminal = await devices.cli(laptop, ["shell", "hub", "--secret", "TOKEN", "--", show], "");
  assert.deepEqual([terminal.code, terminal.stdout], [0, "unset|t-work"]);
  assert.equal((await devices.cli(laptop, ["shell", "hub", "--name", "kept", "--secret", "TOKEN", "--", `${show}; sleep 30`])).code, 0);
  const screen = await devices.cli(laptop, ["screen", "hub", "kept", "--until", "t-work"]);
  assert.deepEqual([screen.code, screen.stdout], [0, "unset|t-work\n"]);
  assert.ok(!(await devices.cli(laptop, ["sessions", "hub", "--json"])).stdout.includes("t-work"));
  await fails(laptop, ["shell", "hub", "--attach", "kept", "--secret", "TOKEN"], /--attach cannot change --secret; it was set when the session started\./);
  assert.equal((await devices.cli(laptop, ["kill", "hub", "kept"])).code, 0);

  // rm finds the mesh as get does.
  await fails(laptop, ["secret", "rm", "API_KEY", "--state", laptop.state], /API_KEY is in the meshes home and work\. Say which: cns secret rm home:API_KEY, or cns secret rm work:API_KEY\./);
  assert.equal((await secret(laptop, ["rm", "TOKEN"])).code, 0);
  await fails(laptop, ["secret", "get", "TOKEN"], /This device holds no secret TOKEN\./);
});
