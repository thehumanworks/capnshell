import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { savePairedPeer, type Permission } from "./peers.js";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("daemons on a standing link tell each other where they are and what they grant, and both save it", { skip: posix ? false : "daemons need POSIX state files", timeout: 60000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-exchange-")));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const cli = async (dir: string, args: string[]) => {
    const child = launchCli(t, args, { env: { CNS_CONFIG_DIR: dir, HOME: dir } });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    const identity = JSON.parse((await cli(dir, ["identity", "--json"])).stdout);
    return { dir, publicKey: identity.publicKey as string, state: path.join(dir, "daemon.json") };
  };
  const [studio, laptop] = [await device("studio"), await device("laptop")];
  const [studioPort, laptopPort, gone] = [await unusedPort("127.0.0.1"), await unusedPort("127.0.0.1"), await unusedPort("127.0.0.1")];
  const save = (dir: string, name: string, publicKey: string, addresses: string[], incoming: Permission[] = []) => {
    process.env.CNS_CONFIG_DIR = dir;
    try { savePairedPeer(name, { publicKey, addresses, pairedAt: new Date().toISOString(), grants: { incoming, outgoing: [] } }); }
    finally { delete process.env.CNS_CONFIG_DIR; }
  };
  // Laptop knows studio where it is now, a hostname someone added, and where it used to be.
  save(laptop.dir, "studio", studio.publicKey, [`ws://127.0.0.1:${studioPort}`, `ws://studio.invalid:${studioPort}`, `ws://127.0.0.2:${gone}`]);
  // Studio accepted a pairing that told it nothing about where laptop is, and later granted laptop its shell.
  save(studio.dir, "laptop", laptop.publicKey, [], ["shell"]);
  cleanups.push(async () => {
    await cli(laptop.dir, ["stop", "--state", laptop.state]);
    await cli(studio.dir, ["stop", "--state", studio.state]);
  });
  const saved = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, "peers", name), "utf8")) as { addresses: string[]; grants: { incoming: string[]; outgoing: string[] } };
  const record = async (dir: string, name: string) => (await saved(dir, name)).addresses;
  const eventually = async (check: () => Promise<boolean>, label: string, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    assert.fail(`Timed out: ${label}`);
  };

  assert.equal((await cli(studio.dir, ["up", "--bind", "127.0.0.1", "--port", studioPort, "--state", studio.state])).code, 0);
  assert.equal((await cli(laptop.dir, ["up", "--bind", "127.0.0.1", "--port", laptopPort, "--state", laptop.state])).code, 0);
  const links = async (state: string) => {
    const control = await connectControl(state);
    try { return (await control.controller.peers()).filter((peer) => peer.peer?.daemon).length; } finally { control.close(); }
  };
  await eventually(async () => await links(laptop.state) === 1 && await links(studio.state) === 1, "the link");

  // Studio learns where laptop listens, so it can dial laptop itself from now on.
  await eventually(async () => (await record(studio.dir, "laptop")).length > 0, "studio saves laptop's address");
  assert.deepEqual(await record(studio.dir, "laptop"), [`ws://127.0.0.1:${laptopPort}`]);
  // Laptop drops the address studio no longer listens at and keeps the hostname.
  await eventually(async () => (await record(laptop.dir, "studio")).length === 2, "laptop drops the stale address");
  assert.deepEqual(await record(laptop.dir, "studio"), [`ws://127.0.0.1:${studioPort}`, `ws://studio.invalid:${studioPort}`]);
  // Laptop's record shows the access studio grants it now, not the none it was saved with.
  await eventually(async () => (await saved(laptop.dir, "studio")).grants.outgoing.length === 1, "laptop saves its current access");
  assert.deepEqual((await saved(laptop.dir, "studio")).grants, { incoming: [], outgoing: ["shell"] });
  assert.deepEqual((await saved(studio.dir, "laptop")).grants, { incoming: ["shell"], outgoing: [] });
});
