import assert from "node:assert/strict";
import test from "node:test";
import { newBunWebSocketRpcSession, newMessagePortRpcSession, newWebSocketRpcSession, RpcTarget, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { forkShell } from "./commands/peer.js";
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
