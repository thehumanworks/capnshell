import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PEERS } from "./commands/peer.js";
import { launchCli, unusedPort } from "./test-support.js";

test("pending handshakes count toward the peer limit and expire without stopping the listener", { timeout: 15000 }, async (t) => {
  const port = await unusedPort();
  const url = `ws://[::1]:${port}`;
  const listener = launchCli(t, ["listen", "--bind", "::1", "--port", port, "--no-repl"]);
  await listener.waitFor("listening at");
  const sockets: WebSocket[] = [];
  t.after(() => { for (const socket of sockets) socket.terminate(); });
  const closed: Promise<void>[] = [];
  await Promise.all(Array.from({ length: MAX_PEERS }, () => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    closed.push(new Promise<void>((done) => socket.addEventListener("close", () => done(), { once: true })));
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Listener rejected an available slot")), { once: true });
    // Deliberately never answer the Cap'n Web info() handshake.
  })));
  const extra = await fetch(`http://[::1]:${port}`, { headers: { Upgrade: "websocket" } });
  assert.equal(extra.status, 503);
  await Promise.all(closed);
  assert.equal(listener.closed, false);
  const command = process.platform === "win32" ? "[Console]::Write('RECLAIMED')" : "printf RECLAIMED";
  const run = launchCli(t, ["run", url, "--", command]);
  assert.equal(await run.exited, 0);
  assert.equal(run.stdout, "RECLAIMED");
});
