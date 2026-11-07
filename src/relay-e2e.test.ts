import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectControl } from "./commands/daemon.js";
import { startRelay } from "./commands/relay.js";
import { INVITE_PREFIX } from "./pairing.js";
import { isRelayAddress } from "./relay-hub.js";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("devices that cannot reach each other directly pair and link through the relay", { skip: !posix, timeout: 120000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-relay-")));
  // Hooks run in the order they were added: stop the daemons, then remove their directories.
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  // CNS_TEST_RELAY_URL tests an external relay, such as the Worker under wrangler dev, without the restart step.
  const external = process.env.CNS_TEST_RELAY_URL;
  const relayPort = Number(await unusedPort("127.0.0.1"));
  const token = "relay-t0ken-value";
  let relay = external ? undefined : startRelay({ bind: "127.0.0.1", port: relayPort, token });
  cleanups.push(async () => relay?.stop());
  const relayBase = external ?? `ws://127.0.0.1:${relayPort}/?token=${token}`;
  const relayHost = new URL(relayBase).host.replace(/[.]/g, "\\.");
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir };
  };
  const studio = await device("studio");
  const laptop = await device("laptop");
  const cli = async (dev: { env: Record<string, string> }, args: string[]) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  /** The daemons' logs, for a failure message. */
  const logs = async () => {
    const { readdir } = await import("node:fs/promises");
    const out: string[] = [];
    for (const dev of [studio, laptop]) for (const name of (await readdir(dev.dir)).filter((file) => file.endsWith(".log"))) out.push(`--- ${path.basename(dev.dir)}/${name}\n${await readFile(path.join(dev.dir, name), "utf8")}`);
    return out.join("\n");
  };
  const eventually = async (check: () => Promise<boolean>, label: string, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    assert.fail(`Timed out: ${label}\n${await logs()}`);
  };

  const port = await unusedPort("127.0.0.1");
  const up = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--relay", relayBase, "--state", studio.state]);
  assert.equal(up.code, 0, up.stderr);
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));
  assert.match(up.stdout, new RegExp(`Reachable at ws://127\\.0\\.0\\.1:${port}, wss?://${relayHost}/v1/dial/[A-Za-z0-9_-]{43}\\.\\nRelay: \\S+, regist`));
  await eventually(async () => /Relay: +\S+ \(registered\)/.test((await cli(studio, ["status", "--state", studio.state])).stdout), "studio registers at the relay");
  // The token registers studio but is never shown, saved for others, or on the daemon's command line.
  if (!external) {
    const shown = [up.stdout, up.stderr, (await cli(studio, ["status", "--state", studio.state])).stdout, (await cli(studio, ["status", "--json", "--state", studio.state])).stdout];
    assert.ok(!shown.some((text) => text.includes(token)), "the token is redacted");
    const pid = JSON.parse((await cli(studio, ["status", "--json", "--state", studio.state])).stdout).daemon.pid;
    assert.ok(!(await readFile(`/proc/${pid}/cmdline`, "utf8")).includes(token), "the token is not in the daemon's arguments");
  }

  // The invite lists the direct address, then the relay. Laptop gets only the relay part, as if
  // studio's network were out of reach, and pairs through it.
  const inviting = launchCli(t, ["pair", "--yes", "--name", "laptop", "--grant", "all", "--state", studio.state], { env: studio.env });
  inviting.child.stdin.end();
  await inviting.waitFor("Invite: cns1:");
  const text = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
  const body = JSON.parse(Buffer.from(text.slice(INVITE_PREFIX.length), "base64url").toString("utf8"));
  assert.deepEqual(body.addr.map(isRelayAddress), [false, true]);
  assert.ok(!JSON.stringify(body).includes(token), "invites carry no relay token");
  const relayOnly = INVITE_PREFIX + Buffer.from(JSON.stringify({ ...body, addr: body.addr.filter(isRelayAddress) })).toString("base64url");
  const paired = await cli(laptop, ["pair", relayOnly, "--yes", "--name", "studio", "--request", "all"]);
  assert.equal(paired.code, 0, paired.stderr);
  assert.equal(await inviting.exited, 0, inviting.stderr);

  // Laptop's saved addresses: an unreachable direct one first, then the relay. Commands fall back to it.
  const file = path.join(laptop.dir, "peers", "studio");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, addresses: ["ws://127.0.0.1:1", ...record.addresses] }), { mode: 0o600 });
  const run = await cli(laptop, ["run", "studio", "--", "printf via-relay"]);
  assert.deepEqual([run.code, run.stdout], [0, "via-relay"], run.stderr);
  const doctor = await cli(laptop, ["doctor", "studio"]);
  assert.equal(doctor.code, 0, doctor.stdout + doctor.stderr);
  assert.match(doctor.stdout, /ws:\/\/127\.0\.0\.1:1\/?: unreachable/);
  assert.match(doctor.stdout, /\/v1\/dial\/[A-Za-z0-9_-]{43} \[relay\]: ok \(.*encrypted\)/);
  // Studio's self-check shows its relay registration and the relay address, with the token hidden.
  const self = await cli(studio, ["doctor", "--state", studio.state]);
  assert.equal(self.code, 0, self.stdout + self.stderr);
  assert.match(self.stdout, /Relay: +\S+ \(registered\)/);
  assert.match(self.stdout, /\/v1\/dial\/[A-Za-z0-9_-]{43} \[relay\]: /);
  if (!external) assert.ok(!self.stdout.includes(token), "the token is redacted");

  // Laptop's daemon keeps a standing link to studio through the relay; studio has no address for laptop.
  const laptopUp = await cli(laptop, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", laptop.state]);
  assert.equal(laptopUp.code, 0, laptopUp.stderr);
  cleanups.push(() => cli(laptop, ["stop", "--state", laptop.state]));
  const viaOf = async (dev: typeof laptop) => {
    const control = await connectControl(dev.state);
    try { return (await control.controller.peers()).filter((peer) => peer.peer?.daemon).map((peer) => peer.peer!.via); } finally { control.close(); }
  };
  await eventually(async () => (await viaOf(laptop)).join() === "relay" && (await viaOf(studio)).join() === "relay", "a link through the relay");
  assert.match((await cli(laptop, ["peers", "--state", laptop.state])).stdout, /\nstudio +online +relay +/);
  // MCP through laptop's daemon names the paired device and takes its name as the peer.
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioClientTransport } = await import("@modelcontextprotocol/client/stdio");
  const { cliInvocation, cliEnvironment } = await import("./test-support.js");
  const invocation = cliInvocation(["mcp", "--daemon", "--state", laptop.state]);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: invocation.file, args: invocation.args, env: cliEnvironment(laptop.env) as Record<string, string> }));
  cleanups.push(() => client.close());
  const listed = await client.callTool({ name: "list_peers", arguments: {} });
  const peers = (listed.structuredContent as { peers: Array<{ name?: string }> }).peers;
  assert.deepEqual(peers.map((peer) => peer.name), ["studio"]);
  const ran = await client.callTool({ name: "run_command", arguments: { peer: "studio", command: "printf mcp-by-name" } });
  assert.equal((ran.structuredContent as { stdout: string }).stdout, "mcp-by-name");
  await client.close();
  assert.match((await cli(studio, ["status", "--state", studio.state])).stdout, /Links: +laptop \(relay, /);

  if (!relay) return;
  // The relay restarts: studio registers again and the daemons link again.
  const registered = async () => JSON.parse((await cli(studio, ["status", "--json", "--state", studio.state])).stdout).daemon.relayRegistered;
  await relay.stop();
  await eventually(async () => (await viaOf(laptop)).length === 0 && !(await registered()), "the link and the registration end with the relay");
  relay = startRelay({ bind: "127.0.0.1", port: relayPort, token });
  await eventually(registered, "studio registers at the new relay", 60000);
  await eventually(async () => (await viaOf(laptop)).join() === "relay", "the link returns through the new relay", 60000);
  assert.equal((await cli(laptop, ["run", "studio", "--", "printf back"])).stdout, "back");
});
