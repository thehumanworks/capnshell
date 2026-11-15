import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { suggestedName } from "./pairing.js";
import { RefusingShell } from "./refusing-shell.js";
import { connectSecure, rpcSession } from "./secure.js";
import { launchCli, testDevices } from "./test-support.js";
import { decodeToken } from "./tokens.js";

test("a program with a token reaches the device that made it, within its grants, until it expires or is revoked", { skip: process.platform === "win32", timeout: 90000 }, async (t) => {
  const devices = await testDevices(t, "cns-tokens-");
  const studio = await devices.device("studio");
  await devices.up(studio);
  // The token calls the device by the name the device suggests for itself, as an invite does.
  const name = suggestedName(os.hostname());

  // Making a token names what it may use, and prints only the token on stdout.
  const unnamed = await devices.cli(studio, ["token", "create", "ci", "--state", studio.state]);
  assert.equal(unnamed.code, 2);
  assert.match(unnamed.stderr, /Say what the token may use here: --grant/);
  const created = await devices.cli(studio, ["token", "create", "ci", "--grant", "shell", "--expires", "90d", "--state", studio.state]);
  assert.equal(created.code, 0, created.output);
  assert.match(created.stdout, /^cnst1:[A-Za-z0-9_-]+\n$/);
  assert.match(created.stderr, /Token ci \(fingerprint [a-z2-7-]+\)\. It may use this machine's: shell\. It expires on \d{4}-\d\d-\d\d\./);
  assert.match(created.stderr, new RegExp(`cns run ${name} -- hostname`));
  const token = created.stdout.trim();
  // The device saved only the token's public key, as a paired device that is a token.
  const record = JSON.parse(await readFile(path.join(studio.dir, "peers", "ci"), "utf8"));
  assert.equal(record.grants.incoming.join(), "shell");
  assert.ok(record.token.expiresAt);
  assert.ok(!JSON.stringify(record).includes(token.slice(6, 40)));
  const again = await devices.cli(studio, ["token", "create", "ci", "--grant", "shell", "--state", studio.state]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already named ci/);

  // The headless machine has no identity, no pairing and no daemon; nothing is written there.
  const bot = await devices.device("bot");
  const home = { ...bot.env, CNS_CONFIG_DIR: path.join(bot.dir, ".cns"), CNS_TOKEN: token };
  const cli = async (args: string[], env: Record<string, string> = home) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };
  const ran = await cli(["run", name, "--", "echo", "hello from the token"]);
  assert.equal(ran.code, 0, ran.output);
  assert.equal(ran.stdout, "hello from the token\n");
  // The same token, used by several programs at once.
  const together = await Promise.all([1, 2, 3].map((n) => cli(["run", name, "--", "echo", String(n)])));
  assert.deepEqual(together.map((result) => [result.code, result.stdout]), [[0, "1\n"], [0, "2\n"], [0, "3\n"]]);
  // Nothing of cns's, that is (Bun, running cns from source, may keep a cache in the home directory).
  const written = async () => (await readdir(bot.dir)).filter((entry) => entry !== ".bun");
  assert.deepEqual(await written(), []);

  // A token that claims to be a daemon's standing link is taken as one program's connection.
  const decoded = decodeToken(token);
  const { channel } = await connectSecure(decoded.device.addresses[0]!, decoded.identity, { expect: decoded.device.publicKey, mode: "daemon" });
  const remote = rpcSession(channel, new RefusingShell());
  const control = await connectControl(studio.state);
  try {
    let seen: Array<{ peer?: { name: string; daemon: boolean } }> = [];
    for (let tries = 0; tries < 100 && !seen.some((peer) => peer.peer?.name === "ci"); tries++) {
      seen = await control.controller.peers();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(seen.filter((peer) => peer.peer?.name === "ci").map((peer) => peer.peer?.daemon), [false]);
  } finally {
    control.close();
    remote[Symbol.dispose]();
    channel.close();
  }

  // What it was not granted is refused, with the command to grant it on the device.
  const copy = await cli(["cp", `${name}:${path.join(studio.dir, "daemon.json")}`, path.join(os.tmpdir(), "cns-token-copy")]);
  assert.equal(copy.code, 4, copy.output);
  assert.match(copy.stderr, new RegExp(`files not granted to ci\\. To allow it, run on ${name}: cns peer grant ci files`));

  // A name no token is for, and a token that is not one, are usage errors.
  const elsewhere = await cli(["run", "beelink", "--", "true"]);
  assert.equal(elsewhere.code, 2);
  assert.match(elsewhere.stderr, new RegExp(`CNS_TOKEN reaches ${name}, not beelink`));
  const garbled = await cli(["run", name, "--", "true"], { ...home, CNS_TOKEN: token.slice(0, -8) });
  assert.equal(garbled.code, 2);
  assert.match(garbled.stderr, /CNS_TOKEN is not a cns token/);

  // The device lists tokens apart from the devices it pairs with.
  const listed = JSON.parse((await devices.cli(studio, ["token", "list", "--json"])).stdout);
  assert.deepEqual(listed.map((entry: { name: string; grants: string[]; expired: boolean }) => [entry.name, entry.grants, entry.expired]), [["ci", ["shell"], false]]);
  assert.deepEqual(JSON.parse((await devices.cli(studio, ["peers", "--json"])).stdout), []);

  // A connection that is open when the token expires ends then.
  const recordPath = path.join(studio.dir, "peers", "ci");
  const expireAt = async (when: number) => writeFile(recordPath, JSON.stringify({ ...record, token: { expiresAt: new Date(when).toISOString() } }, null, 2) + "\n", { mode: 0o600 });
  await expireAt(Date.now() + 4000);
  const started = Date.now();
  const long = await cli(["run", name, "--", "sleep", "30"]);
  assert.notEqual(long.code, 0, long.output);
  assert.ok(Date.now() - started < 20000, `ran for ${Date.now() - started} ms`);
  // After that, the device refuses it at once.
  const expired = await cli(["run", name, "--", "true"]);
  assert.equal(expired.code, 3, expired.output);
  assert.match(expired.stderr, new RegExp(`${name} refused this token: it has expired\\. On ${name}, make a new one: cns token create`));
  const shown = await devices.cli(studio, ["token", "list"]);
  assert.match(shown.stdout, /^ci +shell +\d{4}-\d\d-\d\d \(expired\) /m);

  // Revoked, it is refused, and the device forgets it.
  await expireAt(Date.now() + 86_400_000);
  assert.equal((await cli(["run", name, "--", "true"])).code, 0);
  const notToken = await devices.cli(studio, ["token", "revoke", "nobody", "--state", studio.state]);
  assert.equal(notToken.code, 2);
  const revoked = await devices.cli(studio, ["token", "revoke", "ci", "--state", studio.state]);
  assert.equal(revoked.code, 0, revoked.output);
  assert.match(revoked.stdout, /^Revoked ci\./);
  const refused = await cli(["run", name, "--", "true"]);
  assert.equal(refused.code, 3, refused.output);
  assert.match(refused.stderr, new RegExp(`${name} does not accept this token: it was revoked`));
  assert.deepEqual(JSON.parse((await devices.cli(studio, ["token", "list", "--json"])).stdout), []);
  assert.deepEqual(await written(), []);
});
