import assert from "node:assert/strict";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { GrantedShell } from "./granted-shell.js";
import { expandGrants } from "./peers.js";
import { PtyRegistry, ShellApi, type PtyExit } from "./shell.js";

const windows = process.platform === "win32";

test("a granted shell allows exactly what was granted and refuses the rest without side effects", { skip: windows }, async (t) => {
  const shell = new ShellApi();
  const granted = new GrantedShell(shell, expandGrants(["files", "sessions:list"]), "laptop");
  t.after(() => granted[Symbol.dispose]());
  assert.equal(granted.info().pid, process.pid);
  assert.equal(granted.grants, "files, sessions:list");
  assert.equal((await granted.stat("/")).kind, "directory");
  await assert.rejects(async () => { await granted.writeFileAt("relative", new Uint8Array()); }, /absolute/);
  assert.deepEqual(granted.ptySessions(), []);
  await assert.rejects(async () => { await granted.run("printf x"); }, /Permission denied: shell not granted to laptop/);
  assert.throws(() => granted.fork(), /shell not granted/);
  assert.throws(() => granted.startPtySession("work", { command: "true" }), /sessions:create not granted/);
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
  await assert.rejects(async () => { await remote.writeFileAt("/tmp/never", new Uint8Array(1)); }, /files not granted/);
  // Exec input is a stub the executing side reads from until it ends.
  class Collect extends RpcTarget { text = ""; output(_stream: string, data: Uint8Array) { this.text += new TextDecoder().decode(data); } }
  class Input extends RpcTarget {
    #chunks = ["over ", "rpc"];
    read() { const next = this.#chunks.shift(); return next === undefined ? null : new TextEncoder().encode(next); }
  }
  const collect = new Collect();
  const result = await remote.exec(collect, "cat", {}, new Input());
  assert.equal(result.exitCode, 0);
  assert.equal(collect.text, "over rpc");
});

test("session handles check viewing, typing and killing separately, and owners keep their own sessions", { skip: windows }, async (t) => {
  const registry = new PtyRegistry();
  t.after(() => registry[Symbol.dispose]());
  const local = new ShellApi(registry);
  t.after(() => local[Symbol.dispose]());
  const host = local.startPtySession("host", { command: "printf READY; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done" });
  await host.wait({ text: "READY", timeoutMs: 10000 });
  const as = (grants: string[], owner = "laptop-fingerprint") => {
    const shell = new GrantedShell(new ShellApi(registry, { owner }), expandGrants(grants), "laptop", owner);
    t.after(() => shell[Symbol.dispose]());
    return shell;
  };

  // View only: read the screen and watch, but not type, resize or kill.
  const viewer = as(["sessions:list", "sessions:view"]);
  assert.equal(viewer.ptySessions()[0]?.owner, null, "a session started on the host has no paired owner");
  const watched = viewer.ptySession("host");
  assert.match((await watched.capture()).text, /READY/);
  assert.throws(() => watched.keys(["x"]), /sessions:control not granted to laptop/);
  assert.throws(() => watched.resize(100, 40), /sessions:control/);
  await assert.rejects(async () => { await watched.kill(); }, /sessions:kill/);
  const output: string[] = [];
  const sink = { output(data: Uint8Array) { output.push(new TextDecoder().decode(data)); }, exit(_: PtyExit) {} };
  const before = host.info();
  const attachment = watched.attach(sink, { cols: 120, rows: 50 });
  assert.deepEqual([host.info().cols, host.info().rows], [before.cols, before.rows], "a viewer cannot resize the session");
  assert.throws(() => attachment.write("x"), /sessions:control/);
  host.keys(["seen", "Enter"]);
  await host.wait({ text: "got:seen", timeoutMs: 10000 });
  attachment.detach();
  assert.throws(() => as(["sessions:list"]).ptySession("host"), /sessions:view not granted/);

  // Control: type, but not kill someone else's session.
  const typist = as(["sessions:view", "sessions:control"]);
  typist.ptySession("host").keys(["typed", "Enter"]);
  assert.equal((await host.wait({ text: "got:typed", timeoutMs: 10000 })).matched, true);
  await assert.rejects(async () => { await typist.ptySession("host").kill(); }, /sessions:kill not granted/);

  // Create only: the device owns what it starts, so it may view, type into and kill that, and only that.
  const creator = as(["sessions:create"]);
  const own = creator.startPtySession("mine", { command: "printf OWN; sleep 30" });
  assert.equal(own.info().owner, "laptop-fingerprint");
  assert.equal((await own.wait({ text: "OWN", timeoutMs: 10000 })).matched, true);
  own.keys(["x"]);
  // A handle on someone else's session does nothing for it.
  assert.throws(() => creator.ptySession("host").info(), /sessions:view not granted/);
  assert.throws(() => creator.ptySession("host").keys(["x"]), /sessions:control not granted/);
  const reopened = creator.ptySession("mine");
  assert.equal((await reopened.kill()).signal, "SIGHUP");
  assert.deepEqual(local.ptySessions().map((session) => session.name), ["host"]);
  // Another device with the same grants does not own it.
  const other = as(["sessions:create"], "studio-fingerprint");
  other.startPtySession("theirs", { command: "sleep 30" })[Symbol.dispose]();
  assert.throws(() => creator.ptySession("theirs").info(), /sessions:view not granted/);
  // Killing needs only sessions:kill; a device without any session permission learns nothing.
  const killer = as(["sessions:kill"]);
  assert.throws(() => killer.ptySession("theirs").info(), /sessions:view not granted/);
  assert.equal((await killer.ptySession("theirs").kill()).signal, "SIGHUP");
  assert.throws(() => as(["shell"]).ptySession("missing-or-not"), /sessions:view not granted/);
});
