import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { installService, installedService, installedServiceRuns, launchdPlist, serviceEnvironment, serviceFailed, serviceFile, serviceOverrides, servicePath, startInstalledService, systemdUnit, uninstallService, type Runner, type ServiceSpec } from "./service.js";
import { fakeSystemctl, launchCli, unusedPort } from "./test-support.js";

const spec: ServiceSpec = {
  program: { file: "/opt/cns & co/bin/cns", args: ["daemon", "--service", "--state", "/home/a b/.cns/daemon.json", "--relay-ish", "100%", "$HOME", "say \"hi\"\\"] },
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
  assert.equal(exec, `"/opt/cns & co/bin/cns" "daemon" "--service" "--state" "/home/a b/.cns/daemon.json" "--relay-ish" "100%%" "$$HOME" "say \\"hi\\"\\\\"`);
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

test("installed services preserve CA paths without inheriting secrets or TLS bypasses", () => {
  const trust = { NODE_EXTRA_CA_CERTS: "/etc/company/root.pem", SSL_CERT_FILE: "/etc/ssl/ca-bundle.crt", SSL_CERT_DIR: "/etc/ssl/certs" };
  const env = serviceEnvironment({ ...trust, SECRET: "do-not-copy", NODE_TLS_REJECT_UNAUTHORIZED: "0", SSLKEYLOGFILE: "/tmp/keys" });
  assert.deepEqual(env, trust);
  for (const contents of [systemdUnit({ ...spec, env }), launchdPlist({ ...spec, env })]) {
    for (const [name, value] of Object.entries(trust)) { assert.ok(contents.includes(name)); assert.ok(contents.includes(value)); }
    assert.doesNotMatch(contents, /SECRET|do-not-copy|NODE_TLS_REJECT_UNAUTHORIZED|SSLKEYLOGFILE/);
  }
  assert.deepEqual(serviceEnvironment({ NODE_EXTRA_CA_CERTS: "", SSL_CERT_FILE: "", SSL_CERT_DIR: "" }), {});
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
    // Installing again replaces the file. Without starting, a running daemon is left to the restart worker.
    calls.length = 0;
    await installService(file, runner, false);
    assert.deepEqual(calls, kind === "systemd" ? ["systemctl --user daemon-reload", "systemctl --user enable cns.service"] : []);
    calls.length = 0;
    assert.equal(await uninstallService(kind, runner, home, {}), true);
    assert.equal(calls.length > 0, true);
    assert.equal(await uninstallService(kind, runner, home, {}), false);
  }

  const failing: Runner = (file, args) => ({ code: args.includes("enable") ? 1 : 0, output: "Failed to connect to bus" });
  await assert.rejects(installService(serviceFile("systemd", spec, home, {}), failing), /systemctl --user enable cns\.service failed: Failed to connect to bus/);
});

test("the restart worker kickstarts a launchd agent, and loads its file again only after cns up --install rewrote it, trying a busy bootstrap again", async () => {
  const calls: string[] = [];
  const logged: string[] = [];
  const slept: number[] = [];
  let busy = 0;
  const runner: Runner = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (args[0] === "bootstrap" && busy > 0) { busy--; return { code: 5, output: "Bootstrap failed: 5: Input/output error" }; }
    return { code: 0, output: "" };
  };
  const steps = { runner, sleep: async (ms: number) => { slept.push(ms); }, log: (line: string) => { logged.push(line); } };
  const domain = `gui/${process.getuid?.() ?? 0}`;
  const job = `${domain}/com.thehumanworks.cns`;

  // A plain cns daemon restart: the agent launchd has loaded starts again.
  await startInstalledService("launchd", "/p/cns.plist", false, steps);
  assert.deepEqual(calls, [`launchctl kickstart ${job}`]);

  // After cns up --install: unloaded and loaded from the file, through a bootstrap launchd refuses for a moment.
  calls.length = 0;
  logged.length = 0;
  busy = 2;
  await startInstalledService("launchd", "/p/cns.plist", true, steps);
  assert.deepEqual(calls, [`launchctl bootout ${job}`, ...Array(3).fill(`launchctl bootstrap ${domain} /p/cns.plist`)]);
  assert.deepEqual(slept, [1000, 1000]);
  assert.deepEqual(logged, [
    `launchctl bootout ${job}: done.`,
    `launchctl bootstrap ${domain} /p/cns.plist failed: Bootstrap failed: 5: Input/output error; trying again in a second.`,
    `launchctl bootstrap ${domain} /p/cns.plist failed: Bootstrap failed: 5: Input/output error; trying again in a second.`,
    `launchctl bootstrap ${domain} /p/cns.plist: done.`,
  ]);

  // Refused five times: the worker then starts the daemon without the service.
  calls.length = 0;
  busy = 5;
  await assert.rejects(startInstalledService("launchd", "/p/cns.plist", true, steps), /^Error: launchctl bootstrap gui\/\d+ \/p\/cns\.plist failed: Bootstrap failed: 5: Input\/output error$/);
  assert.equal(calls.filter((call) => call.includes("bootstrap")).length, 5);

  // systemd restarts the unit, with what its file says since daemon-reload.
  calls.length = 0;
  await startInstalledService("systemd", "/u/cns.service", true, steps);
  assert.deepEqual(calls, ["systemctl --user restart cns.service"]);
});


test("cns up --install runs the daemon from the unit; cns up starts it again after cns stop; --uninstall stops it", { skip: process.platform !== "linux", timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-install-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(path.join(home, ".cns"), { recursive: true, mode: 0o700 });
  await mkdir(bin);
  await fakeSystemctl(bin);
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

  // A daemon cns up started is replaced by the service, which keeps its settings, through the restart's own process.
  const first = await cli(["up", "--bind", "127.0.0.1", "--port", port, "--state", state]);
  assert.equal(first.code, 0, first.stderr);
  const installed = await cli(["up", "--install", "--state", state]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stderr, /Installed a systemd user service at .*\/systemd\/user\/cns\.service/);
  assert.match(installed.stdout, /^Restarted as \S+ \(cns [\d.]+, pid \d+, a systemd user service\), listening at ws:\/\/127\.0\.0\.1:\d+\./);
  assert.notEqual(/pid (\d+)/.exec(installed.stdout)![1], /pid (\d+)/.exec(first.stdout)![1]);
  assert.ok(installed.stdout.includes(`ws://127.0.0.1:${port}`));
  const unit = await readFile(path.join(home, ".config", "systemd", "user", "cns.service"), "utf8");
  assert.match(unit, /"daemon" "--service" "--state"/);
  assert.ok(unit.includes(`"--bind" "127.0.0.1" "--port" "${port}"`));
  assert.ok(installedService(state, home, env));

  // cns stop ends the daemon; cns up then starts it through the service, not as a detached process.
  assert.equal((await cli(["stop", "--state", state])).code, 0);
  const again = await cli(["up", "--state", state]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^Started as \S+ \(cns [\d.]+, pid \d+, a systemd user service\)/);
  assert.match(await readFile(log, "utf8"), /^--user start cns\.service$/m);

  // cns daemon restart leaves the restart to systemd, which runs what the unit and its drop-ins say.
  const restarts = async () => (await readFile(log, "utf8")).split("\n").filter((line) => line === "--user restart cns.service").length;
  const restartsBefore = await restarts();
  const restarted = await cli(["daemon", "restart", "--state", state]);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.match(restarted.stdout, /^Restarted as \S+ \(cns [\d.]+, pid \d+, a systemd user service\)/);
  assert.notEqual(/pid (\d+)/.exec(restarted.stdout)![1], /pid (\d+)/.exec(again.stdout)![1]);
  assert.equal(await restarts(), restartsBefore + 1);

  const removed = await cli(["up", "--uninstall", "--state", state]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /^Removed the systemd user service; the daemon is stopped\./);
  assert.match((await cli(["status", "--state", state])).stdout, /Daemon:\s+not running/);
  assert.match((await cli(["up", "--uninstall", "--state", state])).stdout, /^No systemd user service is installed\./);
});

test("when the service does not start the daemon the restart worker stopped, the worker starts it without the service", { skip: process.platform !== "linux", timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-fallback-")));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(path.join(home, ".cns"), { recursive: true, mode: 0o700 });
  await mkdir(bin);
  await fakeSystemctl(bin);
  const env = { HOME: home, CNS_CONFIG_DIR: path.join(home, ".cns"), XDG_CONFIG_HOME: path.join(home, ".config"), PATH: `${bin}:${process.env.PATH}`, FAKE_SYSTEMCTL_FAIL: "restart" };
  const state = path.join(home, ".cns", "daemon.json");
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  t.after(async () => { await cli(["stop", "--state", state]); await rm(root, { recursive: true, force: true }); });
  const port = await unusedPort("127.0.0.1");
  const first = await cli(["up", "--bind", "127.0.0.1", "--port", port, "--state", state]);
  assert.equal(first.code, 0, first.stderr);

  // The unit is installed, but systemctl restart fails, as for a unit that cannot run.
  const installed = await cli(["up", "--install", "--state", state]);
  const log = await readFile(path.join(home, ".cns", "restart.log"), "utf8");
  assert.equal(installed.code, 0, `${installed.stderr}\n${log}`);
  assert.match(log, /The systemd user service did not start the daemon \(systemctl --user restart cns\.service failed: Job for cns\.service failed because the control process exited with error code\.\); starting it without the service\./);
  assert.ok(log.includes(`Starting it detached at ws://127.0.0.1:${port}.`), log);
  // What runs is reported, not the service that is installed.
  assert.match(installed.stdout, new RegExp(`^Restarted as \\S+ \\(cns [\\d.]+, pid \\d+\\), listening at ws://127\\.0\\.0\\.1:${port}\\.`));
  assert.notEqual(/pid (\d+)/.exec(installed.stdout)![1], /pid (\d+)/.exec(first.stdout)![1]);
  const control = await connectControl(state);
  try { assert.notEqual((await control.remote.status()).service, true); } finally { control.close(); }
});

test("cns up --install refuses, writing nothing, while a service it did not install runs the daemon", { skip: process.platform !== "linux", timeout: 60000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-system-")));
  const bin = path.join(root, "bin");
  await mkdir(path.join(root, ".cns"), { recursive: true, mode: 0o700 });
  await mkdir(bin);
  await fakeSystemctl(bin);
  const env = { HOME: root, CNS_CONFIG_DIR: path.join(root, ".cns"), XDG_CONFIG_HOME: path.join(root, ".config"), PATH: `${bin}:${process.env.PATH}` };
  const state = path.join(root, ".cns", "daemon.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  // As the NixOS module runs it: a system service, with no user unit.
  const daemon = launchCli(t, ["daemon", "--service", "--state", state, "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1")], { env });
  await daemon.waitFor("listening at");
  const installing = launchCli(t, ["up", "--install", "--state", state], { env });
  installing.child.stdin.end();
  assert.equal(await installing.exited, 1);
  assert.match(installing.stderr, /A system service runs this daemon, such as the NixOS module's cns\.service, so a user service would run a second daemon beside it\./);
  await assert.rejects(stat(path.join(root, ".config", "systemd", "user", "cns.service")), /ENOENT/);
  const control = await connectControl(state);
  try { assert.equal((await control.remote.status()).service, true, "the daemon runs on"); } finally { control.close(); }
});

test("the Nix modules run the daemon command that cns up --install writes", async () => {
  // A command cns no longer has makes the service fail at every start, and cns up then waits for it until it times out.
  for (const module of ["home-manager.nix", "nixos.nix"]) {
    const source = await readFile(path.join(import.meta.dir, "..", "nix", "modules", module), "utf8");
    const words = /\[\s*(?:exe\s+)?((?:"[^"]*"\s+)+)"--state"/.exec(source)?.[1]?.match(/"[^"]*"/g)?.map((word) => JSON.parse(word));
    assert.deepEqual(words, ["daemon", "--service"], module);
  }
});

test("systemd drop-ins whose ExecStart runs another cns are found, others are not", { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-service-overrides-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const self = "/nix/store/new-capnweb-shell-1.8.0/bin/cns";
  const files = {
    // As left on a device: the unit's command cleared, then replaced with an older cns.
    recovery: "[Service]\nExecStart=\nExecStart=/nix/store/old-capnweb-shell-1.0.0/bin/cns daemon --service --state /home/a/.cns/daemon.json\nRestartSec=30s\n",
    limits: "[Unit]\nStartLimitBurst=5\n[Service]\nRestartSec=30s\nExecStartPre=/bin/true\n# ExecStart=/opt/old/cns\n",
    clearOnly: "[Service]\nExecStart=\n",
    sameCns: `[Service]\nExecStart=\nExecStart="${self}" "daemon" "--service"\n`,
  };
  const paths = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, contents]) => {
    const file = path.join(root, `${name}.conf`);
    await writeFile(file, contents);
    return [name, file] as const;
  })));
  const calls: string[][] = [];
  const shows = (output: string, code = 0): Runner => (file, args) => { calls.push([file, ...args]); return { code, output }; };
  const all = `${Object.values(paths).join(" ")} ${path.join(root, "gone.conf")}\n`;
  assert.deepEqual(serviceOverrides("systemd", self, shows(all)), [paths.recovery]);
  assert.deepEqual(calls[0], ["systemctl", "--user", "show", "cns.service", "--property=DropInPaths", "--value"]);
  assert.deepEqual(serviceOverrides("systemd", self, shows("")), []);
  assert.deepEqual(serviceOverrides("systemd", self, shows("Failed to connect to bus", 1)), []);
  // Only absolute paths are read: anything else in the output is not a drop-in.
  assert.deepEqual(serviceOverrides("systemd", self, shows(`relative.conf ${paths.recovery}`)), [paths.recovery]);
  calls.length = 0;
  assert.deepEqual(serviceOverrides("launchd", self, shows(all)), []);
  assert.equal(calls.length, 0);
});

test("a systemd service that failed, or waits to restart after failing, is reported failed", () => {
  const shows = (output: string): Runner => () => ({ code: 0, output });
  assert.equal(serviceFailed("systemd", shows("ActiveState=activating\nSubState=auto-restart")), true);
  assert.equal(serviceFailed("systemd", shows("ActiveState=failed\nSubState=failed")), true);
  assert.equal(serviceFailed("systemd", shows("ActiveState=activating\nSubState=start-pre")), false);
  assert.equal(serviceFailed("systemd", shows("ActiveState=active\nSubState=running")), false);
  assert.equal(serviceFailed("systemd", () => ({ code: 1, output: "Failed to connect to bus" })), undefined);
  assert.equal(serviceFailed("launchd", shows("")), undefined);
});

test("what an installed service runs: this executable or another, and whether Nix owns its file", { skip: process.platform === "win32" }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-service-runs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const kind of ["systemd", "launchd"] as const) {
    const home = path.join(root, kind);
    const file = serviceFile(kind, spec, home, {});
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
    const service = { kind, path: file.path };
    // Matched as the service file writes it, escapes and all, never as a bare substring of another path.
    assert.deepEqual(installedServiceRuns(service, spec.program.file), { managedByNix: false, runsThis: true }, kind);
    assert.deepEqual(installedServiceRuns(service, "/opt/cns & co/bin/cn"), { managedByNix: false, runsThis: false }, kind);
    assert.deepEqual(installedServiceRuns(service, "/opt/other/cns"), { managedByNix: false, runsThis: false }, kind);

    // Home Manager links the file into the Nix store; cns must not rewrite it.
    const store = path.join(root, "store") + path.sep;
    const owned = path.join(store, `${kind}-unit`);
    await mkdir(store, { recursive: true });
    await writeFile(owned, file.contents);
    await rm(file.path);
    await symlink(owned, file.path);
    assert.deepEqual(installedServiceRuns(service, spec.program.file, store), { managedByNix: true, runsThis: true }, kind);
    await rm(file.path);
    assert.deepEqual(installedServiceRuns(service, spec.program.file, store), { managedByNix: false, runsThis: false }, `${kind}: gone`);
  }
});
