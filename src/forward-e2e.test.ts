import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectControl } from "./commands/daemon.js";
import { isRelayAddress } from "./relay-hub.js";
import { startRelay } from "./relay-server.js";
import { launchCli, settledLink, testDevices, unusedPort, type TestDevice } from "./test-support.js";

const posix = process.platform !== "win32";
const MiB = 1024 * 1024;
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const ms = (start: number) => Math.round(performance.now() - start);
const ipv6 = await new Promise<boolean>((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => { probe.close(); resolve(true); });
});

/** A service on localhost, which the devices share in a test: each connection goes to `handle`. */
async function service(t: TestContext, handle: (socket: net.Socket) => void, host = "127.0.0.1"): Promise<number> {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer({ allowHalfOpen: true }, (socket) => { sockets.add(socket); socket.on("error", () => {}); handle(socket); });
  listener.listen(0, host);
  await once(listener, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); listener.close(); });
  return (listener.address() as net.AddressInfo).port;
}
/** `promise`, or a failure that says what was awaited and shows `output`. */
async function within<T>(promise: Promise<T>, what: string, output: () => string, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Waiting for ${what}:\n${output()}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
/** Echo every byte back, and end when the other side does. */
const echo = (socket: net.Socket) => { socket.pipe(socket); };

/** `cns forward` on `device`, once it says it is forwarding. */
async function forwarding(t: TestContext, device: TestDevice, args: string[]) {
  const child = launchCli(t, ["forward", ...args], { env: device.env });
  child.child.stdin.end();
  await child.waitFor("cns: forwarding 127.0.0.1:");
  return child;
}

/** A connection to the forward's port here. */
async function dial(port: string | number): Promise<net.Socket> {
  const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
  await once(socket, "connect");
  socket.on("error", () => {});
  return socket;
}
/** Send `text` and wait for it back, from an echo service. */
async function echoed(socket: net.Socket, text: string): Promise<string> {
  let got = "";
  socket.write(text);
  while (got.length < text.length) got += String((await once(socket, "data"))[0]);
  return got;
}
/** Everything until the other side's end. */
const readAll = (socket: net.Socket) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.once("end", () => resolve(Buffer.concat(chunks)));
  socket.once("close", () => resolve(Buffer.concat(chunks)));
  socket.once("error", reject);
});

test("over the daemon's link: 50 MiB each way by hash while the link still answers, 32 connections and a refused one, and a peer daemon restart",
  { skip: !posix, timeout: 180000 }, async (t) => {
  const devices = await testDevices(t, "cns-forward-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  // At the default path, where cns forward finds the daemon that lends it its link.
  laptop.state = path.join(laptop.dir, ".cns", "daemon.json");
  await devices.up(studio);
  await devices.pair(studio, laptop);
  await devices.up(laptop);
  const control = await connectControl(laptop.state);
  t.after(() => control.close());
  await settledLink(control, "studio");
  const studioKey = JSON.parse(await readFile(path.join(laptop.dir, "peers", "studio"), "utf8")).publicKey as string;

  // The service sends 50 MiB, and hashes what it gets until the other side's end.
  const down = randomBytes(50 * MiB);
  let received: Promise<string> | undefined;
  const bulk = await service(t, (socket) => {
    received = readAll(socket).then(sha);
    socket.end(down);
  });
  const local = await unusedPort("127.0.0.1");
  const forward = await forwarding(t, laptop, ["studio", String(bulk), "--local", local]);
  assert.match(forward.stderr, new RegExp(`forwarding 127\\.0\\.0\\.1:${local} to localhost:${bulk} on studio, via this device's daemon \\(directly\\)`));

  // A small call over the same link, as a keystroke is: its round trip, idle and during the transfer.
  const lent = await control.remote.lend(studioKey);
  assert.ok(lent);
  const shell = lent.shell as unknown as { info(): Promise<{ [Symbol.dispose]?(): void }> };
  const roundTrip = async () => { const start = performance.now(); const info = await shell.info(); info[Symbol.dispose]?.(); return ms(start); };
  const idle: number[] = [];
  for (let i = 0; i < 10; i++) idle.push(await roundTrip());
  const runStart = performance.now();
  const idleRun = await devices.cli(laptop, ["run", "studio", "--", "echo idle"]);
  const idleRunMs = ms(runStart);
  assert.equal(idleRun.code, 0, idleRun.output);

  const up = randomBytes(50 * MiB);
  const socket = await dial(local);
  const start = performance.now();
  const reading = readAll(socket);
  socket.end(up);
  let busy = true;
  const during: number[] = [];
  const probing = (async () => { while (busy) { during.push(await roundTrip()); await new Promise((resolve) => setTimeout(resolve, 20)); } })();
  const runDuring = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const at = performance.now();
    const result = await devices.cli(laptop, ["run", "studio", "--", "echo busy"]);
    return { result, took: ms(at), finishedFirst: busy };
  })();
  const got = await reading;
  const took = ms(start);
  assert.equal(sha(got), sha(down), "the service's 50 MiB arrived whole and in order");
  assert.equal(await received, sha(up), "this side's 50 MiB arrived whole and in order");
  const run = await runDuring;
  busy = false;
  await probing;
  assert.equal(run.result.code, 0, run.result.output);
  assert.match(run.result.stdout, /busy/);
  const sorted = [...during].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const max = sorted.at(-1) ?? 0;
  t.diagnostic(`100 MiB in ${took} ms (${(100 / (took / 1000)).toFixed(1)} MiB/s both ways together); round trip on the link idle ${Math.max(...idle)} ms max, ` +
    `during ${p50} ms median, ${max} ms max over ${during.length} calls; cns run ${idleRunMs} ms idle, ${run.took} ms during${run.finishedFirst ? ", ending before the transfer" : ""}`);
  // A keystroke waits behind at most the windows of bytes in flight, never the whole transfer.
  assert.ok(max < 2000, `a call on the link took ${max} ms during the transfer`);
  assert.ok(run.took < idleRunMs + 3000, `cns run took ${run.took} ms during the transfer, ${idleRunMs} ms idle`);
  lent.shell[Symbol.dispose]();

  // 32 connections at once, and the 33rd is refused and said so.
  const echoPort = await service(t, echo);
  const echoLocal = await unusedPort("127.0.0.1");
  const echoes = await forwarding(t, laptop, ["studio", String(echoPort), "--local", echoLocal]);
  const open = await Promise.all(Array.from({ length: 32 }, () => dial(echoLocal)));
  assert.deepEqual(await Promise.all(open.map((each, index) => echoed(each, `c${index}`))), open.map((_, index) => `c${index}`));
  const extra = await dial(echoLocal);
  const extraClosed = once(extra, "close");
  await echoes.waitFor("refused a connection to 127.0.0.1:");
  await within(extraClosed, "the refused connection closing", () => echoes.output);
  assert.match(echoes.stderr, /32 connections are open through this forward already/);
  open.pop()!.destroy();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const replacement = await dial(echoLocal);
  assert.equal(await echoed(replacement, "again"), "again");
  for (const each of open) each.destroy();

  let sixForward: Awaited<ReturnType<typeof forwarding>> | undefined;
  if (ipv6) {
    // A service on ::1 alone, as Node dev servers often are.
    const six = await service(t, (each) => each.end("from ::1"), "::1");
    const sixLocal = await unusedPort("127.0.0.1");
    sixForward = await forwarding(t, laptop, ["studio", String(six), "--local", sixLocal]);
    assert.equal(String(await readAll(await dial(sixLocal))), "from ::1");
  } else t.diagnostic("no IPv6 loopback here: the ::1 service was not tested");

  // The device's daemon restarts: the connection closes, the listener stays, and it reconnects.
  const before = echoes.output.length;
  const replacementClosed = once(replacement, "close");
  const stopped = await devices.cli(studio, ["stop", "--state", studio.state]);
  assert.equal(stopped.code, 0, stopped.output);
  await within(replacementClosed, "the connection closing with the link", () => echoes.output);
  await echoes.waitFor("the link to studio was lost; ", before);
  assert.match(echoes.output.slice(before), /the link to studio was lost; \d+ connections? closed; reconnecting \(Ctrl-C stops\)/);
  await devices.up(studio, studio.port);
  await echoes.waitFor("reconnected to studio via ", before);
  const after = await dial(echoLocal);
  assert.equal(await echoed(after, "back"), "back");
  after.destroy();
  assert.equal(echoes.closed, false);

  // A forward whose process is killed is released there with its link: eight more fit, then none.
  echoes.child.kill("SIGKILL");
  await echoes.exited;
  for (const each of [forward, sixForward]) {
    if (!each) continue;
    each.child.kill("SIGTERM");
    assert.equal(await each.exited, 143, each.output);
  }
  // The daemon hung up the control connection that borrowed the link the restart ended.
  const control2 = await connectControl(laptop.state);
  t.after(() => control2.close());
  await settledLink(control2, "studio");
  const borrowed = await control2.remote.lend(studioKey);
  assert.ok(borrowed);
  const shared = borrowed.shell as unknown as { forward(port: number): Promise<{ [Symbol.dispose](): void }> };
  const held: Array<{ [Symbol.dispose](): void }> = [];
  for (let tries = 0; held.length < 8; tries++) {
    try { held.push(await shared.forward(echoPort)); }
    catch (error) { if (tries > 50) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  await assert.rejects(async () => { await shared.forward(echoPort); }, /A device holds at most 8 forwards here at once/);
  for (const each of held) each[Symbol.dispose]();
  borrowed.shell[Symbol.dispose]();
});

test("with only the port's grant, over its own link: other ports refused, one audit entry, a revoked grant ends it with 4, and unpairing or removing with 3",
  { skip: !posix, timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-forward-grant-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop, { hostGrants: "none" });
  const echoPort = await service(t, echo);
  const other = await service(t, echo);
  const local = await unusedPort("127.0.0.1");


  // Port words never travel in a pairing.
  const pairing = await devices.cli(studio, ["pair", "--yes", "--grant", `files,port:${echoPort}`, "--state", studio.state]);
  assert.equal(pairing.code, 1, pairing.output);
  assert.match(pairing.stderr, new RegExp(`port:${echoPort} is given only on the device that has the port, once paired: cns peer grant NAME port:${echoPort}`));

  const refused = await devices.cli(laptop, ["forward", "studio", String(echoPort), "--local", local]);
  assert.equal(refused.code, 4, refused.output);
  assert.match(refused.stderr, new RegExp(`^cns: studio does not let this device reach port ${echoPort}\\. To allow it, run on studio: cns peer grant laptop port:${echoPort}\\n$`));

  const granted = await devices.cli(studio, ["peer", "grant", "laptop", `port:${echoPort},port:${other}`, "--state", studio.state]);
  assert.equal(granted.code, 0, granted.output);
  assert.match(granted.stdout, new RegExp(`laptop may use this device's: ports ${Math.min(echoPort, other)}, ${Math.max(echoPort, other)}\\.`));
  const narrowed = await devices.cli(studio, ["peer", "revoke", "laptop", `port:${other}`, "--state", studio.state]);
  assert.match(narrowed.stdout, new RegExp(`laptop may use this device's: port ${echoPort}\\.`));
  const otherRefused = await devices.cli(laptop, ["forward", "studio", String(other), "--local", local]);
  assert.equal(otherRefused.code, 4, otherRefused.output);

  // Its own link, as no daemon runs here to lend one.
  const forward = await forwarding(t, laptop, ["studio", String(echoPort), "--local", local]);
  assert.match(forward.stderr, /, via a direct link \(Ctrl-C stops\)/);
  const socket = await dial(local);
  assert.equal(await echoed(socket, "hello"), "hello");
  socket.destroy();
  const second = await dial(local);
  assert.equal(await echoed(second, "again"), "again");

  // Revoked while forwarding: its connection closes, and the forward ends with 4.
  const secondClosed = once(second, "close");
  const revoked = await devices.cli(studio, ["peer", "revoke", "laptop", `port:${echoPort}`, "--state", studio.state]);
  assert.equal(revoked.code, 0, revoked.output);
  await within(secondClosed, "the connection closing on revoke", () => forward.output);
  assert.equal(await within(forward.exited, "the forward exiting on revoke", () => forward.output), 4, forward.output);
  assert.match(forward.stderr, new RegExp(`cns: studio no longer lets this device reach port ${echoPort}\\. To allow it, run on studio: cns peer grant laptop port:${echoPort}\\n`));

  // One entry for the forward, with what it carried, and one for each refusal; none per connection.
  const audit = JSON.parse((await devices.cli(studio, ["audit", "--json", "--limit", "100"])).stdout) as Array<Record<string, unknown>>;
  const forwards = audit.filter((entry) => entry.action === "port.forward");
  const carried = forwards.filter((entry) => entry.connections !== undefined);
  assert.equal(carried.length, 1, JSON.stringify(forwards));
  assert.deepEqual([carried[0]!.target, carried[0]!.connections, carried[0]!.bytesIn, carried[0]!.bytesOut], [`localhost:${echoPort}`, 2, 10, 10]);
  assert.ok(forwards.filter((entry) => typeof entry.error === "string").length >= 3, JSON.stringify(forwards));
  assert.equal(forwards.length, 1 + forwards.filter((entry) => typeof entry.error === "string").length, JSON.stringify(forwards));

  // A bare revoke takes the port words too.
  await devices.cli(studio, ["peer", "grant", "laptop", `port:${echoPort},port:${other}`, "--state", studio.state]);
  const bare = await devices.cli(studio, ["peer", "revoke", "laptop", "--state", studio.state]);
  assert.match(bare.stdout, /laptop may use this device's: none\./);

  // Unpaired while forwarding: the forward ends with 3.
  await devices.cli(studio, ["peer", "grant", "laptop", "shell", "--state", studio.state]);
  const again = await forwarding(t, laptop, ["studio", String(echoPort), "--local", local]);
  const removed = await devices.cli(studio, ["peer", "remove", "laptop", "--state", studio.state]);
  assert.equal(removed.code, 0, removed.output);
  assert.equal(await within(again.exited, "the forward exiting on unpairing", () => again.output), 3, again.output);
  assert.match(again.stderr, /cns: studio no longer accepts this device \(/);

  /** Pair the two again, from nothing on either side, with shell for laptop on studio. */
  const repair = async () => {
    await devices.cli(laptop, ["peer", "remove", "studio"]);
    await devices.cli(studio, ["peer", "remove", "laptop", "--state", studio.state]);
    await devices.pair(studio, laptop, { hostGrants: "shell" });
  };
  const notSaved = /cns: No paired device is saved as studio\./;

  // Removed here while forwarding: its own link outlives that until studio's daemon restarts,
  // and the next link is not made, so it ends with 3.
  await repair();
  const removedHere = await forwarding(t, laptop, ["studio", String(echoPort), "--local", local]);
  const removing = await devices.cli(laptop, ["peer", "remove", "studio"]);
  assert.equal(removing.code, 0, removing.output);
  const stopped = await devices.cli(studio, ["stop", "--state", studio.state]);
  assert.equal(stopped.code, 0, stopped.output);
  await devices.up(studio, studio.port);
  assert.equal(await within(removedHere.exited, "the forward exiting once removed here", () => removedHere.output), 3, removedHere.output);
  assert.match(removedHere.stderr, notSaved);

  // Removed here while forwarding, with the link still up: the next connection is closed, and it ends with 3.
  await repair();
  const nextConnection = await forwarding(t, laptop, ["studio", String(echoPort), "--local", local]);
  assert.equal(await echoed(await dial(local), "before"), "before");
  await devices.cli(laptop, ["peer", "remove", "studio"]);
  const late = net.connect({ host: "127.0.0.1", port: Number(local) });
  late.on("error", () => {});
  const lateClosed = once(late, "close");
  assert.equal(await within(nextConnection.exited, "the forward exiting at the next connection", () => nextConnection.output), 3, nextConnection.output);
  assert.match(nextConnection.stderr, notSaved);
  await within(lateClosed, "the next connection closing", () => nextConnection.output);
});

test("through the relay when no direct address answers", { skip: !posix, timeout: 120000 }, async (t) => {
  const relayPort = Number(await unusedPort("127.0.0.1"));
  const relay = startRelay({ bind: "127.0.0.1", port: relayPort });
  t.after(() => relay.stop());
  const env = { CNS_RELAY: `ws://127.0.0.1:${relayPort}` };
  const devices = await testDevices(t, "cns-forward-relay-");
  const studio = await devices.device("studio", env);
  const laptop = await devices.device("laptop", env);
  await devices.up(studio);
  await devices.pair(studio, laptop);
  // Only the relay can reach studio from here.
  const file = path.join(laptop.dir, "peers", "studio");
  const record = JSON.parse(await readFile(file, "utf8"));
  const relayed = (record.addresses as string[]).filter(isRelayAddress);
  assert.ok(relayed.length, JSON.stringify(record.addresses));
  await writeFile(file, JSON.stringify({ ...record, addresses: ["ws://127.0.0.1:1", ...relayed] }), { mode: 0o600 });

  const down = randomBytes(4 * MiB);
  const bulk = await service(t, (socket) => socket.end(down));
  const local = await unusedPort("127.0.0.1");
  const forward = await forwarding(t, laptop, ["studio", String(bulk), "--local", local]);
  assert.match(forward.stderr, /, via the relay \(Ctrl-C stops\)/);
  assert.equal(sha(await readAll(await dial(local))), sha(down));
  forward.child.kill("SIGINT");
  assert.equal(await forward.exited, 130, forward.output);

  // Nothing answers now: the first attempt fails with 1, and says why on one line.
  await relay.stop();
  const unreachable = await devices.cli(laptop, ["forward", "studio", String(bulk), "--local", local]);
  assert.equal(unreachable.code, 1, unreachable.output);
  assert.match(unreachable.stderr, /^cns: Cannot connect to studio: [^\n]*\n$/);
});
