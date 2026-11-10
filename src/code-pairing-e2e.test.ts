import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startRelay } from "./relay-server.js";
import { launchCli, unusedPort } from "./test-support.js";
import { WORDS } from "./words.js";

const posix = process.platform !== "win32";

test("devices pair by typing a short code, after a wrong one, through the relay", { skip: !posix, timeout: 120000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-code-")));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const external = process.env.CNS_TEST_RELAY_URL;
  const relayPort = Number(await unusedPort("127.0.0.1"));
  const relay = external ? undefined : startRelay({ bind: "127.0.0.1", port: relayPort });
  cleanups.push(async () => relay?.stop());
  const relayBase = external ?? `ws://127.0.0.1:${relayPort}`;
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir, CNS_RELAY: relayBase }, state: path.join(dir, ".cns", "daemon.json"), dir };
  };
  const studio = await device("studio");
  const laptop = await device("laptop");
  const cli = async (dev: { env: Record<string, string> }, args: string[]) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };

  const up = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", studio.state]);
  assert.equal(up.code, 0, up.stderr);
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));

  const inviting = launchCli(t, ["pair", "--yes", "--name", "laptop", "--grant", "all", "--state", studio.state], { env: studio.env });
  inviting.child.stdin.end();
  await inviting.waitFor("Waiting for it (the code works once and expires in 5 minutes)");
  const code = /Code: (\d+-[a-z]+-[a-z]+-[a-z]+)\n/.exec(inviting.stdout)![1]!;
  assert.match(inviting.stderr, new RegExp(`On the other device, run: cns pair ${code}\\n`));
  assert.doesNotMatch(inviting.output, /cns1:/, "the long invite is not shown");
  const [room, ...words] = code.split("-");

  // A wrong word costs a try, and both sides say so.
  const other = WORDS.find((word) => !words.includes(word))!;
  const wrong = await cli(laptop, ["pair", room!, words[0]!, words[1]!, other, "--yes", "--name", "studio"]);
  assert.equal(wrong.code, 3, wrong.stderr);
  assert.match(wrong.stderr, /The code is wrong\. Check the words on the other device and try again \(2 tries left\)\./);
  await inviting.waitFor("A device typed a wrong code (1 of 3 tries).");
  // A word that is not on the list is refused before anything is sent: no try is used.
  const typo = await cli(laptop, ["pair", `${room}-${words[0]}-${words[1]}-qqqq`, "--yes", "--name", "studio"]);
  assert.equal(typo.code, 3);
  assert.match(typo.stderr, /"qqqq" is not a word cns uses/);
  assert.doesNotMatch(inviting.output, /2 of 3 tries/);

  // The right code, typed with spaces and four letters per word.
  const paired = await cli(laptop, ["pair", room!, ...words.map((word) => word.slice(0, 4).toUpperCase()), "--yes", "--name", "studio", "--request", "all"]);
  assert.equal(paired.code, 0, paired.stderr);
  assert.match(paired.stdout, /Paired with studio /);
  assert.equal(await inviting.exited, 0, inviting.stderr);
  assert.match(inviting.stdout, /Paired with laptop /);
  const record = JSON.parse(await readFile(path.join(laptop.dir, "peers", "studio"), "utf8"));
  assert.deepEqual(record.grants.outgoing.length > 0, true);
  const run = await cli(laptop, ["run", "studio", "--", "printf by-code"]);
  assert.deepEqual([run.code, run.stdout], [0, "by-code"], run.stderr);

  // The code worked once.
  const again = await cli(laptop, ["pair", code, "--yes", "--name", "studio-2"]);
  assert.equal(again.code, 3);
  assert.match(again.stderr, /No device is showing code/);
});

test("three wrong codes end the pairing on the inviting device", { skip: !posix, timeout: 120000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-code-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relayPort = Number(await unusedPort("127.0.0.1"));
  const relay = startRelay({ bind: "127.0.0.1", port: relayPort });
  t.after(() => relay.stop());
  const env = (name: string) => ({ CNS_CONFIG_DIR: path.join(root, name), HOME: path.join(root, name), CNS_RELAY: `ws://127.0.0.1:${relayPort}` });
  for (const name of ["studio", "laptop"]) await mkdir(path.join(root, name), { mode: 0o700 });
  const state = path.join(root, "studio", ".cns", "daemon.json");
  const upped = launchCli(t, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", state], { env: env("studio") });
  upped.child.stdin.end();
  assert.equal(await upped.exited, 0, upped.stderr);
  t.after(async () => { const stop = launchCli(t, ["stop", "--state", state], { env: env("studio") }); stop.child.stdin.end(); await stop.exited; });
  const inviting = launchCli(t, ["pair", "--yes", "--state", state], { env: env("studio") });
  inviting.child.stdin.end();
  await inviting.waitFor("Code: ");
  const [room, ...words] = /Code: (\d+-[a-z]+-[a-z]+-[a-z]+)\n/.exec(inviting.stdout)![1]!.split("-");
  const other = WORDS.find((word) => !words.includes(word))!;
  for (let tries = 1; tries <= 3; tries++) {
    const wrong = launchCli(t, ["pair", room!, other, words[1]!, words[2]!, "--yes"], { env: env("laptop") });
    wrong.child.stdin.end();
    assert.equal(await wrong.exited, 3, wrong.stderr);
  }
  assert.equal(await inviting.exited, 3, inviting.output);
  assert.match(inviting.stderr, /The code was typed wrong 3 times, so it no longer works\. Run cns pair again/);
});

test("without the relay, a code cannot be exchanged and cns pair says what to do instead", { skip: !posix }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-code-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = launchCli(t, ["pair", "12-orbit-canyon-velvet", "--yes"], { env: { CNS_CONFIG_DIR: root, HOME: root, CNS_RELAY: "off" } });
  child.child.stdin.end();
  assert.equal(await child.exited, 1);
  assert.match(child.stderr, /Pairing codes go through the relay, which is off here \(CNS_RELAY=off\)\. Run cns pair --long on the other device/);
});
