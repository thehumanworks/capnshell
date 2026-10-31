import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test, { type TestContext } from "node:test";
import { buildPiPackage, PACKAGE_NAME } from "../scripts/build-pi-package.js";
import { connectControl } from "../src/commands/daemon.js";
import { daemonHome, launchCli, PROJECT_ROOT, unusedPort } from "../src/test-support.js";
import { BUN_PACKAGES } from "./program.js";

const posix = process.platform !== "win32";
const bunPackage = BUN_PACKAGES[`${process.platform}-${process.arch}`]?.[0];

/** Node 22.19 or newer, which Pi needs. */
function suitableNode(): string | undefined {
  const node = Bun.which("node");
  if (!node) return undefined;
  const [major = 0, minor = 0] = spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim().slice(1).split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19) ? node : undefined;
}
const node = suitableNode();
// Not this checkout's node_modules/.bin/pi, which `bun run` puts on PATH: that is the Node one.
const installedPi = Bun.which("pi", {
  PATH: (process.env.PATH ?? "").split(path.delimiter).filter((directory) => !path.resolve(directory).startsWith(PROJECT_ROOT)).join(path.delimiter),
});
/** Pi as npm installs it, on Node, and the installed Pi, which is usually Bun's single-file executable. */
const runtimes: [string, { file: string; args: string[] } | undefined][] = [
  ["Node", node ? { file: node, args: [path.join(PROJECT_ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")] } : undefined],
  ["the installed pi", installedPi ? { file: installedPi, args: [] } : undefined],
];

async function temporaryDirectory(t: TestContext, prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

/**
 * The package as npm would install it: in node_modules, beside this platform's
 * Bun package, here a link to the Bun running the tests.
 */
async function install(t: TestContext): Promise<string> {
  const root = await temporaryDirectory(t, "cns-pkg-install-");
  const modules = path.join(root, "node_modules");
  const extension = path.join(modules, ...PACKAGE_NAME.split("/"));
  await buildPiPackage(extension);
  const bun = path.join(modules, ...bunPackage!.split("/"));
  await mkdir(path.join(bun, "bin"), { recursive: true });
  await writeFile(path.join(bun, "package.json"), JSON.stringify({ name: bunPackage, version: Bun.version }));
  await symlink(process.execPath, path.join(bun, "bin", "bun"));
  return extension;
}

interface RpcMessage { type: string; id?: string; method?: string; message?: string; statusText?: string; success?: boolean; data?: any; error?: string }

/** Pi in RPC mode with only the packaged extension, as JSON lines in both directions. */
function rpcPi(t: TestContext, runtime: { file: string; args: string[] }, extension: string, options: { cwd: string; env: NodeJS.ProcessEnv }) {
  const child = spawn(runtime.file, [...runtime.args, "--mode", "rpc", "--no-extensions", "--no-session", "-e", path.join(extension, "index.js")], {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: RpcMessage[] = [];
  const waiting = new Set<() => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try { messages.push(JSON.parse(line)); } catch { return; }
    for (const check of waiting) check();
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  t.after(async () => {
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
  });
  let next = 0;
  const pi = {
    messages,
    /** The first message, from the start, that matches. */
    waitFor(match: (message: RpcMessage) => boolean, what: string): Promise<RpcMessage> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(check);
          reject(new Error(`Waiting for ${what}. Pi said:\n${messages.map((message) => JSON.stringify(message)).join("\n")}\n${stderr}`));
        }, 20000);
        const check = () => {
          const found = messages.find(match);
          if (!found) return;
          clearTimeout(timer);
          waiting.delete(check);
          resolve(found);
        };
        waiting.add(check);
        check();
      });
    },
    notice: (text: string) => pi.waitFor((message) => message.method === "notify" && !!message.message?.includes(text), `a notice with ${text}`),
    status: (text: string) => pi.waitFor((message) => message.method === "setStatus" && !!message.statusText?.includes(text), `a status with ${text}`),
    async request(command: Record<string, unknown>): Promise<RpcMessage> {
      const id = `test-${++next}`;
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      const response = await pi.waitFor((message) => message.type === "response" && message.id === id, `the response to ${JSON.stringify(command)}`);
      assert.equal(response.success, true, response.error ?? JSON.stringify(response));
      return response;
    },
  };
  return pi;
}

for (const [name, runtime] of runtimes) {
  test(`the npm package runs in Pi on ${name} with nothing else installed, listening because of CNS_LISTEN`, {
    skip: !posix || !bunPackage || !runtime, timeout: 90000,
  }, async (t) => {
    const extension = await install(t);
    const { home, statePath } = await daemonHome(t, "cns-pkg-home-");
    const peerHome = await temporaryDirectory(t, "cns-pkg-peer-");
    // Pi starts in a project, and the daemon in the home directory: Bun settings in
    // either must not reach the daemon.
    const project = await temporaryDirectory(t, "cns-pkg-project-");
    for (const directory of [project, home]) {
      await writeFile(path.join(directory, "bunfig.toml"), `preload = ["./preload.js"]\n`);
      await writeFile(path.join(directory, "preload.js"), `require("node:fs").writeFileSync(${JSON.stringify(path.join(directory, "PRELOADED"))}, "");\n`);
      await writeFile(path.join(directory, ".env"), `CNS_LEAKED=${directory}\n`);
    }
    const port = await unusedPort("127.0.0.1");

    // No bun and no cns on PATH: the package brings both.
    const pi = rpcPi(t, runtime!, extension, {
      cwd: project,
      env: { PATH: "/usr/bin:/bin", HOME: home, PI_OFFLINE: "1", CNS_LISTEN: "1", CNS_BIND: "127.0.0.1", CNS_PORT: port },
    });
    await pi.notice(`listening on 127.0.0.1:${port}`);
    await pi.status(`listening 127.0.0.1:${port}`);
    const started = await pi.notice("Started the cns daemon");
    assert.doesNotMatch(started.message!, /WARNING/, "a loopback listener is not exposed");
    const control = await connectControl(statePath);
    t.after(() => control.close());

    launchCli(t, ["connect", `ws://127.0.0.1:${port}`, "--no-repl"], { env: { HOME: peerHome } });
    const deadline = Date.now() + 10000;
    while ((await control.controller.peers()).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    await pi.request({ type: "prompt", message: "/cns attach p1" });
    await pi.notice("Attached to p1");
    const remote = await pi.request({ type: "bash", command: "pwd; printf '[%s]' \"$CNS_LEAKED\"" });
    assert.equal(remote.data.output, `${peerHome}\n[]`);
    assert.equal(remote.data.exitCode, 0);

    // The daemon runs commands without the Bun settings of the project or the home directory.
    const run = launchCli(t, ["run", `ws://127.0.0.1:${port}`, "--", "pwd; printf '[%s]' \"$CNS_LEAKED\""]);
    assert.equal(await run.exited, 0, run.output);
    assert.equal(run.stdout, `${home}\n[]`);
    for (const directory of [project, home]) await assert.rejects(stat(path.join(directory, "PRELOADED")), { code: "ENOENT" });
    const logs = (await readdir(path.join(home, ".cns"))).filter((file) => file.endsWith(".log"));
    assert.equal(logs.length, 1);
    const log = await readFile(path.join(home, ".cns", logs[0]!), "utf8");
    assert.doesNotMatch(log, /error/i, log);
  });
}

test("the package names its Bun and only the host's modules", { skip: !bunPackage }, async (t) => {
  const extension = await buildPiPackage(await temporaryDirectory(t, "cns-pkg-build-"));
  const manifest = JSON.parse(await readFile(path.join(extension, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi, { extensions: ["./index.js"] });
  assert.ok(manifest.optionalDependencies[bunPackage!], "this platform's Bun is a dependency");
  assert.equal(manifest.dependencies, undefined, "everything else is bundled");
  for (const file of manifest.files) await stat(path.join(extension, file));
  const imports = [...(await readFile(path.join(extension, "index.js"), "utf8")).matchAll(/^import\s[^;]*?\bfrom "([^"]+)";$/gm)].map((match) => match[1]!);
  assert.deepEqual([...new Set(imports.filter((name) => !name.startsWith("node:")))].sort(), Object.keys(manifest.peerDependencies).sort());
});
