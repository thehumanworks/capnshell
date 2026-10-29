import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execa } from "execa";
import { cliEnvironment, cliInvocation } from "./test-support.js";

function runCli(args: string[], cwd: string, reject = true) {
  const invocation = cliInvocation(args);
  return execa(invocation.file, invocation.args, { cwd, reject, env: cliEnvironment() });
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns cli test "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the CLI exposes only cross-platform peer commands with side-effect-free help", async (t) => {
  const cwd = await temporaryDirectory(t);
  const { stdout } = await runCli(["--help"], cwd);
  for (const command of ["listen", "connect", "run", "attach", "stop"]) {
    assert.ok(stdout.includes(command));
    const result = await runCli([command, "--help"], cwd);
    assert.match(result.stdout, /Usage: cns/);
    assert.doesNotMatch(result.stdout, /listening at/);
    if (command === "run" || command === "listen") {
      assert.match(result.stdout, /CNS_BIND/);
      assert.match(result.stdout, /CNS_PORT/);
    }
    if (command === "run") assert.match(result.stdout, /CNS_CWD/);
  }
  assert.doesNotMatch(stdout, /bundle-mac|install-windows|integration-smoke|\bwindows\b|\bwsl\b/);
  assert.deepEqual(await readdir(cwd), []);
});

test("CLI syntax errors and removed setup commands exit nonzero without side effects", async (t) => {
  const cwd = await temporaryDirectory(t);
  for (const args of [[], ["unknown"], ["connect"], ["listen", "--bogus"],
    ["run"], ["run", "ws://127.0.0.1:1"],
    ["run", "ws://127.0.0.1:1", "echo bad"],
    ["run", "ws://127.0.0.1:1", "--", "echo", "bad"],
    ["run", "ws://127.0.0.1:1", "--", ""],
    ["bundle-mac"], ["install-windows"], ["integration-smoke"], ["windows"], ["wsl"]]) {
    const result = await runCli(args, cwd, false);
    assert.notEqual(result.exitCode, 0, `Expected rejection: ${args.join(" ")}`);
    assert.ok(result.stderr.length > 0);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("compiled CLI runs outside its checkout without a JS runtime on PATH", { skip: !process.env.CAPNWEB_TEST_BINARY }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const invocation = cliInvocation([]);
  const executable = path.join(cwd, process.platform === "win32" ? "cns.exe" : "cns");
  await copyFile(invocation.file, executable);
  const result = await execa(executable, ["--help"], { cwd, env: { PATH: "" } });
  assert.match(result.stdout, /Usage: cns/);
  assert.equal(result.exitCode, 0);
});
