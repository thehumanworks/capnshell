import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectControl } from "./commands/daemon.js";
import { HOLDERS } from "./held-sessions.js";
import { CNS_VERSION } from "./version.js";
import { cliInvocation, cnsAs, fakeSystemctl, testDevices } from "./test-support.js";

// These run cns upgrade against real daemons. The device's daemon starts on an older cns, a copy of
// this source that says it is 2.7.0; stand-ins play mise, and the cns mise installs is this one. The
// stand-ins are sh scripts, so not on Windows.

/** The pid and version of the daemon at `state`, and whether a service manager runs it. */
async function daemonAt(state: string): Promise<{ pid: number; version?: string; service: boolean }> {
  const control = await connectControl(state);
  try { const { pid, version, service } = await control.remote.status(); return { pid, ...version ? { version } : {}, service: service === true }; } finally { control.close(); }
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
 * A device whose daemon, once started with `old`, runs cns 2.7.0 that mise installed as `tool`, as
 * far as cns upgrade can tell: the cns on its PATH says so, mise lists it there and says it comes
 * from github:thehumanworks/capnshell, and its mise "installs" this cns as the latest release,
 * which the releases URL it returns, for CNS_RELEASES, names. `daemon` is what that cns says of its
 * daemon's named sessions.
 */
async function miseDevice(t: TestContext, devices: Awaited<ReturnType<typeof testDevices>>, name: string, { tool = "github:thehumanworks/capnshell", daemon = { sessions: [] } }: { tool?: string; daemon?: object } = {}) {
  const tools = path.join(devices.root, `${name}-tools`);
  const bin = path.join(tools, "bin");
  // As mise names the directory: installs/github-thehumanworks-capnshell, or installs/cns for a [tool_alias] cns.
  const installs = path.join(tools, "mise", "installs", tool.replaceAll(/[:/]/g, "-"));
  const old = await cnsAs(devices.root, "2.7.0");
  const fresh = await script(path.join(installs, CNS_VERSION, "cns"), `exec ${self().map(sh).join(" ")} "$@"`);
  const miseLog = path.join(tools, "mise.log");
  await writeFile(miseLog, "");
  await script(path.join(bin, "cns"), `echo ${sh(JSON.stringify({ version: "2.7.0", daemon: { version: "2.7.0", executable: path.join(installs, "2.7.0", "cns"), ...daemon } }))}`);
  // What mise 2026.11.14 prints for these, cut to what cns reads.
  const source = { type: "mise.toml", path: path.join(devices.root, name, ".config", "mise", "config.toml") };
  const listing = { [tool]: [{ version: "2.7.0", requested_version: "2.7.0", install_path: path.join(installs, "2.7.0"), source, installed: true, active: true }] };
  await script(path.join(bin, "mise"), [
    `echo "$*" >> ${sh(miseLog)}`,
    `case "$1" in`,
    `  --version) echo '2026.11.14 linux-x64 (2026-11-24)' ;;`,
    `  ls) echo ${sh(JSON.stringify(listing, null, 2))} ;;`,
    `  tool) [ "$2" = ${sh(tool)} ] || exit 1; echo '{ "backend": "github:thehumanworks/capnshell" }' ;;`,
    `  use) ;;`,
    `  which) echo ${sh(fresh)} ;;`,
    `  *) exit 2 ;;`,
    `esac`,
  ].join("\n"));
  // XDG_CONFIG_HOME: a unit goes where cns and the stand-in for systemctl look, never into this user's own systemd.
  const device = await devices.device(name, { PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: path.join(devices.root, name, ".config") });
  // The state path cns uses by default, as the commands that run there do.
  device.state = path.join(device.dir, ".cns", "daemon.json");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ tag_name: `v${CNS_VERSION}` }) });
  t.after(() => server.stop(true));
  const log = async () => { try { return await readFile(path.join(device.dir, ".cns", "restart.log"), "utf8"); } catch (error) { return String(error); } };
  return { device, old, bin, miseLog, log, releases: `http://127.0.0.1:${server.port}/releases/latest` };
}

test("cns upgrade --all upgrades a device through mise and restarts its daemon, and names the device it cannot reach", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-");
  const { device: studio, old, miseLog, log, releases } = await miseDevice(t, devices, "studio");
  const pi = await devices.device("pi");
  const laptop = await devices.device("laptop");
  await devices.up(studio, undefined, old);
  await devices.pair(studio, laptop);
  await devices.up(pi);
  await devices.pair(pi, laptop);
  assert.equal((await devices.cli(pi, ["stop", "--state", pi.state])).code, 0);
  const asks = { ...laptop, env: { ...laptop.env, CNS_RELEASES: releases } };
  const before = await daemonAt(studio.state);
  assert.equal(before.version, "2.7.0");
  // cns upgrade asks GitHub every time: what cns peers learned today does not count.
  const cache = path.join(laptop.dir, "latest-release.json");
  await writeFile(cache, JSON.stringify({ version: "1.0.0", checkedAt: Date.now() }));

  // The plan reads what each device runs and changes nothing.
  const plan = await devices.cli(asks, ["upgrade", "--all", "--dry-run"]);
  assert.equal(plan.code, 1, plan.output);
  assert.match(plan.stderr, new RegExp(`^Checking pi, studio against cns ${escaped}, the latest release\\.`));
  // Each device's line comes as soon as it is known, so in no set order.
  assert.equal(plan.stdout.split("\n").length, 3, plan.stdout);
  assert.match(plan.stdout, /^pi: unreachable \(Cannot connect to pi: .*\)\. Later, run cns upgrade pi$/m);
  assert.match(plan.stdout, new RegExp(`^studio: would upgrade from 2\\.7\\.0 to ${escaped}: mise use -g github:thehumanworks/capnshell@${escaped}, which pins that version in mise's global config there, then cns up --install from the new cns if a service runs the old one, else cns daemon restart, which ends any open shells$`, "m"));
  const asked = "--version\nls --installed --json\ntool github:thehumanworks/capnshell --json\n";
  assert.equal(await readFile(miseLog, "utf8"), asked);
  assert.equal((await daemonAt(studio.state)).pid, before.pid);
  assert.equal(JSON.parse(await readFile(cache, "utf8")).version, CNS_VERSION);

  const upgraded = await devices.cli(asks, ["upgrade", "--all"]);
  assert.equal(upgraded.code, 1, `${upgraded.output}\nThe restart's log:\n${await log()}`);
  assert.equal(upgraded.stdout.split("\n").length, 3, upgraded.stdout);
  assert.match(upgraded.stdout, /^pi: unreachable \(Cannot connect to pi: .*\)\. Later, run cns upgrade pi$/m);
  assert.match(upgraded.stdout, new RegExp(`^studio: upgraded from 2\\.7\\.0 to ${escaped}$`, "m"));
  assert.equal(await readFile(miseLog, "utf8"), `${asked}${asked}use -g github:thehumanworks/capnshell@${CNS_VERSION}\nwhich cns --tool github:thehumanworks/capnshell@${CNS_VERSION}\n`);
  const after = await replaced(studio.state, before.pid, log);
  assert.equal(after.version, CNS_VERSION);
  assert.equal(after.service, false, "a daemon cns up started is started again the same way");
  assert.match(await log(), new RegExp(`Restarted the daemon \\(pid ${after.pid}\\)`));
  const again = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(again.code, 0, again.output);
});

test("a paired device's cns up --install hands the restart to a process of its own, and cns upgrade moves the service onto the new cns, through a mise tool alias", { skip: process.platform !== "linux", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-service-");
  // [tool_alias] cns = "github:thehumanworks/capnshell" in mise's config there.
  const { device: studio, old, bin, miseLog, log, releases } = await miseDevice(t, devices, "studio", { tool: "cns" });
  await fakeSystemctl(bin);
  const laptop = await devices.device("laptop");
  await devices.up(studio, undefined, old);
  await devices.pair(studio, laptop);
  const unitPath = path.join(studio.dir, ".config", "systemd", "user", "cns.service");
  const before = await daemonAt(studio.state);
  assert.equal(before.service, false);

  // The old cns installs its service. It runs under the daemon it replaces: stopping that daemon
  // itself would end it before the service existed, and leave studio without a daemon.
  const installed = await devices.cli(laptop, ["run", "studio", "--", [...old, "up", "--install"].map(sh).join(" ")]);
  assert.equal(installed.code, 0, `${installed.output}\nThe restart's log:\n${await log()}`);
  assert.match(installed.stdout, /^Restarting the daemon through its systemd user service in a moment\./);
  const service = await replaced(studio.state, before.pid, log);
  assert.deepEqual([service.service, service.version], [true, "2.7.0"], "the service runs the old cns now");
  // The worker was told the service's file changed, which launchd needs to load it again.
  assert.match(await log(), /^Restarting the daemon \(pid \d+\) from its service's new file\.$/m);
  assert.ok((await readFile(unitPath, "utf8")).includes(old[1]!));

  const upgraded = await devices.cli({ ...laptop, env: { ...laptop.env, CNS_RELEASES: releases } }, ["upgrade", "studio"]);
  assert.equal(upgraded.code, 0, `${upgraded.output}\nThe restart's log:\n${await log()}`);
  assert.equal(upgraded.stdout, `studio: upgraded from 2.7.0 to ${CNS_VERSION}\n`);
  // By the alias, so that mise moves the alias's version rather than adding github:thehumanworks/capnshell beside it.
  assert.equal(await readFile(miseLog, "utf8"), `--version\nls --installed --json\ntool cns --json\nuse -g cns@${CNS_VERSION}\nwhich cns --tool cns@${CNS_VERSION}\n`);
  const after = await replaced(studio.state, service.pid, log);
  assert.deepEqual([after.service, after.version], [true, CNS_VERSION]);
  assert.match(await log(), /^Restarting the daemon \(pid \d+\) from its service's new file\.$/m);
  // cns up --install from the new cns wrote the unit for that cns, which runs as this one.
  const rewritten = await readFile(unitPath, "utf8");
  assert.ok(!rewritten.includes(old[1]!), rewritten);
  assert.ok(rewritten.includes(`ExecStart=${self().map((word) => `"${word}"`).join(" ")} "daemon" "--service"`), rewritten);
  const again = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(again.code, 0, again.output);
});

test("cns upgrade restarts a daemon whose named sessions outlive it, and the session runs on with its pid", { skip: !HOLDERS, timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-upgrade-kept-");
  const { device: studio, old, log, releases } = await miseDevice(t, devices, "studio", { daemon: { sessions: ["build"], keepsSessions: true } });
  const laptop = await devices.device("laptop");
  await devices.up(studio, undefined, old);
  await devices.pair(studio, laptop);
  const started = await devices.cli(laptop, ["shell", "studio", "--name", "build", "--", "sleep 300"]);
  assert.equal(started.code, 0, started.output);
  const listed = async () => JSON.parse((await devices.cli(laptop, ["sessions", "studio", "--json"])).stdout) as Array<{ name: string; pid: number; startedAt: string }>;
  const [before] = await listed();
  const daemon = await daemonAt(studio.state);

  const upgraded = await devices.cli({ ...laptop, env: { ...laptop.env, CNS_RELEASES: releases } }, ["upgrade", "studio"]);
  assert.equal(upgraded.code, 0, `${upgraded.output}\nThe restart's log:\n${await log()}`);
  assert.equal(upgraded.stdout, `studio: upgraded from 2.7.0 to ${CNS_VERSION}\n`);
  assert.equal((await replaced(studio.state, daemon.pid, log)).version, CNS_VERSION);
  for (const deadline = Date.now() + 20000; ; await new Promise((resolve) => setTimeout(resolve, 200))) {
    const after = await listed().catch(() => []);
    if (after.length) { assert.deepEqual(after.map(({ name, pid, startedAt }) => ({ name, pid, startedAt })), [{ name: "build", pid: before!.pid, startedAt: before!.startedAt }]); break; }
    if (Date.now() > deadline) assert.fail("laptop never listed studio's sessions again");
  }
});

test("cns status --json names the named sessions its daemon runs, and whether they outlive a restart", { timeout: 60000 }, async (t) => {
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
  const status = JSON.parse((await devices.cli(studio, ["status", "--json", "--state", studio.state])).stdout) as { daemon: { keepsSessions: boolean } };
  assert.equal(status.daemon.keepsSessions, HOLDERS);
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

  // GitHub fails now, but laptop learned the release today; a day on, the last release it named stands.
  status = 500;
  const cache = path.join(laptop.dir, "latest-release.json");
  for (const checkedAt of [Date.now(), Date.now() - 25 * 60 * 60_000]) {
    await writeFile(cache, JSON.stringify({ version: "99.0.0", checkedAt }));
    const remembered = await peers();
    assert.equal(remembered.code, 0, remembered.output);
    assert.ok(remembered.stderr.includes(behind), remembered.stderr);
  }

  // Nothing learned, and GitHub fails: nothing is said of the release, and cns peers still lists the devices.
  await writeFile(cache, JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60_000 }));
  const failing = await peers();
  assert.equal(failing.code, 0, failing.output);
  assert.doesNotMatch(failing.stderr, /latest release|Older cns/);
  assert.match(failing.stdout, /\nstudio +online/);
});
