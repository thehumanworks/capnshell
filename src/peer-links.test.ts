import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { savePairedPeer } from "./peers.js";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("a daemon whose peer restarted after losing the link silently links again", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-links-")));
  // Hooks run in the order they were added: stop the daemons first, then remove their directories.
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
  // The smaller key keeps the link it dials when both dial at once; it is the side that can hold a stale one.
  let [small, large] = [await device("a"), await device("b")];
  if (!(small.publicKey < large.publicKey)) [small, large] = [large, small];
  const [smallPort, largePort, proxyPort] = [await unusedPort("127.0.0.1"), await unusedPort("127.0.0.1"), await unusedPort("127.0.0.1")];
  const save = (dir: string, name: string, publicKey: string, addresses: string[]) => {
    process.env.CNS_CONFIG_DIR = dir;
    try { savePairedPeer(name, { publicKey, addresses, pairedAt: new Date().toISOString(), grants: { incoming: ["shell"], outgoing: ["shell"] } }); }
    finally { delete process.env.CNS_CONFIG_DIR; }
  };
  // Small reaches large through a proxy that can drop traffic without closing anything.
  save(small.dir, "large", large.publicKey, [`ws://127.0.0.1:${proxyPort}`]);
  save(large.dir, "small", small.publicKey, []);
  let blackhole = false;
  const pairs: Array<{ client: net.Socket; upstream: net.Socket }> = [];
  const proxy = net.createServer((client) => {
    const upstream = net.connect(Number(largePort), "127.0.0.1");
    pairs.push({ client, upstream });
    client.on("data", (data) => { if (!blackhole) upstream.write(data); });
    upstream.on("data", (data) => { if (!blackhole) client.write(data); });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => { if (!blackhole) client.destroy(); });
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((resolve) => proxy.listen(Number(proxyPort), "127.0.0.1", resolve));
  cleanups.push(async () => {
    await cli(large.dir, ["stop", "--state", large.state]);
    await cli(small.dir, ["stop", "--state", small.state]);
    for (const pair of pairs) { pair.client.destroy(); pair.upstream.destroy(); }
    proxy.close();
  });
  const links = async (dev: typeof small) => {
    const control = await connectControl(dev.state);
    try { return (await control.controller.peers()).filter((peer) => peer.peer?.daemon).length; } finally { control.close(); }
  };
  const eventually = async (check: () => Promise<boolean>, label: string, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    assert.fail(`Timed out: ${label}`);
  };

  assert.equal((await cli(large.dir, ["up", "--bind", "127.0.0.1", "--port", largePort, "--state", large.state])).code, 0);
  assert.equal((await cli(small.dir, ["up", "--bind", "127.0.0.1", "--port", smallPort, "--state", small.state])).code, 0);
  await eventually(async () => await links(small) === 1 && await links(large) === 1, "the first link");

  // Large learns small's address, then loses its end of the link without small seeing a close.
  const file = path.join(large.dir, "peers", "small");
  await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), addresses: [`ws://127.0.0.1:${smallPort}`] }), { mode: 0o600 });
  blackhole = true;
  for (const pair of pairs) pair.upstream.destroy();
  assert.equal((await cli(large.dir, ["stop", "--state", large.state])).code, 0);
  assert.equal(await links(small), 1, "small still holds the dead link");

  // Large restarts and dials small directly; small replaces the link it can no longer use.
  assert.equal((await cli(large.dir, ["up", "--bind", "127.0.0.1", "--port", largePort, "--state", large.state])).code, 0);
  await eventually(async () => await links(large) === 1 && await links(small) === 1, "large links again");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual([await links(small), await links(large)], [1, 1], "the new link stays single");
});
