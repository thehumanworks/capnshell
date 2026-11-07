import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installService, installedService, launchdPlist, serviceEnvironment, serviceFile, servicePath, systemdUnit, uninstallService, type Runner, type ServiceSpec } from "./service.js";
import { launchCli, unusedPort } from "./test-support.js";

const spec: ServiceSpec = {
  program: { file: "/opt/cns & co/bin/cns", args: ["listen", "--service", "--state", "/home/a b/.cns/daemon.json", "--relay-ish", "100%", "$HOME", "say \"hi\"\\"] },
  env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8 a%20b&c=$X" },
  log: "/home/a b/.cns/service.log",
};

test("the launchd agent runs the daemon in the foreground, escaped, and restarts it only after a failure", () => {
  const plist = launchdPlist(spec);
  assert.match(plist, /<key>Label<\/key>\n\t<string>com\.thehumanworks\.cns<\/string>/);
  assert.ok(plist.includes("<string>/opt/cns &amp; co/bin/cns</string>"));
  assert.ok(plist.includes("<string>say &quot;hi&quot;\\</string>"));
  assert.ok(plist.includes("<string>en_US.UTF-8 a%20b&amp;c=$X</string>"));
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.ok(plist.includes("<key>StandardErrorPath</key>\n\t<string>/home/a b/.cns/service.log</string>"));
});

test("the systemd unit quotes every word so specifiers and variables stay literal", () => {
  const unit = systemdUnit(spec);
  const exec = /^ExecStart=(.*)$/m.exec(unit)![1]!;
  assert.equal(exec, `"/opt/cns & co/bin/cns" "listen" "--service" "--state" "/home/a b/.cns/daemon.json" "--relay-ish" "100%%" "$$HOME" "say \\"hi\\"\\\\"`);
  assert.ok(unit.includes(`Environment="LANG=en_US.UTF-8 a%%20b&c=$X"`));
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("a setting with a newline cannot inject service directives", () => {
  const injected = { ...spec, env: { PATH: "/bin\nExecStartPre=/bin/evil" } };
  assert.throws(() => systemdUnit(injected), /newline/);
  assert.throws(() => launchdPlist(injected), /newline/);
});

test("the service keeps the login environment the daemon's shells need, and nothing else", () => {
  assert.deepEqual(serviceEnvironment({ PATH: "/a:/b", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", SECRET: "x", CNS_CONFIG_DIR: "/c", LC_ALL: "" }),
    { PATH: "/a:/b", SHELL: "/bin/zsh", LANG: "en_US.UTF-8", CNS_CONFIG_DIR: "/c" });
});

test("service files live where launchd and systemd look for per-user services", () => {
  assert.equal(servicePath("launchd", "/Users/a"), "/Users/a/Library/LaunchAgents/com.thehumanworks.cns.plist");
  assert.equal(servicePath("systemd", "/home/a", {}), "/home/a/.config/systemd/user/cns.service");
  assert.equal(servicePath("systemd", "/home/a", { XDG_CONFIG_HOME: "/x" }), "/x/systemd/user/cns.service");
  assert.equal(servicePath("systemd", "/home/a", { XDG_CONFIG_HOME: "relative" }), "/home/a/.config/systemd/user/cns.service");
});

test("installing writes a private file and starts the service; uninstalling stops and removes it", { skip: process.platform === "win32" }, async (t) => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-service-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: string[] = [];
  const runner: Runner = (file, args) => { calls.push([file, ...args].join(" ")); return { code: 0, output: "" }; };
  const previous = process.env.CNS_CONFIG_DIR;
  process.env.CNS_CONFIG_DIR = path.join(home, ".cns");
  t.after(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; });

  for (const kind of ["systemd", "launchd"] as const) {
    calls.length = 0;
    const file = serviceFile(kind, spec, home, {});
    await installService(file, runner);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600, "the service file is private");
    assert.equal(await readFile(file.path, "utf8"), file.contents);
    assert.deepEqual(calls, kind === "systemd"
      ? ["systemctl --user daemon-reload", "systemctl --user enable cns.service", "systemctl --user restart cns.service"]
      : [`launchctl bootout gui/${process.getuid!()}/com.thehumanworks.cns`, `launchctl bootstrap gui/${process.getuid!()} ${file.path}`]);
    // Installing again replaces the file.
    await installService(file, runner);
    calls.length = 0;
    assert.equal(await uninstallService(kind, runner, home, {}), true);
    assert.equal(calls.length > 0, true);
    assert.equal(await uninstallService(kind, runner, home, {}), false);
  }

  const failing: Runner = (file, args) => ({ code: args.includes("enable") ? 1 : 0, output: "Failed to connect to bus" });
  await assert.rejects(installService(serviceFile("systemd", spec, home, {}), failing), /systemctl --user enable cns\.service failed: Failed to connect to bus/);
});

/** A stand-in for systemctl that runs the unit's ExecStart as systemd would, and stops it with cns stop. */
const FAKE_SYSTEMCTL = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\n");
const unitPath = process.env.XDG_CONFIG_HOME + "/systemd/user/cns.service";
const unquote = (word) => word.slice(1, -1).replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$");
function unit() {
  const text = readFileSync(unitPath, "utf8");
  const exec = text.match(/^ExecStart=(.*)$/m)[1].match(/"(?:[^"\\]|\\.)*"/g).map(unquote);
  const env = {};
  for (const [, line] of text.matchAll(/^Environment=("(?:[^"\\]|\\.)*")$/gm)) { const pair = unquote(line); env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1); }
  return { exec, env };
}
const { exec, env } = (args.includes("restart") || args.includes("start") || args.includes("--now")) ? unit() : { exec: [], env: {} };
const stop = () => spawnSync(exec[0], [...exec.slice(1, exec.indexOf("listen")), "stop", "--state", exec[exec.indexOf("--state") + 1]], { stdio: "ignore" });
if (args.includes("restart") || args.includes("start")) {
  if (args.includes("restart")) stop();
  spawn(exec[0], exec.slice(1), { detached: true, stdio: "ignore", env: { HOME: process.env.HOME, ...env } }).unref();
}
if (args.includes("--now")) stop();
`;

test("cns up --install runs the daemon from the unit; cns up starts it again after cns stop; --uninstall stops it", { skip: process.platform !== "linux", timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-install-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(path.join(home, ".cns"), { recursive: true, mode: 0o700 });
  await mkdir(bin);
  const systemctl = path.join(bin, "systemctl");
  await writeFile(systemctl, `#!${process.execPath}\n${FAKE_SYSTEMCTL}`);
  await chmod(systemctl, 0o755);
  const log = path.join(root, "systemctl.log");
  await writeFile(log, "");
  const env = { HOME: home, CNS_CONFIG_DIR: path.join(home, ".cns"), XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log };
  const state = path.join(home, ".cns", "daemon.json");
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  t.after(async () => { await cli(["stop", "--state", state]); await rm(root, { recursive: true, force: true }); });
  const port = await unusedPort("127.0.0.1");

  // A daemon cns up started is replaced by the service, which keeps its settings.
  const first = await cli(["up", "--bind", "127.0.0.1", "--port", port, "--state", state]);
  assert.equal(first.code, 0, first.stderr);
  const installed = await cli(["up", "--install", "--state", state]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stderr, /Stopped the running daemon; the service runs it from now on\./);
  assert.match(installed.stderr, /Installed a systemd user service at .*\/systemd\/user\/cns\.service/);
  assert.match(installed.stdout, /^Running as \S+ \(pid \d+, a systemd user service\), listening at ws:\/\/127\.0\.0\.1:\d+\./);
  assert.ok(installed.stdout.includes(`ws://127.0.0.1:${port}`));
  const unit = await readFile(path.join(home, ".config", "systemd", "user", "cns.service"), "utf8");
  assert.match(unit, /"listen" "--no-repl" "--paired" "--service" "--state"/);
  assert.ok(unit.includes(`"--bind" "127.0.0.1" "--port" "${port}"`));
  assert.ok(installedService(state, home, env));

  // cns stop ends the daemon; cns up then starts it through the service, not as a detached process.
  assert.equal((await cli(["stop", "--state", state])).code, 0);
  const again = await cli(["up", "--state", state]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^Started as \S+ \(pid \d+, a systemd user service\)/);
  assert.match(await readFile(log, "utf8"), /^--user start cns\.service$/m);

  const removed = await cli(["up", "--uninstall", "--state", state]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /^Removed the systemd user service; the daemon is stopped\./);
  assert.match((await cli(["status", "--state", state])).stdout, /Daemon:\s+not running/);
  assert.match((await cli(["up", "--uninstall", "--state", state])).stdout, /^No systemd user service is installed\./);
});
