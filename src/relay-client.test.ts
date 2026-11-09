import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, LOOPBACK, LOOPBACK_HOST, unusedPort } from "./test-support.js";
import { connectControl } from "./commands/daemon.js";
import { serviceEnvironment } from "./service.js";

const posix = process.platform !== "win32";

test("relay TLS failures are logged; a service with its configured CA registers with verification enabled", { timeout: 30000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-relay-tls-")));
  const state = path.join(root, "daemon.json");
  const cert = path.join(import.meta.dir, "test-fixtures", "relay-cert.pem");
  // Public test-only key/certificate, never used by a real relay or identity.
  let refusedOnce = false;
  const relay = Bun.serve({
    hostname: LOOPBACK, port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(path.join(import.meta.dir, "test-fixtures", "relay-key.pem")) },
    fetch(request, server) { if (!server.upgrade(request)) return new Response("upgrade required", { status: 400 }); },
    websocket: {
      open(ws) {
        if (!refusedOnce) { refusedOnce = true; ws.close(4000, "Registration refused"); return; }
        ws.send(JSON.stringify({ t: "challenge", nonce: "A".repeat(22) }));
      },
      message(ws, data) { if (JSON.parse(String(data)).t === "proof") ws.send(JSON.stringify({ t: "ready" })); },
    },
  });
  const children: ReturnType<typeof launchCli>[] = [];
  t.after(async () => {
    for (const child of children) if (!child.closed) { child.child.kill("SIGTERM"); await child.exited; }
    await relay.stop(true);
    await rm(root, { recursive: true, force: true });
  });
  const env = {
    HOME: root, CNS_CONFIG_DIR: root, CNS_RELAY: `wss://${LOOPBACK_HOST}:${relay.port}`,
    NODE_EXTRA_CA_CERTS: undefined, SSL_CERT_FILE: undefined, SSL_CERT_DIR: undefined,
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
  };
  const args = ["daemon", "--service", "--state", state, "--bind", LOOPBACK, "--port", await unusedPort()];
  const untrusted = launchCli(t, args, { env });
  children.push(untrusted);
  await untrusted.waitFor("Cannot register at the relay");
  assert.match(untrusted.output, /[Cc]ertificate/);
  assert.match(untrusted.output, /Retrying automatically/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(untrusted.output.split("Cannot register at the relay").length - 1, 1, "identical failures are not logged on every retry");
  const control = await connectControl(state);
  try {
    assert.equal((await control.remote.status()).relayRegistered, false);
    await control.remote.stop();
  } finally { control.close(); }
  assert.equal(await untrusted.exited, 0, untrusted.output);

  const trusted = launchCli(t, args, { env: { ...env, ...serviceEnvironment({ NODE_EXTRA_CA_CERTS: cert }) } });
  children.push(trusted);
  await trusted.waitFor("Registered at the relay");
  assert.match(trusted.output, /Connection closed before registration \(4000\): Registration refused/);
  const connected = await connectControl(state);
  try { assert.equal((await connected.remote.status()).relayRegistered, true); }
  finally { connected.close(); }
});

test("a hostile relay cannot crash the daemon or make it open connections without limit", { skip: !posix, timeout: 60000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-evil-relay-")));
  const dir = path.join(root, "studio");
  await mkdir(dir, { mode: 0o700 });
  // CNS_RELAY points cns at the hostile relay below once it listens.
  let relayUrl = "";
  const env = () => ({ CNS_CONFIG_DIR: dir, HOME: dir, CNS_RELAY: relayUrl });
  const state = path.join(dir, "daemon.json");
  const cli = async (args: string[]) => {
    const child = launchCli(t, args, { env: env() });
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
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  // Hooks run in the order they were added: stop the daemon, then the relay, then remove the directory.
  t.after(async () => { await cli(["stop", "--state", state]); await relay.stop(true); await rm(root, { recursive: true, force: true }); });

  const up = await cli(["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", state]);
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
