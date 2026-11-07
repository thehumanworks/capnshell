import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PEERS } from "./commands/peer.js";
import { HANDSHAKE_MS } from "./secure.js";
import { launchCli, testDevices } from "./test-support.js";

test("connections that never authenticate count toward the limit and expire without stopping the daemon", { skip: process.platform === "win32", timeout: HANDSHAKE_MS + 20000 }, async (t) => {
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  const port = await devices.up(studio);
  await devices.pair(studio, laptop, { hostGrants: "shell" });
  const url = `ws://127.0.0.1:${port}`;
  const sockets: WebSocket[] = [];
  t.after(() => { for (const socket of sockets) socket.terminate(); });
  const closed: Promise<void>[] = [];
  await Promise.all(Array.from({ length: MAX_PEERS }, () => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    closed.push(new Promise<void>((done) => socket.addEventListener("close", () => done(), { once: true })));
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("The daemon rejected an available slot")), { once: true });
    // Deliberately never start the authenticated handshake.
  })));
  const extra = await fetch(`http://127.0.0.1:${port}`, { headers: { Upgrade: "websocket" } });
  assert.equal(extra.status, 503);
  await Promise.all(closed);
  const run = launchCli(t, ["run", "studio", "--", "printf RECLAIMED"], { env: laptop.env });
  assert.equal(await run.exited, 0, run.output);
  assert.equal(run.stdout, "RECLAIMED");
});
