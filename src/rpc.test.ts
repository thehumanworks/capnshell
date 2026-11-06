import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newBunWebSocketRpcSession, newMessagePortRpcSession, newWebSocketRpcSession, RpcTarget, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { forkShell } from "./connect.js";
import { RefusingShell } from "./refusing-shell.js";
import { localShellInfo, ShellApi, type RunResult } from "./shell.js";

// Model an untrusted caller, not the typed client contract. Runtime validation
// must reject malformed values even when the other peer is not TypeScript.
interface UntrustedShell {
  run(command: unknown, options?: unknown): Promise<RunResult>;
}

test("Cap’n Web validates untrusted calls and keeps the bidirectional session usable", { timeout: 15000 }, async (t) => {
  const serverApi = new ShellApi();
  const clientApi = new ShellApi();
  interface Data { transport?: BunWebSocketTransport<Data> }
  let accept!: (stub: RpcStub<ShellApi>) => void;
  const accepted = new Promise<RpcStub<ShellApi>>((resolve) => { accept = resolve; });
  const server = Bun.serve<Data>({
    hostname: "::1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: {} })) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      open(ws) {
        const { stub, transport } = newBunWebSocketRpcSession<ShellApi, Data>(ws, serverApi);
        ws.data.transport = transport;
        accept(stub);
      },
      message(ws, message) { ws.data.transport?.dispatchMessage(message); },
      close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
    },
  });
  t.after(async () => {
    serverApi[Symbol.dispose]();
    clientApi[Symbol.dispose]();
    await server.stop(true);
  });
  const client = new WebSocket(`ws://[::1]:${server.port}`);
  t.after(() => client.terminate());
  // Cap'n Web queues outgoing calls until the native client socket opens.
  using clientRemote = newWebSocketRpcSession<UntrustedShell>(client, clientApi);
  using serverRemote = await accepted;

  for (const command of [null, 42, {}, "", " ", "x".repeat(8193)]) {
    await assert.rejects(async () => { await clientRemote.run(command); });
  }
  for (const options of [null, [], "bad", { timeoutMs: "200" }, { timeoutMs: NaN },
    { timeoutMs: Infinity }, { timeoutMs: 0.5 }, { cwd: 123 }, { cwd: "relative" }, { extra: true }]) {
    await assert.rejects(async () => { await clientRemote.run("echo should-not-run", options); });
  }
  const command = process.platform === "win32" ? "[Console]::Write('still-connected')" : "printf still-connected";
  const results = await Promise.all([clientRemote.run(command), serverRemote.run(command)]);
  for (const result of results) {
    try {
      assert.equal(result.stdout, "still-connected");
      assert.equal(result.exitCode, 0);
    } finally { result[Symbol.dispose](); }
  }
});

test("RefusingShell answers info() and refuses every other ShellApi method over RPC", async (t) => {
  const { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  newMessagePortRpcSession(port1, new RefusingShell());
  using remote = newMessagePortRpcSession<ShellApi>(port2);
  assert.equal((await remote.info()).pid, process.pid);
  const methods = Object.getOwnPropertyNames(ShellApi.prototype).filter((name) => name !== "constructor" && name !== "info");
  assert.ok(methods.includes("run") && methods.includes("readFile") && methods.includes("exec"));
  for (const name of methods) {
    await assert.rejects(async () => { await (remote as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!("/tmp"); },
      new RegExp(RefusingShell.refusal.replace(/[.;]/g, "\\$&")), `${name} must be refused`);
  }
});

test("one-way WebSocket refuses valid reverse operations without blocking forward use", { timeout: 15000, skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = path.join(directory, "secret");
  const marker = path.join(directory, "marker");
  await writeFile(secret, "unchanged");
  const offered = new ShellApi();
  interface Data { transport?: BunWebSocketTransport<Data> }
  let accept!: (stub: RpcStub<ShellApi>) => void;
  const accepted = new Promise<RpcStub<ShellApi>>((resolve) => { accept = resolve; });
  const server = Bun.serve<Data>({
    hostname: "::1", port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: {} })) return; return new Response("WebSocket required", { status: 400 }); },
    websocket: {
      idleTimeout: 0,
      open(ws) { const { stub, transport } = newBunWebSocketRpcSession<ShellApi, Data>(ws, offered); ws.data.transport = transport; accept(stub); },
      message(ws, message) { ws.data.transport?.dispatchMessage(message); },
      close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
    },
  });
  t.after(async () => { offered[Symbol.dispose](); await server.stop(true); });
  const socket = new WebSocket(`ws://[::1]:${server.port}`);
  t.after(() => socket.terminate());
  using forward = newWebSocketRpcSession<ShellApi>(socket, new RefusingShell());
  using reverse = await accepted;
  assert.equal((await reverse.info()).pid, process.pid);
  class Sink extends RpcTarget { output() {} exit() {} }
  const sink = new Sink();
  const calls: Array<() => PromiseLike<unknown>> = [
    () => reverse.run("printf touched > marker", { cwd: directory }),
    () => reverse.exec(sink, "printf touched > marker", { cwd: directory }),
    () => reverse.readFile(secret),
    () => reverse.writeFile(secret, new TextEncoder().encode("changed")),
    () => reverse.fork(),
    () => reverse.openPty(sink, { command: "printf touched > marker", cwd: directory }),
    () => reverse.startPtySession("work", { command: "printf touched > marker", cwd: directory }),
    () => reverse.ptySession("work"),
    () => reverse.ptySessions(),
  ];
  for (const call of calls) await assert.rejects(async () => { await call(); }, /does not run commands or share files/);
  assert.equal(await readFile(secret, "utf8"), "unchanged");
  await assert.rejects(() => stat(marker), { code: "ENOENT" });
  const result = await forward.run("printf forward-ok");
  try { assert.equal(result.stdout, "forward-ok"); } finally { result[Symbol.dispose](); }
});

test("forkShell forks a current peer's shell and recognises an older peer without fork", async (t) => {
  class OlderShell extends RpcTarget { info() { return localShellInfo(); } }
  for (const [label, target] of [["current", new ShellApi()], ["older", new OlderShell()]] as const) {
    const { port1, port2 } = new MessageChannel();
    t.after(() => { port1.close(); port2.close(); });
    newMessagePortRpcSession(port1, target);
    using remote = newMessagePortRpcSession<ShellApi>(port2);
    const fork = await forkShell(remote);
    if (label === "older") {
      assert.equal(fork, undefined);
      continue;
    }
    assert.ok(fork);
    try {
      const result = await fork.run(process.platform === "win32" ? "[Console]::Write('forked')" : "printf forked");
      assert.equal(result.stdout, "forked");
    } finally { fork[Symbol.dispose](); }
    (target as ShellApi)[Symbol.dispose]();
  }
});
