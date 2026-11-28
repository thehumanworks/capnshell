import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { ensureIdentity } from "../identity.js";
import { TOOL_NAMES } from "../mcp/server.js";
import { CNS_VERSION } from "../version.js";
import { approve, chooseTools, forgetAtGateway, gatewayDrift, READ_TOOLS, status } from "./gateway.js";

/** The tools a gateway deployed before the skill tools and list_secrets (2.3.0) can grant. */
const OLD_TOOLS = ["list_peers", "run_command", "start_session", "send_keys", "read_screen", "list_sessions", "kill_session", "read_file", "write_file", "list_directory", "glob"];

interface Fake {
  /** What the gateway's status adds: nothing for one deployed before 2.3.1. */
  build?: { version?: string; tools?: string[]; meshes?: unknown[] };
  /** The first line of its root page: `cns gateway` alone before 1.4.0. */
  root: string;
}

/** A gateway that answers as one deployed from some cns would, and records the approvals it gets. */
async function fakeGateway(t: test.TestContext, fake: Fake) {
  const approvals: Record<string, unknown>[] = [];
  const known = fake.build?.tools ?? OLD_TOOLS;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(`${fake.root}\nAdd ${url.origin}/mcp as a custom connector in Claude.\n`);
      const input = await request.json() as Record<string, unknown>;
      switch (url.pathname) {
        case "/admin/consent": return Response.json({ consent: { code: input.code, clientName: "Claude", clientDomain: "claude.ai", redirectHost: "claude.ai", loopback: false, expiresAt: 0, status: "pending", devices: [], tools: [] } });
        case "/admin/status": return Response.json({ fingerprint: "fp", name: "gateway", relay: "wss://relay", devices: [{ name: "studio", fingerprint: "fp", granted: ["shell"], pairedAt: "" }], pending: [], grants: [], owner: "me", ...fake.build });
        case "/admin/approve": {
          // As the gateway's Durable Object does: a tool it does not have is refused.
          const tools = Array.isArray(input.tools) ? input.tools as string[] : known;
          for (const tool of tools) if (!known.includes(tool)) return Response.json({ error: `Unknown tool ${tool}.` }, { status: 400 });
          approvals.push(input);
          // From 2.4.0 the gateway keeps all for an approval for all devices; before, it kept the keys paired then.
          const devices = input.devices === "all" && fake.build?.version === CNS_VERSION ? "all" : ["key"];
          return Response.json({ consent: { code: input.code, clientName: "Claude", status: "approved", devices, tools } });
        }
        default: return Response.json({ error: "Unknown action." }, { status: 404 });
      }
    },
  });
  t.after(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, approvals };
}

/** Runs a cns gateway command with this test's own identity, and returns what it printed. */
async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const [log, error] = [console.log, console.error];
  let out = "", err = "";
  console.log = (...args: unknown[]) => { out += `${args.join(" ")}\n`; };
  console.error = (...args: unknown[]) => { err += `${args.join(" ")}\n`; };
  try { await run(); } finally { [console.log, console.error] = [log, error]; }
  return { out, err };
}

// Each test signs with an identity of its own, never this machine's.
let dir = "";
const previous = process.env.CNS_CONFIG_DIR;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cns-gateway-cli-"));
  process.env.CNS_CONFIG_DIR = dir;
  ensureIdentity();
});
afterEach(async () => {
  if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous;
  await rm(dir, { recursive: true, force: true });
});

test("approving all tools at a gateway deployed before the skill tools grants what it has, and says to redeploy it", async (t) => {
  const gateway = await fakeGateway(t, { root: "cns gateway" });
  const { out, err } = await capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true }));
  assert.match(out, /Approved Claude for studio\./);
  assert.equal(gateway.approvals.length, 1);
  assert.equal("tools" in gateway.approvals[0]!, false, "all tools is left to the gateway, which knows its own");
  assert.match(err, /Tools: {11}all the gateway has\n/);
  assert.match(err, new RegExp(`The gateway runs a cns too old to report its version, not this cns's ${CNS_VERSION.replaceAll(".", "\\.")}, so it may lack tools this cns has\\. Redeploy it from this release: cd gateway && npx wrangler deploy`));
});

test("a tool an old gateway refuses at approval comes back as what to do, not as an unknown tool", async (t) => {
  const gateway = await fakeGateway(t, { root: "cns gateway 2.2.0" });
  await assert.rejects(capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true, tools: "read" })),
    /^Error: The gateway has no tool list_skills\. The gateway runs cns 2\.2\.0, not this cns's [\d.]+, so it may lack tools this cns has\. Redeploy it from this release: cd gateway && npx wrangler deploy \(gateway\/README\.md\)\. Or approve with --tools naming tools it has\.$/);
  assert.equal(gateway.approvals.length, 0);
});

test("a gateway that lists its tools gets only those it has for --tools read, and a missing one named is refused before approving", async (t) => {
  const gateway = await fakeGateway(t, { root: "cns gateway 2.3.1", build: { version: "2.2.0", tools: OLD_TOOLS } });
  const { err } = await capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true, tools: "read" }));
  assert.deepEqual(gateway.approvals[0]!.tools, READ_TOOLS.filter((tool) => OLD_TOOLS.includes(tool)));
  assert.match(err, /\(not list_skills, read_skill, search_skills: the gateway lacks them\)/);
  assert.match(err, /so it cannot grant list_skills, read_skill, search_skills, list_secrets\. Redeploy it/);
  await assert.rejects(capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true, tools: "list_peers,list_skills" })), /The gateway has no tool list_skills\. The gateway runs cns 2\.2\.0/);
  await assert.rejects(capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true, tools: "format_disk" })), /Unknown tool format_disk\. Tools: list_peers, run_command/);
  assert.equal(gateway.approvals.length, 1);
});

test("a gateway on this cns approves everything without a warning, and status shows its version", async (t) => {
  const gateway = await fakeGateway(t, { root: `cns gateway ${CNS_VERSION}`, build: { version: CNS_VERSION, tools: [...TOOL_NAMES], meshes: [{ name: "home", admin: "studio", version: 4, members: ["laptop", "nas"] }] } });
  const { out, err } = await capture(() => approve("ABCD-EFGH", { url: gateway.url, yes: true }));
  assert.match(err, /Devices: {9}all, including devices paired with the gateway later \(now: studio\)\n/);
  assert.match(out, /Approved Claude for every device paired with the gateway \(now studio\) and any paired later\./);
  assert.match(err, new RegExp(`Tools: {11}all ${TOOL_NAMES.length} the gateway has\\n`));
  assert.doesNotMatch(err, /Redeploy/);
  const shown = await capture(() => status({ url: gateway.url }));
  assert.match(shown.out, new RegExp(`^Version: {4}cns ${CNS_VERSION.replaceAll(".", "\\.")}\\n`, "m"));
  assert.match(shown.out, /^Meshes: {5}reached by connectors approved for all devices\n {2}home {2}run by studio, version 4: laptop, nas$/m);
  assert.doesNotMatch(shown.out, /Redeploy/);
  const old = await fakeGateway(t, { root: "cns gateway" });
  assert.match((await capture(() => status({ url: old.url }))).out, /^Version: {4}a cns too old to report its version\n {2}The gateway runs a cns too old to report its version, not this cns's [\d.]+, so it may lack tools this cns has\. Redeploy it/m);
});

test("the tools an approval names, by what the gateway lists", () => {
  assert.deepEqual(chooseTools(undefined, {}), { dropped: [] });
  assert.deepEqual(chooseTools("all", { tools: OLD_TOOLS }), { dropped: [] });
  assert.deepEqual(chooseTools("read", {}), { tools: [...READ_TOOLS], dropped: [] }, "an old gateway is asked for every read tool, and refuses one it lacks");
  assert.deepEqual(chooseTools("glob, read_file", { tools: OLD_TOOLS }), { tools: ["glob", "read_file"], dropped: [] });
  assert.equal(gatewayDrift({ version: CNS_VERSION, tools: [...TOOL_NAMES] }), undefined);
  assert.match(gatewayDrift({ version: "99.0.0", tools: [...TOOL_NAMES, "new_tool"] })!, /newer than this cns/);
});

test("a lost device the gateway cannot be asked about is reported as not used, unreachable, not permitted or failed, with what to run", async (t) => {
  const previousGateway = process.env.CNS_GATEWAY;
  t.after(() => { if (previousGateway === undefined) delete process.env.CNS_GATEWAY; else process.env.CNS_GATEWAY = previousGateway; });
  const fp = "aaaa-bbbb-cccc-dddd-eeee-ffff";
  const later = `Later, run: cns peer remove --fingerprint ${fp} --everywhere`;
  // Said whatever the gateway answered: a lost owner the gateway never paired can still approve connectors.
  const owners = "; if it was one of the gateway's owners too, it can still approve connectors until its key is out of OWNER_KEYS (cd gateway && npx wrangler secret put OWNER_KEYS); cns gateway grants lists the connectors, and cns gateway revoke ID stops one";
  let asked = 0;
  const answering = (status: number, body: string) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { asked++; return new Response(body, { status, headers: { "Content-Type": "application/json" } }); } });
    t.after(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  };
  // With no CNS_GATEWAY, no gateway is asked, not even the default one.
  delete process.env.CNS_GATEWAY;
  assert.deepEqual(await forgetAtGateway(fp, false), { outcome: "not used", detail: `CNS_GATEWAY is not set here, so no gateway was asked. If this device owns a gateway, run: cns gateway status, then cns gateway remove NAME (fingerprint ${fp})${owners}` });
  assert.deepEqual(await forgetAtGateway(fp, true), await forgetAtGateway(fp, false));
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  process.env.CNS_GATEWAY = `http://127.0.0.1:${closed.port}`;
  await closed.stop(true);
  const gone = await forgetAtGateway(fp, false);
  assert.equal(gone.outcome, "unreachable");
  assert.match(gone.detail!, /^Cannot reach the gateway at http:\/\/127\.0\.0\.1:\d+.*; if it was one of the gateway's owners too/);
  assert.equal(gone.next, later);
  process.env.CNS_GATEWAY = answering(401, JSON.stringify({ error: "Device x is not an owner of this gateway." }));
  const refused = await forgetAtGateway(fp, false);
  assert.equal(refused.outcome, "not permitted");
  assert.match(refused.detail!, /^Device x is not an owner of this gateway\. This device's public key is \S+\.; if it was one of the gateway's owners too/);
  assert.equal(refused.next, "Run this on one of the gateway's owners, with CNS_GATEWAY set to its address");
  process.env.CNS_GATEWAY = answering(503, JSON.stringify({ error: "This gateway has no owners yet." }));
  assert.equal((await forgetAtGateway(fp, false)).outcome, "not permitted");
  // What the gateway sends is made printable where the place is made, for the report and --json alike.
  process.env.CNS_GATEWAY = answering(502, "<html>Bad\u009b31m gateway\u202e</html>");
  assert.deepEqual(await forgetAtGateway(fp, true), { outcome: "failed", detail: `The gateway answered 502: <html>Bad?31m gateway?</html>${owners}`, next: later });
  assert.equal(asked, 3);
});
