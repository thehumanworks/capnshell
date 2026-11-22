import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stopDaemon } from "./commands/daemon.js";
import { testDevices, unusedPort } from "./test-support.js";

// Run this against each release binary as well as from source. No relay, pre-existing identities or real tokens.
test("a token from stdout starts the right bot via CNS_TOKEN or an explicit file, even behind an environment-setting launcher", { timeout: 90000 }, async (t) => {
  const devices = await testDevices(t, "cns-token-cli-");
  const hub = await devices.device("admin");
  const create = await devices.cli(hub, ["mesh", "create", "home", "--state", hub.state]);
  assert.equal(create.code, 0, create.stderr);
  const mint = await devices.cli(hub, ["mesh", "token", "home", "ci", "--allow", "none", "--state", hub.state]);
  assert.equal(mint.code, 0, mint.stderr);
  const publicKey = JSON.parse(await readFile(path.join(hub.dir, "peers", "ci"), "utf8")).publicKey;
  const file = path.join(devices.root, "bot.token");
  await writeFile(file, mint.stdout, { mode: 0o600, flag: "wx" });
  const fromFile = (await readFile(file, "utf8")).trimEnd(); // Like POSIX command substitution for the token line.
  for (const explicit of [false, true]) {
    // A Mise shim with a configured CNS_TOKEN can replace even an inline environment assignment.
    const bot = await devices.device(explicit ? "via-file" : "via-env", { CNS_TOKEN: explicit ? "overridden-by-launcher" : fromFile });
    try {
      const started = await devices.cli(bot, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", bot.state, ...explicit ? ["--token-file", file] : []]);
      assert.equal(started.code, 0, started.stderr);
      assert.equal(JSON.parse(await readFile(path.join(bot.dir, "identity.json"), "utf8")).publicKey, publicKey);
    } finally { if (existsSync(bot.state)) await stopDaemon(bot.state); }
  }

  // An explicit file is authoritative: never silently start using the env token if the file is bad.
  const fresh = await devices.device("fresh", { CNS_TOKEN: fromFile });
  const checkFile = (name: string) => devices.cli(fresh, ["--token-file", name, "mesh", "list"]);
  const missing = await checkFile(path.join(devices.root, "missing.token"));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Cannot read --token-file/);
  await writeFile(file, "cnsbot1:a-broken-token");
  const bad = await checkFile(file);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Invalid token file.*incomplete or damaged/);
  assert.ok(!bad.stderr.includes("a-broken-token"));
  assert.match((await checkFile(devices.root)).stderr, /regular file|Cannot read --token-file/);
  await writeFile(file, "x".repeat(64 * 1024 + 1));
  assert.match((await checkFile(file)).stderr, /token file is too long/);
  assert.ok(!existsSync(path.join(fresh.dir, "identity.json")));
});
