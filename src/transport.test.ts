import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port], { env: { CNS_TEST_PEER: "LISTENER_ONLY" } });
  await listener.waitFor("listening at");
  const rejected = await fetch(`http://[::1]:${port}`, { headers: { Origin: "https://example.invalid", Upgrade: "websocket" } });
  assert.equal(rejected.status, 401);
  const first = launchCli(t, ["connect", url], { env: { CNS_TEST_PEER: "FIRST_ONLY" } });
  await first.waitFor("Type a shell command");
  await listener.send(":info", `"pid": ${first.child.pid}`);
  await listener.send(environment, "FIRST_ONLY");

  const second = launchCli(t, ["connect", url], { env: { CNS_TEST_PEER: "SECOND_ONLY" } });
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

  const third = launchCli(t, ["connect", url], { env: { CNS_TEST_PEER: "THIRD_ONLY" } });
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

test("run uses environment defaults and honors explicit endpoint and cwd overrides", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns env "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const override = path.join(directory, "override cwd");
  await mkdir(override);
  await writeFile(path.join(directory, "marker.txt"), "ENV_CWD");
  await writeFile(path.join(override, "marker.txt"), "FLAG_CWD");
  const port = await unusedPort();
  const env = { CNS_BIND: "::1", CNS_PORT: port, CNS_CWD: directory };
  const listener = launchCli(t, ["listen", "--no-repl"], { env });
  await listener.waitFor(`listening at ws://[::1]:${port}`);
  const command = process.platform === "win32"
    ? "[Console]::Write((Get-Content -Raw marker.txt)); exit 7"
    : "printf '%s' \"$(< marker.txt)\"; exit 7";
  for (const scenario of [
    { args: ["run", "--", command], env, output: "ENV_CWD" },
    {
      args: ["run", "--bind", "::1", "--port", port, "--cwd", override, "--", command],
      env: { CNS_BIND: "invalid", CNS_PORT: "invalid", CNS_CWD: "" },
      output: "FLAG_CWD",
    },
    {
      args: ["run", `ws://[::1]:${port}`, "--", command],
      env: { ...env, CNS_BIND: "invalid", CNS_PORT: "invalid" },
      output: "ENV_CWD",
    },
  ]) {
    const run = launchCli(t, scenario.args, { env: scenario.env });
    assert.equal(await run.exited, 7, run.output);
    assert.equal(run.stdout, scenario.output);
    assert.equal(run.stderr, "");
  }
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
  const run = launchCli(t, ["run", url, "--cwd", directory, "--", "printf '%s' $$ > command.pid; exec sleep 60"], { env: { CNS_TEST_PEER: "REVERSE_RUN_ONLY" } });
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

test("tty runs programs on a remote terminal with piped input and returns their status", { timeout: 30000, skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns tty "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port]);
  await listener.waitFor("listening at");
  const tty = launchCli(t, ["tty", url, "--cwd", directory, "--cols", "100", "--rows", "30", "--term", "vt100", "--",
    `tty -s && printf 'IS''TTY %s %s ' "$TERM" "$(pwd)"; stty size; read -r line; printf 'got:%s\n' "$line"; exit 5`]);
  await tty.waitFor("ISTTY");
  // Reverse calls keep working while the forward PTY is live.
  await listener.send(":use p1\n:info", `"pid": ${tty.child.pid}`);
  // Without a local terminal the console cannot hand its keyboard to a PTY.
  await listener.send(":tty", ":tty and :attach require an interactive local terminal");
  tty.child.stdin.write("héllo\r");
  assert.equal(await tty.exited, 5, tty.output);
  // The terminal echoes input wherever it arrives, so check each fact separately.
  assert.ok(tty.stdout.includes(`ISTTY vt100 `) && tty.stdout.includes(`${path.basename(directory)} `), tty.stdout);
  assert.match(tty.stdout, /[ \n]30 100\r\n/);
  assert.match(tty.stdout, /got:héllo\r\n/);
  assert.equal(tty.stderr, "");

  const timed = launchCli(t, ["tty", url, "--timeout", "100", "--", "sleep 60"]);
  assert.equal(await timed.exited, 124);
  assert.match(timed.stderr, /timed out/);

  // --screen prints the rendered terminal, not the escape sequences that drew it.
  const drawn = "printf '\\033[?1049h\\033[2J\\033[2;3Hdrawn\\033[1;1Htop'; sleep 60";
  const screen = launchCli(t, ["tty", url, "--screen", "--cols", "20", "--rows", "4", "--timeout", "1000", "--", drawn]);
  assert.equal(await screen.exited, 124, screen.output);
  assert.equal(screen.stdout, "top\n  drawn\n");
  const history = launchCli(t, ["tty", url, "--screen", "--rows", "3", "--history", "2", "--", "seq 1 8; exit 4"]);
  assert.equal(await history.exited, 4, history.output);
  assert.equal(history.stdout, "5\n6\n7\n8\n");
  assert.equal(history.stderr, "");
  assert.equal(listener.closed, false);
});

test("named tty sessions persist across CLI calls for keys, screens, attach and kill", { timeout: 60000, skip: process.platform === "win32" }, async (t) => {
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port, "--no-repl"]);
  await listener.waitFor("listening at");
  const cli = async (...args: string[]) => {
    const command = launchCli(t, args);
    command.child.stdin.end();
    const code = await command.exited;
    return { code, stdout: command.stdout, stderr: command.stderr };
  };
  const program = "printf 'ready\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; [ \"$line\" = quit ] && exit 6; done";
  assert.deepEqual(await cli("tty", url, "--name", "app", "--cols", "40", "--rows", "6", "--", program), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await cli("screen", url, "app", "--until", "ready"), { code: 0, stdout: "ready\n", stderr: "" });
  assert.deepEqual(await cli("keys", url, "app", "hello there", "Enter"), { code: 0, stdout: "", stderr: "" });
  const shown = await cli("screen", url, "app", "--until", "got:hello there");
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /got:hello there\n$/);
  const timedOut = await cli("screen", url, "app", "--until", "absent", "--timeout", "200");
  assert.equal(timedOut.code, 124);
  assert.match(timedOut.stderr, /timed out waiting/);
  assert.match(timedOut.stdout, /got:hello there/);
  const listed = await cli("sessions", url, "--json");
  const [info] = JSON.parse(listed.stdout);
  assert.deepEqual([info.name, info.running, info.cols, info.rows, info.viewers], ["app", true, 40, 6, 0]);
  assert.match((await cli("sessions", url)).stdout, /^app {2}running {2}40x6 {2}0 attached {2}printf 'ready/);
  assert.equal((await cli("tty", url, "--name", "app", "--", "true")).code, 1);

  // Attaching without a terminal redraws the screen and streams until the program exits.
  // It does not resize a session that others may share.
  const attached = launchCli(t, ["tty", url, "--attach", "app"]);
  await attached.waitFor("got:hello there");
  attached.child.stdin.write("quit\r");
  assert.equal(await attached.exited, 6, attached.output);
  assert.match(attached.stdout, /got:quit/);
  assert.match((await cli("sessions", url)).stdout, /^app {2}exited 6 {2}40x6 /);
  const ended = await cli("screen", url, "app", "--until", "absent");
  assert.equal(ended.code, 1);
  assert.match(ended.stderr, /ended before the text appeared/);

  assert.deepEqual(await cli("kill", url, "app"), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await cli("sessions", url), { code: 0, stdout: "", stderr: "" });
  const missing = await cli("keys", url, "app", "Enter");
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, "No PTY session named app.\n");
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
