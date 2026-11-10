import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectControl } from "./commands/daemon.js";
import { PERMISSIONS, savePairedPeer } from "./peers.js";
import { startRelay } from "./relay-server.js";
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();
/** Nothing listens here, so dialing it fails at once. */
const DEAD = "ws://127.0.0.1:1";

/**
 * Two devices with their own homes, paired by writing their records, and their daemons'
 * state at the default path, where commands such as cns run look for a daemon to lend
 * them its link. Hooks stop the daemons and then remove the directories.
 */
async function devices(t: TestContext, prefix: string, env: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const cli = async (dev: { env: Record<string, string> }, args: string[], input = "") => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end(input);
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    const dev = { name, dir, env: { CNS_CONFIG_DIR: dir, HOME: dir, SHELL: "/bin/bash", ...env }, state: path.join(dir, ".cns", "daemon.json"), port: await unusedPort("127.0.0.1"), publicKey: "" };
    dev.publicKey = JSON.parse((await cli(dev, ["identity", "--json"])).stdout).publicKey;
    return dev;
  };
  type Device = Awaited<ReturnType<typeof device>>;
  const save = (dev: Device, other: Device, addresses: string[]) => {
    process.env.CNS_CONFIG_DIR = dev.dir;
    try { savePairedPeer(other.name, { publicKey: other.publicKey, addresses, pairedAt: new Date().toISOString(), grants: { incoming: [...PERMISSIONS], outgoing: [...PERMISSIONS] } }); }
    finally { delete process.env.CNS_CONFIG_DIR; }
  };
  const setAddresses = async (dev: Device, other: Device, addresses: string[]) => {
    const file = path.join(dev.dir, "peers", other.name);
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), addresses }), { mode: 0o600 });
  };
  const up = async (dev: Device) => {
    const result = await cli(dev, ["up", "--bind", "127.0.0.1", "--port", dev.port, "--state", dev.state]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    cleanups.push(() => cli(dev, ["stop", "--state", dev.state]));
  };
  /** The daemon's standing links to `other`: how each runs. */
  const links = async (dev: Device, other: Device) => {
    const control = await connectControl(dev.state);
    try { return (await control.controller.peers()).filter((peer) => peer.peer?.daemon && peer.peer.name === other.name).map((peer) => peer.peer!.via); }
    finally { control.close(); }
  };
  const eventually = async (check: () => Promise<boolean>, label: string, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    assert.fail(`Timed out: ${label}`);
  };
  return { root, cli, device, save, setAddresses, up, links, eventually, cleanups };
}

test("commands reach a device that cannot be dialed over the link it dialed to this device's daemon", { skip: !posix, timeout: 120000 }, async (t) => {
  const { cli, device, save, setAddresses, up, links, eventually } = await devices(t, "cns-lent-");
  // wsl stands for a device in WSL: its host drops inbound connections, while its own dials out work.
  const studio = await device("studio");
  const wsl = await device("wsl");
  save(studio, wsl, [DEAD]);
  save(wsl, studio, [`ws://127.0.0.1:${studio.port}`]);
  await up(studio);
  await up(wsl);
  await eventually(async () => (await links(studio, wsl)).join() === "direct", "wsl links to studio");
  // Over the link, studio learns where wsl listens; make that unreachable again, as WSL's host does.
  await eventually(async () => (await readFile(path.join(studio.dir, "peers", "wsl"), "utf8")).includes(`:${wsl.port}`), "studio learns wsl's address");
  await setAddresses(studio, wsl, [DEAD]);

  // Commands use the daemon's link: there is nothing else that reaches wsl.
  const run = await cli(studio, ["run", "wsl", "--", "printf lent"]);
  assert.deepEqual([run.code, run.stdout], [0, "lent"], run.stderr);
  const piped = await cli(studio, ["run", "wsl", "--", "tr a-z A-Z"], "piped input");
  assert.deepEqual([piped.code, piped.stdout], [0, "PIPED INPUT"], piped.stderr);
  assert.equal((await cli(studio, ["run", "wsl", "--", "exit 7"])).code, 7);
  assert.equal((await cli(studio, ["sessions", "wsl"])).code, 0);

  // A command that stops ends its work on wsl, as it does on a connection of its own.
  const marker = path.join(wsl.dir, "still-running");
  const cancelled = launchCli(t, ["run", "wsl", "--", `echo started; sleep 2; touch ${marker}`], { env: studio.env });
  cancelled.child.stdin.end();
  await cancelled.waitFor("started");
  cancelled.child.kill("SIGTERM");
  await cancelled.exited;
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(existsSync(marker), false, "the command was killed on wsl");
  assert.deepEqual(await links(studio, wsl), ["direct"], "the link outlives the command");

  // cns tty at a terminal attaches through the link too, and two terminals get a shell each.
  const inTerminal = () => {
    const invocation = cliInvocation(["tty", "wsl"]);
    let screen = "";
    let notify = () => {};
    const terminal = Bun.spawn([invocation.file, ...invocation.args], {
      env: cliEnvironment(studio.env) as Record<string, string>,
      terminal: { cols: 100, rows: 30, name: "xterm-256color", data: (_terminal, data) => { screen += decoder.decode(data, { stream: true }); notify(); } },
    });
    t.after(() => { if (terminal.exitCode === null) terminal.kill(); });
    return {
      write: (text: string) => terminal.terminal!.write(text),
      exited: terminal.exited,
      get screen() { return screen; },
      waitFor: (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Waiting for ${JSON.stringify(needle)} in ${JSON.stringify(screen.slice(-600))}`)), 15000);
        notify = () => { if (screen.indexOf(needle, from) >= 0) { clearTimeout(timer); resolve(); } };
        notify();
      }),
    };
  };
  const [one, two] = [inTerminal(), inTerminal()];
  await Promise.all([one.waitFor("connected to wsl via this device's daemon (directly)"), two.waitFor("connected to wsl via this device's daemon (directly)")]);
  const [nameOne, nameTwo] = [one, two].map((terminal) => /as session (tty-\d+)/.exec(terminal.screen)?.[1]);
  assert.deepEqual([nameOne, nameTwo].sort(), ["tty-1", "tty-2"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const [fromOne, fromTwo] = [one.screen.length, two.screen.length];
  one.write("echo $((6 * 7))\r");
  two.write("echo $((6 * 8))\r");
  await Promise.all([one.waitFor("42", fromOne), two.waitFor("48", fromTwo)]);
  assert.doesNotMatch(two.screen.slice(fromTwo), /42/);
  one.write("\x1d");
  two.write("exit\r");
  assert.deepEqual([await one.exited, await two.exited], [0, 0]);
  const listed = await cli(studio, ["sessions", "wsl", "--json"]);
  assert.deepEqual((JSON.parse(listed.stdout) as Array<{ name: string }>).map((session) => session.name), [nameOne], "the exited terminal's session is gone, the detached one runs");

  // The link ends while a command runs: the command ends too, rather than waiting on it.
  const running = launchCli(t, ["run", "wsl", "--", "echo started; sleep 30"], { env: studio.env });
  running.child.stdin.end();
  await running.waitFor("started");
  const stopped = Date.now();
  assert.equal((await cli(wsl, ["stop", "--state", wsl.state])).code, 0);
  assert.notEqual(await running.exited, 0);
  assert.ok(Date.now() - stopped < 10000, "the command ended with the link");
  // Without the link, nothing reaches wsl: the commands above all used it.
  const offline = await cli(studio, ["run", "wsl", "--", "true"]);
  assert.notEqual(offline.code, 0);
  assert.match(offline.stderr, /Cannot connect to wsl/);
});

test("a standing link through the relay gives way to a direct one that one of the devices can dial", { skip: !posix, timeout: 120000 }, async (t) => {
  const relayPort = await unusedPort("127.0.0.1");
  const relay = startRelay({ bind: "127.0.0.1", port: Number(relayPort) });
  const { cli, device, save, setAddresses, up, links, eventually, cleanups } = await devices(t, "cns-upgrade-", { CNS_RELAY: `ws://127.0.0.1:${relayPort}` });
  cleanups.push(() => relay.stop());
  const studio = await device("studio");
  const wsl = await device("wsl");
  // Neither can dial the other directly at first, so they link through the relay.
  save(studio, wsl, [DEAD]);
  save(wsl, studio, [DEAD]);
  await up(studio);
  await up(wsl);
  await eventually(async () => (await links(studio, wsl)).join() === "relay" && (await links(wsl, studio)).join() === "relay", "a link through the relay");
  // Over it, each learns where the other listens. Only wsl can use that, as from WSL.
  await eventually(async () => (await readFile(path.join(studio.dir, "peers", "wsl"), "utf8")).includes(`:${wsl.port}`), "studio learns wsl's address");
  await setAddresses(studio, wsl, [DEAD]);
  await eventually(async () => (await readFile(path.join(wsl.dir, "peers", "studio"), "utf8")).includes(`:${studio.port}`), "wsl learns studio's address");

  // wsl's daemon dials studio directly, and both replace the relayed link with that one.
  await eventually(async () => (await links(studio, wsl)).join() === "direct" && (await links(wsl, studio)).join() === "direct", "the link becomes direct", 60000);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.deepEqual([await links(studio, wsl), await links(wsl, studio)], [["direct"], ["direct"]], "one direct link stays");
  const run = await cli(studio, ["run", "wsl", "--", "printf upgraded"]);
  assert.deepEqual([run.code, run.stdout], [0, "upgraded"], run.stderr);
});
