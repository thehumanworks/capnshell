import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { connectControl, processExited } from "./commands/daemon.js";
import { HeldSessions, HOLDERS, holderDirectory } from "./held-sessions.js";
import { launchCli, testDevices, type TestDevice } from "./test-support.js";

const program = "printf 'READY\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Two paired devices; laptop starts the session `work` on studio, which runs the daemon. */
async function setUp(t: Parameters<typeof testDevices>[0]) {
  const devices = await testDevices(t, "cns-keep-");
  const studio = await devices.device("studio", { SHELL: "/bin/bash" });
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  const dir = holderDirectory(studio.state);
  const ok = async (device: TestDevice, args: string[]) => {
    const result = await devices.cli(device, args);
    assert.equal(result.code, 0, `cns ${args.join(" ")}:\n${result.output}`);
    return result;
  };
  const work = async () => (JSON.parse((await ok(laptop, ["sessions", "studio", "--json"])).stdout) as Array<{ name: string; pid: number; startedAt: string; running: boolean }>).find((session) => session.name === "work");
  const records = async () => (await readdir(dir)).filter((file) => file.endsWith(".json"));
  const holderPid = async () => (JSON.parse(await readFile(path.join(dir, (await records())[0]!), "utf8")) as { pid: number }).pid;
  const daemonPid = async () => {
    const control = await connectControl(studio.state);
    try { return (await control.remote.status()).pid; } finally { control.close(); }
  };
  await ok(laptop, ["shell", "studio", "--name", "work", "--", program]);
  return { devices, studio, laptop, dir, ok, work, records, holderPid, daemonPid };
}

test("a named session outlives cns daemon restart, a killed daemon and cns stop, with its pid, start time and screen, and cns kill ends it", { skip: !HOLDERS, timeout: 120000 }, async (t) => {
  const { devices, studio, laptop, ok, work, records, holderPid, daemonPid } = await setUp(t);
  await ok(laptop, ["keys", "studio", "work", "one", "Enter"]);
  await ok(laptop, ["screen", "studio", "work", "--until", "got:one"]);
  const before = (await work())!;
  const holder = await holderPid();
  assert.notEqual(holder, before.pid, "the holder runs the program, rather than being it");
  assert.equal(JSON.parse((await ok(studio, ["status", "--json", "--state", studio.state])).stdout).daemon.keepsSessions, true);
  const same = async (moment: string, text: string) => {
    const now = await work();
    assert.deepEqual([now?.pid, now?.startedAt, now?.running], [before.pid, before.startedAt, true], moment);
    await ok(laptop, ["keys", "studio", "work", text, "Enter"]);
    const screen = await ok(laptop, ["screen", "studio", "work", "--until", `got:${text}`]);
    assert.match(screen.stdout, /got:one/, `${moment}: the screen from before is still there`);
  };

  const restarted = await ok(studio, ["daemon", "restart", "--state", studio.state]);
  assert.doesNotMatch(restarted.stdout, /sessions it holds end/);
  await same("after cns daemon restart", "two");

  const killed = await daemonPid();
  process.kill(killed, "SIGKILL");
  assert.ok(await processExited(killed));
  await devices.up(studio, studio.port);
  await same("after the daemon was killed", "three");

  const stopped = await ok(studio, ["stop", "--state", studio.state]);
  assert.match(stopped.stdout, /^Daemon stopped\.\nNamed sessions keep running: work\. Once the daemon runs again, cns kill DEVICE NAME on a paired device ends one\.$/m);
  assert.ok(alive(holder), "the holder outlives cns stop");
  await devices.up(studio, studio.port);
  await same("after cns stop and cns up", "four");
  assert.equal(await holderPid(), holder);

  await ok(laptop, ["kill", "studio", "work"]);
  assert.ok(await processExited(holder), "cns kill ends the holder");
  assert.deepEqual(await records(), [], "and its record goes");
  assert.equal(await work(), undefined);
});

test("the daemon adopts its holders before it accepts links, leaves the ones it cannot reach running and removes the records of holders that are gone", { skip: !HOLDERS, timeout: 120000 }, async (t) => {
  const { devices, studio, laptop, dir, ok, work, records } = await setUp(t);
  const attached = launchCli(t, ["shell", "studio", "--attach", "work"], { env: laptop.env });
  await attached.waitFor("READY");
  attached.child.stdin.write("one\r");
  await attached.waitFor("got:one");

  const record = (name: string, pid: number, socket: string, protocol = 1) => writeFile(path.join(dir, `${name}.json`),
    JSON.stringify({ protocol, name, owner: null, pid, startedAt: new Date().toISOString(), socket, token: "a".repeat(64), version: "0.0.1" }), { mode: 0o600 });
  // A holder that is gone, as after a reboot: its pid has exited and nothing listens at its socket.
  const exited = spawn("true");
  await new Promise((resolve) => exited.once("exit", resolve));
  await record("stale", exited.pid!, path.join(dir, "stale.sock"));
  // A holder of a newer cns, whose protocol this one does not speak: it listens, so it is left running.
  const newer = spawn("sleep", ["60"]);
  t.after(() => { newer.kill(); });
  const listener = net.createServer((connection) => { connection.on("error", () => {}); });
  await new Promise<void>((resolve) => listener.listen(path.join(dir, "newer.sock"), resolve));
  t.after(() => { listener.close(); });
  await record("newer", newer.pid!, path.join(dir, "newer.sock"), 99);
  // One whose pid runs, maybe as another process by now, but whose socket nobody listens at: it is gone.
  await record("silent", newer.pid!, path.join(dir, "silent.sock"), 99);
  // A record whose socket is elsewhere is ignored, and nothing there is touched.
  const elsewhere = path.join(studio.dir, "elsewhere.sock");
  await writeFile(elsewhere, "");
  await record("elsewhere", exited.pid!, elsewhere);
  // A holder that takes its time: while the daemon waits for it, nothing may reach the daemon yet.
  let reached: boolean | undefined;
  const hung = net.createServer((connection) => {
    connection.on("error", () => {});
    const probe = net.connect(Number(studio.port), "127.0.0.1");
    probe.once("connect", () => { reached ??= true; probe.destroy(); });
    probe.once("error", () => { reached ??= false; });
  });
  await new Promise<void>((resolve) => hung.listen(path.join(dir, "hung.sock"), resolve));
  t.after(() => { hung.close(); });
  const waiting = spawn("sleep", ["60"]);
  t.after(() => { waiting.kill(); });
  await record("hung", waiting.pid!, path.join(dir, "hung.sock"));

  const before = (await work())!;
  await ok(studio, ["daemon", "restart", "--state", studio.state]);
  assert.equal(reached, false, "the daemon accepted connections before it had adopted its sessions");
  await attached.waitFor("reattached to studio/work");
  const from = attached.output.length;
  attached.child.stdin.write("two\r");
  await attached.waitFor("got:two", from);
  assert.deepEqual([(await work())?.pid, (await work())?.startedAt], [before.pid, before.startedAt]);

  assert.ok(!existsSync(path.join(dir, "stale.json")), "a gone holder's record is removed");
  assert.ok(existsSync(path.join(dir, "newer.json")) && alive(newer.pid!), "a newer holder is left running");
  assert.ok(!existsSync(path.join(dir, "silent.json")), "a newer record whose socket nobody listens at is removed");
  assert.ok(existsSync(path.join(dir, "hung.json")));
  assert.ok(existsSync(elsewhere) && existsSync(path.join(dir, "elsewhere.json")), "a record never removes a file outside the directory");
  const log = (await readdir(studio.dir)).filter((file) => file.startsWith("daemon.json.") && file.endsWith(".log"));
  const said = (await Promise.all(log.map((file) => readFile(path.join(studio.dir, file), "utf8")))).join("");
  assert.match(said, /The session newer runs in a holder \(pid \d+\) of another cns, protocol 99, which cns \S+ cannot reach: run the daemon from that cns to reach it\. It keeps running; kill \d+ ends it\./);
  assert.match(said, /Cannot reach the holder of the session hung \(pid \d+\): The session's holder did not answer\. It keeps running; kill \d+ ends it\./);
  assert.match(said, /Ignored \S+elsewhere\.json: its socket is not in \S+\./);
  assert.doesNotMatch(said, /silent/);
  // Their names stay taken, and only the session the daemon reaches is listed.
  const taken = await devices.cli(laptop, ["shell", "studio", "--name", "newer", "--", "true"]);
  assert.notEqual(taken.code, 0);
  assert.match(taken.output, /A PTY session named newer already exists/);
  assert.deepEqual(JSON.parse((await ok(laptop, ["sessions", "studio", "--json"])).stdout).map((session: { name: string }) => session.name), ["work"]);
  // work's own record, by its holder's id, and the three planted ones the daemon leaves.
  assert.deepEqual((await records()).map((file) => file.replace(/^[a-f0-9]{16}\.json$/, "work")).sort(), ["elsewhere.json", "hung.json", "newer.json", "work"]);
});

test("a device that may only start sessions is refused, with exit 4, the ones it did not start, also one no paired device started", { skip: !HOLDERS, timeout: 120000 }, async (t) => {
  const { devices, studio, dir, ok } = await setUp(t);
  const phone = await devices.device("phone");
  await devices.pair(studio, phone, { hostGrants: "sessions:create" });
  // A session that no paired device owns, in a holder the daemon adopts when it restarts.
  const host = new HeldSessions(dir);
  await host.adopt();
  await host.startSession("host", { command: program }, null);
  host[Symbol.dispose]();
  await ok(studio, ["daemon", "restart", "--state", studio.state]);
  const refusals: Array<[string[], string]> = [
    [["screen", "studio", "host"], "sessions:view"], [["keys", "studio", "host", "x"], "sessions:control"], [["kill", "studio", "host"], "sessions:kill"],
    [["screen", "studio", "work"], "sessions:view"],
  ];
  for (const [args, permission] of refusals) {
    const refused = await devices.cli(phone, args);
    assert.equal(refused.code, 4, `cns ${args.join(" ")}:\n${refused.output}`);
    assert.match(refused.stderr, new RegExp(`^Permission denied: ${permission} `), refused.stderr);
  }
  // What it starts, it owns.
  await ok(phone, ["shell", "studio", "--name", "mine", "--", program]);
  await ok(phone, ["screen", "studio", "mine", "--until", "READY"]);
  await ok(phone, ["kill", "studio", "mine"]);
});
