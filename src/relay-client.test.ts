import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("a hostile relay cannot crash the daemon or make it open connections without limit", { skip: !posix, timeout: 60000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-evil-relay-")));
  const dir = path.join(root, "studio");
  await mkdir(dir, { mode: 0o700 });
  const env = { CNS_CONFIG_DIR: dir, HOME: dir };
  const state = path.join(dir, "daemon.json");
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  let registrations = 0;
  let badChallengeClosed = false;
  const answers: string[] = [];
  interface Data { kind: string; id?: string; n?: number }
  const relay = Bun.serve<Data>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const parts = new URL(request.url).pathname.split("/").filter(Boolean);
      if (server.upgrade(request, { data: { kind: parts[1] ?? "", id: parts[3] } })) return;
      return new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "answer") { answers.push(ws.data.id!); return; } // Held open, never piped.
        if (ws.data.kind !== "accept") return;
        ws.data.n = ++registrations;
        // The first registration gets a challenge that cannot be decoded.
        ws.send(JSON.stringify({ t: "challenge", nonce: ws.data.n === 1 ? "!!!not base64url!!!!!!" : "A".repeat(22) }));
      },
      message(ws) {
        if (ws.data.kind !== "accept" || ws.data.n === 1) return;
        ws.send(JSON.stringify({ t: "ready" }));
        // Then a flood: unique ids, one id repeated, and ids that are not ids at all.
        for (let index = 0; index < 100; index++) ws.send(JSON.stringify({ t: "incoming", id: `id${String(index).padStart(20, "0")}` }));
        for (let index = 0; index < 50; index++) ws.send(JSON.stringify({ t: "incoming", id: "B".repeat(22) }));
        for (const id of ["../../etc", "x", "A".repeat(500), 7]) ws.send(JSON.stringify({ t: "incoming", id }));
      },
      close(ws) { if (ws.data.kind === "accept" && ws.data.n === 1) badChallengeClosed = true; },
    },
  });
  // Hooks run in the order they were added: stop the daemon, then the relay, then remove the directory.
  t.after(async () => { await cli(["stop", "--state", state]); await relay.stop(true); await rm(root, { recursive: true, force: true }); });

  const up = await cli(["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--relay", `ws://127.0.0.1:${relay.port}`, "--state", state]);
  assert.equal(up.code, 0, up.stderr);
  const until = Date.now() + 20000;
  while (Date.now() < until && answers.length < 32) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.ok(badChallengeClosed, "the undecodable challenge was refused");
  assert.ok(registrations >= 2, "the daemon registered again after refusing it");
  assert.equal(answers.length, 32, "at most 32 answers at once");
  assert.equal(new Set(answers).size, answers.length, "no id answered twice");
  assert.ok(answers.every((id) => /^[A-Za-z0-9_-]{22}$/.test(id)));
  const status = await cli(["status", "--json", "--state", state]);
  assert.equal(status.code, 0, "the daemon still answers");
  assert.equal(JSON.parse(status.stdout).daemon.relayRegistered, true);
});
