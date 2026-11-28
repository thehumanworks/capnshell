import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { SERVICE_LABEL, servicePath } from "./service.js";
import { cliInvocation, cnsAs, launchCli, testDevices, unusedPort } from "./test-support.js";
import { CNS_VERSION } from "./version.js";

/** One word for the paired device's shell. */
const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// Loads a real launchd agent for this account and removes it after: macos.yml sets CNS_TEST_LAUNCHD.
// An account that has a cns agent already, as a developer's Mac may, is skipped, so its agent is never touched.
test("on macOS, a restart through the daemon kickstarts its launchd agent, and cns up --install from a cns at another path loads the agent's new file", { skip: process.platform !== "darwin" || !process.env.CNS_TEST_LAUNCHD, timeout: 240000 }, async (t) => {
  const plist = servicePath("launchd");
  if (existsSync(plist)) {
    const why = `this account has a cns launchd agent at ${plist}, which this test would boot out and remove. It runs only where none is installed, as on the runner macos.yml uses.`;
    console.error(`Skipped: ${why}`);
    t.skip(why);
    return;
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-launchd-")));
  // Offline: the agent's daemon registers at no relay.
  const env = { CNS_CONFIG_DIR: root, CNS_RELAY: "off" };
  const state = path.join(root, "daemon.json");
  const job = `gui/${process.getuid!()}/${SERVICE_LABEL}`;
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  t.after(async () => {
    spawnSync("launchctl", ["bootout", job]);
    await rm(plist, { force: true });
    // A daemon the restart started without the agent, had the agent not started one.
    await cli(["stop", "--state", state]);
    await rm(root, { recursive: true, force: true });
  });
  const status = async () => {
    const control = await connectControl(state);
    try { return await control.remote.status(); } finally { control.close(); }
  };
  const restartLog = () => readFile(path.join(root, "restart.log"), "utf8").catch((error: unknown) => String(error));
  const until = async (what: string, check: () => Promise<boolean>) => {
    const deadline = Date.now() + 45000;
    while (!(await check().catch(() => false))) {
      if (Date.now() > deadline) {
        const print = spawnSync("launchctl", ["print", job], { encoding: "utf8" });
        const service = await readFile(path.join(root, "service.log"), "utf8").catch((error: unknown) => String(error));
        throw new Error(`Timed out waiting for ${what}. The restart's log:\n${await restartLog()}\nlaunchctl print ${job}:\n${print.stdout}${print.stderr}\nThe agent's log:\n${service}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const port = await unusedPort("127.0.0.1");

  const installed = await cli(["up", "--install", "--bind", "127.0.0.1", "--port", port, "--state", state]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.ok(installed.stderr.includes(`Installed a launchd agent at ${plist}.`), installed.stderr);
  assert.match(installed.stdout, /^Running as \S+ \(cns [\d.]+, pid \d+, a launchd agent\), listening at ws:\/\/127\.0\.0\.1:\d+\./);

  const devices = await testDevices(t, "cns-launchd-peer-");
  const laptop = await devices.device("laptop", { CNS_RELAY: "off" });
  await devices.pair({ name: "studio", dir: root, env, state }, laptop);
  /**
   * Run `cns` with `args` on studio from laptop, so inside the agent's own processes, as cns upgrade
   * does: the command returns first, then the daemon that comes back is the agent's.
   */
  const throughDaemon = async (cns: string[], args: string[]) => {
    const old = (await status()).pid;
    const ran = await devices.cli(laptop, ["run", "studio", "--", [...cns, ...args].map(sh).join(" ")]);
    assert.equal(ran.code, 0, ran.output);
    assert.match(ran.stdout, /^Restarting the daemon through its launchd agent in a moment\./m);
    let log = "";
    await until(`${args.join(" ")} through the daemon`, async () => {
      const { pid } = await status();
      log = await restartLog();
      return pid !== old && log.includes(`Restarted the daemon (pid ${pid}).`);
    });
    const now = await status();
    assert.equal(now.service, true, `started by the agent, not detached:\n${log}`);
    assert.equal(now.port, Number(port));
    return { old, now, log };
  };

  // cns daemon restart: the worker stops the daemon, and launchd starts the agent it has loaded.
  const self = (() => { const { file, args } = cliInvocation([]); return [file, ...args]; })();
  const restarted = await throughDaemon(self, ["daemon", "restart", "--state", state]);
  assert.match(restarted.log, new RegExp(`^Restarting the daemon \\(pid ${restarted.old}\\)\\.$`, "m"));
  assert.ok(restarted.log.includes(`launchctl kickstart ${job}\n`), restarted.log);

  // cns up --install from a cns at another path, as after an upgrade: the agent's file now runs that
  // cns, so the worker unloads the agent and loads its file again, from a process the agent started.
  const other = await cnsAs(root, CNS_VERSION);
  const moved = await throughDaemon(other, ["up", "--install", "--state", state]);
  assert.match(moved.log, new RegExp(`^Restarting the daemon \\(pid ${moved.old}\\) from its service's new file\\.$`, "m"));
  assert.ok(moved.log.includes(`launchctl bootout ${job}: `), moved.log);
  assert.ok(moved.log.includes(`launchctl bootstrap gui/${process.getuid!()} ${plist}: done.\n`), moved.log);
  assert.equal(moved.now.executable, other[1], "the daemon runs the other cns");
  // launchd itself has the new file loaded: it lists the job running, with the other cns among its arguments.
  const print = spawnSync("launchctl", ["print", job], { encoding: "utf8" });
  assert.equal(print.status, 0, print.stderr);
  assert.match(print.stdout, /^\s*state = running\s*$/m, print.stdout);
  assert.ok(print.stdout.includes(other[1]!), print.stdout);

  const back = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(back.code, 0, back.output);
  assert.match(back.stdout, /^back$/m);
});
