import assert from "node:assert/strict";
import { spawnSync, type spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import {
  installedService, installedServiceRuns, installService, registeredTask, scheduledTask, schtasks, serviceFile, serviceKind, serviceLog, serviceName,
  servicePath, runTask, superviseDaemon, TaskGone, taskGone, taskName, uninstallService, windowsQuote, type Runner, type ServiceSpec,
} from "./service.js";
import { cliInvocation, launchCli, testDevices, unusedPort } from "./test-support.js";

const user = "S-1-5-21-1004336348-1177238915-682003330-1001";
const state = "C:\\Users\\A B\\.cns\\daemon.json";
const spec: ServiceSpec = {
  program: { file: "C:\\Program Files\\cns & co\\cns.exe", args: ["daemon", "--supervise", "--state", state, "--bind", "0.0.0.0", "--port", "47381", "say \"hi\"\\", "C:\\trailing\\", "100% <sure>"] },
  env: { PATH: "C:\\bin", CNS_RELAY: "off" },
  log: "C:\\Users\\A B\\.cns\\service.log",
  user,
};

/** Split a command line as the C runtime does, which is how cns.exe reads the one conhost passes on. */
function windowsArgv(line: string): string[] {
  const words: string[] = [];
  let word: string | undefined;
  let quoted = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === "\\") {
      let count = 1;
      while (line[at + count] === "\\") count++;
      at += count - 1;
      if (line[at + 1] !== "\"") { word = (word ?? "") + "\\".repeat(count); continue; }
      word = (word ?? "") + "\\".repeat(count >> 1);
      // An odd count escapes the quote; an even one leaves it to open or close quoting.
      if (count % 2) { word += "\""; at++; }
    } else if (char === "\"") {
      word ??= "";
      quoted = !quoted;
    } else if (!quoted && (char === " " || char === "\t")) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + char;
  }
  if (word !== undefined) words.push(word);
  return words;
}

const unescape = (text: string) => text.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("the scheduled task starts the daemon at this account's sign-in, unelevated, with no time limit, through a headless console", () => {
  const task = scheduledTask(spec);
  assert.match(task, /<LogonTrigger>\s*<UserId>S-1-5-21-1004336348-1177238915-682003330-1001<\/UserId>\s*<\/LogonTrigger>/);
  assert.match(task, /<Principal id="Author">\s*<UserId>S-1-5-21-[\d-]+<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/);
  for (const setting of ["<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>", "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>", "<Priority>5</Priority>"]) assert.ok(task.includes(setting), setting);
  assert.match(task, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>10<\/Count>\s*<\/RestartOnFailure>/);
  // Nothing that needs an administrator: no group, no elevation, no trigger for every account.
  assert.doesNotMatch(task, /GroupId|HighestAvailable|<LogonTrigger>\s*<\/LogonTrigger>/);
  // Task Scheduler passes no environment, and none is written.
  assert.doesNotMatch(task, /CNS_RELAY|C:\\bin/);
  assert.equal(/<Command>(.*)<\/Command>/.exec(task)![1], "%SystemRoot%\\System32\\conhost.exe");
  const line = unescape(/<Arguments>(.*)<\/Arguments>/.exec(task)![1]!);
  // Spaces, quotes, trailing backslashes, & and < survive the trip: XML, then the command line the daemon parses.
  assert.deepEqual(windowsArgv(line), ["--headless", spec.program.file, ...spec.program.args]);
});

test("each word of the task's command line is quoted so the C runtime reads it back unchanged", () => {
  assert.equal(windowsQuote("daemon"), "\"daemon\"");
  assert.equal(windowsQuote("C:\\Users\\A B\\"), "\"C:\\Users\\A B\\\\\"");
  assert.equal(windowsQuote("a\\\"b"), "\"a\\\\\\\"b\"");
  assert.equal(windowsQuote(""), "\"\"");
  for (const value of ["", "\\", "\\\\\"", "a b\\\\", "\"\"", "x\\y\\\\z\""]) assert.deepEqual(windowsArgv(windowsQuote(value)), [value], value);
});

test("a task setting that Task Scheduler would expand, or that injects a line, is refused", () => {
  const program = (value: string) => ({ ...spec, program: { file: "C:\\cns\\cns.exe", args: ["--state", value] } });
  assert.throws(() => scheduledTask(program("C:\\%USERNAME%\\daemon.json")), /Task Scheduler would expand %NAME% in a service setting\. Use paths without percent signs\./);
  assert.doesNotThrow(() => scheduledTask(program("C:\\100% sure\\daemon.json")));
  assert.throws(() => scheduledTask(program("C:\\a\r\n</Arguments>")), /newline/);
  assert.throws(() => scheduledTask({ ...spec, user: undefined }), /needs the account it runs as/);
});

test("Windows runs the daemon from a scheduled task per account, whose definition cns keeps in ~/.cns", () => {
  assert.equal(serviceKind("win32"), "schtasks");
  assert.equal(servicePath("schtasks", path.join("home", "a b")), path.join("home", "a b", ".cns", "service.xml"));
  assert.equal(serviceName("schtasks"), "scheduled task");
  assert.equal(serviceLog("schtasks", path.join("home", ".cns", "daemon.json")), path.join("home", ".cns", "service.log"));
  assert.equal(taskName("A B"), "cns-A B");
});


/** A home for a test's service files, with CNS_CONFIG_DIR inside it. */
async function tempHome(t: test.TestContext): Promise<string> {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-task-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.CNS_CONFIG_DIR;
  process.env.CNS_CONFIG_DIR = path.join(home, ".cns");
  t.after(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; });
  return home;
}

/** A stand-in for schtasks that records its calls; `fails` names the steps that fail. */
function fakeSchtasks(fails: string[] = [], output = "") {
  const calls: string[][] = [];
  const runner: Runner = (file, args) => { calls.push([file, ...args]); return { code: fails.includes(args[0]!) ? 1 : 0, output }; };
  return { calls, runner };
}

const step = (...args: string[]) => [schtasks(), ...args];

test("installing registers the task from a UTF-16 definition; it is found while Task Scheduler has it", async (t) => {
  const home = await tempHome(t);
  const name = taskName();
  const { calls, runner } = fakeSchtasks();
  assert.equal(path.basename(schtasks()), "schtasks.exe");
  assert.equal(path.basename(path.dirname(schtasks())), "System32");

  const file = serviceFile("schtasks", spec, home, {});
  await installService(file, runner);
  const bytes = await readFile(file.path);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], "a UTF-16 byte order mark, as the declaration says");
  assert.equal(bytes.subarray(2).toString("utf16le"), file.contents);
  assert.deepEqual(calls, [step("/Create", "/TN", name, "/XML", file.path, "/F")], "run by runTask, never ended");

  calls.length = 0;
  assert.deepEqual(installedService(state, home, {}, runner, "win32"), { kind: "schtasks", path: file.path });
  assert.deepEqual(calls, [step("/Query", "/TN", name)]);
  // Matched as a whole quoted word, never as part of another path.
  assert.equal(installedService("C:\\Users\\A B\\.cns\\daemon.jso", home, {}, runner, "win32"), undefined);
  assert.equal(installedService("C:\\other\\daemon.json", home, {}, runner, "win32"), undefined);
  // Deleted in Task Scheduler: the definition cns kept no longer counts.
  assert.equal(installedService(state, home, {}, fakeSchtasks(["/Query"]).runner, "win32"), undefined);
  const service = { kind: "schtasks" as const, path: file.path };
  assert.deepEqual(installedServiceRuns(service, spec.program.file), { managedByNix: false, runsThis: true });
  assert.deepEqual(installedServiceRuns(service, "C:\\Program Files\\cns & co\\cns"), { managedByNix: false, runsThis: false });
  assert.deepEqual(installedServiceRuns(service, "C:\\Users\\A B\\scoop\\shims\\cns.exe"), { managedByNix: false, runsThis: false });
});

test("uninstalling deletes a task Task Scheduler has, and keeps its definition when the delete fails", async (t) => {
  const home = await tempHome(t);
  const name = taskName();
  const file = serviceFile("schtasks", spec, home, {});
  await installService(file, fakeSchtasks().runner);

  // No task: nothing to delete, and nothing reported removed.
  const none = fakeSchtasks(["/Query"]);
  assert.equal(await uninstallService("schtasks", none.runner, home, {}), false);
  assert.deepEqual(none.calls, [step("/Query", "/TN", name)]);

  const refused = fakeSchtasks(["/Delete"], "ERROR: Access is denied.");
  await assert.rejects(uninstallService("schtasks", refused.runner, home, {}),
    new RegExp(`failed: ERROR: Access is denied\\. Delete ${name} in Task Scheduler, or run schtasks /Delete /TN "${name}" /F\\.$`));
  assert.equal(existsSync(file.path), true, "kept while the task is still there");

  const { calls, runner } = fakeSchtasks();
  assert.equal(await uninstallService("schtasks", runner, home, {}), true);
  assert.deepEqual(calls, [step("/Query", "/TN", name), step("/Delete", "/TN", name, "/F")], "never /End, which would end this command if it runs through the daemon");
  assert.equal(existsSync(file.path), false);
});

test("the task's daemon is found by the --state its definition names, while Task Scheduler has the task", async (t) => {
  const home = await tempHome(t);
  const odd = "C:\\Users\\A&B <x>\\cns state\\daemon.json";
  const file = serviceFile("schtasks", { ...spec, program: { file: spec.program.file, args: ["daemon", "--supervise", "--state", odd, "--bind", "0.0.0.0", "--port", "47381"] } }, home, {});
  assert.deepEqual(registeredTask(home, {}, fakeSchtasks().runner), {}, "no definition kept: the state is not known");
  await installService(file, fakeSchtasks().runner);
  assert.deepEqual(registeredTask(home, {}, fakeSchtasks().runner), { state: odd });
  assert.equal(registeredTask(home, {}, fakeSchtasks(["/Query"]).runner), undefined);
});

test("starting the task runs it, and runs it again each second until a daemon answers, since Task Scheduler ignores a run while the last one ends", async () => {
  const name = taskName();
  const { calls, runner } = fakeSchtasks();
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  let asked = 0;
  assert.equal(await runTask(state, { runner, sleep, answers: async (at) => { assert.equal(at, state); return ++asked === 3; } }), true);
  assert.deepEqual(calls, [1, 2, 3].map(() => step("/Run", "/TN", name)));
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  calls.length = 0;
  assert.equal(await runTask(state, { runner, sleep, answers: async () => false }), false, "15 seconds, then the caller starts it detached");
  assert.equal(calls.length, 15);
  assert.ok(calls.every((call) => call[1] === "/Run"));
  await assert.rejects(runTask(state, { runner: fakeSchtasks(["/Run"], "ERROR: Access is denied.").runner, sleep, answers: async () => false }), /\/Run \/TN \S+ failed: ERROR: Access is denied\.$/);
});

// What changed: a restart still running the task when cns up --uninstall deleted it found /Run
// failing, and started the daemon detached, just after uninstalling had said it was stopped.
test("a task that did not start the daemon lets it start without the task while Task Scheduler has it, and not once it is gone", () => {
  const { calls, runner } = fakeSchtasks();
  assert.equal(taskGone("no daemon answered within 15 seconds", runner), undefined, "there, maybe disabled: the daemon starts detached");
  assert.deepEqual(calls, [step("/Query", "/TN", taskName())]);
  const gone = taskGone(`${schtasks()} /Run /TN ${taskName()} failed: ERROR: The system cannot find the file specified.`, fakeSchtasks(["/Query"]).runner);
  assert.ok(gone instanceof TaskGone);
  assert.equal(gone.message, `The scheduled task ${taskName()} is gone, as after cns up --uninstall (${schtasks()} /Run /TN ${taskName()} failed: ERROR: The system cannot find the file specified).`);
});

test("when schtasks refuses to register the task, the error says what failed and what to run next", async (t) => {
  const home = await tempHome(t);
  const file = serviceFile("schtasks", spec, home, {});
  await assert.rejects(installService(file, fakeSchtasks(["/Create"], "ERROR: Access is denied.").runner),
    /^Error: .*schtasks\.exe \/Create \/TN \S+.* \/F failed: ERROR: Access is denied\. Run cns up to start the daemon without a service\.$/);
});

/** A stand-in for spawn whose children end as `outcomes` say, one per launch. */
function fakeLaunch(outcomes: Array<[string, ...unknown[]]>) {
  const launches: Array<{ args: string[]; options: { detached?: boolean; windowsHide?: boolean } }> = [];
  const launch = ((_file: string, args: string[], options: object) => {
    const child = new EventEmitter();
    const [event, ...values] = outcomes[launches.length]!;
    launches.push({ args, options });
    setImmediate(() => child.emit(event, ...values));
    return child;
  }) as unknown as typeof spawn;
  return { launches, launch };
}

test("the task's supervisor restarts a failed daemon 5 seconds later, detached and logged, and ends when it stops cleanly", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-supervise-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const daemonState = path.join(root, "state", "daemon.json");
  const log = path.join(root, "state", "service.log");
  const { launches, launch } = fakeLaunch([["exit", 1, null], ["error", new Error("spawn ENOENT")], ["exit", null, "SIGKILL"], ["exit", 0, null]]);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const { calls, runner } = fakeSchtasks([]);
  await superviseDaemon({ state: daemonState, bind: "127.0.0.1", port: 47381 }, { launch, sleep, runner, answers: async () => false });
  assert.equal(launches.length, 4);
  assert.deepEqual(sleeps, [5000, 5000, 5000], "never a hot loop");
  assert.equal(calls.length, 3, "the task is checked before each restart");
  for (const { args, options } of launches) {
    assert.deepEqual(args.slice(-8), ["daemon", "--service", "--state", daemonState, "--bind", "127.0.0.1", "--port", "47381"]);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
  }
  assert.equal(await readFile(log, "utf8"), [1, "spawn ENOENT", "SIGKILL"].map((ended) => `[cns: the daemon ended (${ended}); starting it again in 5 seconds]\n`).join(""));

  // A task deleted since, or another daemon at the state file: one failure ends the supervision.
  for (const [reason, check] of [["its scheduled task is gone", { runner: fakeSchtasks(["/Query"]).runner, answers: async () => false }], ["a daemon answers at its state file", { runner, answers: async () => true }]] as const) {
    await rm(log);
    const once = fakeLaunch([["exit", 1, null]]);
    await superviseDaemon({ state: daemonState, bind: "127.0.0.1", port: 47381 }, { launch: once.launch, sleep, ...check });
    assert.equal(once.launches.length, 1, reason);
    assert.equal(await readFile(log, "utf8"), `[cns: the daemon ended (1); starting it again in 5 seconds]\n[cns: not starting it again: ${reason}]\n`);
  }
});

// Registers a real task for this account, replacing the one cns up --install made: windows.yml sets CNS_TEST_TASK_SCHEDULER.
test("on Windows, cns up --install runs a hidden daemon from the task, restarts it after a crash, restarts and reinstalls it through itself, and --uninstall removes it", { skip: process.platform !== "win32" || !process.env.CNS_TEST_TASK_SCHEDULER, timeout: 240000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-task-")));
  const daemonState = path.join(root, "daemon.json");
  const cli = async (args: string[]) => {
    const child = launchCli(t, args);
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const status = async () => {
    const control = await connectControl(daemonState);
    try { return await control.remote.status(); } finally { control.close(); }
  };
  const pid = async () => (await status()).pid;
  const until = async (what: string, check: () => Promise<boolean>, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  t.after(async () => {
    await cli(["peer", "remove", "laptop", "--state", daemonState]);
    await cli(["up", "--uninstall", "--state", daemonState]);
    await cli(["stop", "--state", daemonState]);
    await rm(root, { recursive: true, force: true });
  });
  const port = await unusedPort("127.0.0.1");

  const installed = await cli(["up", "--install", "--bind", "127.0.0.1", "--port", port, "--state", daemonState]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.match(installed.stderr, /Installed a scheduled task named cns-.+, defined in .+service\.xml\./);
  assert.match(installed.stdout, /^Running as \S+ \(cns [\d.]+, pid \d+, a scheduled task\), listening at ws:\/\/127\.0\.0\.1:\d+\./);
  // Task Scheduler exports its own XML, leaving out defaults such as RunLevel LeastPrivilege, so look for what matters.
  const query = spawnSync(schtasks(), ["/Query", "/TN", taskName(), "/XML"], { encoding: "utf8" });
  assert.equal(query.status, 0, query.stderr);
  for (const part of [/<LogonTrigger\b/, /<LogonType>\s*InteractiveToken\s*</, /conhost\.exe\s*<\/Command>/i, /<Arguments>\s*--headless\s/, /--supervise/]) {
    assert.match(query.stdout, part, `The exported task:\n${query.stdout}`);
  }
  assert.doesNotMatch(query.stdout, /HighestAvailable/, `Elevated. The exported task:\n${query.stdout}`);

  // No window: not the headless console host, the supervisor in it, nor the daemon.
  const windows = spawnSync("powershell", ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${daemonState.replace(/'/g, "''")}*' } | ForEach-Object { "$($_.Name) $((Get-Process -Id $_.ProcessId).MainWindowHandle)" }`], { encoding: "utf8" });
  const processes = windows.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(processes.some((line) => /^conhost\.exe /i.test(line)), windows.stdout + windows.stderr);
  assert.ok(processes.length >= 3, windows.stdout + windows.stderr);
  for (const line of processes) assert.match(line, /\s0$/, `${line} has a window. All of them:\n${windows.stdout}`);

  // A daemon that crashes comes back through the supervisor.
  const crashed = await pid();
  spawnSync("taskkill", ["/F", "/PID", String(crashed)]);
  await until("the supervisor to start the daemon again", async () => (await pid()) !== crashed);
  assert.match(await readFile(path.join(root, "service.log"), "utf8"), /\[cns: the daemon ended \(\d+\); starting it again in 5 seconds\]/);

  // cns stop ends it until cns up, which starts it through the task.
  assert.equal((await cli(["stop", "--state", daemonState])).code, 0);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  assert.match((await cli(["status", "--state", daemonState])).stdout, /Daemon:\s+not running/);
  const again = await cli(["up", "--state", daemonState]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /^Started as \S+ \(cns [\d.]+, pid \d+, a scheduled task\)/);

  // cns daemon restart stops it and runs the task again.
  const before = await pid();
  const restarted = await cli(["daemon", "restart", "--state", daemonState]);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.match(restarted.stdout, /^Restarting the daemon through its scheduled task in a moment\./);
  await until("cns daemon restart", async () => (await pid()) !== before);
  assert.equal((await status()).service, true, "started by the task");

  // Run through the daemon from a paired device, so inside the task's processes, as an upgrade of
  // every device does: each returns first, and the daemon comes back, through the task if it can.
  const devices = await testDevices(t, "cns-task-peer-");
  const laptop = await devices.device("laptop");
  await devices.up(laptop);
  await devices.pair({ name: "studio", dir: root, env: {}, state: daemonState }, laptop);
  /** Whether the task started the daemon that comes back after `args` runs through the daemon. */
  const throughDaemon = async (args: string[]) => {
    const { file, args: rest } = cliInvocation(args);
    const old = await pid();
    const ran = await devices.cli(laptop, ["run", "studio", "--", `& ${[file, ...rest].map((word) => `'${word.replaceAll("'", "''")}'`).join(" ")}`]);
    assert.equal(ran.code, 0, ran.output);
    assert.match(ran.stdout, /Restarting the daemon through its scheduled task in a moment\./);
    await until(`${args.join(" ")} through the daemon`, async () => (await pid()) !== old, 45000);
    const now = await status();
    assert.equal(now.port, Number(port));
    return { service: now.service, log: await readFile(path.join(root, "restart.log"), "utf8") };
  };
  const restart = ["daemon", "restart", "--state", daemonState];
  let back = await throughDaemon(restart);
  assert.equal(back.service, true, `started by the task, not detached:\n${back.log}`);
  // A task that cannot run: the daemon comes back detached rather than not at all.
  const disabled = spawnSync(schtasks(), ["/Change", "/TN", taskName(), "/DISABLE"], { encoding: "utf8" });
  try {
    assert.equal(disabled.status, 0, disabled.stdout + disabled.stderr);
    back = await throughDaemon(restart);
  } finally { spawnSync(schtasks(), ["/Change", "/TN", taskName(), "/ENABLE"], { encoding: "utf8" }); }
  assert.equal(back.service, false, `started detached:\n${back.log}`);
  // cns up --install puts the task's daemon in place of that one.
  back = await throughDaemon(["up", "--install", "--state", daemonState]);
  assert.equal(back.service, true, `started by the task, not detached:\n${back.log}`);

  // One task per account: installing it for another state file while its daemon runs is refused.
  const elsewhere = await cli(["up", "--install", "--state", path.join(root, "other", "daemon.json")]);
  assert.notEqual(elsewhere.code, 0, elsewhere.stdout);
  assert.match(elsewhere.stderr, /The scheduled task runs the daemon at .+, not .+\. Run cns up --uninstall first\./);

  const removed = await cli(["up", "--uninstall", "--state", daemonState]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /^Removed the scheduled task; the daemon is stopped\./);
  assert.notEqual(spawnSync(schtasks(), ["/Query", "/TN", taskName()], { encoding: "utf8" }).status, 0);
  // A restart still running the task when it went would leave its steps here.
  const logs = async () => (await Promise.all(["restart.log", "service.log"].map(async (name) => `${name}:\n${await readFile(path.join(root, name), "utf8").catch((error: Error) => error.message)}`))).join("\n");
  const after = (await cli(["status", "--state", daemonState])).stdout;
  assert.match(after, /Daemon:\s+not running/, `${after}${await logs()}`);
});
