import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { newBunWebSocketRpcSession, newMessagePortRpcSession, RpcTarget, type BunWebSocketTransport } from "capnweb";
import { connectControl } from "../commands/daemon.js";
import { GrantedShell, type SecretsHere } from "../granted-shell.js";
import type { Permission } from "../peers.js";
import { ShellApi, type FileChunk, type ShellInfo } from "../shell.js";
import { plain } from "../terminal.js";
import { listSkillFiles, listSkills, readSkillFile } from "../skills.js";
import { cliEnvironment, cliInvocation, launchCli, settledLink, testDevices, unusedPort } from "../test-support.js";
import { LegacySessions, MAX_SESSIONS } from "./legacy-sessions.js";
import { clip, createMcpServer, MAX_RESULT_CHARS, readLines } from "./server.js";
import { daemonTarget, type McpTarget, type PeerFiles, type ToolController } from "./target.js";
import { CNS_VERSION } from "../version.js";

const posix = process.platform !== "win32";
const print = (marker: string) => posix ? `printf '${marker}'` : `[Console]::Write('${marker}')`;
const TOKEN = "t".repeat(40);

/** Studio runs its daemon and grants laptop everything; laptop's cns mcp studio reaches it. */
async function paired(t: TestContext) {
  const devices = await testDevices(t, "cns-mcp-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop, { hostGrants: "all" });
  return { devices, studio, laptop, env: laptop.env };
}

/** Start cns mcp over stdio as an MCP client would, speaking the protocol revision `mode` selects. */
async function stdioClient(t: TestContext, args: string[], mode: "auto" | "legacy" = "auto", env: Record<string, string> = {}) {
  const invocation = cliInvocation(["mcp", ...args]);
  const transport = new StdioClientTransport({
    command: invocation.file, args: invocation.args, env: cliEnvironment(env) as Record<string, string>, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "cns-tests", version: "1" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { client, transport, get stderr() { return stderr; } };
}

/** Serve cns mcp --http for a paired device and return its endpoint. */
async function httpServer(t: TestContext, args: string[], token = TOKEN, env: Record<string, string> = {}) {
  const port = await unusedPort("127.0.0.1");
  const server = launchCli(t, ["mcp", ...args, "--http", port], { env: { ...env, CNS_MCP_TOKEN: token } });
  await server.waitFor("Tools reach");
  return { server, endpoint: `http://127.0.0.1:${port}/mcp`, port };
}

async function httpClient(t: TestContext, endpoint: string, mode: "auto" | "legacy" = "auto", token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "cns-tests", version: "1" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return Object.assign(client, { http: transport });
}

const initializeRequest = () => new Request("http://127.0.0.1/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cns-tests", version: "1" },
  } }),
});

const structured = (result: unknown) => (result as CallToolResult).structuredContent as Record<string, any>;
const text = (result: unknown) => ((result as CallToolResult).content[0] as { text: string }).text;
function succeeded(result: unknown) {
  assert.notEqual((result as CallToolResult).isError, true, text(result));
  return structured(result);
}

async function eventually(check: () => boolean | Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out: ${label}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-mcp-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

/** Start a command that records its shell's PID, and wait until it has. */
async function startSleeper(client: Client, directory: string, signal: AbortSignal) {
  const pidFile = path.join(directory, `${crypto.randomUUID()}.pid`);
  const call = client.callTool({ name: "run_command", arguments: { command: `echo $$ > '${pidFile}'; sleep 30`, timeoutMs: 0 } }, { signal });
  call.catch(() => {});
  await eventually(async () => existsSync(pidFile) && (await readFile(pidFile, "utf8")).trim() !== "", "the command to start");
  return { call, pid: Number((await readFile(pidFile, "utf8")).trim()) };
}

test("clip keeps the start and end of long text without splitting characters", () => {
  assert.deepEqual(clip("short"), { text: "short", clipped: false });
  const long = "a".repeat(MAX_RESULT_CHARS) + "😀".repeat(10) + "END";
  const { text: clipped, clipped: wasClipped } = clip(long);
  assert.ok(wasClipped);
  assert.ok(clipped.startsWith("aaa"));
  assert.ok(clipped.endsWith("END"));
  assert.match(clipped, /\[\.\.\. \d+ characters omitted \.\.\.\]/);
  assert.ok(clipped.length <= MAX_RESULT_CHARS + 60);
  // No lone surrogate halves at either cut.
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(clipped, loneSurrogate);
  for (const offset of [0, 1]) assert.doesNotMatch(clip("x".repeat(offset) + "😀".repeat(MAX_RESULT_CHARS)).text, loneSurrogate);
});

test("2025-era HTTP sessions are capped by evicting the longest idle one", async () => {
  const unreachable = { label: "nowhere", open: async () => { throw new Error("unused"); } };
  const sessions = new LegacySessions(() => createMcpServer(unreachable), (error) => { throw error; });
  try {
    const ids: string[] = [];
    for (let index = 0; index <= MAX_SESSIONS; index++) {
      const response = await sessions.fetch(initializeRequest());
      assert.equal(response.status, 200);
      await response.text();
      ids.push(response.headers.get("Mcp-Session-Id")!);
    }
    assert.equal(sessions.size, MAX_SESSIONS);
    const ping = (id: string) => sessions.fetch(new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": id, "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    }));
    assert.equal((await ping(ids[0]!)).status, 404);
    const kept = await ping(ids[1]!);
    assert.equal(kept.status, 200);
    await kept.text();
  } finally {
    await sessions.close();
  }
  assert.equal(sessions.size, 0);
});

/** A target whose commands run until their call's connection closes. */
function hangingTarget() {
  const links = { opened: 0, closed: 0 };
  const target: McpTarget = {
    label: "a hanging peer",
    async open() {
      links.opened++;
      let close!: () => void;
      const closed = new Promise<void>((resolve) => { close = resolve; });
      let done = false;
      return {
        controller: { run: () => closed.then(() => { throw new Error("closed"); }) } as unknown as ToolController,
        peer: async () => "p1",
        lost: false,
        close() {
          if (done) return;
          done = true;
          links.closed++;
          close();
        },
      };
    },
  };
  return { target, links };
}

test("2025-era HTTP sessions end cancelled and abandoned calls without leaking responses", { timeout: 30000 }, async (t) => {
  const { target, links } = hangingTarget();
  const sessions = new LegacySessions(() => createMcpServer(target), () => {});
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => sessions.fetch(request) });
  t.after(async () => {
    await sessions.close();
    await server.stop(true);
  });
  const endpoint = `http://127.0.0.1:${server.port}/mcp`;
  const connect = async () => {
    const client = new Client({ name: "cns-tests", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    return client;
  };
  const client = await connect();
  t.after(() => client.close());
  // The client keeps one event stream open for server messages.
  const baseline = 1;
  await eventually(() => server.pendingRequests === baseline, "the client's event stream");
  for (let round = 1; round <= 3; round++) {
    const controller = new AbortController();
    const call = client.callTool({ name: "run_command", arguments: { command: "true" } }, { signal: controller.signal });
    call.catch(() => {});
    await eventually(() => links.opened === round, "the call to start");
    controller.abort();
    await assert.rejects(call);
    await eventually(() => links.closed === round, "the cancelled call to close its connection");
    await eventually(() => server.pendingRequests === baseline, "the cancelled call's response to end");
  }

  // A client that goes away mid-call cannot receive the result, so the call ends.
  const leaving = await connect();
  const call = leaving.callTool({ name: "run_command", arguments: { command: "true" } });
  call.catch(() => {});
  await eventually(() => links.opened === 4, "the call to start");
  await leaving.close();
  await eventually(() => links.closed === 4, "the abandoned call to close its connection");
});

test("2025-era HTTP sessions starting at once stay within the limit", { timeout: 30000 }, async () => {
  const sessions = new LegacySessions(() => createMcpServer(hangingTarget().target), () => {});
  try {
    const responses = await Promise.all(Array.from({ length: MAX_SESSIONS + 16 }, () => sessions.fetch(initializeRequest())));
    assert.equal(responses.filter((response) => response.status === 200).length, MAX_SESSIONS);
    assert.equal(responses.filter((response) => response.status === 503).length, 16);
    assert.equal(sessions.size, MAX_SESSIONS);
    await Promise.all(responses.map((response) => response.text()));
  } finally {
    await sessions.close();
  }
});

test("stdio MCP server runs commands on a paired device and reports failures as tool errors", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env } = await paired(t);
  const { client } = await stdioClient(t, ["studio"], "auto", env);
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.match(client.getInstructions() ?? "", /run_command/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(),
    ["glob", "kill_session", "list_directory", "list_peers", "list_secrets", "list_sessions", "list_skills", "read_file", "read_screen", "read_skill", "run_command", "search_skills", "send_keys", "start_session", "write_file"]);
  const run = tools.find((tool) => tool.name === "run_command")!;
  assert.equal(run.annotations?.destructiveHint, true);
  assert.equal(run.annotations?.readOnlyHint, false);
  assert.equal(run.inputSchema.additionalProperties, false);
  assert.equal(tools.find((tool) => tool.name === "read_screen")!.annotations?.readOnlyHint, true);

  const peers = succeeded(await client.callTool({ name: "list_peers", arguments: {} }));
  assert.equal(peers.peers.length, 1);
  assert.equal(peers.peers[0].id, "p1");
  assert.equal(peers.peers[0].name, "studio");
  assert.equal(peers.peers[0].shell, posix ? "Bash" : "PowerShell");
  // Agents can see which cns a device runs.
  assert.equal(peers.peers[0].version, CNS_VERSION);
  // The device's name selects it too.
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: print("BY_NAME"), peer: "studio" } })).stdout, "BY_NAME");

  const ran = succeeded(await client.callTool({ name: "run_command", arguments: { command: print("MCP_OK") } }));
  assert.equal(ran.stdout, "MCP_OK");
  assert.equal(ran.exitCode, 0);
  assert.equal(ran.peer, "p1");

  // A command that fails is a result the agent reads, not a tool error.
  const failed = await client.callTool({ name: "run_command", arguments: { command: posix ? "echo oops >&2; exit 3" : "[Console]::Error.Write('oops'); exit 3" } });
  assert.equal(failed.isError, undefined);
  assert.equal(structured(failed).exitCode, 3);
  assert.match(structured(failed).stderr, /oops/);
  assert.match(text(failed), /^Exit code 3/);

  const relative = await client.callTool({ name: "run_command", arguments: { command: print("x"), cwd: "relative/path" } });
  assert.equal(relative.isError, true);
  const wrongPeer = await client.callTool({ name: "run_command", arguments: { command: print("x"), peer: "p2" } });
  assert.equal(wrongPeer.isError, true);
  assert.match(text(wrongPeer), /Unknown peer p2/);
  const extra = await client.callTool({ name: "run_command", arguments: { command: print("x"), shell: "zsh" } });
  assert.equal(extra.isError, true);
  const missing = await client.callTool({ name: "read_screen", arguments: { name: "absent" } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /No PTY session named absent/);

  if (posix) {
    const timedOut = succeeded(await client.callTool({ name: "run_command", arguments: { command: "sleep 10", timeoutMs: 200 } }));
    assert.equal(timedOut.timedOut, true);
    const big = succeeded(await client.callTool({ name: "run_command", arguments: { command: "head -c 200000 /dev/zero | tr '\\0' x; printf END" } }));
    assert.equal(big.truncated, true);
    assert.ok(big.stdout.endsWith("END"));
    assert.ok(big.stdout.length < 200_000);
  }
});

test("terminal session tools drive an interactive program", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env } = await paired(t);
  const { client } = await stdioClient(t, ["studio"], "auto", env);
  const started = succeeded(await client.callTool({ name: "start_session", arguments: {
    name: "repl", command: "printf 'ready> '; while read -r line; do printf 'got:%s\\nready> ' \"$line\"; done", cols: 100, rows: 30, until: "ready>",
  } }));
  assert.equal(started.session.name, "repl");
  assert.equal(started.session.cols, 100);
  assert.equal(started.matched, true);
  assert.match(started.screen.text, /ready>/);

  const duplicate = await client.callTool({ name: "start_session", arguments: { name: "repl", command: "true" } });
  assert.equal(duplicate.isError, true);
  assert.match(text(duplicate), /already exists/);

  const sent = succeeded(await client.callTool({ name: "send_keys", arguments: { name: "repl", keys: ["hello", "Enter"], until: "got:hello" } }));
  assert.equal(sent.sent, 2);
  assert.equal(sent.matched, true);
  assert.equal(sent.running, true);
  assert.match(sent.screen.text, /got:hello/);

  const waited = await client.callTool({ name: "read_screen", arguments: { name: "repl", until: "never shown", waitMs: 200 } });
  assert.equal(structured(waited).matched, false);
  assert.match(text(waited), /timed out after 200 ms/);

  const listed = succeeded(await client.callTool({ name: "list_sessions", arguments: {} }));
  assert.deepEqual(listed.sessions.map((session: { name: string }) => session.name), ["repl"]);

  const ended = succeeded(await client.callTool({ name: "send_keys", arguments: { name: "repl", keys: ["C-d"], until: "never shown" } }));
  assert.equal(ended.matched, false);
  assert.equal(ended.running, false);
  assert.equal(ended.exit.exitCode, 0);

  const killed = succeeded(await client.callTool({ name: "kill_session", arguments: { name: "repl" } }));
  assert.equal(killed.exit.exitCode, 0);
  assert.deepEqual(succeeded(await client.callTool({ name: "list_sessions", arguments: {} })).sessions, []);
});

test("a 2025-era stdio client is served too", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env } = await paired(t);
  const { client } = await stdioClient(t, ["studio"], "legacy", env);
  assert.notEqual(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: print("LEGACY_OK") } })).stdout, "LEGACY_OK");
});

test("cancelling calls kills their commands and frees their screen waits", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env } = await paired(t);
  const { client } = await stdioClient(t, ["studio"], "auto", env);
  const directory = await temporaryDirectory(t);
  const controller = new AbortController();
  const { call, pid } = await startSleeper(client, directory, controller.signal);
  controller.abort();
  await assert.rejects(call);
  await eventually(() => !alive(pid), "the cancelled command to be killed");

  // A session allows 8 waiters; cancelled waits must give their places back.
  succeeded(await client.callTool({ name: "start_session", arguments: { name: "idle", command: "cat" } }));
  const waits = Array.from({ length: 8 }, () => {
    const cancel = new AbortController();
    const waiting = client.callTool({ name: "read_screen", arguments: { name: "idle", until: "never shown", waitMs: 0 } }, { signal: cancel.signal });
    waiting.catch(() => {});
    return { cancel, waiting };
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const { cancel } of waits) cancel.abort();
  await Promise.allSettled(waits.map(({ waiting }) => waiting));
  await eventually(async () => {
    const result = await client.callTool({ name: "read_screen", arguments: { name: "idle", until: "never shown", waitMs: 100 } });
    return result.isError !== true;
  }, "a waiter slot to be released");
  succeeded(await client.callTool({ name: "kill_session", arguments: { name: "idle" } }));
});

test("the stdio server exits when its client closes stdin", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env } = await paired(t);
  const server = launchCli(t, ["mcp", "studio"], { env });
  server.child.stdin.end();
  assert.equal(await server.exited, 0, server.output);
  assert.equal(server.stdout, "");
});

test("the device cannot run commands on the MCP server's machine", { skip: !posix, timeout: 30000 }, async (t) => {
  const { env, studio } = await paired(t);
  const { client } = await stdioClient(t, ["studio"], "auto", env);
  const controller = new AbortController();
  const directory = await temporaryDirectory(t);
  const { call } = await startSleeper(client, directory, controller.signal);
  t.after(() => controller.abort());
  const control = await connectControl(studio.state);
  try {
    const connection = (await control.controller.peers()).find((peer) => peer.peer?.name === "laptop" && !peer.peer.daemon);
    assert.ok(connection, "the call's connection is listed");
    await assert.rejects(() => control.controller.run(connection.id, print("REVERSE_SHELL"), {}), /does not run commands/);
  } finally { control.close(); }
  controller.abort();
  await assert.rejects(call);
});

test("Streamable HTTP requires the token, refuses browsers and serves both protocol eras", { skip: !posix, timeout: 60000 }, async (t) => {
  const { env } = await paired(t);
  const { server, endpoint, port } = await httpServer(t, ["studio"], TOKEN, env);
  assert.match(server.stdout, /MCP endpoint: http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.doesNotMatch(server.stdout, new RegExp(TOKEN));
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const post = (headers: Record<string, string>, target = endpoint) => fetch(target, {
    method: "POST", body, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
  });
  const unauthorized = await post({});
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("WWW-Authenticate") ?? "", /^Bearer/);
  assert.equal((await post({ Authorization: `Bearer ${"x".repeat(40)}` })).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}`, Origin: "http://127.0.0.1" })).status, 403);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}`, Host: `rebound.example:${port}` })).status, 403);
  assert.equal((await post({ Authorization: `Bearer ${TOKEN}` }, endpoint.replace("/mcp", "/other"))).status, 404);

  const modern = await httpClient(t, endpoint);
  assert.equal(modern.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.equal(succeeded(await modern.callTool({ name: "run_command", arguments: { command: print("HTTP_OK") } })).stdout, "HTTP_OK");
  assert.equal(modern.http.sessionId, undefined);
  const legacy = await httpClient(t, endpoint, "legacy");
  assert.notEqual(legacy.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.equal(succeeded(await legacy.callTool({ name: "run_command", arguments: { command: print("LEGACY_HTTP_OK") } })).stdout, "LEGACY_HTTP_OK");

  // 2025-era clients get a session, so their cancellations reach their calls.
  const sessionId = legacy.http.sessionId;
  assert.match(sessionId ?? "", /^[0-9a-f-]{36}$/);
  const inSession = (id: string, method = "POST") => fetch(endpoint, {
    method, body: method === "POST" ? body : undefined,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": id, "MCP-Protocol-Version": "2025-06-18" },
  });
  assert.equal((await inSession(crypto.randomUUID())).status, 404);
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" } })).status, 400);
  const ended = await httpClient(t, endpoint, "legacy");
  const endedId = ended.http.sessionId!;
  await ended.http.terminateSession();
  assert.equal((await inSession(endedId)).status, 404);

  if (posix) {
    // Calls outlast Bun's 10 s idle timeout, as single JSON responses or as event
    // streams reporting progress.
    const progress: number[] = [];
    const [quiet, reported] = await Promise.all([
      modern.callTool({ name: "run_command", arguments: { command: "sleep 11; printf QUIET_OK" } }, { timeout: 30_000 }),
      modern.callTool({ name: "run_command", arguments: { command: "sleep 11; printf LONG_OK" } }, {
        onprogress: ({ progress: value }) => progress.push(value), timeout: 30_000,
      }),
    ]);
    assert.equal(succeeded(quiet).stdout, "QUIET_OK");
    assert.equal(succeeded(reported).stdout, "LONG_OK");
    assert.ok(progress.length >= 1, "a progress notification");

    const directory = await temporaryDirectory(t);
    for (const client of [modern, legacy]) {
      const controller = new AbortController();
      const { call, pid } = await startSleeper(client, directory, controller.signal);
      controller.abort();
      await assert.rejects(call);
      await eventually(() => !alive(pid), `the cancelled ${client === modern ? "modern" : "legacy"} HTTP call's command to be killed`);
    }
  }
});

test("HTTP refuses a weak CNS_MCP_TOKEN and prints a generated one", { timeout: 30000 }, async (t) => {
  const weak = launchCli(t, ["mcp", "--http", await unusedPort("127.0.0.1")], { env: { CNS_MCP_TOKEN: "short" } });
  assert.equal(await weak.exited, 1);
  assert.match(weak.stderr, /CNS_MCP_TOKEN must be/);
  const generated = launchCli(t, ["mcp", "--http", await unusedPort("127.0.0.1")]);
  await generated.waitFor("CNS_MCP_TOKEN to keep one");
  assert.match(generated.stdout, /Authorization: Bearer [A-Za-z0-9_-]{43}\n/);
});

test("the daemon target chooses among linked devices and kills cancelled commands", { skip: !posix, timeout: 90000 }, async (t) => {
  const devices = await testDevices(t, "cns-mcp-daemon-");
  const studio = await devices.device("studio");
  await devices.up(studio);
  const directory = await temporaryDirectory(t);
  const absent = await stdioClient(t, ["--state", path.join(directory, "absent.json")], "auto", studio.env);
  const notRunning = await absent.client.callTool({ name: "list_peers", arguments: {} });
  assert.equal(notRunning.isError, true);
  assert.match(text(notRunning), /No local daemon is running\. Start it with cns up --state .*absent\.json/);

  const { client } = await stdioClient(t, ["--state", studio.state], "auto", studio.env);
  const none = await client.callTool({ name: "run_command", arguments: { command: print("x") } });
  assert.equal(none.isError, true);
  assert.match(text(none), /No peers are connected/);

  /**
   * A device whose daemon links to studio's and lets studio use all of it. After pairing,
   * both daemons dial each other and keep one link (src/link-rules.ts); until that settles,
   * the device's link ID can change, and while one link replaces the other the device is
   * briefly missing from the daemon's peers.
   */
  const watcher = await connectControl(studio.state);
  t.after(() => watcher.close());
  const linked = async (name: string, marker: string) => {
    const device = await devices.device(name, { CNS_TEST_PEER: marker });
    await devices.up(device);
    await devices.pair(studio, device, { hostGrants: "none", guestGrants: "all" });
    await settledLink(watcher, name);
    return device;
  };
  const firstDevice = await linked("first", "FIRST");
  assert.equal(succeeded(await client.callTool({ name: "list_peers", arguments: {} })).peers.length, 1);
  const only = succeeded(await client.callTool({ name: "run_command", arguments: { command: `printf "$CNS_TEST_PEER"` } }));
  assert.equal(only.stdout, "FIRST");
  assert.match(only.peer, /^p\d+$/);
  const first = only.peer as string;
  const noteFile = path.join(directory, "via-daemon", "note.txt");
  assert.equal(succeeded(await client.callTool({ name: "write_file", arguments: { path: noteFile, content: "via daemon" } })).created, true);
  assert.equal(succeeded(await client.callTool({ name: "read_file", arguments: { path: noteFile } })).content, "via daemon");
  assert.deepEqual(succeeded(await client.callTool({ name: "glob", arguments: { pattern: "**/*.txt", path: directory } })).paths, [noteFile]);

  const secondDevice = await linked("second", "SECOND");
  const both = succeeded(await client.callTool({ name: "list_peers", arguments: {} }));
  assert.equal(both.peers.length, 2);
  // Through the daemon too: the version survives the daemon's check of each device's handshake.
  assert.deepEqual(both.peers.map((peer: { version?: string }) => peer.version), [CNS_VERSION, CNS_VERSION]);
  const ambiguous = await client.callTool({ name: "run_command", arguments: { command: print("x") } });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /Several peers are connected \(first \(p\d+\), second \(p\d+\)\); pass peer/);
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: `printf "$CNS_TEST_PEER"`, peer: "second" } })).stdout, "SECOND");

  // Each device's skills, through the daemon with the files grant: listed once, from the newest copy.
  await skill(path.join(firstDevice.dir, ".agents", "skills"), "notes", { "SKILL.md": "---\ndescription: Take notes\n---\nfirst\n" }, 1_900_000_000);
  await skill(path.join(secondDevice.dir, ".agents", "skills"), "notes", { "SKILL.md": "---\ndescription: Take notes\n---\nsecond\n" }, 2_000_000_000);
  const skills = succeeded(await client.callTool({ name: "list_skills", arguments: {} }));
  assert.deepEqual(skills.skills.map(({ name, peer, alsoOn }: Record<string, unknown>) => ({ name, peer, alsoOn })), [{ name: "notes", peer: "second", alsoOn: ["first"] }]);
  assert.equal(succeeded(await client.callTool({ name: "read_skill", arguments: { name: "notes" } })).content.split("\n").at(-1), "second");
  assert.equal(succeeded(await client.callTool({ name: "read_skill", arguments: { name: "notes", peer: "first", offset: 4 } })).content, "first");

  const controller = new AbortController();
  const pidFile = path.join(directory, "daemon.pid");
  const call = client.callTool({ name: "run_command", arguments: { command: `echo $$ > '${pidFile}'; sleep 30`, peer: first, timeoutMs: 0 } }, { signal: controller.signal });
  call.catch(() => {});
  await eventually(async () => existsSync(pidFile) && (await readFile(pidFile, "utf8")).trim() !== "", "the command to start");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  controller.abort();
  await assert.rejects(call);
  await eventually(() => !alive(pid), "the daemon to kill the cancelled command");

  // Commands from an attached console still outlive its connection.
  const keptFile = path.join(directory, "kept.pid");
  const console = await connectControl(studio.state);
  const kept = console.controller.run(first, `echo $$ > '${keptFile}'; sleep 30`, {});
  kept.catch(() => {});
  await eventually(async () => existsSync(keptFile) && (await readFile(keptFile, "utf8")).trim() !== "", "the console's command to start");
  const keptPid = Number((await readFile(keptFile, "utf8")).trim());
  t.after(() => { try { process.kill(-keptPid, "SIGKILL"); } catch { /* Already gone. */ } });
  console.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(alive(keptPid), "a detached console's command keeps running");
});

/** The control surface of a daemon started by a cns from before the file tools: it lists a peer but offers no files. */
class OlderControlApi extends RpcTarget {
  peers() { return [{ id: "p1", info: new ShellApi().info() }]; }
}

test("file tools tell a daemon that is older than cns to restart instead of failing with 'files' is not a function", async (t) => {
  const directory = await temporaryDirectory(t);
  const statePath = path.join(directory, "daemon.json");
  const token = "a".repeat(64);
  const server = Bun.serve<{ transport?: BunWebSocketTransport<unknown> }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) { return server.upgrade(request, { data: {} }) ? undefined : new Response("upgrade", { status: 400 }); },
    websocket: {
      open(ws) { ws.data.transport = newBunWebSocketRpcSession(ws, new OlderControlApi()).transport as BunWebSocketTransport<unknown>; },
      message(ws, message) { ws.data.transport?.dispatchMessage(message); },
      close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
    },
  });
  t.after(() => server.stop(true));
  await writeFile(statePath, JSON.stringify({ version: 1, pid: process.pid, port: server.port, token }), { mode: 0o600 });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = createMcpServer(daemonTarget(statePath));
  await mcp.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await mcp.close(); });

  for (const [name, args] of [
    ["list_directory", { path: directory }], ["read_file", { path: statePath }], ["glob", { pattern: "*", path: directory }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.doesNotMatch(text(result), /is not a function/, name);
    assert.match(text(result), /runs an older cns than this one and does not offer file access/, name);
    assert.ok(text(result).includes(`cns daemon restart --state ${statePath};`), name);
  }
});

/** Files whose reads come back in pieces of `piece` bytes, to cross chunk boundaries. */
function chunkedFiles(content: Uint8Array, piece: number): PeerFiles {
  return {
    async readFile(_file: string, options: { offset?: number } = {}): Promise<FileChunk> {
      const offset = options.offset ?? 0;
      const data = content.slice(offset, offset + piece);
      return { data, size: content.byteLength, eof: offset + data.byteLength >= content.byteLength };
    },
  } as unknown as PeerFiles;
}

test("readLines returns line ranges across chunks and stops before results grow too long", async () => {
  const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1} é😀`);
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  // Seven-byte pieces split the multi-byte characters.
  const files = chunkedFiles(bytes, 7);
  const all = await readLines(files, "/f", 1, 1000);
  assert.equal(all.content, lines.join("\n"));
  assert.deepEqual([all.endLine, all.totalLines, all.nextOffset, all.size], [50, 50, null, bytes.byteLength]);
  const middle = await readLines(files, "/f", 10, 3);
  assert.equal(middle.content, lines.slice(9, 12).join("\n"));
  assert.deepEqual([middle.endLine, middle.nextOffset], [12, 13]);
  const beyond = await readLines(files, "/f", 60, 5);
  assert.deepEqual([beyond.content, beyond.endLine, beyond.totalLines, beyond.nextOffset], ["", 59, 50, null]);
  const unterminated = await readLines(chunkedFiles(new TextEncoder().encode("a\nb"), 1), "/f", 1, 10);
  assert.deepEqual([unterminated.content, unterminated.totalLines], ["a\nb", 2]);
  const empty = await readLines(chunkedFiles(new Uint8Array(), 1), "/f", 1, 10);
  assert.deepEqual([empty.content, empty.endLine, empty.totalLines], ["", 0, 0]);

  const wide = "x".repeat(MAX_RESULT_CHARS / 3);
  const many = await readLines(chunkedFiles(new TextEncoder().encode(Array(5).fill(wide).join("\n")), 4096), "/f", 1, 1000);
  assert.deepEqual([many.endLine, many.nextOffset, many.totalLines], [2, 3, null]);
  const long = await readLines(chunkedFiles(new TextEncoder().encode(`${"y".repeat(MAX_RESULT_CHARS * 3)}\nnext`), 65536), "/f", 1, 1000);
  assert.ok(long.content.length <= MAX_RESULT_CHARS);
  assert.match(long.content, /line shortened/);
  assert.deepEqual([long.endLine, long.nextOffset], [1, 2]);

  await assert.rejects(readLines(chunkedFiles(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]), 64), "/bin", 1, 10), /binary file/);
});

test("file tools read, write, list and find files on a paired device", { skip: !posix, timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-mcp-files-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(path.join(directory, "src", "deep"), { recursive: true });
  await mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(directory, "src", "a.ts"), "one\ntwo\nthree\n");
  await writeFile(path.join(directory, "src", "deep", "b.ts"), "b");
  await writeFile(path.join(directory, "node_modules", "pkg", "c.ts"), "c");
  await writeFile(path.join(directory, "blob.bin"), Buffer.from([1, 0, 2]));
  const { env } = await paired(t);
  const { client } = await stdioClient(t, ["studio", "--cwd", directory], "auto", env);

  const { tools } = await client.listTools();
  assert.equal(tools.find((tool) => tool.name === "read_file")!.annotations?.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === "write_file")!.annotations?.destructiveHint, true);

  const read = succeeded(await client.callTool({ name: "read_file", arguments: { path: "src/a.ts" } }));
  assert.equal(read.path, path.join(directory, "src", "a.ts"));
  assert.equal(read.content, "one\ntwo\nthree");
  assert.deepEqual([read.startLine, read.endLine, read.totalLines, read.truncated], [1, 3, 3, false]);
  const part = await client.callTool({ name: "read_file", arguments: { path: path.join(directory, "src", "a.ts"), offset: 2, limit: 1 } });
  assert.equal(structured(part).content, "two");
  assert.equal(structured(part).nextOffset, 3);
  assert.match(text(part), /lines 2-2 .*\ntwo\n.*pass offset 3/);

  const missing = await client.callTool({ name: "read_file", arguments: { path: "absent.txt" } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /ENOENT/);
  const binary = await client.callTool({ name: "read_file", arguments: { path: "blob.bin" } });
  assert.equal(binary.isError, true);
  assert.match(text(binary), /binary file/);

  const created = succeeded(await client.callTool({ name: "write_file", arguments: { path: "new/dir/note.txt", content: "héllo\n" } }));
  assert.deepEqual([created.created, created.bytes], [true, 7]);
  assert.equal(await readFile(path.join(directory, "new", "dir", "note.txt"), "utf8"), "héllo\n");
  const replaced = succeeded(await client.callTool({ name: "write_file", arguments: { path: "src/a.ts", content: "replaced" } }));
  assert.equal(replaced.created, false);
  assert.equal(await readFile(path.join(directory, "src", "a.ts"), "utf8"), "replaced");
  const onDirectory = await client.callTool({ name: "write_file", arguments: { path: "src", content: "x" } });
  assert.equal(onDirectory.isError, true);
  assert.match(text(onDirectory), /is a directory/);

  const listed = await client.callTool({ name: "list_directory", arguments: {} });
  assert.deepEqual(structured(listed).entries, [
    { name: "blob.bin", kind: "file" }, { name: "new", kind: "directory" },
    { name: "node_modules", kind: "directory" }, { name: "src", kind: "directory" },
  ]);
  assert.match(text(listed), /\nsrc\//);
  const limited = succeeded(await client.callTool({ name: "list_directory", arguments: { path: "src", limit: 1 } }));
  assert.deepEqual([limited.entries.length, limited.truncated], [1, true]);

  const found = succeeded(await client.callTool({ name: "glob", arguments: { pattern: "**/*.ts", ignore: ["**/node_modules/**"] } }));
  assert.deepEqual(found.paths.sort(), [path.join(directory, "src", "a.ts"), path.join(directory, "src", "deep", "b.ts")]);
  assert.equal(found.truncated, false);
  const capped = succeeded(await client.callTool({ name: "glob", arguments: { pattern: "**/*.ts", limit: 1 } }));
  assert.deepEqual([capped.paths.length, capped.truncated], [1, true]);
  const relative = succeeded(await client.callTool({ name: "glob", arguments: { pattern: "*.ts", path: "src" } }));
  assert.deepEqual(relative.paths, [path.join(directory, "src", "a.ts")]);
});

/** An in-process server whose one peer is this machine's shell, limited to `grants`. */
async function grantedClient(t: TestContext, grants: Permission[]) {
  const shell = new GrantedShell(new ShellApi(), grants, "studio");
  const target: McpTarget = {
    label: "studio",
    async open() {
      return {
        controller: {
          peers: async () => [{ id: "p1", info: shell.info() }],
          files: async () => shell as unknown as PeerFiles,
        } as unknown as ToolController,
        peer: async () => "p1",
        lost: false,
        close() {},
      };
    },
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(target);
  await server.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("file tools need the files grant on a paired device", { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-mcp-grants-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, "secret.txt");
  await writeFile(file, "secret");

  const denied = await grantedClient(t, ["shell"]);
  for (const [name, args] of [
    ["read_file", { path: file }], ["write_file", { path: file, content: "x" }],
    ["list_directory", { path: directory }], ["glob", { pattern: "*", path: directory }],
  ] as const) {
    const result = await denied.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /Permission denied: files not granted to studio/, name);
  }
  assert.equal(await readFile(file, "utf8"), "secret");

  const allowed = await grantedClient(t, ["files"]);
  assert.equal(succeeded(await allowed.callTool({ name: "read_file", arguments: { path: file } })).content, "secret");
});

test("a server limited to some tools lists and runs only those, and reports each call", async (t) => {
  const calls: { tool: string; ok: boolean; args: Record<string, unknown> }[] = [];
  const target: McpTarget = {
    label: "a test peer",
    async open() {
      return {
        controller: { run: async () => ({ stdout: "hi\n", stderr: "", exitCode: 0, signal: null, signalNumber: null, timedOut: false, elapsedMs: 1, truncated: false }) } as unknown as ToolController,
        peer: async () => "p1",
        lost: false,
        close() {},
      };
    },
  };
  const server = createMcpServer(target, { tools: ["run_command", "read_file"], onCall: (call) => calls.push(call) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["read_file", "run_command"]);
  const ran = await client.callTool({ name: "run_command", arguments: { command: "echo hi" } }) as CallToolResult;
  assert.equal(ran.isError, undefined);
  // A tool left out does not exist for the client.
  await assert.rejects(client.callTool({ name: "write_file", arguments: { path: "/tmp/x", content: "x" } }), /write_file/);
  const failed = await client.callTool({ name: "read_file", arguments: { path: "/etc/hosts" } }) as CallToolResult;
  assert.equal(failed.isError, true);
  assert.deepEqual(calls.map(({ tool, ok }) => ({ tool, ok })), [{ tool: "run_command", ok: true }, { tool: "read_file", ok: false }]);
  assert.equal(calls[0]!.args.command, "echo hi");
});

/** A skill in `root`: a directory with these files, all last changed at `modified` seconds. */
async function skill(root: string, name: string, files: Record<string, string>, modified: number) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, name, ...file.split("/"));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
    await utimes(full, modified, modified);
  }
}

/** An in-process client whose peers are named devices, each with the skills in its own directory; `refusing` grant none. */
async function skillsClient(t: TestContext, roots: Record<string, string>, refusing: string[] = []) {
  const info = new ShellApi().info();
  const target: McpTarget = {
    label: "test peers",
    async open() {
      return {
        controller: {
          peers: async () => Object.keys(roots).map((name) => ({ id: name, info, peer: { name, fingerprint: "f", daemon: true, via: "direct" as const } })),
          files: async (id: string) => ({
            async skills() {
              if (refusing.includes(id)) throw new Error("Permission denied: skills not granted to laptop.");
              return await listSkills(roots[id]);
            },
            skillFiles: (name: string) => listSkillFiles(name, roots[id]),
            readSkillFile: (name: string, file: string, options: { offset?: number }) => readSkillFile(name, file, options, roots[id]),
          }) as unknown as PeerFiles,
        } as unknown as ToolController,
        peer: async (requested) => requested ?? assert.fail("pass peer"),
        lost: false,
        close() {},
      };
    },
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(target);
  await server.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("skill tools list every peer's skills once, newest first, and read and search them", async (t) => {
  const studio = await temporaryDirectory(t);
  const mini = await temporaryDirectory(t);
  await skill(studio, "pdf", { "SKILL.md": "---\ndescription: Fill PDF forms\n---\nRun scripts/fill.py.\n", "scripts/fill.py": "print('fill')\n" }, 2_000_000_000);
  await skill(mini, "pdf", { "SKILL.md": "---\ndescription: An older copy\n---\nold\n" }, 1_900_000_000);
  await skill(mini, "deploy", { "SKILL.md": "---\ndescription: Ship a release\n---\nRun make release, then Release notes.\n" }, 1_900_000_000);
  const client = await skillsClient(t, { studio, mini, laptop: mini }, ["laptop"]);

  const listed = succeeded(await client.callTool({ name: "list_skills", arguments: {} }));
  assert.deepEqual(listed.skills.map(({ name, peer, alsoOn, description }: Record<string, unknown>) => ({ name, peer, alsoOn, description })), [
    { name: "deploy", peer: "mini", alsoOn: [], description: "Ship a release" },
    { name: "pdf", peer: "studio", alsoOn: ["mini"], description: "Fill PDF forms" },
  ]);
  assert.deepEqual(listed.unlisted, [{ peer: "laptop", reason: listed.unlisted[0].reason }]);
  assert.match(listed.unlisted[0].reason, /Permission denied: skills not granted to laptop\./);
  assert.deepEqual(succeeded(await client.callTool({ name: "list_skills", arguments: { peer: "mini" } })).skills.map((entry: { name: string }) => entry.name), ["deploy", "pdf"]);
  const refused = await client.callTool({ name: "list_skills", arguments: { peer: "laptop" } });
  assert.equal(refused.isError, true);

  // The newest copy unless a peer is named, its SKILL.md unless a file is.
  const main = await client.callTool({ name: "read_skill", arguments: { name: "pdf" } });
  assert.deepEqual([structured(main).peer, structured(main).file, structured(main).totalLines], ["studio", "SKILL.md", 4]);
  assert.deepEqual(structured(main).files, [{ path: "SKILL.md", size: 57 }, { path: "scripts/fill.py", size: 14 }]);
  assert.match(text(main), /^\[pdf\/SKILL\.md on studio: lines 1-4 of 4 .*\]\n---\ndescription: Fill PDF forms\n---\nRun scripts\/fill\.py\.\n\[Other files of pdf: scripts\/fill\.py\. Read one with read_skill and file\.\]$/);
  assert.equal(succeeded(await client.callTool({ name: "read_skill", arguments: { name: "pdf", file: "scripts/fill.py" } })).content, "print('fill')");
  assert.equal(succeeded(await client.callTool({ name: "read_skill", arguments: { name: "pdf", peer: "mini", offset: 4 } })).content, "old");
  const absent = await client.callTool({ name: "read_skill", arguments: { name: "nope" } });
  assert.equal(absent.isError, true);
  assert.match(text(absent), /No skill nope on the peers that answered\. Skills there: pdf, deploy\. Not listed: laptop \(Permission denied/);
  const outside = await client.callTool({ name: "read_skill", arguments: { name: "pdf", file: "../deploy/SKILL.md" } });
  assert.equal(outside.isError, true);

  const found = succeeded(await client.callTool({ name: "search_skills", arguments: { pattern: "release", ignoreCase: true } }));
  assert.deepEqual(found.matches, [{ peer: "mini", skill: "deploy", file: "SKILL.md", line: 2, text: "description: Ship a release" }, { peer: "mini", skill: "deploy", file: "SKILL.md", line: 4, text: "Run make release, then Release notes." }]);
  assert.equal(found.truncated, false);
  const capped = await client.callTool({ name: "search_skills", arguments: { pattern: "e", limit: 1 } });
  assert.deepEqual([structured(capped).matches.length, structured(capped).truncated], [1, true]);
  assert.match(text(capped), /^\[1 matching line in 2 skills, more not shown\]\nmini:deploy\/SKILL\.md:1: ---|^\[1 matching line in 2 skills, more not shown\]\ndeploy\/SKILL\.md:2: /);
  // Only the newest copy of each skill is searched, and only the skills named.
  assert.deepEqual(succeeded(await client.callTool({ name: "search_skills", arguments: { pattern: "old|fill", skills: ["pdf"] } })).matches.map((match: { file: string }) => match.file), ["SKILL.md", "scripts/fill.py"]);
  const bad = await client.callTool({ name: "search_skills", arguments: { pattern: "(" } });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /is not a regular expression/);
});

/** An in-process client whose one peer is this machine's shell with `grants`, holding the secrets `held`; `version` is what it reports. */
async function secretsClient(t: TestContext, grants: Permission[], held: Record<string, string>, version?: string, shell?: ShellApi, env?: string[]) {
  const here: SecretsHere = {
    list: () => Object.keys(held).map((name) => ({ mesh: "home", name, readBy: name === "MINE" ? "this device" : "all members", setBy: name === "MINE" ? ["this device"] : ["laptop"] })),
    variables(names) {
      const missing = names.find((name) => !(name.replace(/^home:/, "") in held));
      if (missing) throw new Error(`This device holds no mesh secret ${missing}.`);
      return Object.fromEntries(names.map((name) => [name.replace(/^home:/, ""), held[name.replace(/^home:/, "")]!]));
    },
  };
  // Over Cap'n Web, as a peer is reached.
  const channel = new MessageChannel();
  newMessagePortRpcSession(channel.port1, shell ?? new GrantedShell(new ShellApi(), grants, "laptop", null, undefined, undefined, undefined, here));
  const peer = newMessagePortRpcSession<GrantedShell>(channel.port2);
  t.after(() => { peer[Symbol.dispose](); channel.port1.close(); channel.port2.close(); });
  const info: ShellInfo = { ...new ShellApi().info(), ...version ? { version } : {} };
  const target: McpTarget = {
    label: "studio",
    async open() {
      return {
        controller: {
          peers: async () => [{ id: "p1", info, peer: { name: "studio", fingerprint: "f", daemon: true, via: "direct" as const } }],
          run: async (_id: string, command: string, options: object) => await plain(peer.run(command, options)),
          async startPtySession(_id: string, name: string, options: object) {
            using session = await peer.startPtySession(name, options);
            return await plain(session.info());
          },
          ptySessions: async () => await plain(peer.ptySessions()),
          ptySession: async (_id: string, name: string) => await peer.ptySession(name),
          // As through a daemon: a fork of the peer's shell.
          async secrets() {
            using fork = await peer.fork();
            return await plain(fork.secretNames());
          },
        } as unknown as ToolController,
        peer: async () => "p1",
        lost: false,
        close() {},
      };
    },
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(target, { env });
  await server.connect(serverSide);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(clientSide);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test("commands and sessions get the secrets their peer holds as variables, which only shell lists, by name", { skip: !posix, timeout: 30000 }, async (t) => {
  const client = await secretsClient(t, ["shell", "sessions:create", "sessions:list", "sessions:view", "sessions:kill"], { API_KEY: "sk-home", MINE: "m" });
  const listed = succeeded(await client.callTool({ name: "list_secrets", arguments: {} }));
  assert.deepEqual(listed, { peer: "studio", secrets: [
    { mesh: "home", name: "API_KEY", readBy: "all members", setBy: ["laptop"] }, { mesh: "home", name: "MINE", readBy: "studio only", setBy: ["studio"] },
  ] });
  const show = `printf '%s|%s' "\${API_KEY-unset}" "\${MINE-unset}"`;
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["home:API_KEY"] } })).stdout, "sk-home|unset");
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: show } })).stdout, "unset|unset");
  const missing = await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["NOPE"] } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /This device holds no mesh secret NOPE\./);
  const invalid = await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["not a name"] } });
  assert.equal(invalid.isError, true);

  const started = succeeded(await client.callTool({ name: "start_session", arguments: { name: "keys", command: `${show}; sleep 30`, secrets: ["API_KEY", "MINE"], until: "sk-home" } }));
  assert.equal(started.matched, true);
  assert.match(started.screen.text, /sk-home\|m/);
  assert.doesNotMatch(JSON.stringify(succeeded(await client.callTool({ name: "list_sessions", arguments: {} }))), /sk-home/);
  succeeded(await client.callTool({ name: "kill_session", arguments: { name: "keys" } }));

  // Without the shell grant there is nothing to list, and a command could not use them.
  const sessionsOnly = await secretsClient(t, ["sessions:create"], { API_KEY: "sk-home" });
  const denied = await sessionsOnly.callTool({ name: "list_secrets", arguments: {} });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /Permission denied: shell not granted to laptop/);
});

test("secrets on a peer from before secrets for agents say which cns to update, and nothing starts", { skip: !posix, timeout: 30000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = path.join(directory, "ran");
  // A cns from before: its shell knows no secrets option and no secretNames call.
  const client = await secretsClient(t, [], {}, "2.2.0", new ShellApi());
  for (const [name, args] of [
    ["run_command", { command: `touch '${marker}'`, secrets: ["API_KEY"] }],
    ["start_session", { name: "old", command: `touch '${marker}'`, secrets: ["API_KEY"] }],
    ["list_secrets", {}],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    assert.match(text(result), /studio runs cns 2\.2\.0, from before secrets for agents, so nothing was done there\. Update cns on studio to 2\.3\.0 or later\./, name);
  }
  assert.equal(existsSync(marker), false);
});

test("an agent's commands on a mesh member get the secrets that member holds, without the values passing through cns mcp", { skip: !posix, timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-mcp-secrets-");
  const hub = await devices.device("hub");
  const laptop = await devices.device("laptop");
  for (const device of [hub, laptop]) await devices.up(device);
  await devices.pair(hub, laptop);
  const ok = async (device: typeof hub, args: string[], input = "") => {
    const result = await devices.cli(device, [...args, "--state", device.state], input);
    assert.equal(result.code, 0, result.output);
  };
  await ok(hub, ["mesh", "create", "home"]);
  await ok(hub, ["mesh", "add", "home", "laptop"]);
  await ok(laptop, ["mesh", "join", "home", "--via", "hub"]);
  await ok(laptop, ["secret", "set", "API_KEY"], "sk-home\n");
  await eventually(async () => (await devices.cli(hub, ["secret", "get", "API_KEY"])).stdout === "sk-home", "hub to read laptop's secret", 20000);

  const { client } = await stdioClient(t, ["hub"], "auto", laptop.env);
  assert.deepEqual(succeeded(await client.callTool({ name: "list_secrets", arguments: {} })).secrets, [{ mesh: "home", name: "API_KEY", readBy: "all members", setBy: ["laptop"] }]);
  const show = `printf '%s' "\${API_KEY-unset}"`;
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["API_KEY"] } })).stdout, "sk-home");
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["home:API_KEY"] } })).stdout, "sk-home");
  const missing = await client.callTool({ name: "run_command", arguments: { command: show, secrets: ["NOPE"] } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /This device holds no mesh secret NOPE\. It holds home:API_KEY\./);
});

test("cns mcp --env lets calls set the variables it names from its own environment, and offers no others", { skip: !posix, timeout: 30000 }, async (t) => {
  process.env.CNS_TEST_FORWARDED = "gh-token";
  delete process.env.CNS_TEST_UNSET;
  t.after(() => { delete process.env.CNS_TEST_FORWARDED; });
  const client = await secretsClient(t, ["shell", "sessions:create", "sessions:view"], { API_KEY: "sk-home" }, undefined, undefined, ["CNS_TEST_FORWARDED", "CNS_TEST_UNSET"]);
  const { tools } = await client.listTools();
  const schema = tools.find((tool) => tool.name === "run_command")!.inputSchema as { properties: Record<string, { items?: { enum?: string[] } }> };
  assert.deepEqual(schema.properties.env!.items!.enum, ["CNS_TEST_FORWARDED", "CNS_TEST_UNSET"]);
  const show = `printf '%s|%s' "\${CNS_TEST_FORWARDED-unset}" "\${API_KEY-unset}"`;
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: show, env: ["CNS_TEST_FORWARDED"], secrets: ["API_KEY"] } })).stdout, "gh-token|sk-home");
  const started = succeeded(await client.callTool({ name: "start_session", arguments: { name: "env", command: `${show}; sleep 30`, env: ["CNS_TEST_FORWARDED"], until: "gh-token" } }));
  assert.equal(started.matched, true);
  const unset = await client.callTool({ name: "run_command", arguments: { command: show, env: ["CNS_TEST_UNSET"] } });
  assert.equal(unset.isError, true);
  assert.match(text(unset), /CNS_TEST_UNSET is not set where cns mcp runs\./);
  const unlisted = await client.callTool({ name: "run_command", arguments: { command: show, env: ["PATH"] } });
  assert.equal(unlisted.isError, true);

  const plainServer = await secretsClient(t, ["shell"], {});
  const run = (await plainServer.listTools()).tools.find((tool) => tool.name === "run_command")!.inputSchema as { properties: Record<string, unknown> };
  assert.equal(run.properties.env, undefined);
  const refused = await plainServer.callTool({ name: "run_command", arguments: { command: show, env: ["CNS_TEST_FORWARDED"] } });
  assert.equal(refused.isError, true);
});
