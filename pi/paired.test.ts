import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "../src/test-support.js";
import { connectPaired } from "./host.js";
import { parseTarget, targetLabel } from "./target.js";

const posix = process.platform !== "win32";

test("Pi attaches to a paired device by name over an encrypted link, within its grants", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-pi-paired-")));
  // Hooks run in the order they were added: stop the daemon, then remove the directory.
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir };
  };
  const studio = await device("studio");
  const pi = await device("pi");
  const reader = await device("reader");
  const cli = async (dev: { env: Record<string, string> }, args: string[]) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const port = await unusedPort("127.0.0.1");
  assert.equal((await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state])).code, 0);
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));
  const pair = async (other: typeof pi, grant: string) => {
    const inviting = launchCli(t, ["pair", "--yes", "--name", path.basename(other.dir), "--grant", grant, "--state", studio.state], { env: studio.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    assert.equal((await cli(other, ["pair", invite, "--yes", "--name", "studio"])).code, 0);
    assert.equal(await inviting.exited, 0);
  };
  const shellOnly = await device("shellonly");
  await pair(pi, "shell,files");
  await pair(reader, "files");
  await pair(shellOnly, "shell");

  const previous = process.env.CNS_CONFIG_DIR;
  t.after(() => { if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous; });
  process.env.CNS_CONFIG_DIR = pi.dir;
  const target = parseTarget("studio");
  assert.equal(target.kind, "paired");
  assert.equal(targetLabel(target), "studio");
  assert.deepEqual(parseTarget("elsewhere"), { kind: "url", url: "ws://elsewhere:47381/" }, "an unknown word is still a hostname");
  const host = await connectPaired(target as Extract<typeof target, { kind: "paired" }>, AbortSignal.timeout(10000));
  t.after(() => host.close());
  assert.equal(host.info.hostname, os.hostname());
  let output = "";
  const result = await host.exec("printf from-studio", host.home, { onData: (data: Buffer) => { output += data.toString(); }, signal: AbortSignal.timeout(10000) } as never);
  assert.deepEqual([result.exitCode, output], [0, "from-studio"]);
  host.close();

  // A device granted only files can read there, but Pi's commands are refused there.
  process.env.CNS_CONFIG_DIR = reader.dir;
  const limited = await connectPaired(parseTarget("studio") as never, AbortSignal.timeout(10000));
  t.after(() => limited.close());
  assert.equal((await limited.stat(limited.home)).kind, "directory");
  await assert.rejects(limited.exec("printf x", limited.home, { onData: () => {}, signal: AbortSignal.timeout(10000) } as never), /Permission denied: shell not granted to reader/);

  // A device granted only shell attaches: bash works, and the file tools say what is missing.
  process.env.CNS_CONFIG_DIR = shellOnly.dir;
  const shelled = await connectPaired(parseTarget("studio") as never, AbortSignal.timeout(10000));
  t.after(() => shelled.close());
  let ran = "";
  await shelled.exec("printf shell-only", shelled.home, { onData: (data: Buffer) => { ran += data.toString(); }, signal: AbortSignal.timeout(10000) } as never);
  assert.equal(ran, "shell-only");
  await assert.rejects(shelled.stat(shelled.home), /Permission denied: files not granted/);

  // A saved name that cannot be read is an error, never a hostname; an address alias is its URL.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(shellOnly.dir, "peers", "broken"), '{"version":9}', { mode: 0o600 });
  assert.throws(() => parseTarget("broken"), /The saved peer broken cannot be read/);
  assert.equal((await cli(shellOnly, ["peer", "add", "box", "ws://127.0.0.1:1"])).code, 0);
  assert.deepEqual(parseTarget("box"), { kind: "url", url: "ws://127.0.0.1:1/" });
});
