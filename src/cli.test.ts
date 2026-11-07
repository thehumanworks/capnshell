import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
  for (const command of ["listen", "connect", "run", "tty", "cp", "sessions", "keys", "screen", "kill", "attach", "stop"]) {
    assert.ok(stdout.includes(command));
    const result = await runCli([command, "--help"], cwd);
    assert.match(result.stdout, /Usage: cns/);
    assert.doesNotMatch(result.stdout, /listening at/);
    if (command !== "connect" && command !== "attach" && command !== "stop") {
      assert.match(result.stdout, /CNS_BIND/);
      assert.match(result.stdout, /CNS_PORT/);
    }
    if (command === "run" || command === "tty") assert.match(result.stdout, /CNS_CWD/);
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
    ["tty", "htop"], ["tty", "--", "echo", "bad"], ["tty", "--cols", "0"], ["tty", "--history", "5"],
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

test("the device identity is created once and reported consistently", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const env = { ...cliEnvironment(), CNS_CONFIG_DIR: path.join(cwd, "config") };
  await mkdir(env.CNS_CONFIG_DIR, { mode: 0o700 });
  const call = (args: string[]) => { const invocation = cliInvocation(args); return execa(invocation.file, invocation.args, { cwd, env }); };
  const first = await call(["identity"]);
  assert.match(first.stderr, /Created this device's identity/);
  const [fingerprintLine, keyLine] = first.stdout.split("\n");
  assert.match(fingerprintLine!, /^Fingerprint: [a-z2-7]{4}(-[a-z2-7]{4}){5}$/);
  assert.match(keyLine!, /^Public key:  [A-Za-z0-9_-]{43}$/);
  const second = await call(["identity", "--json"]);
  assert.equal(second.stderr, "");
  const json = JSON.parse(second.stdout);
  assert.deepEqual(Object.keys(json), ["publicKey", "fingerprint", "createdAt", "path"]);
  assert.equal(`Public key:  ${json.publicKey}`, keyLine);
  assert.equal(`Fingerprint: ${json.fingerprint}`, fingerprintLine);
  assert.equal(json.path, path.join(env.CNS_CONFIG_DIR, "identity.json"));
});

test("saved peer addresses persist across CLI invocations", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const env = { ...cliEnvironment(), CNS_CONFIG_DIR: path.join(cwd, "config") };
  await mkdir(env.CNS_CONFIG_DIR, { mode: 0o700 });
  async function call(args: string[], reject = true) {
    const invocation = cliInvocation(args);
    return execa(invocation.file, invocation.args, { cwd, reject, env });
  }
  // An empty address book lists nothing as text and an empty array as JSON.
  assert.equal((await call(["peer", "list"])).stdout, "");
  assert.deepEqual(JSON.parse((await call(["peer", "list", "--json"])).stdout), []);
  await call(["peer", "add", "studio", "ws://127.0.0.1:12345"]);
  await call(["peer", "add", "build", "ws://127.0.0.1:12346"]);
  assert.match((await call(["peer", "list"])).stdout, /studio\s+ws:\/\/127\.0\.0\.1:12345\//);
  // JSON lists the same entries, sorted by name, with name before url in each object.
  const json = (await call(["peer", "list", "--json"])).stdout;
  assert.deepEqual(JSON.parse(json), [{ name: "build", url: "ws://127.0.0.1:12346/" }, { name: "studio", url: "ws://127.0.0.1:12345/" }]);
  assert.deepEqual(JSON.parse(json).map((peer: object) => Object.keys(peer)), [["name", "url"], ["name", "url"]]);
  await call(["peer", "remove", "build"]);
  assert.notEqual((await call(["peer", "add", "studio", "ws://127.0.0.1:12346"], false)).exitCode, 0);
  // Errors are the same with --json: a message on stderr, nothing on stdout and a failing status.
  await chmod(env.CNS_CONFIG_DIR, 0o755);
  for (const args of [["peer", "list"], ["peer", "list", "--json"]]) {
    const unsafe = await call(args, false);
    assert.deepEqual([unsafe.exitCode, unsafe.stdout], [1, ""]);
    assert.match(unsafe.stderr, /directory must be private/);
  }
  await chmod(env.CNS_CONFIG_DIR, 0o700);
  await call(["peer", "remove", "studio"]);
  const missing = await call(["run", "--peer", "studio", "--", "pwd"], false);
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /Unknown peer alias/);
});
