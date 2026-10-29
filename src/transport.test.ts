import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "./test-support.js";

const print = (marker: string) => process.platform === "win32"
  ? `[Console]::Write('${marker}')` : `printf '${marker}'`;
const environment = process.platform === "win32" ? "[Console]::Write($env:CNS_TEST_PEER)" : `printf '%s' "$CNS_TEST_PEER"`;

async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${label}`);
}

test("listener routes multiple bidirectional peers explicitly and survives disconnects", { timeout: 30000 }, async (t) => {
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port], { env: { ...process.env, CNS_TEST_PEER: "LISTENER_ONLY" } });
  await listener.waitFor("listening at");
  const rejected = await fetch(`http://[::1]:${port}`, { headers: { Origin: "https://example.invalid", Upgrade: "websocket" } });
  assert.equal(rejected.status, 401);
  const first = launchCli(t, ["connect", url], { env: { ...process.env, CNS_TEST_PEER: "FIRST_ONLY" } });
  await first.waitFor("Type a shell command");
  await listener.send(":info", `"pid": ${first.child.pid}`);
  await listener.send(environment, "FIRST_ONLY");

  const second = launchCli(t, ["connect", url], { env: { ...process.env, CNS_TEST_PEER: "SECOND_ONLY" } });
  await second.waitFor("Type a shell command");
  // Wait for the listener to complete its own handshake too.
  await listener.waitFor("p2");
  const ambiguous = await listener.send(":info", ":use");
  assert.ok(!ambiguous.includes(`"pid": ${first.child.pid}`), "must not silently retain an implicit target");
  const peers = await listener.send(":peers", "p2");
  assert.match(peers, /p1/);
  await listener.send(":use p2\n:info", `"pid": ${second.child.pid}`);
  await Promise.all([
    listener.send(environment, "SECOND_ONLY"),
    first.send(":info", `"pid": ${listener.child.pid}`),
    second.send(":info", `"pid": ${listener.child.pid}`),
  ]);
  await Promise.all([first.send(environment, "LISTENER_ONLY"), second.send(environment, "LISTENER_ONLY")]);
  await second.send(":timeout 3600000", "Timeout: 3600000 ms");
  await first.send(":timeout", "Timeout: disabled");
  await listener.send(":cwd " + os.tmpdir(), "Remote cwd: " + os.tmpdir());
  await listener.send(":timeout 3600000", "Timeout: 3600000 ms");
  await listener.send(":use p1\n:timeout", "Timeout: disabled");
  await listener.send(":cwd", os.homedir());
  await listener.send(":use p2\n:timeout", "Timeout: 3600000 ms");
  await listener.send(":cwd", os.tmpdir());

  first.child.stdin.write(":quit\n");
  assert.equal(await first.exited, 0);
  await listener.send(":info", `"pid": ${second.child.pid}`);
  await second.send(print("SECOND_STILL_WORKS"), "SECOND_STILL_WORKS");
  assert.equal(listener.closed, false);

  const third = launchCli(t, ["connect", url], { env: { ...process.env, CNS_TEST_PEER: "THIRD_ONLY" } });
  await third.waitFor("Type a shell command");
  await listener.waitFor("p3");
  await listener.send(":info", `"pid": ${second.child.pid}`);
  second.child.stdin.write(":quit\n");
  assert.equal(await second.exited, 0);
  await listener.send(":info", ":use");
  await listener.send(":use p3\n:info", `"pid": ${third.child.pid}`);
  await listener.send(environment, "THIRD_ONLY");
  await third.send(print("THIRD_STILL_WORKS"), "THIRD_STILL_WORKS");
  listener.child.stdin.write(":quit\n");
  assert.deepEqual(await Promise.all([listener.exited, third.exited]), [0, 0]);
});

test("run preserves exact output, quoting and remote exit status against a headless listener", { timeout: 30000 }, async (t) => {
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port, "--no-repl"]);
  await listener.waitFor("listening at");
  const command = process.platform === "win32"
    ? `[Console]::Write("héllo 'quoted' "+'$HOME'); [Console]::Error.Write('exact error'); exit 7`
    : `printf '%s' "héllo 'quoted' " '$HOME'; printf 'exact error' >&2; exit 7`;
  const run = launchCli(t, ["run", url, "--", command]);
  assert.equal(await run.exited, 7);
  assert.equal(run.stdout, "héllo 'quoted' $HOME");
  assert.equal(run.stderr, "exact error");
  const next = launchCli(t, ["run", url, "--", print("LATER_RUN")]);
  assert.equal(await next.exited, 0);
  assert.equal(next.stdout, "LATER_RUN");
  assert.equal(next.stderr, "");
  assert.equal(listener.closed, false);
  await eventually(async () => (listener.stdout.match(/Disconnected from /g) ?? []).length === 2, "both connections logged");
  const connected = [...listener.stdout.matchAll(/Connected to (.+) \[/g)].map((match) => match[1]);
  const disconnected = [...listener.stdout.matchAll(/Disconnected from (.+)\./g)].map((match) => match[1]);
  assert.equal(connected.length, 2);
  assert.deepEqual(disconnected, connected, "each disconnect identifies the same endpoint as its connection");
  for (const identity of connected) {
    assert.ok(identity!.startsWith(`${os.hostname()} (`));
    assert.match(identity!, /\[::1\]:\d+\)$/);
  }
  assert.doesNotMatch(listener.stdout, /\bp\d+\b/);
});

test("run exports reverse RPC while its command is live and disconnect cleans up its processes only", { timeout: 30000, skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns transport "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "command.pid");
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port]);
  await listener.waitFor("listening at");
  const survivor = launchCli(t, ["connect", url]);
  await survivor.waitFor("Type a shell command");
  const run = launchCli(t, ["run", url, "--cwd", directory, "--", "printf '%s' $$ > command.pid; exec sleep 60"], { env: { ...process.env, CNS_TEST_PEER: "REVERSE_RUN_ONLY" } });
  await eventually(async () => { try { return (await readFile(pidFile, "utf8")).length > 0; } catch { return false; } }, "remote command started in requested cwd");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  await listener.send(":use p2\n:info", `"pid": ${run.child.pid}`);
  await listener.send(environment, "REVERSE_RUN_ONLY");
  assert.equal(run.closed, false, "reverse calls must work during the pending forward run");
  run.child.kill("SIGTERM");
  await run.exited;
  await eventually(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "disconnected session process group was killed");
  await survivor.send(print("SURVIVOR_OK"), "SURVIVOR_OK");
  await listener.send(":use p1\n:info", `"pid": ${survivor.child.pid}`);
  const timed = launchCli(t, ["run", url, "--timeout", "100", "--", "sleep 60"]);
  assert.equal(await timed.exited, 124);
  assert.equal(listener.closed, false);
});


test("run and interactive connect report unreachable listeners as failure", { timeout: 15000 }, async (t) => {
  const url = `ws://[::1]:${await unusedPort()}`;
  const run = launchCli(t, ["run", url, "--", print("MUST_NOT_RUN")]);
  const interactive = launchCli(t, ["connect", url]);
  const codes = await Promise.all([run.exited, interactive.exited]);
  assert.ok(codes.every((code) => typeof code === "number" && code !== 0));
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /connect|WebSocket|closed/i);
  assert.match(interactive.stderr, /connect|WebSocket|closed/i);
});
