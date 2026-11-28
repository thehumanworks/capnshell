import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectControl } from "./commands/daemon.js";
import { CNS_VERSION } from "./version.js";
import { cliInvocation, fakeSystemctl, testDevices } from "./test-support.js";

// These run cns upgrade against real daemons, with stand-ins for mise and for the cns it installs:
// a script that runs this cns. The stand-ins are sh scripts, so not on Windows.

/** The pid of the daemon at `state`, and whether a service manager runs it. */
async function daemonAt(state: string): Promise<{ pid: number; service: boolean }> {
  const control = await connectControl(state);
  try { const { pid, service } = await control.remote.status(); return { pid, service: service === true }; } finally { control.close(); }
}

/** The daemon at `state` once another than `old` answers there; fails if none does. */
async function replaced(state: string, old: number, log: () => Promise<string>) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try { const now = await daemonAt(state); if (now.pid !== old) return now; } catch { /* Between the two daemons. */ }
    if (Date.now() > deadline) throw new Error(`No daemon came back. The restart's log:\n${await log()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One word for sh. */
const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
/** This cns as a command: its executable, and its script when it runs from source. */
const self = () => { const { file, args } = cliInvocation([]); return [file, ...args]; };
const escaped = CNS_VERSION.replaceAll(".", "\\.");

async function script(file: string, body: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/**
 * A device whose daemon runs, as far as cns upgrade can tell, a cns that mise installed: the cns on
 * its PATH says so, and its mise "installs cns 99.0.0", which is this cns under a mise path. The
 * releases URL it returns, for CNS_RELEASES, names 99.0.0 as the latest release.
 */
async function miseDevice(t: TestContext, devices: Awaited<ReturnType<typeof testDevices>>, name: string) {
  const tools = path.join(devices.root, `${name}-tools`);
  const bin = path.join(tools, "bin");
  const installs = path.join(tools, "mise", "installs", "github-thehumanworks-capnshell");
  const fresh = await script(path.join(installs, "99.0.0", "cns"), `exec ${self().map(sh).join(" ")} "$@"`);
  const miseLog = path.join(tools, "mise.log");
  await writeFile(miseLog, "");
  await script(path.join(bin, "cns"), `echo ${sh(JSON.stringify({ version: "2.7.0", daemon: { version: CNS_VERSION, executable: path.join(installs, "2.7.0", "cns"), sessions: [] } }))}`);
  await script(path.join(bin, "mise"), `echo "$*" >> ${sh(miseLog)}\ncase "$1" in\n  --version) echo 2026.11.3 ;;\n  use) ;;\n  which) echo ${sh(fresh)} ;;\n  *) exit 2 ;;\nesac`);
  // XDG_CONFIG_HOME: a unit goes where cns and the stand-in for systemctl look, never into this user's own systemd.
  const device = await devices.device(name, { PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(devices.root, name, ".config") });
  // The state path cns uses by default, as the commands that run there do.
  device.state = path.join(device.dir, ".cns", "daemon.json");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ tag_name: "v99.0.0" }) });
  t.after(() => server.stop(true));
  const log = async () => { try { return await readFile(path.join(device.dir, ".cns", "restart.log"), "utf8"); } catch (error) { return String(error); } };
  return { device, tools, bin, miseLog, log, releases: `http://127.0.0.1:${server.port}/releases/latest` };
}

test("cns upgrade --all upgrades a device through mise and restarts its daemon, and names the device it cannot reach", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-");
  const { device: studio, miseLog, log, releases } = await miseDevice(t, devices, "studio");
  const pi = await devices.device("pi");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  await devices.up(pi);
  await devices.pair(pi, laptop);
  assert.equal((await devices.cli(pi, ["stop", "--state", pi.state])).code, 0);
  const asks = { ...laptop, env: { ...laptop.env, CNS_RELEASES: releases } };
  const before = await daemonAt(studio.state);

  // The plan reads what each device runs and changes nothing.
  const plan = await devices.cli(asks, ["upgrade", "--all", "--dry-run"]);
  assert.equal(plan.code, 1, plan.output);
  assert.match(plan.stderr, /^Checking pi, studio against cns 99\.0\.0, the latest release\./);
  // Each device's line comes as soon as it is known, so in no set order.
  assert.equal(plan.stdout.split("\n").length, 3, plan.stdout);
  assert.match(plan.stdout, /^pi: unreachable \(Cannot connect to pi: .*\)\. Later, run cns upgrade pi$/m);
  assert.match(plan.stdout, new RegExp(`^studio: would upgrade from ${escaped} to 99\\.0\\.0: mise use -g github:thehumanworks/capnshell@99\\.0\\.0, which pins that version in mise's global config there, then cns up --install from the new cns if a service runs the old one, else cns daemon restart$`, "m"));
  assert.equal(await readFile(miseLog, "utf8"), "--version\n");
  assert.equal((await daemonAt(studio.state)).pid, before.pid);

  const upgraded = await devices.cli(asks, ["upgrade", "--all"]);
  assert.equal(upgraded.code, 1, `${upgraded.output}\nThe restart's log:\n${await log()}`);
  assert.equal(upgraded.stdout.split("\n").length, 3, upgraded.stdout);
  assert.match(upgraded.stdout, /^pi: unreachable \(Cannot connect to pi: .*\)\. Later, run cns upgrade pi$/m);
  // The "cns 99.0.0" mise installed is this cns, so the daemon comes back with this version, as another process.
  assert.match(upgraded.stdout, new RegExp(`^studio: upgraded from ${escaped} to ${escaped}$`, "m"));
  assert.equal(await readFile(miseLog, "utf8"), "--version\nuse -g github:thehumanworks/capnshell@99.0.0\nwhich cns --tool github:thehumanworks/capnshell@99.0.0\n");
  const after = await replaced(studio.state, before.pid, log);
  assert.equal(after.service, false, "a daemon cns up started is started again the same way");
  assert.match(await log(), new RegExp(`Restarted the daemon \\(pid ${after.pid}\\)`));
  const again = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(again.code, 0, again.output);
});

test("a paired device's cns up --install hands the restart to a process of its own, and cns upgrade moves a service onto the new cns", { skip: process.platform !== "linux", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-service-");
  const { device: studio, tools, bin, log, releases } = await miseDevice(t, devices, "studio");
  await fakeSystemctl(bin);
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  const unitPath = path.join(studio.dir, ".config", "systemd", "user", "cns.service");
  const before = await daemonAt(studio.state);
  assert.equal(before.service, false);

  // It runs under the daemon it replaces: stopping that daemon itself would end it before the
  // service existed, and leave studio without a daemon.
  const installed = await devices.cli(laptop, ["run", "studio", "--", [...self(), "up", "--install"].map(sh).join(" ")]);
  assert.equal(installed.code, 0, `${installed.output}\nThe restart's log:\n${await log()}`);
  assert.match(installed.stdout, /^Restarting the daemon through its systemd user service in a moment\./);
  const service = await replaced(studio.state, before.pid, log);
  assert.equal(service.service, true, "the service runs the daemon now");

  // As after mise installed a new cns: the unit still names the old one, at a path of its own.
  const old = await script(path.join(tools, "old-cns"), `exec ${self().map(sh).join(" ")} "$@"`);
  const command = self().map((word) => `"${word}"`).join(" ");
  const unit = await readFile(unitPath, "utf8");
  assert.ok(unit.includes(`ExecStart=${command} "daemon" "--service"`), unit);
  await writeFile(unitPath, unit.replace(`ExecStart=${command}`, `ExecStart="${old}"`));

  const upgraded = await devices.cli({ ...laptop, env: { ...laptop.env, CNS_RELEASES: releases } }, ["upgrade", "studio"]);
  assert.equal(upgraded.code, 0, `${upgraded.output}\nThe restart's log:\n${await log()}`);
  assert.equal(upgraded.stdout, `studio: upgraded from ${CNS_VERSION} to ${CNS_VERSION}\n`);
  const after = await replaced(studio.state, service.pid, log);
  assert.equal(after.service, true);
  // cns up --install from the new cns wrote the unit for that cns, which runs as this one.
  const rewritten = await readFile(unitPath, "utf8");
  assert.ok(!rewritten.includes(old), rewritten);
  assert.ok(rewritten.includes(`ExecStart=${command} "daemon" "--service"`), rewritten);
  const again = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(again.code, 0, again.output);
});

test("cns status --json names the named sessions its daemon runs, which cns upgrade leaves alone without --end-sessions", { timeout: 60000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-sessions-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  const sessions = async () => {
    const status = await devices.cli(studio, ["status", "--json", "--state", studio.state]);
    assert.equal(status.code, 0, status.output);
    return (JSON.parse(status.stdout) as { daemon: { sessions: string[] } }).daemon.sessions;
  };
  assert.deepEqual(await sessions(), []);
  const started = await devices.cli(laptop, ["shell", "studio", "--name", "build", "--", "sleep 300"]);
  assert.equal(started.code, 0, started.output);
  assert.deepEqual(await sessions(), ["build"]);
});

test("cns peers names a device behind the latest release, learned at most once a day, and exits 0 whether GitHub answers or not", { timeout: 60000 }, async (t) => {
  const devices = await testDevices(t, "cns-peers-release-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.up(laptop);
  await devices.pair(studio, laptop);
  let status = 200;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ tag_name: "v99.0.0" }, { status }) });
  t.after(() => server.stop(true));
  const asks = { ...laptop, env: { ...laptop.env, CNS_RELEASES: `http://127.0.0.1:${server.port}/releases/latest` } };
  const peers = () => devices.cli(asks, ["peers", "--state", laptop.state]);
  for (const deadline = Date.now() + 20000; !/\nstudio +online/.test((await peers()).stdout); await new Promise((resolve) => setTimeout(resolve, 200))) {
    if (Date.now() > deadline) assert.fail("laptop's daemon never linked to studio");
  }
  const behind = `Older cns than the latest release, 99.0.0: studio (${CNS_VERSION}). cns upgrade studio upgrades it; add --dry-run to see how first.\nThis device runs cns ${CNS_VERSION}, older than the latest release, 99.0.0.`;
  const served = await peers();
  assert.equal(served.code, 0, served.output);
  assert.ok(served.stderr.includes(behind), served.stderr);

  // GitHub fails now, but laptop learned the release today.
  status = 500;
  const remembered = await peers();
  assert.equal(remembered.code, 0, remembered.output);
  assert.ok(remembered.stderr.includes(behind), remembered.stderr);

  // A day on, GitHub still fails: nothing is said of the release, and cns peers still lists the devices.
  await writeFile(path.join(laptop.dir, "latest-release.json"), JSON.stringify({ version: "99.0.0", checkedAt: Date.now() - 25 * 60 * 60_000 }));
  const failing = await peers();
  assert.equal(failing.code, 0, failing.output);
  assert.doesNotMatch(failing.stderr, /latest release|Older cns/);
  assert.match(failing.stdout, /\nstudio +online/);
});
