import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { connectControl } from "../commands/daemon.js";
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "../test-support.js";
import { LegacySessions, MAX_SESSIONS } from "./legacy-sessions.js";
import { clip, createMcpServer, MAX_RESULT_CHARS } from "./server.js";
import type { McpTarget, ToolController } from "./target.js";

const posix = process.platform !== "win32";
const print = (marker: string) => posix ? `printf '${marker}'` : `[Console]::Write('${marker}')`;
const TOKEN = "t".repeat(40);

async function listener(t: TestContext, repl = false) {
  const port = await unusedPort();
  const peer = launchCli(t, ["listen", "--bind", "::1", "--port", port, ...repl ? [] : ["--no-repl"]]);
  await peer.waitFor("listening at");
  return { peer, url: `ws://[::1]:${port}` };
}

/** Start cns mcp over stdio as an MCP client would, speaking the protocol revision `mode` selects. */
async function stdioClient(t: TestContext, args: string[], mode: "auto" | "legacy" = "auto") {
  const invocation = cliInvocation(["mcp", ...args]);
  const transport = new StdioClientTransport({
    command: invocation.file, args: invocation.args, env: cliEnvironment() as Record<string, string>, stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "cns-tests", version: "1" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  t.after(async () => { await client.close(); });
  return { client, transport, get stderr() { return stderr; } };
}

/** Serve cns mcp --http for a listener and return its endpoint. */
async function httpServer(t: TestContext, args: string[], token = TOKEN) {
  const port = await unusedPort("127.0.0.1");
  const server = launchCli(t, ["mcp", ...args, "--http", port], { env: { CNS_MCP_TOKEN: token } });
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

test("stdio MCP server runs commands on a listener and reports failures as tool errors", { timeout: 30000 }, async (t) => {
  const { url } = await listener(t);
  const { client } = await stdioClient(t, [url]);
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.match(client.getInstructions() ?? "", /run_command/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(),
    ["kill_session", "list_peers", "list_sessions", "read_screen", "run_command", "send_keys", "start_session"]);
  const run = tools.find((tool) => tool.name === "run_command")!;
  assert.equal(run.annotations?.destructiveHint, true);
  assert.equal(run.annotations?.readOnlyHint, false);
  assert.equal(run.inputSchema.additionalProperties, false);
  assert.equal(tools.find((tool) => tool.name === "read_screen")!.annotations?.readOnlyHint, true);

  const peers = succeeded(await client.callTool({ name: "list_peers", arguments: {} }));
  assert.equal(peers.peers.length, 1);
  assert.equal(peers.peers[0].id, "p1");
  assert.equal(peers.peers[0].shell, posix ? "Bash" : "PowerShell");

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
  const { url } = await listener(t);
  const { client } = await stdioClient(t, [url]);
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

test("a 2025-era stdio client is served too", { timeout: 30000 }, async (t) => {
  const { url } = await listener(t);
  const { client } = await stdioClient(t, [url], "legacy");
  assert.notEqual(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: print("LEGACY_OK") } })).stdout, "LEGACY_OK");
});

test("cancelling calls kills their commands and frees their screen waits", { skip: !posix, timeout: 30000 }, async (t) => {
  const { url } = await listener(t);
  const { client } = await stdioClient(t, [url]);
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

test("the stdio server exits when its client closes stdin", { timeout: 30000 }, async (t) => {
  const { url } = await listener(t);
  const server = launchCli(t, ["mcp", url]);
  server.child.stdin.end();
  assert.equal(await server.exited, 0, server.output);
  assert.equal(server.stdout, "");
});

test("a listener cannot run commands on the MCP server's machine", { skip: !posix, timeout: 30000 }, async (t) => {
  const { peer, url } = await listener(t, true);
  const { client } = await stdioClient(t, [url]);
  const controller = new AbortController();
  const directory = await temporaryDirectory(t);
  const { call } = await startSleeper(client, directory, controller.signal);
  t.after(() => controller.abort());
  await peer.send(":peers", "p");
  const refused = await peer.send(":use p1\n" + print("REVERSE_SHELL"), "does not run commands");
  assert.doesNotMatch(refused, /REVERSE_SHELL/);
  controller.abort();
  await assert.rejects(call);
});

test("Streamable HTTP requires the token, refuses browsers and serves both protocol eras", { timeout: 60000 }, async (t) => {
  const { url } = await listener(t);
  const { server, endpoint, port } = await httpServer(t, [url]);
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

test("the daemon target chooses among connected peers and kills cancelled commands", { skip: !posix, timeout: 60000 }, async (t) => {
  // Not temporaryDirectory: the daemon must stop before its state is removed.
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-mcp-"));
  const statePath = path.join(directory, "daemon.json");
  const port = await unusedPort("127.0.0.1");
  let daemonPid: number | undefined;
  t.after(async () => {
    try {
      const connection = await connectControl(statePath);
      try { await connection.remote.stop(); } catch { /* It stops before answering. */ } finally { connection.close(); }
    } catch { /* Not running, or its state is unreadable. */ }
    if (daemonPid !== undefined) {
      await eventually(() => !alive(daemonPid!), "the daemon to stop", 3000).catch(() => process.kill(daemonPid!, "SIGKILL"));
    }
    await rm(directory, { force: true, recursive: true });
  });
  const daemon = launchCli(t, ["listen", "--daemon", "--state", statePath, "--bind", "127.0.0.1", "--port", port]);
  assert.equal(await daemon.exited, 0, daemon.output);
  daemonPid = JSON.parse(await readFile(statePath, "utf8")).pid;
  assert.ok(daemonPid && alive(daemonPid));
  const absent = await stdioClient(t, ["--daemon", "--state", path.join(directory, "absent.json")]);
  const notRunning = await absent.client.callTool({ name: "list_peers", arguments: {} });
  assert.equal(notRunning.isError, true);
  assert.match(text(notRunning), /No local daemon is running\. Start one with cns listen --daemon --state .*absent\.json/);

  const { client } = await stdioClient(t, ["--daemon", "--state", statePath]);
  const none = await client.callTool({ name: "run_command", arguments: { command: print("x") } });
  assert.equal(none.isError, true);
  assert.match(text(none), /No peers are connected/);

  const first = launchCli(t, ["connect", `ws://127.0.0.1:${port}`], { env: { CNS_TEST_PEER: "FIRST" } });
  await first.waitFor("Connected to");
  const only = succeeded(await client.callTool({ name: "run_command", arguments: { command: `printf "$CNS_TEST_PEER"` } }));
  assert.equal(only.stdout, "FIRST");
  assert.equal(only.peer, "p1");

  const second = launchCli(t, ["connect", `ws://127.0.0.1:${port}`], { env: { CNS_TEST_PEER: "SECOND" } });
  await second.waitFor("Connected to");
  await eventually(async () => succeeded(await client.callTool({ name: "list_peers", arguments: {} })).peers.length === 2, "both peers");
  const ambiguous = await client.callTool({ name: "run_command", arguments: { command: print("x") } });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /Several peers are connected \(p1, p2\); pass peer/);
  assert.equal(succeeded(await client.callTool({ name: "run_command", arguments: { command: `printf "$CNS_TEST_PEER"`, peer: "p2" } })).stdout, "SECOND");

  const controller = new AbortController();
  const pidFile = path.join(directory, "daemon.pid");
  const call = client.callTool({ name: "run_command", arguments: { command: `echo $$ > '${pidFile}'; sleep 30`, peer: "p1", timeoutMs: 0 } }, { signal: controller.signal });
  call.catch(() => {});
  await eventually(async () => existsSync(pidFile) && (await readFile(pidFile, "utf8")).trim() !== "", "the command to start");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  controller.abort();
  await assert.rejects(call);
  await eventually(() => !alive(pid), "the daemon to kill the cancelled command");

  // Commands from an attached console still outlive its connection.
  const keptFile = path.join(directory, "kept.pid");
  const console = await connectControl(statePath);
  const kept = console.controller.run("p1", `echo $$ > '${keptFile}'; sleep 30`, {});
  kept.catch(() => {});
  await eventually(async () => existsSync(keptFile) && (await readFile(keptFile, "utf8")).trim() !== "", "the console's command to start");
  const keptPid = Number((await readFile(keptFile, "utf8")).trim());
  t.after(() => { try { process.kill(-keptPid, "SIGKILL"); } catch { /* Already gone. */ } });
  console.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(alive(keptPid), "a detached console's command keeps running");
});
