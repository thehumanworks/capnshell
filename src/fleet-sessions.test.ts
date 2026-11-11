import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "./auth.js";
import { everywhereExitCode, formatEverywhere, listEverywhere, notesEverywhere, type DeviceSessions, type FleetDevice } from "./fleet-sessions.js";
import type { PtySessionInfo } from "./shell.js";

const LISTING = ["sessions:list"] as const;
const device = (name: string, outgoing: FleetDevice["outgoing"] = LISTING): FleetDevice => ({ name, outgoing });
const session = (name: string, more: Partial<PtySessionInfo> = {}): PtySessionInfo => ({
  name, command: null, cwd: "/home/tomas", pid: 100, cols: 80, rows: 24, title: "", startedAt: "2026-11-11T00:00:00.000Z",
  running: true, exit: null, viewers: 0, outputBytes: 0, owner: null, ...more,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("devices that may not be listed are reported without being asked", async () => {
  const asked: string[] = [];
  const results = await listEverywhere([device("lf"), device("gateway", []), device("nas", ["shell", "sessions:create", "sessions:view"])], async (target) => {
    asked.push(target.name);
    return { sessions: [], via: "direct" };
  });
  assert.deepEqual(asked, ["lf"]);
  assert.deepEqual(results.map((result) => [result.device, result.state]), [["lf", "listed"], ["gateway", "not-granted"], ["nas", "not-granted"]]);
  const skipped = results[1] as Extract<DeviceSessions, { state: "not-granted" }>;
  assert.match(skipped.reason, /does not let this device list its sessions \(sessions:list\); cns doctor gateway/);
});

test("every device is asked at once and reported in the order given, however it answers", async () => {
  const started: string[] = [];
  const results = await listEverywhere([device("slow"), device("denied"), device("gone"), device("stranger"), device("quick")], async (target) => {
    started.push(target.name);
    if (target.name === "slow") { await pause(80); return { sessions: [session("tty-1")], via: "relay" }; }
    if (target.name === "denied") throw new Error("Permission denied: sessions:list not granted to laptop.");
    if (target.name === "gone") throw new Error("connect ECONNREFUSED 127.0.0.1:47381");
    if (target.name === "stranger") throw new AuthError("not-paired", "This device is not paired here.");
    return { sessions: [session("build")], via: "direct" };
  });
  assert.equal(started.length, 5, "a slow device does not hold back the others");
  assert.deepEqual(results.map((result) => [result.device, result.state]), [
    ["slow", "listed"], ["denied", "refused"], ["gone", "unreachable"], ["stranger", "refused"], ["quick", "listed"],
  ]);
  assert.deepEqual(results[0], { device: "slow", state: "listed", sessions: [session("tty-1")], via: "relay" });
  // A refusal says what to run on the device that refused.
  assert.match((results[1] as { reason: string }).reason, /To allow it, run on denied: cns peer grant laptop sessions:list$/);
  assert.match((results[2] as { reason: string }).reason, /ECONNREFUSED/);
  assert.equal(everywhereExitCode(results), 1);
  assert.equal(everywhereExitCode(results.filter((result) => result.state === "listed")), 0);
  assert.equal(everywhereExitCode(results.filter((result) => result.state !== "refused")), 1, "an unreachable device fails the listing");
  assert.equal(everywhereExitCode(results.filter((result) => result.state !== "unreachable")), 1, "a refusal fails the listing");
});

test("a device that does not answer in time is unreachable, and the answer does not wait for it", async () => {
  let signalled: AbortSignal | undefined;
  const started = Date.now();
  const results = await listEverywhere([device("asleep"), device("awake")], async (target, signal) => {
    if (target.name === "awake") return { sessions: [], via: "direct" };
    signalled = signal;
    return await new Promise(() => {});
  }, { timeoutMs: 100 });
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(results[0], { device: "asleep", state: "unreachable", reason: "no answer within 100 ms" });
  assert.equal(signalled?.aborted, true, "the slow ask is told to stop, so it can close its connection");
  assert.equal(results[1]!.state, "listed");
});

test("stopping the listing rejects at once", async () => {
  const stop = new AbortController();
  const stopped = listEverywhere([device("a")], async () => await new Promise(() => {}), { signal: stop.signal });
  stop.abort(new Error("Interrupted"));
  await assert.rejects(stopped, /Interrupted/);
});

test("the table names each session's device and prefers the title a program set", () => {
  const results: DeviceSessions[] = [
    { device: "lf", state: "listed", via: "direct", sessions: [session("tty-1"), session("build", { command: "make test", running: false, exit: { exitCode: 2, signal: null, signalNumber: null, timedOut: false, elapsedMs: 1, error: null } })] },
    { device: "beelink", state: "not-granted", reason: "beelink does not let this device list its sessions" },
    { device: "thestudio", state: "listed", via: "relay", sessions: [session("main", { title: "Claude Code\u001b]0;evil\u0007", viewers: 1, cols: 293, rows: 48 })] },
  ];
  assert.equal(formatEverywhere(results), [
    "DEVICE     NAME   STATUS    SIZE    ATTACHED  TITLE OR COMMAND",
    "lf         tty-1  running   80x24   0         (login shell)",
    "lf         build  exited 2  80x24   0         make test",
    "thestudio  main   running   293x48  1         Claude Code?]0;evil?",
  ].join("\n"));
  assert.deepEqual(notesEverywhere(results), ["beelink: not listed: beelink does not let this device list its sessions"]);
  assert.equal(everywhereExitCode(results), 0, "a device that was never asked is not a failure");
});

test("with nothing to show, the notes say why", () => {
  assert.equal(formatEverywhere([]), "");
  assert.deepEqual(notesEverywhere([]), ["No paired devices. Run cns pair to pair with another device."]);
  const empty: DeviceSessions[] = [
    { device: "lf", state: "listed", via: "direct", sessions: [] },
    { device: "thestudio", state: "listed", via: "relay", sessions: [] },
    { device: "nas", state: "unreachable", reason: "no answer within 10 seconds" },
  ];
  assert.equal(formatEverywhere(empty), "");
  assert.deepEqual(notesEverywhere(empty), ["nas: unreachable: no answer within 10 seconds", "No named sessions on lf, thestudio."]);
});
