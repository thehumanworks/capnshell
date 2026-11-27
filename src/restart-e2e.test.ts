import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { connectControl, runsUnder } from "./commands/daemon.js";
import { restartPlan } from "./commands/pairing-cli.js";
import { cliInvocation, testDevices } from "./test-support.js";

/** The pid and port of the daemon whose state is at `state`. */
async function daemonAt(state: string): Promise<{ pid: number; port: number }> {
  const control = await connectControl(state);
  try { const { pid, port } = await control.remote.status(); return { pid, port }; } finally { control.close(); }
}

/** One command line for the device's shell that runs this cns with `args`: Bash, or PowerShell on Windows. */
function shellCommand(args: string[]): string {
  const { file, args: rest } = cliInvocation(args);
  const words = [file, ...rest].map((word) => `'${word.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`);
  return process.platform === "win32" ? `& ${words.join(" ")}` : words.join(" ");
}

test("a paired device restarts this device's daemon with cns run, and the daemon comes back where it was", { timeout: 90000 }, async (t) => {
  const devices = await testDevices(t, "cns-restart-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  const log = async () => { try { return await readFile(path.join(studio.dir, "restart.log"), "utf8"); } catch (error) { return String(error); } };
  /** The daemon that answers once the one with pid `old` has gone. */
  const replaced = async (old: number) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      try { const now = await daemonAt(studio.state); if (now.pid !== old) return now; } catch { /* Between the two daemons. */ }
      if (Date.now() > deadline) throw new Error(`The daemon did not come back. The restart's log:\n${await log()}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const restart = shellCommand(["daemon", "restart", "--state", studio.state]);
  const before = await daemonAt(studio.state);

  // The command runs under the daemon it restarts: it returns first, then the daemon goes and comes back.
  const ran = await devices.cli(laptop, ["run", "studio", "--", restart]);
  const after = await replaced(before.pid);
  assert.equal(ran.code, 0, `${ran.output}\nThe restart's log:\n${await log()}`);
  assert.match(ran.stdout, /^Restarting the daemon in a moment\. Links to this device drop and come back within seconds/);
  assert.equal(after.port, before.port);
  const again = await devices.cli(laptop, ["run", "studio", "--", "echo back"]);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /back/);

  // Here the command is still running when the daemon stops, which kills it and everything in its
  // process group; the restart runs on in a session of its own. The link drops under cns run.
  const killed = await devices.cli(laptop, ["run", "studio", "--", `${restart}; ${process.platform === "win32" ? "Start-Sleep 30" : "sleep 30"}`]);
  assert.notEqual(killed.code, 0, killed.output);
  const third = await replaced(after.pid);
  assert.equal(third.port, before.port);

  // Run on the device itself, it waits for the new daemon and says so. Windows has no ps to show
  // that this command does not run under the daemon, so there it restarts in the background too.
  const local = await devices.cli(studio, ["daemon", "restart", "--state", studio.state]);
  assert.equal(local.code, 0, local.output);
  assert.match(local.stdout, process.platform === "win32" ? /^Restarting the daemon in a moment\./ : /^Restarted as \S+ \(cns [\d.]+, pid \d+\), listening at /);
  const last = await replaced(third.pid);
  assert.equal(last.port, before.port);
});

test("cns daemon restart lets systemd restart its service, stops any other daemon first, and refuses services it cannot start", () => {
  assert.deepEqual(restartPlan(true, "systemd"), { stop: false, start: "systemd" });
  assert.deepEqual(restartPlan(true, "launchd"), { stop: true, start: "launchd" });
  // A daemon cns up started outside the service it installed, as when the service failed to start.
  assert.deepEqual(restartPlan(false, "systemd"), { stop: true, start: "systemd" });
  assert.deepEqual(restartPlan(false, undefined), { stop: true, start: "detached" });
  assert.deepEqual(restartPlan(undefined, undefined), { stop: true, start: "detached" });
  assert.throws(() => restartPlan(true, undefined), /A service manager cns did not install runs this daemon, so cns cannot start it again\. Restart it there/);
});

test("runsUnder follows ps's parent pids from this process up", () => {
  const listing = (rows: number[][]) => rows.map((row) => `  ${row.join("   ")}`).join("\n") + "\n";
  const chain = listing([[process.pid, 501], [501, 500], [500, 1], [1, 0], [777, 1]]);
  assert.equal(runsUnder(500, chain), true);
  assert.equal(runsUnder(501, chain), true);
  assert.equal(runsUnder(777, chain), false);
  // ps did not list this process: nobody can say.
  assert.equal(runsUnder(500, listing([[501, 500]])), undefined);
  // A loop in the listing ends.
  assert.equal(runsUnder(9, listing([[process.pid, 501], [501, 502], [502, 501]])), false);
  if (process.platform !== "win32") assert.equal(runsUnder(process.ppid), true);
});
