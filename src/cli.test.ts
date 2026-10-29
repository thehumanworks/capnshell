import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { cliInvocation } from "./test-support.js";
import { execa } from "execa";
import { list } from "tar";
import { installWindowsCopy } from "./commands/install-windows.js";
import { PROJECT_FILES, PROJECT_ROOT } from "./project.js";

function runCli(args: string[], cwd: string, reject = true) {
  const invocation = cliInvocation(args);
  return execa(invocation.file, invocation.args, { cwd, reject });
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "capnweb cli test "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the CLI exposes peer and setup commands with side-effect-free help", async (t) => {
  const cwd = await temporaryDirectory(t);
  const { stdout } = await runCli(["--help"], cwd);
  for (const command of ["listen", "connect", "windows", "wsl", "bundle-mac", "install-windows", "integration-smoke"]) {
    assert.ok(stdout.includes(command));
    const result = await runCli([command, "--help"], cwd);
    assert.match(result.stdout, /Usage: capnweb-shell/);
    assert.doesNotMatch(result.stdout, /listening at|Created |Installed the native/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("CLI syntax errors exit nonzero rather than starting a peer or an installer", async (t) => {
  const cwd = await temporaryDirectory(t);
  for (const args of [[], ["unknown"], ["connect"], ["listen", "--bogus"],
    ["bundle-mac", "--output"], ["install-windows", "--bogus"], ["integration-smoke", "--bogus"]]) {
    const result = await runCli(args, cwd, false);
    assert.notEqual(result.exitCode, 0, `Expected rejection: ${args.join(" ")}`);
    assert.ok(result.stderr.length > 0);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("bundle-mac works outside the project and archives src without wrappers or dependencies", async (t) => {
  const cwd = await temporaryDirectory(t);
  const output = path.join(cwd, "portable bundle.tar.gz");
  const result = await runCli(["bundle-mac", "--source", PROJECT_ROOT, "--output", "portable bundle.tar.gz"], cwd);
  assert.ok(result.stdout.includes(output));
  const entries: string[] = [];
  await list({ file: output, onReadEntry: (entry) => { entries.push(entry.path); } });
  for (const entry of ["package.json", "bun.lock", "flake.nix", "flake.lock", "tsconfig.json", "src/cli.ts",
    "src/commands/peer.ts", "src/commands/bundle.ts", "src/commands/install-windows.ts", "src/shell.ts"]) {
    assert.ok(entries.includes(`capnweb-shell/${entry}`), `Missing ${entry}`);
  }
  assert.ok(entries.every((entry) => entry.startsWith("capnweb-shell/")));
  assert.ok(entries.every((entry) => !/\.(sh|cmd|ps1|mjs)$|\/node_modules\/|\/build\//.test(entry)));
});

test("Windows copy installation copies src and runs local dependency install before compilation", async (t) => {
  const destination = path.join(await temporaryDirectory(t), "installed copy");
  const calls: string[][] = [];
  await installWindowsCopy(destination, PROJECT_ROOT, async (args, cwd) => {
    assert.equal(cwd, await realpath(destination));
    assert.match(await readFile(path.join(destination, "src", "cli.ts"), "utf8"), /createCli/);
    calls.push(args);
  });
  assert.deepEqual(calls, [
    ["install", "--frozen-lockfile", "--ignore-scripts"], ["run", "build"],
  ]);
  assert.deepEqual((await readdir(destination)).sort(), [...PROJECT_FILES].sort());
  await writeFile(path.join(destination, "user-notes.txt"), "preserve me");
  await installWindowsCopy(destination, PROJECT_ROOT, async () => {});
  assert.equal(await readFile(path.join(destination, "user-notes.txt"), "utf8"), "preserve me");
});

test("Windows copy installation protects other projects and overlapping destinations", async (t) => {
  const destination = await temporaryDirectory(t);
  const shouldNotRun = async () => { assert.fail("Bun must not run for an invalid destination"); };
  await writeFile(path.join(destination, "notes.txt"), "not an application");
  await assert.rejects(installWindowsCopy(destination, PROJECT_ROOT, shouldNotRun), /Refusing to overwrite/);
  await writeFile(path.join(destination, "package.json"), JSON.stringify({ name: "another-project" }));
  await assert.rejects(installWindowsCopy(destination, PROJECT_ROOT, shouldNotRun), /another project/);
  await assert.rejects(installWindowsCopy(PROJECT_ROOT, PROJECT_ROOT, shouldNotRun), /overlap/);
  await assert.rejects(installWindowsCopy(path.join(PROJECT_ROOT, "nested-install"), PROJECT_ROOT, shouldNotRun), /overlap/);
  await assert.rejects(installWindowsCopy(path.dirname(PROJECT_ROOT), PROJECT_ROOT, shouldNotRun), /overlap/);
  await assert.rejects(installWindowsCopy("relative", PROJECT_ROOT, shouldNotRun), /absolute/);
});

test("Windows copy installation propagates Bun failure and does not continue to build", async (t) => {
  const destination = await temporaryDirectory(t);
  let calls = 0;
  await assert.rejects(installWindowsCopy(destination, PROJECT_ROOT, async () => {
    calls++;
    throw new Error("simulated Bun failure");
  }), /simulated Bun failure/);
  assert.equal(calls, 1);
});

test("compiled CLI runs outside its checkout without a JS runtime on PATH", { skip: !process.env.CAPNWEB_TEST_BINARY }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const invocation = cliInvocation([]);
  const executable = path.join(cwd, process.platform === "win32" ? "standalone.exe" : "standalone");
  await copyFile(invocation.file, executable);
  const result = await execa(executable, ["--help"], {
    cwd, env: { PATH: "", CAPNWEB_SOURCE_DIR: "" },
  });
  assert.match(result.stdout, /Usage: capnweb-shell/);
  assert.equal(result.exitCode, 0);
});

test("source-based commands reject an incomplete explicit checkout without writing output", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await runCli(["bundle-mac", "--source", cwd, "--output", path.join(cwd, "bad.tar.gz")], cwd, false);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /complete source checkout/);
  assert.deepEqual(await readdir(cwd), []);
});
