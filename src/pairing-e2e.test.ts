import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateIdentity } from "./identity.js";
import { savePairedPeer } from "./peers.js";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("two devices pair, run commands within their grants, and refuse everyone else", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-pairing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir };
  };
  const studio = await device("studio");
  const laptop = await device("laptop");
  const reader = await device("reader");
  const stranger = await device("stranger");
  const port = await unusedPort("127.0.0.1");
  const cli = async (dev: { env: Record<string, string> }, args: string[], input?: string) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end(input ?? "");
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };

  // Studio runs the paired daemon on loopback for this test.
  const up = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state]);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /^Started as [a-z2-7]{4}(-[a-z2-7]{4}){5} \(pid \d+\), listening at ws:\/\/127\.0\.0\.1:\d+\.\nReachable at ws:\/\/127\.0\.0\.1:\d+\.\nNo paired devices yet/);
  t.after(async () => { await cli(studio, ["stop", "--state", studio.state]); });
  const again = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state]);
  assert.match(again.stdout, /^Running as/);

  /** Studio prints an invite and waits; `other` pastes it. Returns both results. */
  async function pairWith(other: typeof laptop, studioArgs: string[], otherArgs: string[]) {
    const inviting = launchCli(t, ["pair", "--yes", "--state", studio.state, ...studioArgs], { env: studio.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    const accepting = await cli(other, ["pair", invite, "--yes", "--state", other.state, ...otherArgs]);
    const code = await inviting.exited;
    return { inviting: { code, stdout: inviting.stdout, stderr: inviting.stderr }, accepting };
  }

  // Laptop gets everything on studio and lets studio use its shell.
  const first = await pairWith(laptop, ["--name", "laptop"], ["--name", "studio", "--request", "all", "--offer", "shell"]);
  assert.equal(first.accepting.code, 0, first.accepting.stderr);
  assert.match(first.accepting.stdout, /^Paired with studio \([a-z2-7-]+\)\. This device may use its: shell, files, sessions\. It may use this device's: shell\.$/m);
  assert.equal(first.inviting.code, 0, first.inviting.stderr);
  assert.match(first.inviting.stdout, /Paired with laptop \([a-z2-7-]+\)\. It may use this machine's: shell, files, sessions\. This machine may use its: shell\./);
  const studioIdentity = JSON.parse((await cli(studio, ["identity", "--json"])).stdout);
  assert.match(first.accepting.stdout, new RegExp(studioIdentity.fingerprint));

  // Commands name the paired device and run within its grants.
  const run = await cli(laptop, ["run", "studio", "--", "printf ok; printf err >&2; exit 3"]);
  assert.deepEqual([run.code, run.stdout, run.stderr], [3, "ok", "err"]);
  const sessions = await cli(laptop, ["sessions", "studio", "--json"]);
  assert.deepEqual([sessions.code, JSON.parse(sessions.stdout)], [0, []]);
  const started = await cli(laptop, ["tty", "studio", "--name", "work", "--", "printf READY; sleep 30"]);
  assert.equal(started.code, 0, started.stderr);
  const screen = await cli(laptop, ["screen", "studio", "work", "--until", "READY"]);
  assert.deepEqual([screen.code, screen.stdout], [0, "READY\n"]);
  assert.equal((await cli(laptop, ["kill", "studio", "work"])).code, 0);
  assert.equal((await cli(laptop, ["run", "--peer", "studio", "--", "printf viaflag"])).stdout, "viaflag");

  // Both sides list the pairing; laptop has no daemon of its own, so studio sees it offline between commands.
  const laptopPeers = JSON.parse((await cli(laptop, ["peers", "--json", "--state", laptop.state])).stdout);
  assert.deepEqual(laptopPeers.map((peer: Record<string, unknown>) => [peer.name, peer.kind, peer.status, peer.access, peer.grants]),
    [["studio", "paired", "offline", ["shell", "files", "sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"], ["shell"]]]);
  const studioPeers = await cli(studio, ["peers", "--state", studio.state]);
  assert.match(studioPeers.stdout, /^NAME +STATUS +CONNECTION +ACCESS +FINGERPRINT\nlaptop +offline +- +shell +[a-z2-7-]+\n$/);
  assert.match((await cli(laptop, ["peer", "list"])).stdout, /^studio\t/);

  // A device granted only files cannot run commands, and the refusal has its own exit status.
  const second = await pairWith(reader, ["--name", "reader"], ["--name", "studio", "--request", "files", "--offer", ""]);
  assert.equal(second.accepting.code, 0, second.accepting.stderr);
  assert.match(second.inviting.stdout, /It may use this machine's: files\. This machine may use its: none\./);
  const denied = await cli(reader, ["run", "studio", "--", "printf x"]);
  assert.equal(denied.code, 4, denied.stderr);
  assert.match(denied.stderr, /Permission denied: shell not granted to reader/);
  assert.equal((await cli(reader, ["sessions", "studio"])).code, 4);

  // A device studio never paired with is refused before anything is exported, as is a legacy cns.
  process.env.CNS_CONFIG_DIR = stranger.dir;
  try { savePairedPeer("studio", { publicKey: studioIdentity.publicKey, addresses: [`ws://127.0.0.1:${port}`], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: ["shell"] } }); }
  finally { delete process.env.CNS_CONFIG_DIR; }
  const unpaired = await cli(stranger, ["run", "studio", "--", "printf x"]);
  assert.equal(unpaired.code, 3, unpaired.stderr);
  assert.match(unpaired.stderr, /Not paired with this device/);
  const legacy = await cli(stranger, ["run", `ws://127.0.0.1:${port}`, "--", "printf x"]);
  assert.notEqual(legacy.code, 0);
  assert.equal(legacy.stdout, "");

  // A changed identity behind a saved address is never accepted.
  const file = path.join(laptop.dir, "peers", "studio");
  const saved = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...saved, publicKey: generateIdentity().publicKey }));
  const changed = await cli(laptop, ["run", "studio", "--", "printf x"]);
  assert.equal(changed.code, 3, changed.stderr);
  assert.match(changed.stderr, /identity is not the one saved/);
  await writeFile(file, JSON.stringify(saved));
  assert.equal((await cli(laptop, ["run", "studio", "--", "printf back"])).stdout, "back");
});
