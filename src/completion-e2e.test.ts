import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectControl } from "./commands/daemon.js";
import { LOOKUP_MS } from "./completion.js";
import { PERMISSIONS, savePairedPeer, type Permission } from "./peers.js";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

/**
 * Two devices with their own homes, so each daemon's state is at the default path where
 * completion looks for the link it borrows. Hooks stop the daemons, then remove the homes.
 */
async function devices(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-complete-")));
  const stops: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(root, { recursive: true, force: true }); });
  const cli = async (dev: { env: Record<string, string> }, args: string[]) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end();
    const started = performance.now();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, ms: performance.now() - started };
  };
  const device = async (name: string) => {
    // The home holds only hidden entries, so a listing of it shows what a test puts there.
    const dir = path.join(root, name);
    const config = path.join(dir, ".config-cns");
    await mkdir(config, { recursive: true, mode: 0o700 });
    const dev = { name, dir, config, env: { CNS_CONFIG_DIR: config, HOME: dir, SHELL: "/bin/bash" }, state: path.join(dir, ".cns", "daemon.json"), port: await unusedPort("127.0.0.1"), publicKey: "" };
    dev.publicKey = JSON.parse((await cli(dev, ["identity", "--json"])).stdout).publicKey;
    return dev;
  };
  type Device = Awaited<ReturnType<typeof device>>;
  const save = (dev: Device, name: string, publicKey: string, addresses: string[], outgoing: readonly Permission[] = PERMISSIONS) => {
    process.env.CNS_CONFIG_DIR = dev.config;
    try { savePairedPeer(name, { publicKey, addresses, pairedAt: new Date().toISOString(), grants: { incoming: [...PERMISSIONS], outgoing: [...outgoing] } }); }
    finally { delete process.env.CNS_CONFIG_DIR; }
  };
  const up = async (dev: Device) => {
    const result = await cli(dev, ["up", "--bind", "127.0.0.1", "--port", dev.port, "--state", dev.state]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    stops.push(() => cli(dev, ["stop", "--state", dev.state]));
  };
  /** What cns __complete prints, as lines, once it exits 0 having printed nothing on stderr. */
  const complete = async (dev: Device, words: string[]) => {
    const result = await cli(dev, ["__complete", ...words]);
    assert.deepEqual([result.code, result.stderr], [0, ""], words.join(" "));
    return { lines: result.stdout.split("\n").filter(Boolean), ms: result.ms };
  };
  return { cli, device, save, up, complete };
}

/** A TCP server that accepts connections and never answers, counting them. */
async function silent(t: TestContext) {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { port: (server.address() as net.AddressInfo).port, get connections() { return sockets.length; } };
}

test("sessions and paths complete through the local daemon's link, as far as the device grants", { skip: !posix, timeout: 120000 }, async (t) => {
  const { cli, device, save, up, complete } = await devices(t);
  const laptop = await device("laptop");
  const studio = await device("studio");
  save(laptop, "studio", studio.publicKey, [`ws://127.0.0.1:${studio.port}`]);
  save(studio, "laptop", laptop.publicKey, [`ws://127.0.0.1:${laptop.port}`]);
  await mkdir(path.join(studio.dir, "My Docs"));
  await writeFile(path.join(studio.dir, "notes.txt"), "notes");
  await writeFile(path.join(studio.dir, "bad\nname"), "x");
  await up(studio);
  await up(laptop);
  const deadline = Date.now() + 20000;
  for (;;) {
    const control = await connectControl(laptop.state);
    try { if ((await control.controller.peers()).some((peer) => peer.peer?.daemon && peer.peer.name === "studio")) break; }
    finally { control.close(); }
    assert.ok(Date.now() < deadline, "laptop links to studio");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "build", "--", "sleep 600"])).code, 0);

  assert.deepEqual((await complete(laptop, ["bash", "screen", "studio", ""])).lines, ["build"]);
  assert.deepEqual((await complete(laptop, ["zsh", "ui", "studio/b"])).lines, ["studio/build"]);
  assert.deepEqual((await complete(laptop, ["bash", "cp", "studio:"])).lines, ["studio:My\\ Docs/", "studio:notes.txt"]);
  assert.deepEqual((await complete(laptop, ["pwsh", "cp", "./x", "studio:~/M"])).lines, ["'studio:~/My Docs/'"]);
  assert.deepEqual((await complete(laptop, ["fish", "cp", `studio:${studio.dir}/no`])).lines, [`studio:${studio.dir}/notes.txt`]);

  // Without the files grant there, studio refuses the listing, and completion offers nothing, quietly.
  assert.equal((await cli(studio, ["peer", "revoke", "laptop", "files", "--state", studio.state])).code, 0);
  assert.deepEqual((await complete(laptop, ["bash", "cp", "studio:"])).lines, []);
  assert.deepEqual((await complete(laptop, ["bash", "screen", "studio", ""])).lines, ["build"]);
});

test("without a daemon, or with one that does not answer, completion offers the names here at once and dials nothing", { skip: !posix, timeout: 60000 }, async (t) => {
  const { device, save, complete } = await devices(t);
  const laptop = await device("laptop");
  const studio = await device("studio");
  // studio's saved address is a server that would see any dial.
  const listener = await silent(t);
  save(laptop, "studio", studio.publicKey, [`ws://127.0.0.1:${listener.port}`]);
  const local = await complete(laptop, ["bash", "run", "st"]);
  assert.deepEqual(local.lines, ["studio"]);
  assert.deepEqual((await complete(laptop, ["bash", "cp", "studio:"])).lines, []);
  assert.deepEqual((await complete(laptop, ["bash", "screen", "studio", ""])).lines, []);
  assert.equal(listener.connections, 0, "completion dialed studio");
  // Nor did it start a daemon.
  await assert.rejects(connectControl(path.join(laptop.dir, ".cns", "daemon.json"), 500));

  // A daemon whose control endpoint accepts and never answers holds completion up no longer than the deadline.
  const hung = await silent(t);
  await mkdir(path.join(laptop.dir, ".cns"), { mode: 0o700 });
  await writeFile(path.join(laptop.dir, ".cns", "daemon.json"), JSON.stringify({ version: 2, pid: process.pid, port: hung.port, host: "127.0.0.1", token: "0".repeat(64) }), { mode: 0o600 });
  const waited = await complete(laptop, ["bash", "cp", "studio:"]);
  assert.deepEqual(waited.lines, []);
  assert.equal(hung.connections, 1, "completion asked the daemon");
  assert.ok(waited.ms < local.ms + LOOKUP_MS + 1000, `completion took ${Math.round(waited.ms)} ms, ${Math.round(local.ms)} ms without a lookup`);
  assert.equal(listener.connections, 0, "completion dialed studio");
});
