import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LinkMode } from "./auth.js";
import { connectControl } from "./commands/daemon.js";
import { GrantedShell } from "./granted-shell.js";
import { generateIdentity, type Identity, type PublicKey } from "./identity.js";
import { savePairedPeer, type LanCard, type Permission } from "./peers.js";
import { connectFirst, rpcSession, type SecureChannel } from "./secure.js";
import { ShellApi } from "./shell.js";
import { launchCli, testDevices, unusedPort } from "./test-support.js";
import { lanCards } from "./wake.js";

const posix = process.platform !== "win32";

test("daemons on a standing link tell each other where they are and what they grant, the one that grants its network cards too, and both save it", { skip: posix ? false : "daemons need POSIX state files", timeout: 60000 }, async (t) => {
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
  const saved = async (dir: string, name: string) => JSON.parse(await readFile(path.join(dir, "peers", name), "utf8")) as { addresses: string[]; grants: { incoming: string[]; outgoing: string[] }; lan?: unknown };
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
  // Laptop saves studio's network cards, for cns wake once studio sleeps: here they are this
  // machine's. Laptop grants studio nothing, so it tells studio none.
  for (const [dir, name, cards] of [[laptop.dir, "studio", lanCards()], [studio.dir, "laptop", []]] as const) {
    await eventually(async () => (await saved(dir, name)).lan !== undefined, `${name}'s network cards are saved`);
    assert.deepEqual((await saved(dir, name)).lan, cards);
  }
});

test("a daemon tells its network cards only over a standing link from a device it grants something, and saves only cards told right", { skip: posix ? false : "daemons need POSIX state files", timeout: 60000 }, async (t) => {
  const devices = await testDevices(t, "cns-lan-");
  const studio = await devices.device("studio");
  const studioKey = JSON.parse((await devices.cli(studio, ["identity", "--json"])).stdout).publicKey as PublicKey;
  const [laptop, reader, gateway] = [generateIdentity(), generateIdentity(), generateIdentity()];
  const gone = await unusedPort("127.0.0.1");
  const save = (name: string, publicKey: PublicKey, incoming: Permission[], gatewayRecord = false) => {
    process.env.CNS_CONFIG_DIR = studio.dir;
    try { savePairedPeer(name, { publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming, outgoing: [] }, ...gatewayRecord ? { gateway: true as const } : {} }); }
    finally { delete process.env.CNS_CONFIG_DIR; }
  };
  // Studio lets laptop and the gateway run commands, and reader nothing.
  save("laptop", laptop.publicKey, ["shell"]);
  save("reader", reader.publicKey, []);
  save("gw", gateway.publicKey, ["shell"], true);
  const port = await devices.up(studio);
  const saved = async (name: string) => JSON.parse(await readFile(path.join(studio.dir, "peers", name), "utf8")) as { addresses: string[]; lan?: unknown };
  const channels: SecureChannel[] = [];
  t.after(() => { for (const channel of channels) channel.close(); });
  /** Connect to studio as `identity`, telling it `cards` when asked; what studio says its cards are. */
  const cardsFrom = async (identity: Identity, mode: LinkMode, cards: unknown = []) => {
    const { channel } = await connectFirst([`ws://127.0.0.1:${port}`], identity, { expect: studioKey, mode });
    channels.push(channel);
    const here = new GrantedShell(new ShellApi(), [], "studio", null, () => [`ws://127.0.0.1:${gone}`], () => [], () => [], undefined, () => {}, () => cards as LanCard[]);
    return await rpcSession<GrantedShell>(channel, here).lan();
  };
  const eventually = async (check: () => Promise<boolean>, label: string) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    assert.fail(`Timed out: ${label}`);
  };

  // One command's connection learns none, even from a device granted the shell.
  assert.deepEqual(await cardsFrom(laptop, "client"), []);
  // Nor does a device granted nothing here, or the cns gateway, on a standing link.
  assert.deepEqual(await cardsFrom(reader, "daemon", [{ mac: "00:11:22:33:44:55; id", cidr: "192.168.9.9/24" }]), []);
  assert.deepEqual(await cardsFrom(gateway, "daemon"), []);
  // A daemon studio grants something is told them.
  assert.deepEqual(await cardsFrom(laptop, "daemon", [{ mac: "00:11:22:33:44:55", cidr: "192.168.9.9/24" }]), lanCards());
  // Studio saves where each daemon said it is, and only the cards that are cards: what reader
  // said is neither saved nor shown in studio's log.
  await eventually(async () => (await saved("reader")).addresses.length > 0 && (await saved("laptop")).lan !== undefined, "studio saves what reader and laptop said");
  assert.equal((await saved("reader")).lan, undefined);
  assert.deepEqual((await saved("laptop")).lan, [{ mac: "00:11:22:33:44:55", cidr: "192.168.9.9/24" }]);
  const logs = (await readdir(studio.dir)).filter((file) => file.startsWith("daemon.json.") && file.endsWith(".log"));
  const log = (await Promise.all(logs.map((file) => readFile(path.join(studio.dir, file), "utf8")))).join("");
  assert.match(log, /reader is reachable at /);
  assert.match(log, /laptop's network cards, for cns wake: 00:11:22:33:44:55 \(192\.168\.9\.9\/24\); saved\./);
  assert.doesNotMatch(log, /reader's network cards|; id/);
});
