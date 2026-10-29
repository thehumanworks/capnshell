import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import test, { type TestContext } from "node:test";
import { cliInvocation } from "./test-support.js";

function launch(t: TestContext, args: string[]) {
  const invocation = cliInvocation(args);
  const child = spawn(invocation.file, invocation.args, { stdio: ["pipe", "pipe", "pipe"] });
  const events = new EventEmitter();
  let output = "";
  let closed = false;
  child.stdin.on("error", () => {});
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { output += chunk; events.emit("change"); });
  }
  child.on("error", (error) => { output += error.message; events.emit("change"); });
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => { closed = true; events.emit("change"); resolve(code); }));
  t.after(async () => {
    if (closed) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(timer);
  });
  const waitFor = (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      events.off("change", check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (output.includes(needle, from)) finish();
      else if (closed) finish(new Error(`Peer exited before ${needle}:\n${output}`));
    };
    const timer = setTimeout(() => finish(new Error(`Waiting for ${needle}:\n${output}`)), 15000);
    events.on("change", check);
    check();
  });
  return {
    child, exited, waitFor,
    async send(command: string, expected: string) {
      const from = output.length;
      child.stdin.write(command + "\n");
      await waitFor(expected, from);
    },
  };
}

test("generic listen/connect peers execute calls both ways over one connection", { timeout: 30000 }, async (t) => {
  // IPv6 loopback works in the Pi sandbox, unlike IPv4 127.0.0.1.
  const probe = net.createServer();
  probe.listen(0, "::1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = String(address.port);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const listener = launch(t, ["listen", "--bind", "::1", "--port", port]);
  await listener.waitFor("listening at");
  const rejected = await fetch(`http://[::1]:${port}`, { headers: { Origin: "https://example.invalid", Upgrade: "websocket" } });
  assert.equal(rejected.status, 401);
  const client = launch(t, ["connect", `ws://[::1]:${port}`]);
  await Promise.all([listener.waitFor("Type a shell command"), client.waitFor("Type a shell command")]);
  const extra = await fetch(`http://[::1]:${port}`, { headers: { Upgrade: "websocket" } });
  assert.equal(extra.status, 409, "A second peer must not obtain shell access");
  await Promise.all([
    listener.send(":info", `"pid": ${client.child.pid}`),
    client.send(":info", `"pid": ${listener.child.pid}`),
  ]);
  await Promise.all([
    listener.send(":timeout", "Timeout: disabled"),
    client.send(":timeout", "Timeout: disabled"),
  ]);
  await client.send(":timeout 3600000", "Timeout: 3600000 ms");
  await client.send(":timeout 0", "Timeout: disabled");
  const command = (marker: string) => process.platform === "win32" ? `[Console]::Write('${marker}')` : `printf '${marker}'`;
  await Promise.all([
    listener.send(command("CALLED_BY_LISTENER"), "CALLED_BY_LISTENER"),
    client.send(command("CALLED_BY_CLIENT"), "CALLED_BY_CLIENT"),
  ]);
  await Promise.all([listener.waitFor("[exit=0;"), client.waitFor("[exit=0;")]);
  client.child.stdin.write(":quit\n");
  assert.deepEqual(await Promise.all([listener.exited, client.exited]), [0, 0]);
});
