import assert from "node:assert/strict";
import test from "node:test";
import type { PeerConfig } from "../options.js";
import type { PtySessionInfo } from "../shell.js";
import type { RemoteNamedPty } from "../terminal.js";
import { runDetached } from "./detached-shell.js";

const fast = { pollMs: 5, quietMs: 20, capMs: 200 };

/** A device with named sessions, each described by the infos its handle reports in turn; the last repeats. */
function device(sessions: Record<string, Partial<PtySessionInfo>[]> = {}) {
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
        write: async (data: string) => { typed.push(`${name}:${data}`); },
        [Symbol.dispose]() {},
      } as unknown as RemoteNamedPty;
    },
  };
  return { controller, sessions, typed, started };
}

const config = (extra: Partial<PeerConfig>): PeerConfig =>
  ({ role: "shell", expect: { name: "studio" }, detached: true, command: "make", ...extra }) as PeerConfig;

/** Run -d and collect what it wrote to stderr. */
async function detached(t: test.TestContext, studio: ReturnType<typeof device>, extra: Partial<PeerConfig>, signal = new AbortController().signal) {
  const stderr = t.mock.method(process.stderr, "write", () => true);
  t.mock.method(process.stdout, "write", () => true);
  try {
    const code = await runDetached(config(extra), studio.controller, "id", signal, fast);
    return { code, stderr: stderr.mock.calls.map((call) => String(call.arguments[0])).join("") };
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
