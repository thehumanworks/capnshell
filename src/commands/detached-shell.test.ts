import assert from "node:assert/strict";
import test from "node:test";
import type { PeerConfig } from "../options.js";
import type { PtyScreen, PtySessionInfo } from "../shell.js";
import type { RemoteNamedPty } from "../terminal.js";
import { outputSince, runDetached } from "./detached-shell.js";

const fast = { pollMs: 5, quietMs: 20, capMs: 200, endMs: 20, guessMs: 60 };

/** A screen of `rows` rows whose cursor is on `line`, counted from the top of the scrollback. */
const screen = (lines: string[], rows: number, line: number): PtyScreen =>
  ({ text: lines.join("\n"), cols: 80, rows, cursor: { x: 0, y: line - (lines.length - rows) }, alternateScreen: false, title: "" });

/**
 * A device with named sessions, each described by the infos its handle reports in turn; the
 * last repeats. `busy` and `screens` are what the handles' busy() and capture() return in
 * turn; without `busy` the device's cns is from before busy().
 */
function device(sessions: Record<string, Partial<PtySessionInfo>[]> = {}, { busy = [false], screens = [] }: { busy?: (boolean | null)[] | null; screens?: PtyScreen[] } = {}) {
  const typed: string[] = [];
  const started: string[] = [];
  let pid = 100;
  const describe = (name: string, info: Partial<PtySessionInfo>) =>
    ({ name, running: true, command: null, outputBytes: 0, pid: 1, startedAt: "2026-11-24T10:00:00.000Z", exit: undefined, ...info }) as PtySessionInfo;
  const controller = {
    ptySessions: async () => Object.entries(sessions).map(([name, infos]) => describe(name, infos[0]!)),
    startPtySession: async (_id: string, name: string) => {
      if (sessions[name]) throw new Error(`A PTY session named ${name} already exists. Kill it first.`);
      started.push(name);
      sessions[name] = [{ pid: ++pid }, { pid, outputBytes: 9 }];
      return describe(name, sessions[name][0]!);
    },
    ptySession: async (_id: string, name: string) => {
      const infos = sessions[name];
      if (!infos) throw new Error(`No PTY session named ${name}.`);
      let asked = 0;
      return {
        info: async () => describe(name, infos[Math.min(asked++, infos.length - 1)]!),
        busy: async () => {
          if (!busy) throw new TypeError("'busy' is not a function.");
          return busy.length > 1 ? busy.shift()! : busy[0]!;
        },
        capture: async () => screens.length > 1 ? screens.shift()! : screens[0]!,
        write: async (data: string) => { typed.push(`${name}:${data}`); },
        [Symbol.dispose]() {},
      } as unknown as RemoteNamedPty;
    },
  };
  return { controller, sessions, typed, started };
}

const config = (extra: Partial<PeerConfig>): PeerConfig =>
  ({ role: "shell", expect: { name: "studio" }, detached: true, command: "make", ...extra }) as PeerConfig;

/** Run -d and collect what it wrote to stderr, and with `out` to stdout as well. */
async function detached(t: test.TestContext, studio: ReturnType<typeof device>, extra: Partial<PeerConfig>, signal = new AbortController().signal, out = false) {
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const text = (calls: typeof stderr.mock.calls) => calls.map((call) => String(call.arguments[0])).join("");
  try {
    const code = await runDetached(config(extra), studio.controller, "id", signal, fast);
    return { code, stderr: text(stderr.mock.calls), ...out ? { stdout: text(stdout.mock.calls) } : {} };
  } finally {
    t.mock.restoreAll();
  }
}

test("-d waits for a session that has printed nothing, whoever started it, and types into one that has at once", async (t) => {
  // Another command started the session a moment ago: its shell has not shown a prompt yet.
  const studio = device({ work: [{}, {}, { outputBytes: 12 }], old: [{ outputBytes: 400 }] });
  const began = Date.now();
  assert.deepEqual(await detached(t, studio, { name: "work" }), { code: 0, stderr: "" });
  assert.ok(Date.now() - began >= fast.quietMs, "typed before the prompt");
  assert.deepEqual(studio.typed, ["work:make\r"]);
  assert.deepEqual(await detached(t, studio, { name: "old" }), { code: 0, stderr: "" });
  assert.deepEqual(studio.typed, ["work:make\r", "old:make\r"]);
  assert.deepEqual(studio.started, []);
});

test("-d says when a session shows no prompt in time, and types nothing once it is stopped", async (t) => {
  const silent = device({ work: [{}] });
  assert.deepEqual(await detached(t, silent, { name: "work" }),
    { code: 0, stderr: "cns: the session work did not settle at a prompt within 0.2 seconds; the command was typed anyway\n" });
  assert.deepEqual(silent.typed, ["work:make\r"]);

  const stopped = device({ work: [{}] });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(detached(t, stopped, { name: "work" }, stop.signal),
    /^Error: Stopped before the session work on studio showed its prompt, so nothing was typed\. The session is still running\.$/);
  assert.deepEqual(stopped.typed, []);

  const ending = device({ work: [{}, { running: false, exit: { exitCode: 2 } as PtySessionInfo["exit"] }] });
  await assert.rejects(detached(t, ending, { name: "work" }), /^Error: The session work ended as it started \(.*\); nothing was typed\.$/);
  assert.deepEqual(ending.typed, []);
});

test("-d types only into the session it started", async (t) => {
  const studio = device();
  const { controller } = studio;
  // Between the start and the handle the session is killed and another takes its name.
  const start = controller.startPtySession;
  controller.startPtySession = async (id, name) => {
    const info = await start(id, name);
    studio.sessions[name] = [{ pid: 999, outputBytes: 50 }];
    return info;
  };
  await assert.rejects(detached(t, studio, { name: "work" }),
    /^Error: The session work on studio was replaced by another as it started, so nothing was typed\. Run this again\.$/);
  assert.deepEqual(studio.typed, []);

  // A session started under a free name is typed into once its prompt shows.
  const fresh = device({ "shell-1": [{ outputBytes: 3 }] });
  assert.deepEqual(await detached(t, fresh, { name: undefined }), { code: 0, stderr: "cns: started the session shell-2 on studio\n" });
  assert.deepEqual([fresh.started, fresh.typed], [["shell-2"], ["shell-2:make\r"]]);
});

test("-d --screen prints what the command showed once its shell has the terminal back", async (t) => {
  const before = screen(["old output", "$ ", "", ""], 4, 1);
  const after = screen(["old output", "$ make", "built", "$ "], 4, 3);
  // The shell has the terminal as the command is typed, then make has it a while, then the shell again.
  const studio = device({ work: [{ outputBytes: 50 }, { outputBytes: 50 }, { outputBytes: 50 }, { outputBytes: 60 }, { outputBytes: 70 }] },
    { busy: [false, true, true, true, false], screens: [before, after] });
  const began = Date.now();
  assert.deepEqual(await detached(t, studio, { name: "work", screen: { history: 0 } }, undefined, true), { code: 0, stderr: "", stdout: "$ make\nbuilt\n$ \n" });
  assert.ok(Date.now() - began >= fast.endMs, "printed before the shell had been back for endMs");
  assert.deepEqual(studio.typed, ["work:make\r"]);

  // Without a name, stdout carries the screen alone: stderr names the session it started.
  const fresh = device({}, { screens: [screen(["$ "], 1, 0), screen(["$ make", "$ "], 2, 1)] });
  assert.deepEqual(await detached(t, fresh, { name: undefined, screen: { history: 0 } }, undefined, true),
    { code: 0, stderr: "cns: started the session shell-1 on studio\n", stdout: "$ make\n$ \n" });
});

test("-d --screen toward a device that cannot say when a command ends waits for quiet, and says so", async (t) => {
  const screens = [screen(["$ "], 2, 0), screen(["$ make", "$ "], 2, 1)];
  const old = device({ work: [{ outputBytes: 5 }, { outputBytes: 9 }] }, { busy: null, screens: [...screens] });
  const began = Date.now();
  assert.deepEqual(await detached(t, old, { name: "work", screen: { history: 0 } }, undefined, true), {
    code: 0, stdout: "$ make\n$ \n",
    stderr: "cns: studio runs a cns from before 2.1.0, which cannot say when the command ends; its screen is printed once it shows nothing new for 0.06 seconds\n",
  });
  assert.ok(Date.now() - began >= fast.guessMs, "printed before the output had paused for guessMs");

  const windows = device({ work: [{ outputBytes: 5 }, { outputBytes: 9 }] }, { busy: [null], screens: [...screens] });
  assert.match((await detached(t, windows, { name: "work", screen: { history: 0 } }, undefined, true)).stderr, /^cns: studio cannot say when the command ends; /);
});

test("-d --screen stops waiting on Ctrl-C and says the command goes on; a shell that exits ends it", async (t) => {
  const busy = device({ work: [{ outputBytes: 5 }] }, { busy: [false, true], screens: [screen(["$ "], 1, 0)] });
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  assert.deepEqual(await detached(t, busy, { name: "work", screen: { history: 0 } }, stop.signal, true),
    { code: 130, stdout: "", stderr: "cns: stopped waiting; the command goes on in the session work on studio: cns screen studio work\n" });

  const exits = device({ work: [{ outputBytes: 5 }, { outputBytes: 5 }, { running: false, exit: { exitCode: 3, signal: null, signalNumber: null, timedOut: false, elapsedMs: 1, error: null } }] },
    { screens: [screen(["$ "], 1, 0), screen(["$ exit 3"], 1, 0)] });
  assert.deepEqual(await detached(t, exits, { name: "work", screen: { history: 0 } }, undefined, true),
    { code: 3, stdout: "$ exit 3\n", stderr: "cns: the session work on studio has ended (exited 3)\n" });
});

test("-d --screen ends once the shell has had the terminal back a while, though a job in the background prints on", async (t) => {
  // The shell never gives the terminal away, and the output never stops.
  const printing = Array.from({ length: 2000 }, (_, i) => ({ outputBytes: 10 + i }));
  const studio = device({ work: printing }, { busy: [false], screens: [screen(["$ "], 1, 0), screen(["$ make", "tick", "$ "], 3, 2)] });
  const began = Date.now();
  assert.deepEqual(await detached(t, studio, { name: "work", screen: { history: 0 } }, undefined, true), { code: 0, stderr: "", stdout: "$ make\ntick\n$ \n" });
  assert.ok(Date.now() - began >= fast.guessMs, "ended before the shell had had the terminal for guessMs");
  assert.ok(Date.now() - began < 2000 * fast.pollMs, "waited for the output to stop");
});

test("-d says when it typed into a program that was running in the session", async (t) => {
  const studio = device({ work: [{ outputBytes: 5 }] }, { busy: [true] });
  assert.deepEqual(await detached(t, studio, { name: "work" }), { code: 0, stderr: "cns: a program was running in the session work on studio, and the command was typed into it\n" });
  assert.deepEqual(studio.typed, ["work:make\r"]);
});

test("outputSince starts at the line the command was typed on, after any lines the device dropped", () => {
  const before = screen(["h1", "h2", "h3", "$ ", "", ""], 3, 3);
  assert.equal(outputSince(before, screen(["h1", "h2", "h3", "$ make", "ok", "$ "], 3, 5)), "$ make\nok\n$ ");
  // The device kept 6 lines and dropped the two oldest to make room for the command's.
  assert.equal(outputSince(before, screen(["h3", "$ make", "1", "2", "3", "$ "], 3, 5)), "$ make\n1\n2\n3\n$ ");
  // Nothing lines up, as after clear: all of it is the command's.
  assert.equal(outputSince(before, screen(["$ ", "", ""], 3, 0)), "$ \n\n");
  assert.equal(outputSince(screen(["$ "], 1, 0), screen(["$ ls", "a b", "$ "], 3, 2)), "$ ls\na b\n$ ");
});
