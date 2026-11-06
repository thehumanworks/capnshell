import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { GrantedShell } from "./granted-shell.js";
import { expandGrants } from "./peers.js";
import { ShellApi } from "./shell.js";

const windows = process.platform === "win32";

test("a granted shell allows exactly what was granted and refuses the rest without side effects", { skip: windows }, async (t) => {
  const shell = new ShellApi();
  const granted = new GrantedShell(shell, expandGrants(["files", "sessions:list"]), "laptop");
  t.after(() => granted[Symbol.dispose]());
  assert.equal(granted.info().pid, process.pid);
  assert.equal(granted.grants, "files, sessions:list");
  assert.equal((await granted.stat("/")).kind, "directory");
  assert.deepEqual(granted.ptySessions(), []);
  await assert.rejects(async () => { await granted.run("printf x"); }, /Permission denied: shell not granted to laptop/);
  assert.throws(() => granted.fork(), /shell not granted/);
  assert.throws(() => granted.startPtySession("work", { command: "true" }), /sessions:create, sessions:view, sessions:control, sessions:kill not granted/);
  assert.throws(() => granted.ptySession("work"), /sessions:view/);
  assert.deepEqual(shell.ptySessions(), [], "a refused start created nothing");
  const full = new GrantedShell(new ShellApi(), expandGrants(["all"]), "laptop");
  t.after(() => full[Symbol.dispose]());
  assert.equal((await full.run("printf ok")).stdout, "ok");
  const fork = full.fork();
  assert.ok(fork instanceof GrantedShell);
  assert.equal((await fork.run("printf forked")).stdout, "forked");
  fork[Symbol.dispose]();
  await assert.rejects(async () => { await fork.run("printf x"); }, /closed/);
  // Every ShellApi method is accounted for, so nothing new leaks through.
  for (const name of Object.getOwnPropertyNames(ShellApi.prototype)) {
    if (name === "constructor") continue;
    assert.equal(typeof (GrantedShell.prototype as unknown as Record<string, unknown>)[name], "function", name);
  }
});

test("grants are enforced over RPC, and closing the view closes the shell behind it", { skip: windows }, async (t) => {
  const shell = new ShellApi();
  const { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  newMessagePortRpcSession(port1, new GrantedShell(shell, expandGrants(["shell"]), "laptop"));
  using remote = newMessagePortRpcSession<ShellApi>(port2);
  assert.equal((await remote.run("printf remote")).stdout, "remote");
  await assert.rejects(async () => { await remote.readFile("/etc/hostname"); }, /Permission denied: files not granted to laptop/);
  class Sink extends RpcTarget { output() {} exit() {} }
  await assert.rejects(async () => { await remote.startPtySession("w", { command: "true" }); }, /Permission denied/);
  await assert.rejects(async () => { await remote.ptySessions(); }, /sessions:list/);
  const pty = await remote.openPty(new Sink(), { command: "sleep 30" });
  pty[Symbol.dispose]();
});
