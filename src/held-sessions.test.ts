import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import manifest from "../package.json" with { type: "json" };
import { connectHolder, HeldSessions, HOLDERS, keepsSessions, socketsTooLong } from "./held-sessions.js";
import { HOLDER_CAPNWEB, HOLDER_PROTOCOL, holderRecordSchema, type HolderRecord } from "./holder.js";
import { HandleScope, type PtyExit } from "./pty.js";
import { OutputSink } from "./terminal.js";
import { PROJECT_ROOT, TEST_TMP } from "./test-support.js";

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
  // Only a daemon run as a service asks: one cns up started stops alone, whatever unit its shell is in.
  asked.length = 0;
  assert.equal(keeps(false, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux.service\n", "control-group"), true);
  assert.equal(keeps(true, "0::/user.slice/user-1000.slice/session-2.scope\n", "control-group"), true, "a service outside systemd");
  assert.equal(keeps(true, undefined, "control-group"), true);
  assert.equal(keeps(true, userUnit, "control-group", "darwin"), true);
  assert.deepEqual(asked, []);
  assert.equal(keeps(false, undefined, undefined, "win32"), false);
});

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A daemon's sessions in a directory of their own; hooks end every holder still running. */
async function holders(t: TestContext, finishedMs?: number) {
  const dir = path.join(await realpath(await mkdtemp(path.join(TEST_TMP, "cns-held-"))), "daemon-sessions");
  const sessions = new HeldSessions(dir, () => {}, finishedMs ? { finishedMs } : {});
  await sessions.adopt();
  const records = async () => {
    const files = existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith(".json")) : [];
    return await Promise.all(files.map(async (file) => holderRecordSchema.parse(JSON.parse(await readFile(path.join(dir, file), "utf8")))));
  };
  t.after(async () => {
    sessions[Symbol.dispose]();
    for (const record of await records()) { try { process.kill(record.pid, "SIGTERM"); } catch { /* Gone. */ } }
    await until(async () => !(await records()).some((record) => running(record.pid)), "the holders to end");
    await rm(path.dirname(dir), { recursive: true, force: true });
  });
  return { dir, sessions, records };
}

test("a holder runs the session, forwards to it until its shell closes, and ends once the finished session is removed", { skip: !HOLDERS, timeout: 30000 }, async (t) => {
  const { sessions, records } = await holders(t, 500);
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
