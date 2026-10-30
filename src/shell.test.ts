import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { MAX_OUTPUT_BYTES, MAX_PTY_BACKLOG_BYTES, MAX_PTY_INPUT_BYTES, MAX_TIMEOUT_MS, ShellApi, type PtyExit } from "./shell.js";

const windows = process.platform === "win32";
function apiFor(t: TestContext) {
  const api = new ShellApi();
  t.after(() => api[Symbol.dispose]());
  return api;
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


test("reports signal numbers from the executing operating system", { skip: windows }, async (t) => {
  const result = await apiFor(t).run("kill -USR1 $$");
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGUSR1");
  assert.equal(result.signalNumber, os.constants.signals.SIGUSR1);
});

/** Collect PTY output locally, as a remote caller's sink would. */
function ptySink(stall = false) {
  let output = "";
  let changed = () => {};
  let finish!: (result: PtyExit) => void;
  const exited = new Promise<PtyExit>((resolve) => { finish = resolve; });
  const decoder = new TextDecoder();
  return {
    exited,
    get output() { return output; },
    sink: {
      output(data: Uint8Array) {
        if (stall) return new Promise<void>(() => {});
        output += decoder.decode(data, { stream: true });
        changed();
      },
      exit(result: PtyExit) { finish(result); },
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
  assert.throws(() => api.openPty(collected.sink, { cwd: path.join(os.tmpdir(), "capnweb-no-such-directory", "absent") }), /ENOENT/);
  const pty = api.openPty(collected.sink, { command: "printf 'READY\\n'; sleep 10" });
  await collected.waitFor("READY");
  assert.throws(() => pty.write("x".repeat(MAX_PTY_INPUT_BYTES + 1)), /at most/);
  assert.throws(() => pty.resize(80, 1001));
  api[Symbol.dispose]();
  const result = await collected.exited;
  assert.ok(result.elapsedMs < 8000);
  assert.throws(() => api.openPty(collected.sink), /closed/);
});

test("PTY sessions are refused on Windows peers", { skip: !windows }, (t) => {
  assert.throws(() => apiFor(t).openPty(ptySink().sink), /Linux or macOS/);
});
