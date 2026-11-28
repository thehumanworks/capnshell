import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { AuditEntry, AuditLog } from "./audit.js";
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

test("skills are read with the skills grant, or with files, which reads them anyway, and refused otherwise", async (t) => {
  const views = (["skills", "files", "shell"] as const).map((grant) => new GrantedShell(new ShellApi(), expandGrants([grant]), "laptop"));
  t.after(() => { for (const view of views) view[Symbol.dispose](); });
  const [skills, files, shell] = views;
  for (const view of [skills!, files!]) {
    assert.ok(Array.isArray(await view.skills()));
    await assert.rejects(async () => { await view.skillFiles("../escape"); }, /A skill's name/);
  }
  assert.throws(() => shell!.skills(), /Permission denied: skills not granted to laptop/);
  assert.throws(() => shell!.readSkillFile("pdf", "SKILL.md"), /Permission denied: skills not granted/);
  // skills reads skills alone: no other file, and nothing it may change.
  assert.throws(() => skills!.readFile("/etc/hostname"), /Permission denied: files not granted/);
  assert.throws(() => skills!.setModified("/tmp/x", 0), /Permission denied: files not granted/);
  assert.equal(skills!.grants, "skills");
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

test("any paired device may ask where this device is reachable and what it may do here, and a fork answers the same", { skip: windows }, (t) => {
  let addresses = ["ws://10.0.0.7:47381"];
  const granted = new GrantedShell(new ShellApi(), [], "laptop", null, () => addresses);
  t.after(() => granted[Symbol.dispose]());
  assert.deepEqual(granted.addresses(), ["ws://10.0.0.7:47381"]);
  addresses = ["ws://192.168.1.4:47381"];
  assert.deepEqual(granted.addresses(), ["ws://192.168.1.4:47381"], "asked live, not when the link was made");
  const full = new GrantedShell(new ShellApi(), expandGrants(["shell"]), "laptop", null, () => addresses);
  t.after(() => full[Symbol.dispose]());
  const fork = full.fork();
  t.after(() => fork[Symbol.dispose]());
  assert.deepEqual(fork.addresses(), addresses);
  assert.deepEqual(new GrantedShell(new ShellApi(), [], "laptop").addresses(), []);
  // What the peer may do here is reported as it stands, also without any grant.
  assert.deepEqual(granted.granted(), []);
  assert.deepEqual(fork.granted(), ["shell"]);
  // So are this device's network cards, for cns wake, asked live too.
  let cards = [{ mac: "3c:22:fb:12:34:56", cidr: "192.168.1.23/24" }];
  const lan = new GrantedShell(new ShellApi(), [], "laptop", null, () => [], () => [], () => [], undefined, () => {}, () => cards);
  t.after(() => lan[Symbol.dispose]());
  assert.deepEqual(lan.lan(), [{ mac: "3c:22:fb:12:34:56", cidr: "192.168.1.23/24" }]);
  cards = [];
  assert.deepEqual(lan.lan(), []);
  assert.deepEqual(granted.lan(), []);
});

test("a granted shell records what the peer does, by name and fingerprint, with secret names and never their values", { skip: windows }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cns-audited-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries: AuditEntry[] = [];
  const registry = new PtyRegistry();
  t.after(() => registry[Symbol.dispose]());
  const secretsHere = { list: () => [], variables: () => ({ API_KEY: "sk-secret-value" }) };
  const as = (grants: string[], audit: AuditLog = (entry) => entries.push(entry)) => {
    const shell = new GrantedShell(new ShellApi(registry, { owner: "k7qm" }), expandGrants(grants), "laptop", "k7qm", undefined, undefined, undefined, secretsHere, audit);
    t.after(() => shell[Symbol.dispose]());
    return shell;
  };
  const shell = as(["all"]);
  const recorded = (action: string) => entries.filter((entry) => entry.action === action && entry.phase === undefined);
  const started = () => entries.filter((entry) => entry.phase === "start").map((entry) => [entry.action, entry.target, entry.end, entry.exitCode]);
  async function eventually(action: string) {
    for (const deadline = Date.now() + 10000; !recorded(action).length;) {
      if (Date.now() > deadline) assert.fail(`No ${action} entry: ${JSON.stringify(entries)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // A command, with the mesh secret it got here and the caller's variables, by name only. Its start
  // is recorded while it runs, so a command that never ends still leaves a line.
  const running = shell.run('printf %s "$API_KEY$CALLER"; exit 3', { cwd: dir, secrets: ["home:API_KEY"], env: { CALLER: "caller-secret" } });
  assert.deepEqual([started(), recorded("run")], [[["run", 'printf %s "$API_KEY$CALLER"; exit 3', undefined, undefined]], []]);
  const result = await running;
  assert.deepEqual([result.stdout, result.exitCode], ["sk-secret-valuecaller-secret", 3]);
  const [run] = recorded("run");
  // The start line is the end line without how it ended, with the same id, so cns audit can pair them.
  assert.deepEqual({ ...entries[0], phase: undefined, end: undefined, exitCode: undefined }, { ...run, phase: undefined, end: undefined, exitCode: undefined });
  assert.deepEqual({ ...run, start: undefined, end: undefined, id: undefined }, {
    start: undefined, end: undefined, id: undefined, action: "run", target: 'printf %s "$API_KEY$CALLER"; exit 3', cwd: dir,
    secrets: ["home:API_KEY"], variables: ["CALLER"], exitCode: 3, peer: "laptop", fingerprint: "k7qm",
  });
  assert.match(run!.id!, /^[\w-]{8}$/);
  assert.ok(Date.parse(run!.end!) >= Date.parse(run!.start));
  class Sink extends RpcTarget { output() {} }
  assert.equal((await shell.exec(new Sink(), "exit 4")).exitCode, 4);
  assert.deepEqual(recorded("run").map((entry) => [entry.target, entry.exitCode]), [['printf %s "$API_KEY$CALLER"; exit 3', 3], ["exit 4", 4]]);
  assert.notEqual(recorded("run")[1]!.id, run!.id, "each command has an id of its own");

  // A secret the caller opened with cns run --secret travels as a variable: its name is recorded, never its value.
  assert.equal((await shell.run('printf %s "$OPENAI_API_KEY"', { env: { OPENAI_API_KEY: "sk-opened-by-caller" } })).stdout, "sk-opened-by-caller");
  const opened = recorded("run").at(-1)!;
  assert.deepEqual([opened.variables, opened.secrets], [["OPENAI_API_KEY"], undefined]);

  // A file read or written in parts is one entry; reading it again is another, and so is a read from the middle.
  const file = path.join(dir, "notes.txt");
  const other = path.join(dir, "other.txt");
  await writeFile(file, "0123456789");
  await writeFile(other, "0123456789");
  for (const offset of [0, 4, 8, 0]) await shell.readFile(file, { offset, length: 4 });
  await shell.readFile(other, { offset: 4, length: 4 });
  assert.deepEqual(recorded("file.read").map((entry) => entry.target), [file, file, other]);
  const copy = path.join(dir, "copy.txt");
  await shell.writeFileAt(copy, new Uint8Array(3), { offset: 0, truncate: true });
  await shell.writeFileAt(copy, new Uint8Array(3), { offset: 3 });
  await shell.writeFile(path.join(dir, "whole.txt"), new Uint8Array(1));
  await shell.mkdir(path.join(dir, "made"));
  assert.deepEqual(recorded("file.write").map((entry) => entry.target), [copy, path.join(dir, "whole.txt")]);
  assert.deepEqual(recorded("file.mkdir").map((entry) => entry.target), [path.join(dir, "made")]);

  // A session's start, each attach but nothing typed through it, its kill and its end.
  const session = shell.startPtySession("work", { command: "sleep 30", secrets: ["API_KEY"] });
  assert.deepEqual(recorded("session.start").map((entry) => [entry.target, entry.command, entry.secrets]), [["work", "sleep 30", ["API_KEY"]]]);
  const attachment = shell.ptySession("work").attach({ output() {}, exit() {} });
  const before = entries.length;
  attachment.write("hunter2\r");
  attachment.keys(["Enter"]);
  attachment.detach();
  assert.equal(entries.length, before, "typing is never recorded");
  assert.deepEqual(recorded("session.attach").map((entry) => [entry.target, entry.peer, entry.error]), [["work", "laptop", undefined]]);
  await session.kill();
  await eventually("session.end");
  assert.deepEqual(recorded("session.kill").map((entry) => entry.target), ["work"]);
  assert.deepEqual(recorded("session.end").map((entry) => [entry.target, entry.signal, typeof entry.end]), [["work", "SIGHUP", "string"]]);
  shell.openPty({ output() {}, exit() {} }, { command: "exit 5" });
  await eventually("terminal");
  assert.deepEqual(recorded("terminal").map((entry) => [entry.target, entry.exitCode]), [["exit 5", 5]]);
  assert.deepEqual(started().map(([action, target]) => [action, target]),
    [["run", 'printf %s "$API_KEY$CALLER"; exit 3'], ["run", "exit 4"], ["run", 'printf %s "$OPENAI_API_KEY"'], ["terminal", "exit 5"]]);
  for (const secret of ["sk-secret-value", "caller-secret", "sk-opened-by-caller", "hunter2"]) assert.ok(!JSON.stringify(entries).includes(secret), secret);

  // A refusal is recorded too, and still thrown at once.
  const reader = as(["sessions:list"]);
  assert.throws(() => reader.readFile("/etc/hosts"), /Permission denied: files not granted to laptop/);
  assert.throws(() => reader.readSkillFile("pdf", "SKILL.md"), /skills not granted/);
  await assert.rejects(async () => { await reader.run("id"); }, /shell not granted/);
  assert.deepEqual(entries.slice(-3).map((entry) => [entry.action, entry.target, /^Permission denied/.test(entry.error ?? "")]),
    [["file.read", "/etc/hosts", true], ["skill.read", "pdf/SKILL.md", true], ["run", "id", true]]);
  assert.equal(started().length, 4, "a refused command never started");
  // What a refusal keeps is cut short, so that refusals cannot cheaply push older entries out.
  const long = `/${"x".repeat(9000)}`;
  assert.throws(() => reader.readFile(long), /files not granted/);
  assert.equal(entries.at(-1)!.target, `${long.slice(0, 512)}...`);
  const many = Array.from({ length: 64 }, (_, index) => `VARIABLE_${index}_${"V".repeat(100)}`);
  await assert.rejects(async () => { await reader.run("id", { env: Object.fromEntries(many.map((name) => [name, "value"])) }); }, /shell not granted/);
  const { variables } = entries.at(-1)!;
  assert.deepEqual([variables!.length < many.length, variables!.at(-1), many.slice(0, variables!.length - 1)], [true, "...", variables!.slice(0, -1)]);

  // An audit log that fails makes nothing else fail.
  const careless = as(["shell"], () => { throw new Error("disk full"); });
  assert.equal((await careless.run("printf fine")).stdout, "fine");
  assert.equal((await careless.fork().run("printf forked")).stdout, "forked");
});
