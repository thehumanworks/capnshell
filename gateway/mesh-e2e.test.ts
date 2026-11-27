import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createMcpServer } from "../src/mcp/server.js";
import { startRelay } from "../src/relay-server.js";
import { launchCli, testDevices, unusedPort, type TestDevice } from "../src/test-support.js";
import { gatewayObject } from "./test-object.js";

/** Wait until `check` holds, as lists take a moment to reach every daemon. */
async function eventually(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const text = (result: unknown) => ((result as CallToolResult).content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

test("a mesh's admin adds the gateway, whose connectors then reach the members within their grants, until it is removed", { skip: process.platform === "win32", timeout: 120000 }, async (t) => {
  const relayPort = Number(await unusedPort("127.0.0.1"));
  const relay = startRelay({ bind: "127.0.0.1", port: relayPort });
  t.after(() => relay.stop());
  const RELAY = `ws://127.0.0.1:${relayPort}`;
  const devices = await testDevices(t, "cns-gateway-mesh-");
  const hub = await devices.device("hub", { CNS_RELAY: RELAY });
  const laptop = await devices.device("laptop", { CNS_RELAY: RELAY });
  for (const device of [hub, laptop]) await devices.up(device);
  await devices.pair(hub, laptop);
  const mesh = (device: TestDevice, args: string[]) => devices.cli(device, ["mesh", ...args, "--state", device.state]);
  assert.equal((await mesh(hub, ["create", "home"])).code, 0);
  assert.equal((await mesh(hub, ["add", "home", "laptop"])).code, 0);
  assert.equal((await mesh(laptop, ["join", "home", "--via", "hub", "--allow", "shell"])).code, 0);

  // The gateway pairs with hub through the relay, as cns gateway pair has it do.
  const { object } = await gatewayObject({ env: { RELAY } });
  const inviting = launchCli(t, ["pair", "--long", "--yes", "--name", "gateway", "--grant", "shell,files,sessions:create", "--state", hub.state], { env: hub.env });
  inviting.child.stdin.end();
  await inviting.waitFor("Invite: cns1:");
  const paired = await object.pair(/Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!, { name: "hub" });
  assert.equal(paired.paired, true, inviting.output);
  assert.equal(await inviting.exited, 0, inviting.output);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(object.connectorTarget("all"));
  await server.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  const peers = async () => ((await client.callTool({ name: "list_peers", arguments: {} })).structuredContent as { peers: Array<{ name: string }> }).peers.map((peer) => peer.name);
  assert.deepEqual(await peers(), ["hub"]);

  // Listed as a plain member, which members would dial and share secrets with, the gateway takes no part.
  const plain = await mesh(hub, ["add", "home", "gateway"]);
  assert.match(plain.stderr, /gateway has no address and lets this device use nothing, as the cns gateway does\. If it is the gateway, add it with --gateway instead\./);
  await eventually("laptop saves gateway as a member", () => existsSync(path.join(laptop.dir, "peers", "gateway")));
  assert.deepEqual(await peers(), ["hub"]);

  // hub lists it as the gateway; laptop saves it again from the list, and lets it use what it allows members, within what hub lets the gateway use.
  const added = await mesh(hub, ["add", "home", "gateway", "--gateway"]);
  assert.equal(added.code, 0, added.output);
  assert.match(added.stdout, /The mesh home lists the gateway as gateway \(version 4\)\. It may use at most shell, files, sessions:create on each member/);
  await eventually("laptop saves it as the gateway", async () => /"gateway": true/.test(await readFile(path.join(laptop.dir, "peers", "gateway"), "utf8").catch(() => "")));
  assert.match((await devices.cli(laptop, ["mesh", "list", "home"])).stdout, /gateway \(gateway\)/);

  // Listing devices takes hub's list, then reaches laptop, which the gateway never paired with.
  assert.deepEqual(await peers(), ["hub", "laptop"]);
  const ran = await client.callTool({ name: "run_command", arguments: { command: "echo through-the-mesh", peer: "laptop" } });
  assert.equal((ran.structuredContent as { stdout: string }).stdout.trim(), "through-the-mesh", text(ran));
  const files = await client.callTool({ name: "list_directory", arguments: { peer: "laptop" } });
  assert.equal(files.isError, true);
  assert.match(text(files), /files/);
  assert.deepEqual(object.status().meshes, [{ name: "home", admin: "hub", version: 4, members: ["laptop"] }]);

  // Taken out of the mesh, the gateway forgets it at the next listing, and laptop drops its record.
  assert.equal((await mesh(hub, ["remove", "home", "gateway"])).code, 0);
  await eventually("laptop drops the gateway", () => !existsSync(path.join(laptop.dir, "peers", "gateway")));
  assert.deepEqual(await peers(), ["hub"]);
  assert.deepEqual(object.status().meshes, []);
});
