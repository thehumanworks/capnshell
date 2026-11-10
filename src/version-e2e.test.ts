import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cliEnvironment, launchCli, PROJECT_ROOT, unusedPort } from "./test-support.js";
import { CNS_VERSION } from "./version.js";

/**
 * A daemon keeps the cns it started with, so after an upgrade the daemon can be an older cns than
 * the commands. Here an older cns, a copy of this source with another version in its package.json,
 * starts the daemon; this cns then says so in up, status and doctor, and its advice fixes it.
 */
test("commands say when the daemon runs an older cns, and what to run, which fixes it", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-version-")));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });

  // The older cns: this source under another version.
  const older = path.join(root, "older");
  await cp(path.join(PROJECT_ROOT, "src"), path.join(older, "src"), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  await writeFile(path.join(older, "package.json"), JSON.stringify({ ...manifest, version: "0.9.0" }));
  await symlink(path.join(PROJECT_ROOT, "node_modules"), path.join(older, "node_modules"), "junction");
  const olderCli = path.join(older, "src", "cli.ts");

  const home = path.join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const env = { CNS_CONFIG_DIR: home, HOME: home };
  const state = path.join(home, "daemon.json");
  const port = await unusedPort("127.0.0.1");
  const upArgs = ["up", "--bind", "127.0.0.1", "--port", port, "--state", state];
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  cleanups.push(() => cli(["stop", "--state", state]));

  const started = spawn(process.execPath, [olderCli, ...upArgs], { env: cliEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
  let olderOutput = "";
  started.stdout.on("data", (chunk) => { olderOutput += chunk; });
  started.stderr.on("data", (chunk) => { olderOutput += chunk; });
  const startedCode = await new Promise((resolve) => started.on("close", resolve));
  assert.equal(startedCode, 0, olderOutput);
  assert.match(olderOutput, /\(cns 0\.9\.0, pid \d+\)/);

  const warning = `Warning: The daemon runs cns 0.9.0 (${olderCli}), but this cns is ${CNS_VERSION} (`;
  const status = await cli(["status", "--state", state]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /^Daemon: +cns 0\.9\.0, pid \d+ at /m);
  assert.ok(status.stdout.includes(warning), status.stdout);
  // cns up started it, outside any service, so cns stop and cns up replace it.
  assert.match(status.stdout, /so paired devices and commands that use the daemon get the older one\. Restart it: cns stop, then cns up\. Restarting ends the named sessions it holds\./);
  const json = JSON.parse((await cli(["status", "--json", "--state", state])).stdout);
  assert.deepEqual([json.version, json.daemon.version, json.daemon.executable], [CNS_VERSION, "0.9.0", olderCli]);
  assert.ok(json.daemon.warning.startsWith(warning.slice("Warning: ".length)));

  const up = await cli(upArgs);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /^Running as \S+ \(cns 0\.9\.0, pid \d+\)/);
  assert.ok(up.stderr.includes(warning), up.stderr);

  // A daemon on another version still serves paired devices: a warning, not a problem.
  const doctor = await cli(["doctor", "--json", "--state", state]);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.daemon.version, "0.9.0");
  assert.deepEqual(report.problems, []);
  assert.ok(report.warnings.some((line: string) => line.startsWith(warning.slice("Warning: ".length))), doctor.stdout);

  // Following the advice puts this cns in the daemon's place.
  assert.equal((await cli(["stop", "--state", state])).code, 0);
  const restarted = await cli(upArgs);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.match(restarted.stdout, new RegExp(`^Started as \\S+ \\(cns ${CNS_VERSION.replaceAll(".", "\\.")}, pid \\d+\\)`));
  assert.doesNotMatch(restarted.stderr, /The daemon runs/);
  assert.doesNotMatch((await cli(["status", "--state", state])).stdout, /Warning/);
});
