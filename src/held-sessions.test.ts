import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectHolder, HeldSessions, HOLDERS } from "./held-sessions.js";
import { holderRecordSchema, type HolderRecord } from "./holder.js";
import { HandleScope, type PtyExit } from "./pty.js";
import { OutputSink } from "./terminal.js";

const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A daemon's sessions in a directory of their own; hooks end every holder still running. */
async function holders(t: TestContext, finishedMs?: number) {
  const dir = path.join(await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-held-"))), "daemon-sessions");
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
  assert.deepEqual(sessions.names, []);
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
