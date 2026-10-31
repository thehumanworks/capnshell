import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import {
  MAX_FORKS, MAX_NAMED_PTYS, MAX_OUTPUT_BYTES, MAX_PTY_BACKLOG_BYTES, MAX_PTY_INPUT_BYTES, MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, PtyRegistry, ShellApi, type PtyExit,
} from "./shell.js";

const windows = process.platform === "win32";
function apiFor(t: TestContext) {
  const api = new ShellApi();
  t.after(() => api[Symbol.dispose]());
  return api;
}

/** Named sessions belong to the registry, which outlives each connection's ShellApi. */
function registryFor(t: TestContext) {
  const registry = new PtyRegistry();
  t.after(() => registry[Symbol.dispose]());
  const connect = () => {
    const api = new ShellApi(registry);
    t.after(() => api[Symbol.dispose]());
    return api;
  };
  return { registry, connect };
}

test("reports the native runtime and shell", (t) => {
  const info = apiFor(t).info();
  assert.equal(info.platform, process.platform);
  assert.equal(info.shell, windows ? "PowerShell" : "Bash");
  assert.equal(info.cwd, os.homedir());
});

test("captures stdout, stderr and exit status", async (t) => {
  const result = await apiFor(t).run(windows
    ? "[Console]::Write('out'); [Console]::Error.Write('err'); exit 7"
    : "printf out; printf err >&2; exit 7");
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test("PowerShell errors are text, not CLIXML", { skip: !windows }, async (t) => {
  const result = await apiFor(t).run("Write-Error 'capnweb-test-error'; exit 3");
  assert.match(result.stderr, /capnweb-test-error/);
  assert.doesNotMatch(result.stderr, /CLIXML|<Objs/);
  assert.equal(result.exitCode, 3);
});

test("preserves Unicode and quoting", async (t) => {
  const result = await apiFor(t).run(windows
    ? "[Console]::Write('héllo 漢字 ''quoted''')"
    : `printf '%s' "héllo 漢字 'quoted'"`);
  assert.equal(result.stdout, "héllo 漢字 'quoted'");
  assert.equal(result.exitCode, 0);
});

test("uses a requested working directory, including spaces", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "capnweb test "));
  try {
    const result = await apiFor(t).run(windows ? "[Console]::Write((Get-Location).Path)" : "pwd", { cwd: dir });
    // macOS may canonicalize /var to /private/var when starting Bash.
    assert.equal(await realpath(result.stdout.trim()), await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commands have no deadline by default or with timeoutMs zero", async (t) => {
  const api = apiFor(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const command = windows ? "[Console]::Write('unlimited')" : "printf unlimited";
  const results = Promise.all([api.run(command), api.run(command, { timeoutMs: 0 })]);
  // Advance application timers by a day before handling child-process output.
  // A hidden 30-second deadline would kill the command and set timedOut.
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  for (const result of await results) {
    assert.equal(result.stdout, "unlimited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  }
});

test("accepts optional deadlines well beyond the old five-minute cap", async (t) => {
  const api = apiFor(t);
  const command = windows ? "[Console]::Write('extended')" : "printf extended";
  for (const timeoutMs of [3_600_000, MAX_TIMEOUT_MS]) {
    const result = await api.run(command, { timeoutMs });
    assert.equal(result.stdout, "extended");
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
  }
});

test("times out commands only when a deadline is explicitly supplied", async (t) => {
  const result = await apiFor(t).run(windows ? "Start-Sleep -Seconds 10" : "sleep 10", { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(result.elapsedMs < 8000);
});

test("limits captured output to 1 MiB", async (t) => {
  const count = MAX_OUTPUT_BYTES + 100;
  const result = await apiFor(t).run(windows
    ? `[Console]::Write(('x' * ${count}))`
    : `head -c ${count} /dev/zero | tr '\\0' x`);
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.byteLength(result.stdout), MAX_OUTPUT_BYTES);
  assert.equal(result.truncated, true);
});

test("validates commands, paths and timeout bounds", async (t) => {
  const api = apiFor(t);
  await assert.rejects(api.run(""), /Command/);
  await assert.rejects(api.run("x".repeat(8193)), /Command/);
  await assert.rejects(api.run("echo test", { timeoutMs: -1 }), /timeoutMs/);
  await assert.rejects(api.run("echo test", { timeoutMs: MAX_TIMEOUT_MS + 1 }), /timeoutMs/);
  await assert.rejects(api.run("echo test", { cwd: "relative" }), /absolute/);
  await assert.rejects(api.run("echo test", { cwd: path.join(os.tmpdir(), "capnweb-no-such-directory", "absent") }), /ENOENT/);
});

test("disposal kills in-flight commands and disallows new ones", async () => {
  const api = new ShellApi();
  const pending = api.run(windows ? "Start-Sleep -Seconds 10" : "sleep 10");
  api[Symbol.dispose]();
  const result = await pending;
  assert.ok(result.elapsedMs < 8000);
  await assert.rejects(api.run("echo test"), /closed/);
});


test("releasing a fork kills its commands only, and closing the shell closes its forks", async () => {
  const api = new ShellApi();
  const sleep = windows ? "Start-Sleep -Seconds 10" : "sleep 10";
  const fork = api.fork();
  assert.throws(() => fork.fork(), /cannot fork/);
  const [forked, own] = [fork.run(sleep), api.run(windows ? "Start-Sleep -Milliseconds 300; [Console]::Write('kept')" : "sleep 0.3; printf kept")];
  fork[Symbol.dispose]();
  assert.ok((await forked).elapsedMs < 8000);
  await assert.rejects(fork.run("echo test"), /closed/);
  assert.equal((await own).stdout, "kept");

  const forks = Array.from({ length: MAX_FORKS }, () => api.fork());
  assert.throws(() => api.fork(), /Too many forked shells/);
  forks.pop()![Symbol.dispose]();
  const last = api.fork();
  const pending = last.run(sleep);
  api[Symbol.dispose]();
  assert.ok((await pending).elapsedMs < 8000);
  await assert.rejects(forks[0]!.run("echo test"), /closed/);
  assert.throws(() => api.fork(), /closed/);
});

test("reports signal numbers from the executing operating system", { skip: windows }, async (t) => {
  const result = await apiFor(t).run("kill -USR1 $$");
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGUSR1");
  assert.equal(result.signalNumber, os.constants.signals.SIGUSR1);
});

/** Collect PTY output locally, as a remote caller's sink would. */
function ptySink(stall = false) {
  let output = "";
  let chunks = 0;
  let changed = () => {};
  let finish!: (result: PtyExit) => void;
  const exited = new Promise<PtyExit>((resolve) => { finish = resolve; });
  let detach!: (reason: string) => void;
  const detached = new Promise<string>((resolve) => { detach = resolve; });
  const decoder = new TextDecoder();
  return {
    exited,
    detached,
    get output() { return output; },
    get chunks() { return chunks; },
    sink: {
      output(data: Uint8Array) {
        if (stall) return new Promise<void>(() => {});
        chunks++;
        output += decoder.decode(data, { stream: true });
        changed();
      },
      exit(result: PtyExit) { finish(result); },
      detached(reason: string) { detach(reason); },
    },
    waitFor(needle: string) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Waiting for ${needle}: ${JSON.stringify(output)}`)), 10000);
        changed = () => { if (output.includes(needle)) { clearTimeout(timer); resolve(); } };
        changed();
      });
    },
  };
}

test("PTY sessions run programs on a real terminal with input, size and exit status", { skip: windows }, async (t) => {
  const collected = ptySink();
  const pty = apiFor(t).openPty(collected.sink, {
    command: `tty -s && printf 'IS''TTY '; printf '%s ' "$TERM"; stty size; read -r line; printf 'got:%s\\n' "$line"; exit 7`,
    cols: 120, rows: 40, term: "vt100",
  });
  await collected.waitFor("ISTTY vt100 40 120");
  pty.write("héllo\r");
  const result = await collected.exited;
  assert.match(collected.output, /got:héllo\r\n/);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
});

test("PTY sessions resize, hang up and time out", { skip: windows }, async (t) => {
  const api = apiFor(t);
  const resized = ptySink();
  const pty = api.openPty(resized.sink, { command: "printf 'READY\\n'; read -r _; stty size; read -r _" });
  await resized.waitFor("READY");
  pty.resize(100, 30);
  pty.write("\r");
  await resized.waitFor("30 100");
  pty.close();
  const hungUp = await resized.exited;
  assert.ok(hungUp.signal === "SIGHUP" || hungUp.exitCode !== 0, JSON.stringify(hungUp));

  const timed = ptySink();
  api.openPty(timed.sink, { command: "sleep 10", timeoutMs: 200 });
  const result = await timed.exited;
  assert.equal(result.timedOut, true);
  assert.ok(result.elapsedMs < 8000);
});

test("PTY sessions end when the caller stops acknowledging output", { skip: windows }, async (t) => {
  const stalled = ptySink(true);
  apiFor(t).openPty(stalled.sink, { command: `head -c ${MAX_PTY_BACKLOG_BYTES * 2} /dev/zero | tr '\\0' x; sleep 10` });
  const result = await stalled.exited;
  assert.match(result.error ?? "", /backlog/);
  assert.ok(result.elapsedMs < 8000);
});

test("PTY sessions validate input and are killed with their shell API", { skip: windows }, async () => {
  const api = new ShellApi();
  const collected = ptySink();
  assert.throws(() => api.openPty(collected.sink, { cols: 0 }), /cols|>=1/);
  assert.throws(() => api.openPty(collected.sink, { term: "xterm; rm -rf /" }), /terminfo/);
  assert.throws(() => api.openPty(collected.sink, { command: " " }), /Command/);
  assert.throws(() => api.openPty(collected.sink, { cwd: "relative" }), /absolute/);
  assert.throws(() => api.openPty(null as never), /sink/);
  assert.throws(() => api.openPty(collected.sink, { cwd: path.join(os.tmpdir(), "capnweb-no-such-directory", "absent") }), /cwd does not exist/);
  const pty = api.openPty(collected.sink, { command: "printf 'READY\\n'; sleep 10" });
  await collected.waitFor("READY");
  assert.throws(() => pty.write("x".repeat(MAX_PTY_INPUT_BYTES + 1)), /at most/);
  assert.throws(() => pty.resize(80, 1001));
  api[Symbol.dispose]();
  const result = await collected.exited;
  assert.ok(result.elapsedMs < 8000);
  assert.throws(() => api.openPty(collected.sink), /closed/);
});

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (const deadline = Date.now() + 10000; ;) {
    const value = await read();
    if (accept(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("PTY screens render on request while running, in the alternate screen and after exit", { skip: windows }, async (t) => {
  const api = apiFor(t);
  const collected = ptySink();
  const pty = api.openPty(collected.sink, {
    cols: 30, rows: 5,
    command: `printf '\\033]2;my title\\007main 漢字\\r\\n'; read -r _; printf '\\033[?1049h\\033[2J\\033[3;5Hfull screen'; read -r _; printf '\\033[?1049l'; printf 'done   \\r\\n'`,
  });
  const main = await eventually(() => pty.capture(), (screen) => screen.text.startsWith("main"));
  assert.equal(main.text, "main 漢字\n\n\n\n");
  assert.deepEqual([main.cols, main.rows, main.cursor, main.alternateScreen, main.title], [30, 5, { x: 0, y: 1 }, false, "my title"]);
  pty.write("\r");
  const full = await eventually(() => pty.capture(), (screen) => screen.alternateScreen && screen.text.includes("full"));
  assert.equal(full.text, "\n\n    full screen\n\n");
  assert.deepEqual(full.cursor, { x: 15, y: 2 });
  pty.write("\r");
  assert.equal((await collected.exited).exitCode, 0);
  const after = await pty.capture();
  assert.equal(after.alternateScreen, false);
  assert.match(after.text, /^main 漢字\n\n?done\n/);
  pty[Symbol.dispose]();
  await assert.rejects(pty.capture(), /released/);
});

test("PTY screens keep scrollback, track resizes and can answer terminal queries", { skip: windows }, async (t) => {
  const api = apiFor(t);
  const history = ptySink();
  const scrolled = api.openPty(history.sink, { command: "seq 1 8", rows: 3, cols: 10, stream: false });
  await history.exited;
  assert.equal(history.chunks, 0, "stream: false sends no output");
  assert.equal((await scrolled.capture()).text, "7\n8\n");
  assert.equal((await scrolled.capture({ history: 2 })).text, "5\n6\n7\n8\n");
  assert.equal((await scrolled.capture({ history: MAX_SCREEN_HISTORY })).text, "1\n2\n3\n4\n5\n6\n7\n8\n");
  await assert.rejects(scrolled.capture({ history: MAX_SCREEN_HISTORY + 1 }));
  await assert.rejects(scrolled.capture({ extra: true } as never));
  scrolled[Symbol.dispose]();

  // Without a terminal attached, a cursor-position query is answered by the screen.
  const query = "printf 'abc\\033[6n'; IFS= read -rs -d R reply; printf ' reply=%s' \"${reply#*[}\"";
  const answered = ptySink();
  const pty = api.openPty(answered.sink, { command: query, respond: true, cols: 40, rows: 4 });
  await answered.exited;
  assert.match(answered.output, /reply=1;4/);
  pty.resize(20, 2);
  assert.deepEqual([(await pty.capture()).cols, (await pty.capture()).rows], [40, 4], "resizing after exit has no effect");
  pty[Symbol.dispose]();

  const running = ptySink();
  const live = api.openPty(running.sink, { command: "printf READY; read -r _", cols: 40, rows: 4 });
  await running.waitFor("READY");
  live.resize(50, 6);
  const resized = await live.capture();
  assert.deepEqual([resized.cols, resized.rows], [50, 6]);
  live[Symbol.dispose]();
  assert.equal((await running.exited).timedOut, false);
});

test("released PTY sessions free their slot; unreleased ones keep it", { skip: windows }, async (t) => {
  const api = apiFor(t);
  const sessions = [];
  for (let index = 0; index < 4; index++) {
    const collected = ptySink();
    sessions.push(api.openPty(collected.sink, { command: "true" }));
    await collected.exited;
  }
  assert.throws(() => api.openPty(ptySink().sink, { command: "true" }), /release/);
  sessions[0]![Symbol.dispose]();
  const collected = ptySink();
  api.openPty(collected.sink, { command: "true" });
  await collected.exited;
});

test("named PTY sessions outlive the connection that started them and are found by name", { skip: windows }, async (t) => {
  const { connect } = registryFor(t);
  const first = connect();
  const started = first.startPtySession("work", {
    cols: 40, rows: 5, command: "printf 'ready\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done",
  });
  assert.equal((await started.wait({ text: "ready", timeoutMs: 10000 })).matched, true);
  // Closing the connection that started it leaves a named session running.
  first[Symbol.dispose]();
  const second = connect();
  const work = second.ptySession("work");
  work.keys(["héllo world", "Enter"]);
  const waited = await work.wait({ text: "got:héllo world", timeoutMs: 10000 });
  assert.deepEqual([waited.matched, waited.running], [true, true]);
  assert.match(waited.screen.text, /^ready\n/);
  const [info] = second.ptySessions();
  assert.deepEqual([info?.name, info?.running, info?.exit, info?.viewers, info?.cols, info?.rows], ["work", true, null, 0, 40, 5]);
  assert.match(info!.command!, /^printf 'ready/);
  assert.throws(() => second.startPtySession("work", { command: "true" }), /already exists/);
  assert.throws(() => second.ptySession("missing"), /No PTY session named missing/);
  assert.throws(() => second.ptySession("bad name"), /Session names/);
  assert.throws(() => second.startPtySession("-x", { command: "true" }), /Session names/);
  assert.throws(() => second.startPtySession("nowhere", { command: "true", cwd: "/nonexistent/cns" }), /cwd does not exist on the executing peer/);
  assert.equal(second.ptySessions().length, 1, "a session that failed to start is not registered");

  const exit = await work.kill();
  assert.equal(exit.signal, "SIGHUP");
  assert.deepEqual(second.ptySessions(), []);
  // A handle never reaches a later session that reuses its name.
  second.startPtySession("work", { command: "sleep 60" });
  await assert.rejects(work.capture(), /no longer exists/);
  assert.throws(() => work.keys(["x"]), /no longer exists/);
  assert.equal(second.ptySession("work").info().command, "sleep 60");
});

test("attaching redraws the current screen, then streams; detaching leaves the program running", { skip: windows }, async (t) => {
  const { connect } = registryFor(t);
  const api = connect();
  const session = api.startPtySession("view", {
    cols: 30, rows: 5, command: "printf '\\033[?1049h\\033[2J\\033[1;1Htop line\\033[3;5Hdrawn'; while IFS= read -r line; do printf '<%s>' \"$line\"; done",
  });
  await session.wait({ text: "drawn", timeoutMs: 10000 });
  const first = ptySink();
  const attachment = session.attach(first.sink, { cols: 30, rows: 5 });
  await first.waitFor("drawn");
  // Drawing the redraw on a fresh terminal reproduces the session's screen.
  const fresh = new Screen({ cols: 30, rows: 5, allowProposedApi: true });
  await new Promise<void>((resolve) => fresh.write(first.output, resolve));
  const lines = Array.from({ length: 5 }, (_, y) => fresh.buffer.active.getLine(y)!.translateToString(true).trimEnd());
  assert.equal(lines.join("\n"), (await session.capture()).text);
  assert.equal(fresh.buffer.active.type, "alternate");
  fresh.dispose();

  session.keys(["live", "Enter"]);
  await first.waitFor("<live>");
  const second = ptySink();
  const other = session.attach(second.sink);
  await second.waitFor("<live>");
  assert.equal(session.info().viewers, 2);
  attachment.detach();
  session.keys(["more", "Enter"]);
  await second.waitFor("<more>");
  assert.ok(!first.output.includes("<more>"), "a detached viewer receives nothing further");
  other[Symbol.dispose]();
  assert.deepEqual([session.info().viewers, session.info().running], [0, true]);
  // Attaching with a size resizes the session for every viewer, as in tmux.
  session.attach(ptySink().sink, { cols: 50, rows: 7 })[Symbol.dispose]();
  assert.deepEqual([session.info().cols, session.info().rows], [50, 7]);
});

test("finished named sessions keep their screen; late viewers get the redraw and exit", { skip: windows }, async (t) => {
  const api = registryFor(t).connect();
  const session = api.startPtySession("done", { command: "printf 'final words'; exit 3" });
  // Without a deadline, waiting ends when the program does.
  const waited = await session.wait({ text: "never shown" });
  assert.deepEqual([waited.matched, waited.running], [false, false]);
  assert.match(waited.screen.text, /^final words/);
  assert.equal(session.info().exit?.exitCode, 3);
  assert.equal(api.ptySessions()[0]?.running, false);
  const late = ptySink();
  session.attach(late.sink);
  assert.equal((await late.exited).exitCode, 3);
  assert.match(late.output, /final words/);
  assert.equal((await session.kill()).exitCode, 3);
  assert.deepEqual(api.ptySessions(), []);
});

test("named sessions answer terminal queries unless an attached terminal does", { skip: windows }, async (t) => {
  const session = registryFor(t).connect().startPtySession("queries", {
    cols: 40, rows: 4,
    command: "printf 'abc\\033[6n'; IFS= read -rs -d R first; printf ' first=%s\\n' \"${first#*[}\"; read -r _; printf '\\033[6n'; IFS= read -rs -d R second; printf ' second=%s' \"${second#*[}\"",
  });
  await session.wait({ text: "first=1;4", timeoutMs: 10000 });
  const viewer = ptySink();
  const attachment = session.attach(viewer.sink, { answers: true });
  await viewer.waitFor("first=");
  session.keys(["Enter"]);
  await viewer.waitFor("\x1b[6n");
  // Only the attached terminal answers now; a second answer would corrupt the reply.
  attachment.write("\x1b[9;9R");
  const done = await session.wait({ text: "second=", timeoutMs: 10000 });
  assert.match(done.screen.text, /second=9;9$/m);
});

test("keys follow the program's cursor-key mode", { skip: windows }, async (t) => {
  const session = registryFor(t).connect().startPtySession("cursor", {
    command: "printf '\\033[?1hready'; IFS= read -rs -n 3 key; printf ' hex=%s' \"$(printf '%s' \"$key\" | od -An -tx1 | tr -d ' \\n')\"",
  });
  await session.wait({ text: "ready", timeoutMs: 10000 });
  session.keys(["Up"]);
  assert.match((await session.wait({ text: "hex=", timeoutMs: 10000 })).screen.text, /hex=1b4f41/);
  assert.throws(() => session.keys([]));
  assert.throws(() => session.keys(["x".repeat(MAX_PTY_INPUT_BYTES + 1)]));
});

test("a viewer that stops reading is dropped without ending the program", { skip: windows }, async (t) => {
  const session = registryFor(t).connect().startPtySession("slow", { command: "printf ready; sleep 60" });
  await session.wait({ text: "ready", timeoutMs: 10000 });
  const failing = ptySink();
  failing.sink.output = () => { throw new Error("gone"); };
  session.attach(failing.sink);
  assert.match(await failing.detached, /stopped receiving/);
  assert.deepEqual([session.info().viewers, session.info().running], [0, true]);
});

test("waits time out, validate their options and are limited per session", { skip: windows }, async (t) => {
  const session = registryFor(t).connect().startPtySession("waits", { command: "sleep 60" });
  const timedOut = await session.wait({ text: "x", timeoutMs: 100 });
  assert.deepEqual([timedOut.matched, timedOut.running], [false, true]);
  await assert.rejects(session.wait({ text: "" }));
  await assert.rejects(session.wait({ text: "x", timeoutMs: -1 }));
  await assert.rejects(session.wait({ text: "x", extra: 1 } as never));
  // Killing the session ends every wait.
  const pending = Array.from({ length: 8 }, () => assert.rejects(session.wait({ text: "never" }), /released/));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(session.wait({ text: "never" }), /Too many callers/);
  await session.kill();
  await Promise.all(pending);
});

test("each process holds a bounded number of named sessions until they are killed", { skip: windows }, async (t) => {
  const api = registryFor(t).connect();
  const sessions = Array.from({ length: MAX_NAMED_PTYS }, (_, index) => api.startPtySession(`s${index}`, { command: "true" }));
  assert.throws(() => api.startPtySession("extra", { command: "true" }), /Too many named PTY sessions/);
  await sessions[0]!.kill();
  api.startPtySession("extra", { command: "true" });
});

test("Windows named sessions outlive connections, take keys, attach and are killed", { skip: !windows }, async (t) => {
  const { connect } = registryFor(t);
  const first = connect();
  const session = first.startPtySession("win", {
    cols: 80, rows: 10,
    command: "[Console]::WriteLine('ready'); while ($true) { $line = [Console]::ReadLine(); [Console]::WriteLine('got:' + $line); if ($line -eq 'quit') { exit 6 } }",
  });
  assert.equal((await session.wait({ text: "ready", timeoutMs: 20000 })).matched, true);
  first[Symbol.dispose]();
  const second = connect();
  const win = second.ptySession("win");
  win.keys(["héllo", "Enter"]);
  assert.equal((await win.wait({ text: "got:héllo", timeoutMs: 20000 })).matched, true);
  const viewer = ptySink();
  win.attach(viewer.sink);
  await viewer.waitFor("got:h");
  win.keys(["quit", "Enter"]);
  assert.equal((await viewer.exited).exitCode, 6);
  assert.equal(second.ptySessions()[0]?.running, false);
  assert.equal((await win.kill()).exitCode, 6);

  // Killing a running session ends its process tree.
  const sleeper = second.startPtySession("sleeper", { command: "Start-Sleep -Seconds 60" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const started = Date.now();
  await sleeper.kill();
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(second.ptySessions(), []);
});

// ConPTY: no termios, no signals and no CR-to-LF translation of input.
test("Windows PTY sessions run PowerShell on a ConPTY with input, size, screen and timeout", { skip: !windows }, async (t) => {
  const api = apiFor(t);
  const collected = ptySink();
  const pty = api.openPty(collected.sink, {
    cols: 100, rows: 30,
    command: "[Console]::Write('READY ' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight); $line = [Console]::ReadLine(); [Console]::Write('got:' + $line); exit 7",
  });
  await collected.waitFor("READY 100x30");
  pty.write("héllo\r\n");
  const result = await collected.exited;
  assert.match(collected.output, /got:héllo/);
  assert.equal(result.exitCode, 7);
  assert.match((await pty.capture()).text, /got:héllo/);
  pty[Symbol.dispose]();

  const timed = ptySink();
  api.openPty(timed.sink, { command: "Start-Sleep -Seconds 10", timeoutMs: 500 });
  const timedOut = await timed.exited;
  assert.equal(timedOut.timedOut, true);
  assert.ok(timedOut.elapsedMs < 8000);
});
