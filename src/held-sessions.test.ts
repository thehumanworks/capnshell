import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import manifest from "../package.json" with { type: "json" };
import { RpcTarget } from "capnweb";
import { processExited } from "./commands/daemon.js";
import { connectHolder, daemonSessions, HeldSessions, HOLDERS, keepsSessions, socketsTooLong, startHolder } from "./held-sessions.js";
import { HOLDER_CAPNWEB, HOLDER_PROTOCOL, holderRecordSchema, type HolderRecord } from "./holder.js";
import { HandleScope, type PtyExit } from "./pty.js";
import { OutputSink } from "./terminal.js";
import { childOfThisProcess, PROJECT_ROOT, TEST_TMP } from "./test-support.js";

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("holder protocol 1 is pinned to the Cap'n Web release it was defined with", async () => {
  const installed = JSON.parse(await readFile(path.join(PROJECT_ROOT, "node_modules", "capnweb", "package.json"), "utf8")) as { version: string };
  // A daemon and the holders of the release before it may run different Cap'n Webs. Before moving it,
  // check that its messages are unchanged, or give the holder a new protocol (holder.ts).
  assert.deepEqual([HOLDER_PROTOCOL, manifest.dependencies.capnweb, installed.version], [1, HOLDER_CAPNWEB, HOLDER_CAPNWEB]);
});

test("holders run only where their sockets' paths fit: 103 bytes on macOS, 107 on Linux", () => {
  const limit = process.platform === "darwin" ? 103 : 107;
  // A socket is the directory, a slash, 16 hex digits and .sock.
  const fits = `/${"d".repeat(limit - 23)}`;
  assert.equal(socketsTooLong(fits), undefined);
  assert.equal(socketsTooLong(`${fits}x`),
    `Named sessions run in this daemon and end when it stops or restarts: a socket of theirs, such as ${fits}x/0000000000000000.sock, ` +
    `would be ${limit + 1} bytes long, over the ${limit} this system allows. A shorter --state path lets them outlive the daemon.`);
  // Bytes, not characters.
  assert.match(socketsTooLong(`/${"é".repeat(60)}`) ?? "", /would be 143 bytes long/);
});

test("holders outlive a daemon unless the systemd unit that runs it stops every process of its own", () => {
  const asked: Array<[string, boolean]> = [];
  const keeps = (service: boolean, cgroup: string | undefined, mode?: string, platform: NodeJS.Platform = "linux") =>
    keepsSessions(service, { platform, cgroup: () => cgroup, killMode: (unit, user) => { asked.push([unit, user]); return mode; } });
  const userUnit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/cns.service\n";
  assert.equal(keeps(true, userUnit, "process"), true);
  assert.equal(keeps(true, userUnit, "control-group"), false, "a unit an older cns wrote");
  assert.equal(keeps(true, userUnit, undefined), false, "a unit systemctl cannot tell of");
  assert.equal(keeps(true, "0::/system.slice/cns.service\n", "mixed"), false, "the NixOS module's system service");
  assert.deepEqual(asked, [["cns.service", true], ["cns.service", true], ["cns.service", true], ["cns.service", false]]);
  // A cgroup v1 host: only the name=systemd line names the unit; a controller's line before it can name another.
  asked.length = 0;
  const v1 = [
    "12:pids:/user.slice/user-1000.slice/user@1000.service",
    "11:cpu,cpuacct:/user.slice",
    "4:memory:/user.slice/user-1000.slice/user@1000.service",
    "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/cns.service",
    "",
  ].join("\n");
  assert.equal(keeps(true, v1, "control-group"), false);
  // A hybrid host reads the unified hierarchy's line, also when name=systemd and the controllers say otherwise, or it comes last.
  const hybrid = ["12:pids:/user.slice/user-1000.slice/user@1000.service", "1:name=systemd:/system.slice/other.service", "0::/system.slice/cns.service", ""].join("\n");
  assert.equal(keeps(true, hybrid, "process"), true);
  // And the name=systemd line when the unified one names no unit, as where it is not mounted.
  const unmounted = ["9:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/cns.service", "8:pids:/user.slice/user-1000.slice/user@1000.service", "0::/", ""].join("\n");
  assert.equal(keeps(true, unmounted, "mixed"), false);
  assert.deepEqual(asked, [["cns.service", true], ["cns.service", false], ["cns.service", true]]);
  // A v1 host with no systemd at all, as in a container, has no unit to ask about.
  assert.equal(keeps(true, ["9:name=systemd:/", "8:pids:/process_api/cc-shell", "0::/", ""].join("\n"), "control-group"), true);
  assert.equal(keeps(true, "12:pids:/system.slice/docker.service\n", "control-group"), true, "a controller's line alone names no unit of this process");
  assert.equal(asked.length, 3);
  // Only a daemon run as a service asks: one cns up started stops alone, whatever unit its shell is in.
  asked.length = 0;
  assert.equal(keeps(false, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux.service\n", "control-group"), true);
  assert.equal(keeps(true, "0::/user.slice/user-1000.slice/session-2.scope\n", "control-group"), true, "a service outside systemd");
  assert.equal(keeps(true, undefined, "control-group"), true);
  assert.equal(keeps(true, userUnit, "control-group", "darwin"), true);
  assert.deepEqual(asked, []);
  assert.equal(keeps(false, undefined, undefined, "win32"), false);
});

test("a daemon's status says its sessions outlive it as the systemd probe finds, and never for sessions it keeps itself", { skip: !HOLDERS }, () => {
  const unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/cns.service\n";
  const probe = (mode: string) => (service: boolean) => keepsSessions(service, { platform: "linux", cgroup: () => unit, killMode: () => mode });
  const place = (state: string, service: boolean, mode: string) => {
    const placed = daemonSessions(state, service, { keeps: probe(mode) });
    placed.host[Symbol.dispose]();
    return { keeps: placed.keeps, held: placed.host instanceof HeldSessions, tooLong: placed.tooLong !== undefined };
  };
  const state = path.join(TEST_TMP, "cns-placed", "daemon.json");
  assert.deepEqual(place(state, true, "control-group"), { keeps: false, held: true, tooLong: false }, "a unit that stops them with the daemon");
  assert.deepEqual(place(state, true, "process"), { keeps: true, held: true, tooLong: false });
  assert.deepEqual(place(state, false, "control-group"), { keeps: true, held: true, tooLong: false }, "a daemon cns up started");
  assert.deepEqual(place(path.join(TEST_TMP, "d".repeat(100), "daemon.json"), false, "process"), { keeps: false, held: false, tooLong: true });
  assert.ok(!existsSync(path.dirname(state)), "placing them creates nothing");
});

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The holders' directories of every test, whose holders this process kills as it exits, should a test time out before its hooks end them. */
const holderDirs = new Set<string>();
process.once("exit", () => {
  for (const dir of holderDirs) {
    for (const file of existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : []) {
      try {
        const record = holderRecordSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
        // Only a holder this process started and has not reaped: never a pid another process has by now.
        if (record.success && childOfThisProcess(record.data.pid)) process.kill(record.data.pid, "SIGKILL");
      } catch { /* Gone. */ }
    }
  }
});

/** A daemon's sessions in a directory of their own; hooks end every holder still running, a stopped one too. */
async function holders(t: TestContext, options: ConstructorParameters<typeof HeldSessions>[2] = {}) {
  const dir = path.join(await realpath(await mkdtemp(path.join(TEST_TMP, "cns-held-"))), "daemon-sessions");
  holderDirs.add(dir);
  const sessions = new HeldSessions(dir, () => {}, options);
  await sessions.adopt();
  const records = async () => {
    const files = existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith(".json")) : [];
    // Only holders' own records: a planted one, of another protocol, names no holder to end. A holder
    // that is ending may remove its record between the listing and the read.
    const read = (file: string) => readFile(path.join(dir, file), "utf8").catch(() => "null");
    const parsed = await Promise.all(files.map(async (file) => holderRecordSchema.safeParse(JSON.parse(await read(file)))));
    return parsed.flatMap((record) => record.success ? [record.data] : []);
  };
  t.after(async () => {
    sessions[Symbol.dispose]();
    // Only holders this process started: a record a test changed may name another process.
    const ours = (await records()).map((record) => record.pid).filter(childOfThisProcess);
    for (const pid of ours) { for (const signal of ["SIGTERM", "SIGCONT"] as const) { try { process.kill(pid, signal); } catch { /* Gone. */ } } }
    await until(() => !ours.some((pid) => childOfThisProcess(pid) && running(pid)), "the holders to end");
    await rm(path.dirname(dir), { recursive: true, force: true });
  });
  return { dir, sessions, records };
}

test("a holder runs the session, forwards to it until its shell closes, and ends once the finished session is removed", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t, { finishedMs: 500 });
  const scope = new HandleScope();
  const handle = await sessions.startSession("work", { command: "printf READY; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done" }, "laptop-fingerprint", scope);
  const [record] = await records();
  assert.ok(record && running(record.pid), "the holder runs");
  assert.notEqual(record.pid, process.pid);
  assert.equal(record.owner, "laptop-fingerprint");
  assert.equal((await handle.wait({ text: "READY", timeoutMs: 10000 })).matched, true);

  // Attach, type and read through the daemon's handle, as a paired device's calls do.
  const output: string[] = [];
  const detached: string[] = [];
  const sink = new OutputSink(async (data) => { output.push(new TextDecoder().decode(data)); }, (_: PtyExit) => {}, (reason) => { detached.push(reason); });
  const attachment = await handle.attach(sink, { cols: 100, rows: 30 });
  await attachment.write("one\r");
  await until(() => output.join("").includes("got:one"), "the attached output");
  assert.deepEqual([(await handle.info()).cols, (await handle.info()).rows], [100, 30]);
  assert.deepEqual((await sessions.list()).map((info) => [info.name, info.viewers, info.owner]), [["work", 1, "laptop-fingerprint"]]);

  // Closing the shell's scope revokes the handle and the attachment: a pending wait ends with the reason, the viewer is told why.
  const pending = handle.wait({ text: "never shown", timeoutMs: 0 });
  scope.close("The shell closed.");
  await assert.rejects(pending, /The shell closed\./);
  await assert.rejects(async () => { await handle.info(); }, /The shell closed\./);
  await assert.rejects(async () => { await attachment.write("x"); }, /The shell closed\./);
  await until(() => detached.length > 0, "the viewer to be detached");
  assert.deepEqual(detached, ["The shell closed."]);
  const other = sessions.openSession("work", new HandleScope());
  await until(async () => (await other.info()).viewers === 0, "the viewer to leave");

  // The program ends: the holder keeps its screen until the finished session is removed, then ends and removes its record.
  await other.keys(["C-d"]);
  await until(async () => !(await other.info()).running, "the program to end");
  assert.match((await other.capture()).text, /got:one/);
  await until(() => !running(record.pid), "the holder to end");
  await until(async () => (await records()).length === 0, "the record to go");
  // The daemon hears of it once the connection breaks, which can come after the record has gone.
  await until(() => sessions.names.length === 0, "the daemon to let the session go");
  assert.throws(() => sessions.openSession("work", new HandleScope()), /No PTY session named work\./);
});

test("killing a held session ends its holder, and its name can be used again at once", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t);
  const first = await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records();
  await assert.rejects(sessions.startSession("work", { command: "true" }, null, new HandleScope()), /A PTY session named work already exists/);
  await assert.rejects(sessions.startSession("cwd", { command: "true", cwd: "/nonexistent/cns" }, null, new HandleScope()), /cwd does not exist on the executing peer/);
  assert.equal((await first.kill()).signal, "SIGHUP");
  await until(() => !running(record!.pid), "the holder to end");
  await until(async () => (await records()).length === 0, "the record to go");
  await assert.rejects(async () => { await first.info(); }, /PTY session work no longer exists/);
  const again = await sessions.startSession("work", { command: "printf again; sleep 60" }, null, new HandleScope());
  assert.equal((await again.wait({ text: "again", timeoutMs: 10000 })).matched, true);
  // The first handle never reaches the session that took its name.
  await assert.rejects(async () => { await first.capture(); }, /PTY session work no longer exists/);
  await assert.rejects(async () => { await first.kill(); }, /PTY session work no longer exists/);
  assert.equal((await again.info()).running, true);
});

/** A viewer that never acknowledges the end of the program, so that it stays attached to a finished session. */
class StayingSink extends RpcTarget {
  output() {}
  exit() { return new Promise<void>(() => {}); }
  detached() {}
}

test("starts at the cap each make room by killing a finished session of their own, the one that ended first with nobody attached, and are refused once none is left", { skip: !HOLDERS, timeout: 60000 }, async (t) => {
  const { sessions } = await holders(t, { max: 3 });
  const finished = async (name: string) => {
    const handle = await sessions.startSession(name, { command: "true" }, null, new HandleScope());
    await until(async () => !(await handle.info()).running, `${name} to end`);
    return handle;
  };
  // watched ended first, but somebody is attached to it.
  const watched = await finished("watched");
  await watched.attach(new StayingSink() as never);
  await until(async () => (await watched.info()).viewers === 1, "the viewer to attach");
  await finished("a");
  await finished("b");
  // Two starts at once, at the cap: each kills a finished session of its own, rather than both the same one.
  await Promise.all(["c", "d"].map((name) => sessions.startSession(name, { command: "sleep 60" }, null, new HandleScope())));
  assert.deepEqual(sessions.names, ["c", "d", "watched"]);
  await assert.rejects(sessions.startSession("e", { command: "sleep 60" }, null, new HandleScope()),
    /^Error: Too many named PTY sessions: all 3 are running or in use\. Kill one first\.$/);
  assert.deepEqual(sessions.names, ["c", "d", "watched"]);
});

test("a full daemon names the sessions whose holders it cannot reach", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions } = await holders(t);
  // The holder of a newer cns: something listens at its socket, but this cns does not speak its protocol.
  const listener = net.createServer((connection) => { connection.on("error", () => {}); });
  await new Promise<void>((resolve) => listener.listen(path.join(dir, "newer.sock"), resolve));
  t.after(() => { listener.close(); });
  await writeFile(path.join(dir, "newer.json"), JSON.stringify({ protocol: 99, name: "newer", pid: process.pid, socket: path.join(dir, "newer.sock") }), { mode: 0o600 });
  const full = new HeldSessions(dir, () => {}, { max: 2 });
  t.after(() => full[Symbol.dispose]());
  await full.adopt();
  await full.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  await assert.rejects(full.startSession("more", { command: "sleep 60" }, null, new HandleScope()),
    /^Error: Too many named PTY sessions: all 2 are running or in use, 1 of them in holders this daemon cannot reach \(newer\), as its log says\. Kill one first\.$/);
  sessions[Symbol.dispose]();
});

test("a stopped holder holds up neither the list nor a kill, which kills the holder, and its name stays taken until it has gone", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t, { killMs: 1000 });
  const stuck = await sessions.startSession("stuck", { command: "sleep 60" }, null, new HandleScope());
  await sessions.startSession("fine", { command: "sleep 60" }, null, new HandleScope());
  const { pid, socket } = (await records()).find((record) => record.name === "stuck")!;
  process.kill(pid, "SIGSTOP");
  let started = Date.now();
  assert.deepEqual((await sessions.list(500)).map((info) => info.name), ["fine"]);
  assert.ok(Date.now() - started < 2000, "the list does not wait for the stopped holder");

  started = Date.now();
  const killing = stuck.kill();
  await until(() => !sessions.names.includes("stuck"), "the kill to start");
  assert.throws(() => sessions.openSession("stuck", new HandleScope()), /^Error: No PTY session named stuck\.$/);
  await assert.rejects(sessions.startSession("stuck", { command: "true" }, null, new HandleScope()), /^Error: The PTY session stuck is still ending\. Start it again once it has\.$/);
  const exit = await killing;
  assert.ok(Date.now() - started >= 1000, "the holder had killMs to answer");
  assert.deepEqual([exit.exitCode, exit.signal, exit.error], [null, null, `The session's holder (pid ${pid}) did not answer, so it was killed.`]);
  // Killed, the holder could not remove its record and socket: the kill did.
  assert.deepEqual([existsSync(socket), (await records()).map((record) => record.name)], [false, ["fine"]]);
  assert.ok(await processExited(pid), "SIGKILL ends even a stopped holder");
  await sessions.startSession("stuck", { command: "sleep 60" }, null, new HandleScope());
  assert.deepEqual(sessions.names, ["fine", "stuck"]);
});

test("a session still ending takes its place at the cap, and a start then is told to try again in a moment", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t, { max: 2, killMs: 1000 });
  await sessions.startSession("a", { command: "sleep 60" }, null, new HandleScope());
  const b = await sessions.startSession("b", { command: "sleep 60" }, null, new HandleScope());
  // b's holder is stopped, so that its kill takes killMs.
  process.kill((await records()).find((record) => record.name === "b")!.pid, "SIGSTOP");
  const killing = b.kill();
  await until(() => !sessions.names.includes("b"), "the kill to start");
  await assert.rejects(sessions.startSession("c", { command: "sleep 60" }, null, new HandleScope()),
    /^Error: Too many named PTY sessions for now: b is still ending\. Try again in a moment\.$/);
  await killing;
  await sessions.startSession("c", { command: "sleep 60" }, null, new HandleScope());
  assert.deepEqual(sessions.names, ["a", "c"]);
  assert.equal((await records()).length, 2, "never more holders than the cap");
});

test("a killed session's name stays taken until its holder's connection has gone, not only until a signal was sent", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records() as [HolderRecord];
  sessions[Symbol.dispose]();
  // Its record names another process, as a pid reused would: SIGKILL ends that one, and the holder, stopped, runs on.
  const decoy = spawn("sleep", ["60"]);
  const decoyEnded = new Promise((resolve) => decoy.once("exit", resolve));
  t.after(() => { decoy.kill("SIGKILL"); });
  const file = path.join(dir, `${path.basename(record.socket, ".sock")}.json`);
  await writeFile(file, JSON.stringify({ ...record, pid: decoy.pid }));
  const next = new HeldSessions(dir, () => {}, { killMs: 500 });
  t.after(() => next[Symbol.dispose]());
  await next.adopt();
  process.kill(record.pid, "SIGSTOP");
  let ended = false;
  const killing = next.openSession("work", new HandleScope()).kill().finally(() => { ended = true; });
  await decoyEnded;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended, false, "the kill waits for the holder's connection, which the decoy's end did not break");
  await assert.rejects(next.startSession("work", { command: "true" }, null, new HandleScope()), /^Error: The PTY session work is still ending\./);
  process.kill(record.pid, "SIGKILL");
  assert.match((await killing).error ?? "", /did not answer, so it was killed\.$/);
  assert.deepEqual([existsSync(record.socket), existsSync(file)], [false, false]);
});

test("a holder that does not answer is named with kill -9, which a stopped or hung one needs", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records() as [HolderRecord];
  sessions[Symbol.dispose]();
  process.kill(record.pid, "SIGSTOP");
  const said: string[] = [];
  const next = new HeldSessions(dir, (message) => said.push(message));
  t.after(() => next[Symbol.dispose]());
  await next.adopt();
  assert.deepEqual(said, [`Cannot reach the holder of the session work (pid ${record.pid}): The session's holder did not answer. It keeps running; kill -9 ${record.pid} ends it.`]);
});

test("a holder that starts wrong is killed, not left running", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(TEST_TMP, "cns-held-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "pid");
  // A holder that sends no record and would otherwise run on.
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("message", () => process.send({ ready: {} })); setInterval(() => {}, 1000);`;
  const start = { dir, name: "work", options: {}, owner: null, finishedMs: 1000 };
  await assert.rejects(startHolder(start, 10_000, { file: process.execPath, args: ["-e", script] }), /^Error: The session's holder sent no record\.$/);
  const pid = Number(await readFile(pidFile, "utf8"));
  t.after(() => { if (childOfThisProcess(pid)) process.kill(pid, "SIGKILL"); });
  assert.ok(await processExited(pid, 3000), "the holder was killed");
});

test("connectHolder refuses a holder that answers with another protocol, and says so in printable text", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const dir = await mkdtemp(path.join(TEST_TMP, "cns-held-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "holder.sock");
  let reply = "";
  const server = net.createServer((connection) => { connection.on("error", () => {}); connection.once("data", () => connection.write(reply)); });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => { server.close(); });
  reply = '{"protocol":2}\n';
  await assert.rejects(connectHolder({ socket, token: "a".repeat(64) }), /^Error: The session's holder answered with protocol 2, not 1\.$/);
  reply = '{"protocol":"\\u202e1"}\n';
  await assert.rejects(connectHolder({ socket, token: "a".repeat(64) }), /^Error: The session's holder answered with protocol \?1, not 1\.$/);
});

test("a holder another cns runs is named with the pid that ends it only when its socket answers", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions } = await holders(t);
  sessions[Symbol.dispose]();
  const listener = net.createServer((connection) => { connection.on("error", () => {}); });
  await new Promise<void>((resolve) => listener.listen(path.join(dir, "answers.sock"), resolve));
  t.after(() => { listener.close(); });
  // Both pids run; only one socket answers. The other's path is too long to connect to, so whether anything listens cannot be told.
  const record = (name: string, socket: string) => writeFile(path.join(dir, `${name}.json`), JSON.stringify({ protocol: 99, name, pid: process.pid, socket: path.join(dir, socket) }), { mode: 0o600 });
  await record("answers", "answers.sock");
  await record("unknown", `${"x".repeat(120)}.sock`);
  const said: string[] = [];
  const next = new HeldSessions(dir, (message) => said.push(message));
  t.after(() => next[Symbol.dispose]());
  await next.adopt();
  assert.deepEqual(next.names, ["answers", "unknown"]);
  const about = (name: string) => said.find((message) => message.startsWith(`The session ${name} `)) ?? "";
  assert.match(about("answers"), new RegExp(`It keeps running; kill ${process.pid} ends it\\.$`));
  assert.match(about("unknown"), /Its name stays taken while its record, \S+unknown\.json, is there\.$/);
});

test("a daemon hears of the end of only the sessions it adopts while their program runs", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions } = await holders(t);
  const done = await sessions.startSession("done", { command: "true" }, "laptop-fingerprint", new HandleScope());
  await until(async () => !(await done.info()).running, "done to end");
  await sessions.startSession("live", { command: "sleep 60" }, "laptop-fingerprint", new HandleScope());
  sessions[Symbol.dispose]();
  const adopted: string[] = [];
  const next = new HeldSessions(dir, () => {}, { adopted: (record) => adopted.push(record.name) });
  t.after(() => next[Symbol.dispose]());
  await next.adopt();
  assert.deepEqual(next.names, ["done", "live"]);
  // The daemon that ran done when it ended heard of it.
  assert.deepEqual(adopted, ["live"]);
});

test("a start the daemon gives up on leaves no holder behind", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t);
  const starting = sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  sessions[Symbol.dispose]();
  await assert.rejects(starting, /The daemon is stopping\./);
  await until(async () => (await records()).length === 0, "the holder to end and remove its record");
});

test("holders keep to a private directory: a looser one is refused, a looser record ignored, and each socket is the user's alone", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records() as [HolderRecord];
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(record.socket)).mode & 0o777, 0o600);
  sessions[Symbol.dispose]();
  // A record others could have written, even one that names a live holder and its token, is ignored.
  const loose = path.join(dir, "loose.json");
  await writeFile(loose, JSON.stringify({ ...record, name: "loose" }));
  await chmod(loose, 0o644);
  const said: string[] = [];
  const next = new HeldSessions(dir, (message) => said.push(message));
  await next.adopt();
  next[Symbol.dispose]();
  assert.deepEqual(next.names, []);
  assert.match(said.join("\n"), /^Ignored \S+loose\.json: it is not a private file of this user\.$/m);
  assert.doesNotMatch(said.join("\n"), /loose.*pid/);
  // A directory others may read is refused, with what to run.
  await chmod(dir, 0o755);
  try { await assert.rejects(new HeldSessions(dir).adopt(), /must be private and owned by your user: \S+\. To make it private, run: chmod 700 /); }
  finally { await chmod(dir, 0o700); }
});

test("a second holder of a live name is reported, with the pid that ends it", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { dir, sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  // A daemon that never adopted the first starts another.
  const other = new HeldSessions(dir);
  await other.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  other[Symbol.dispose]();
  const [one, two] = (await records()).map((record) => record.pid);
  const said: string[] = [];
  const next = new HeldSessions(dir, (message) => said.push(message));
  t.after(() => next[Symbol.dispose]());
  await next.adopt();
  assert.deepEqual(next.names, ["work"]);
  assert.match(said.join("\n"), new RegExp(`^Two holders run a session named work, pids (${one} and ${two}|${two} and ${one}): this daemon reaches the first\\. kill (${one}|${two}) ends the other\\.$`, "m"));
});

test("a holder closes on a caller whose hello is too long, or that says nothing for 5 seconds", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records() as [HolderRecord];
  /** How long the holder takes to close on a caller that sends `hello`; Infinity past 8 seconds. */
  const closes = (hello: string) => new Promise<number>((resolve) => {
    const started = Date.now();
    const socket = net.connect(record.socket, () => { if (hello) socket.write(hello); });
    const timer = setTimeout(() => { socket.destroy(); resolve(Infinity); }, 8000);
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timer); resolve(Date.now() - started); });
  });
  const long = await closes("x".repeat(2000));
  assert.ok(long < 2000, `a hello past 1024 bytes is closed on at once, not after ${long} ms`);
  const silent = await closes("");
  assert.ok(silent >= 4500 && silent < 8000, `a silent caller is closed on after 5 seconds, not ${silent} ms`);
});

test("a holder answers only a caller with its record's token", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t);
  await sessions.startSession("work", { command: "sleep 60" }, null, new HandleScope());
  const [record] = await records() as [HolderRecord];
  /** What the holder sends back to a first line, until it closes the connection. */
  const answer = (line: string) => new Promise<string>((resolve) => {
    const socket = net.connect(record.socket, () => socket.write(`${line}\n`));
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { received += chunk; if (received.includes("\n")) { socket.destroy(); resolve(received); } });
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
  });
  assert.equal(await answer(JSON.stringify({ token: "0".repeat(64), protocol: 1 })), "", "a wrong token gets nothing");
  assert.equal(await answer(JSON.stringify({ protocol: 1 })), "");
  assert.equal(await answer("hello"), "");
  assert.equal(await answer(JSON.stringify({ token: record.token, protocol: 1 })), '{"protocol":1}\n');
  await assert.rejects(connectHolder({ socket: record.socket, token: "f".repeat(64) }), /refused the connection/);
  const connection = await connectHolder(record);
  try {
    using handle = await connection.main.handle();
    assert.equal((await handle.info()).name, "work");
  } finally { connection.close(); }
});
