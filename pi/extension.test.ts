import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, createBashToolDefinition, DefaultResourceLoader, detectSupportedImageMimeTypeFromFile, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { connectControl } from "../src/commands/daemon.js";
import { cliInvocation, daemonHome, launchCli, unusedPort } from "../src/test-support.js";
import { plain } from "../src/terminal.js";
import { detectImageMimeType } from "./image.js";
import { createCnsExtension } from "./index.js";
import { parseTarget } from "./target.js";
import { findPattern } from "./tools.js";

const posix = process.platform !== "win32";
// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function temporaryDirectory(t: TestContext, prefix = "cns-pi-"): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

interface ToolResult { text: string; isError: boolean; content: { type: string; text?: string; mimeType?: string }[] }

/** A Pi session with only the cns extension, driven by a scripted model. */
async function startPi(t: TestContext, options: {
  cwd: string; statePath: string; env?: NodeJS.ProcessEnv; flags?: Record<string, string | boolean>;
  /** Active tools; by default Pi's defaults and the ones the tests use. */
  tools?: string[] | null;
  /** To continue a session; by default a new one. */
  sessionManager?: SessionManager;
  /** Other extensions, loaded before cns and after it. */
  before?: ExtensionFactory[];
  after?: ExtensionFactory[];
}) {
  const faux = registerFauxProvider({});
  t.after(() => faux.unregister());
  const model = faux.getModel();
  const agentDir = await temporaryDirectory(t, "cns-pi-agent-");
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json") });
  modelRuntime.registerProvider(model.provider, {
    baseUrl: model.baseUrl, apiKey: "faux", api: faux.api,
    models: faux.models.map((entry) => ({
      id: entry.id, name: entry.name, api: entry.api, reasoning: entry.reasoning, input: entry.input,
      cost: entry.cost, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens, baseUrl: entry.baseUrl,
    })),
  });
  const env = { ...process.env, CNS_LISTEN: undefined, CNS_BIND: undefined, CNS_PORT: undefined, CNS_BIN: undefined, ...options.env };
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir,
    extensionFactories: [
      ...(options.before ?? []), createCnsExtension({ statePath: options.statePath, env, invocation: cliInvocation }), ...(options.after ?? []),
    ],
  });
  await resourceLoader.reload();
  for (const [name, value] of Object.entries(options.flags ?? {})) resourceLoader.getExtensions().runtime.flagValues.set(name, value);
  const { session } = await createAgentSession({
    cwd: options.cwd, agentDir, model, modelRuntime, resourceLoader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd), settingsManager: SettingsManager.inMemory({}),
    ...(options.tools === null ? {} : { tools: options.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls", "cns"] }),
  });
  t.after(() => session.dispose());
  const notes: string[] = [];
  const statuses = new Map<string, string | undefined>();
  // Pi copies the context, so every method is spelled out.
  const nothing = () => undefined;
  const uiContext = {
    notify: (message: string) => { notes.push(message); },
    setStatus: (name: string, text: string | undefined) => { statuses.set(name, text); },
    theme: { fg: (_color: string, text: string) => text },
    select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    custom: async () => undefined, onTerminalInput: () => nothing, setWorkingMessage: nothing, setWorkingVisible: nothing,
    setWorkingIndicator: nothing, setHiddenThinkingLabel: nothing, setWidget: nothing, setFooter: nothing, setHeader: nothing,
    setTitle: nothing, pasteToEditor: nothing, setEditorText: nothing, getEditorText: () => "", addAutocompleteProvider: nothing,
    setEditorComponent: nothing, getEditorComponent: nothing, getAllThemes: () => [], getTheme: nothing,
    setTheme: () => ({ success: false, error: "No themes in tests" }), getToolsExpanded: () => false, setToolsExpanded: nothing,
  } as unknown as ExtensionUIContext;
  await session.bindExtensions({ uiContext });
  return {
    session, notes, statuses,
    /** Let the model start calling one tool; the turn ends when the returned promise does. */
    begin(name: string, args: Record<string, unknown>): Promise<void> {
      faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
      return session.prompt(`call ${name}`);
    },
    /** Let the model call one tool, and return its result. */
    async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
      await this.begin(name, args);
      return lastResult(session, name);
    },
    /** Run a slash command and return what it reported. */
    async command(text: string): Promise<string> {
      const before = notes.length;
      await session.prompt(text);
      return notes.slice(before).join("\n");
    },
    /** What Pi's ! does: let an extension take the command, then run it. */
    async bang(command: string) {
      const handled = await session.extensionRunner.emitUserBash({ type: "user_bash", command, excludeFromContext: false, cwd: options.cwd });
      if (handled?.result) return handled.result;
      return await session.executeBash(command, undefined, { operations: handled?.operations });
    },
  };
}

function lastResult(session: AgentSession, name: string): ToolResult {
  const result = session.messages.filter((message) => message.role === "toolResult" && message.toolName === name).at(-1);
  if (!result || result.role !== "toolResult") throw new Error(`No ${name} result`);
  const content = result.content as ToolResult["content"];
  return { text: content.filter((part) => part.type === "text").map((part) => part.text).join("\n"), isError: result.isError, content };
}

/** A cns listener whose home, the directory its tools start in, is `home`. */
async function listener(t: TestContext, home: string, env: NodeJS.ProcessEnv = {}) {
  const port = await unusedPort("127.0.0.1");
  // Without this test's Pi session, which runs it, so nothing of it reaches the host.
  const peer = launchCli(t, ["listen", "--no-repl", "--bind", "127.0.0.1", "--port", port], { env: { HOME: home, PI_SESSION_ID: undefined, ...env } });
  await peer.waitFor("listening at");
  return { peer, address: `127.0.0.1:${port}` };
}

test("hosts are named as peers, listeners or URLs", () => {
  const env = { CNS_PORT: "5000" };
  assert.deepEqual(parseTarget("local"), { kind: "local" });
  assert.deepEqual(parseTarget("p12"), { kind: "peer", id: "p12" });
  assert.deepEqual(parseTarget("box", env), { kind: "url", url: "ws://box:5000/" });
  assert.deepEqual(parseTarget("10.0.0.2:47390"), { kind: "url", url: "ws://10.0.0.2:47390/" });
  assert.deepEqual(parseTarget("::1", {}), { kind: "url", url: "ws://[::1]:47381/" });
  assert.deepEqual(parseTarget("[fe80::1]:9"), { kind: "url", url: "ws://[fe80::1]:9/" });
  assert.deepEqual(parseTarget("wss://relay.example/cns"), { kind: "url", url: "wss://relay.example/cns" });
  assert.throws(() => parseTarget(""), /Name a host/);
  assert.throws(() => parseTarget("user@box"), /Not a host/);
  assert.throws(() => parseTarget("ws://user:secret@box"), /without credentials/);
  // Peer IDs start at p1; p0 can only be a host name.
  assert.deepEqual(parseTarget("p0", {}), { kind: "url", url: "ws://p0:47381/" });
});

test("find patterns match as fd matches them", () => {
  assert.equal(findPattern("*.ts", "/w"), "**/*.ts");
  assert.equal(findPattern("src/**/*.spec.ts", "/w"), "**/src/**/*.spec.ts");
  assert.equal(findPattern("**/*.json", "/w"), "**/*.json");
  assert.equal(findPattern("/w/src/*.ts", "/w"), "src/*.ts");
});

test("image detection agrees with Pi's", async (t) => {
  const directory = await temporaryDirectory(t);
  const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
  const animated = Buffer.concat([PNG.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(12)]);
  const samples = { png: PNG, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), jpegLs: Buffer.from([0xff, 0xd8, 0xff, 0xf7]), gif, webp, animated, text: Buffer.from("hello") };
  for (const [name, bytes] of Object.entries(samples)) {
    const file = path.join(directory, name);
    await writeFile(file, bytes);
    assert.equal(detectImageMimeType(bytes), await detectSupportedImageMimeTypeFromFile(file), name);
  }
});

test("Pi's tools and ! run on an attached listener, and fail closed when it goes away", { skip: !posix, timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  // The listener's runtime may keep files in its home, so the tools work in a directory of their own.
  const work = path.join(home, "work");
  await mkdir(work);
  const { peer, address } = await listener(t, home);
  const pi = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json") });

  assert.equal((await pi.call("bash", { command: "pwd" })).text.trim(), local);
  const attached = await pi.call("cns", { action: "attach", host: address, cwd: "work" });
  assert.equal(attached.isError, false, attached.text);
  assert.match(attached.text, new RegExp(`Attached to ${address.replace(/\./g, "\\.")}: .* in ${work}`));
  assert.match(pi.statuses.get("cns") ?? "", new RegExp(`^cns: tools on ${address.replace(/\./g, "\\.")} [^ ]+:~/work$`));

  // Commands and paths are the host's: its directory, its home for ~, nothing forwarded from here.
  const bash = await pi.call("bash", { command: "pwd; printf '%s\\n' \"$HOME\" \"${PI_SESSION_ID:-none}\"" });
  assert.deepEqual(bash.text.trim().split("\n"), [work, home, "none"]);
  assert.equal((await pi.call("write", { path: "notes/a.txt", content: "hello\nworld\n" })).isError, false);
  assert.equal(await readFile(path.join(work, "notes", "a.txt"), "utf8"), "hello\nworld\n");
  await assert.rejects(stat(path.join(local, "notes")), { code: "ENOENT" });
  assert.match((await pi.call("read", { path: "~/work/notes/a.txt" })).text, /hello\nworld/);
  const edited = await pi.call("edit", { path: "notes/a.txt", edits: [{ oldText: "world", newText: "there" }] });
  assert.equal(edited.isError, false, edited.text);
  assert.equal(await readFile(path.join(work, "notes", "a.txt"), "utf8"), "hello\nthere\n");
  await writeFile(path.join(work, "pixel.png"), PNG);
  const image = await pi.call("read", { path: "pixel.png" });
  assert.ok(image.content.some((part) => part.type === "image" && part.mimeType === "image/png"), JSON.stringify(image.content));
  assert.deepEqual((await pi.call("ls", {})).text.split("\n"), ["notes/", "pixel.png"]);
  assert.equal((await pi.call("find", { pattern: "*.txt" })).text, "notes/a.txt");
  assert.equal((await pi.call("grep", { pattern: "there" })).text, "notes/a.txt:2: there");
  const bang = await pi.bang("pwd");
  assert.equal(bang.output.trim(), work);

  // Once the host is gone, nothing runs anywhere until the user decides.
  peer.child.kill("SIGTERM");
  await peer.exited;
  const lost = await pi.call("bash", { command: "touch MUST_NOT_EXIST" });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /was lost.*Nothing runs on this machine instead/);
  const refused = await pi.bang("touch MUST_NOT_EXIST");
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /^cns: .*was lost/);
  await assert.rejects(stat(path.join(local, "MUST_NOT_EXIST")), { code: "ENOENT" });
  assert.match(pi.statuses.get("cns") ?? "", /lost/);

  assert.equal((await pi.call("cns", { action: "detach" })).isError, false);
  assert.equal((await pi.call("bash", { command: "pwd" })).text.trim(), local);
  assert.equal(pi.statuses.get("cns"), undefined);
});

// Pi's own grep and find, the reference, need ripgrep and fd here; Pi would download them otherwise.
test("remote tools give the same results as Pi's own", { skip: !posix || !Bun.which("rg") || !Bun.which("fd"), timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  for (const root of [local, path.join(home, "work")]) {
    await mkdir(path.join(root, "src", "deep"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
    const lines = Array.from({ length: 30 }, (_, index) => index % 7 === 0 ? `Needle ${index} ${"long ".repeat(index === 14 ? 120 : 1)}` : `line ${index}`);
    await writeFile(path.join(root, "src", "big.txt"), `${lines.join("\n")}\n`);
    await writeFile(path.join(root, "src", "deep", "a.spec.ts"), "export const needle = 1;\n");
    await writeFile(path.join(root, ".hidden.ts"), "hidden\n");
    await writeFile(path.join(root, "node_modules", "dep", "index.ts"), "needle\n");
    // Pi's local find honours .gitignore; with custom operations, as through cns, it skips node_modules and .git.
    await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
  }
  const { address } = await listener(t, home);
  const pi = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json") });
  const calls: [string, Record<string, unknown>][] = [
    ["grep", { pattern: "needle", ignoreCase: true, path: "src/big.txt" }],
    ["grep", { pattern: "needle", ignoreCase: true, path: "src/big.txt", context: 2 }],
    ["grep", { pattern: "needle", ignoreCase: true, path: "src/big.txt", limit: 2, context: 1 }],
    ["grep", { pattern: "Needle 2", literal: true, path: "src" }],
    ["grep", { pattern: "needle", glob: "*.ts", path: "src" }],
    ["grep", { pattern: "absent" }],
    ["find", { pattern: "*.ts" }],
    ["find", { pattern: "src/**/*.spec.ts" }],
    ["find", { pattern: "deep" }],
    ["ls", { path: "src" }],
    ["read", { path: "src/big.txt", offset: 5, limit: 3 }],
  ];
  const sorted = (name: string, text: string) => name === "find" ? text.split("\n").sort().join("\n") : text;
  const expected: string[] = [];
  for (const [name, args] of calls) expected.push(sorted(name, (await pi.call(name, args)).text));
  assert.equal((await pi.call("cns", { action: "attach", host: address, cwd: "work" })).isError, false);
  for (const [index, [name, args]] of calls.entries()) {
    assert.equal(sorted(name, (await pi.call(name, args)).text), expected[index], `${name} ${JSON.stringify(args)}`);
  }
  assert.ok(!expected[6]!.includes("node_modules"));

  // A host without ripgrep says so instead of searching some other way.
  const bin = await temporaryDirectory(t, "cns-pi-bin-");
  await symlink(Bun.which("bash")!, path.join(bin, "bash"));
  const bare = await listener(t, home, { PATH: bin });
  assert.equal((await pi.call("cns", { action: "attach", host: bare.address })).isError, false);
  const missing = await pi.call("grep", { pattern: "needle" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /ripgrep \(rg\) is not installed on 127\.0\.0\.1:\d+/);
});

test("Pi sessions share one daemon and attach to its peers", { skip: !posix, timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const peerHome = await temporaryDirectory(t, "cns-pi-peer-");
  const { statePath } = await daemonHome(t, "cns-pi-state-");
  const port = await unusedPort("127.0.0.1");
  const env = { CNS_BIND: "127.0.0.1", CNS_PORT: port };
  const first = await startPi(t, { cwd: local, statePath, env });
  const second = await startPi(t, { cwd: local, statePath, env });

  assert.match(await first.command("/cns attach p1"), /none runs/);
  const reports = await Promise.all([first.command("/cns listen"), second.command("/cns listen")]);
  assert.equal(reports.filter((report) => report.startsWith("Started the cns daemon")).length, 1, reports.join("\n---\n"));
  assert.ok(reports.every((report) => report.includes(`listening on 127.0.0.1:${port}`)), reports.join("\n"));
  assert.ok(reports.every((report) => !report.includes("WARNING")), "a loopback listener is not exposed");
  const control = await connectControl(statePath);
  t.after(() => control.close());

  const peer = launchCli(t, ["connect", `ws://127.0.0.1:${port}`, "--no-repl"], { env: { HOME: peerHome } });
  const deadline = Date.now() + 10000;
  while ((await control.controller.peers()).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(await first.command("/cns status"), /Peers: p1 /);

  assert.match(await first.command("/cns attach p1 /"), /Attached to p1: .* in \/\./);
  assert.equal((await first.call("bash", { command: "pwd" })).text.trim(), "/");
  assert.match(await first.command("/cns attach p1"), /Attached to p1/);
  assert.equal((await first.call("bash", { command: "printf %s \"$HOME\"" })).text, peerHome);
  assert.match(await first.command("/cns run p1 printf %s \"$HOME\""), /^$/);
  const run = first.session.messages.filter((message) => message.role === "custom").at(-1);
  assert.match(JSON.stringify(run), new RegExp(`Output of .* on p1: .*\`\`\`\\\\n${peerHome.replace(/[/.]/g, "\\$&")}\\\\n\`\`\``));
  // The other session still runs its tools here.
  assert.equal((await second.call("bash", { command: "pwd" })).text.trim(), local);

  peer.child.kill("SIGTERM");
  await peer.exited;
  const lost = await first.call("bash", { command: "pwd" });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /was lost/);

  // Ending a session leaves the shared daemon running.
  first.session.dispose();
  assert.ok((await plain(control.remote.status())).pid > 0);
});

test("CNS_LISTEN starts or finds the daemon when Pi starts, and other values are refused", { skip: !posix, timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const { statePath } = await daemonHome(t, "cns-pi-state-");
  const port = await unusedPort("127.0.0.1");
  const env = { CNS_BIND: "127.0.0.1", CNS_PORT: port };
  const first = await startPi(t, { cwd: local, statePath, env: { ...env, CNS_LISTEN: "1" } });
  assert.ok(first.notes.some((note) => note.startsWith("Started the cns daemon")), first.notes.join("\n"));
  assert.equal(first.statuses.get("cns"), `cns: listening 127.0.0.1:${port} (0 peers)`);
  const second = await startPi(t, { cwd: local, statePath, env: { ...env, CNS_LISTEN: "Yes" } });
  assert.ok(second.notes.some((note) => note.startsWith("Using the cns daemon already running")), second.notes.join("\n"));

  for (const value of ["0", "off", ""]) {
    const quiet = await startPi(t, { cwd: local, statePath, env: { ...env, CNS_LISTEN: value } });
    assert.deepEqual(quiet.notes, []);
    assert.equal(quiet.statuses.get("cns"), undefined);
  }
  const wrong = await startPi(t, { cwd: local, statePath, env: { ...env, CNS_LISTEN: "127.0.0.1" } });
  assert.match(wrong.notes.join("\n"), /cannot listen: CNS_LISTEN must be 1 to listen when Pi starts, or 0 not to/);
  assert.equal(wrong.statuses.get("cns"), undefined);

  // Without cns on PATH, Pi stops the daemon it shares with the other sessions.
  const peerHome = await temporaryDirectory(t, "cns-pi-peer-");
  const peer = launchCli(t, ["connect", `ws://127.0.0.1:${port}`, "--no-repl"], { env: { HOME: peerHome } });
  await peer.waitFor("Connected to");
  assert.match(await first.command("/cns attach p1"), /Attached to p1/);
  assert.match(await first.command("/cns stop"), /^The connection to p1 .* was lost: the local daemon stopped\..*\nStopped the cns daemon \(pid \d+\)\.$/);
  const lost = await first.call("bash", { command: "touch MUST_NOT_EXIST" });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /was lost/);
  await assert.rejects(stat(path.join(local, "MUST_NOT_EXIST")), { code: "ENOENT" });
  assert.match(first.statuses.get("cns") ?? "", /^cns: p1 lost: \/cns attach or \/cns detach$/);
  await assert.rejects(stat(statePath), { code: "ENOENT" });
  const deadline = Date.now() + 5000;
  while (!second.notes.includes("The cns daemon stopped.") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(second.notes.includes("The cns daemon stopped."), "the other session hears of it");
  assert.equal(await first.command("/cns stop"), "No cns daemon is running.");
});

test("a failed --cns-attach blocks the tools instead of running them here", { skip: !posix, timeout: 30000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const port = await unusedPort("127.0.0.1");
  const pi = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json"), flags: { "cns-attach": `127.0.0.1:${port}` } });
  assert.ok(pi.notes.some((note) => note.includes("attaching failed")), pi.notes.join("\n"));
  const blocked = await pi.call("bash", { command: "touch MUST_NOT_EXIST" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /Nothing runs on this machine instead/);
  await assert.rejects(stat(path.join(local, "MUST_NOT_EXIST")), { code: "ENOENT" });
  await pi.command("/cns detach");
  assert.equal((await pi.call("bash", { command: "pwd" })).text.trim(), local);
});

test("the tools take the built-ins' place and keep Pi's active set", { skip: !posix, timeout: 30000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  const { address } = await listener(t, home);
  const pi = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json"), tools: null });
  assert.deepEqual(pi.session.getActiveToolNames().sort(), ["bash", "cns", "edit", "read", "write"]);
  assert.equal((await pi.call("cns", { action: "attach", host: address })).isError, false);
  assert.equal((await pi.call("bash", { command: "pwd" })).text.trim(), home);
});

async function waitUntil(check: () => Promise<boolean> | boolean, what: string, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("aborting or timing out a command stops it on the host", { skip: !posix, timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  const work = path.join(home, "work");
  await mkdir(work);
  const { address } = await listener(t, home);
  const pi = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json") });
  assert.equal((await pi.call("cns", { action: "attach", host: address, cwd: "work" })).isError, false);

  const timedOut = await pi.call("bash", { command: "echo $$ > timed.pid; echo started; sleep 30", timeout: 1 });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.text, /started[\s\S]*Command timed out after 1 seconds/);
  const timedPid = Number(await readFile(path.join(work, "timed.pid"), "utf8"));
  await waitUntil(() => !running(timedPid), "the timed-out command to end");

  const turn = pi.begin("bash", { command: "echo $$ > aborted.pid; exec sleep 30" });
  const pidFile = path.join(work, "aborted.pid");
  await waitUntil(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim() !== "", "the command to start");
  const pid = Number(await readFile(pidFile, "utf8"));
  const aborting = Date.now();
  await pi.session.abort();
  await turn;
  assert.ok(Date.now() - aborting < 3000, "the abort settles without waiting for the command");
  const aborted = lastResult(pi.session, "bash");
  assert.equal(aborted.isError, true);
  assert.match(aborted.text, /Command aborted/);
  await waitUntil(() => !running(pid), "the aborted command to end");

  // Commands too long to send are uploaded to a directory only the host's user can read.
  const long = await pi.call("bash", { command: `printf '%s' ${"x".repeat(9000)} | wc -c` });
  assert.equal(long.text.trim(), "9000");
  const scripts = path.join(home, ".cns", "scripts");
  assert.equal((await stat(scripts)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(scripts), []);
});

test("a continued session goes back to its host, or runs nothing until the user chooses", { skip: !posix, timeout: 60000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  const work = path.join(home, "work");
  await mkdir(work);
  const { peer, address } = await listener(t, home);
  const statePath = path.join(local, "daemon.json");
  const sessionManager = SessionManager.inMemory(local);
  const first = await startPi(t, { cwd: local, statePath, sessionManager });
  assert.equal((await first.call("cns", { action: "attach", host: address, cwd: "work" })).isError, false);
  first.session.dispose();

  const second = await startPi(t, { cwd: local, statePath, sessionManager });
  assert.ok(second.notes.some((note) => note.includes("attached again")), second.notes.join("\n"));
  assert.equal((await second.call("bash", { command: "pwd" })).text.trim(), work);
  second.session.dispose();

  peer.child.kill("SIGTERM");
  await peer.exited;
  const third = await startPi(t, { cwd: local, statePath, sessionManager });
  const blocked = await third.call("bash", { command: "touch MUST_NOT_EXIST" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /attaching again failed.*Nothing runs on this machine instead/);
  await assert.rejects(stat(path.join(local, "MUST_NOT_EXIST")), { code: "ENOENT" });
  await third.command("/cns detach");
  assert.equal((await third.call("bash", { command: "pwd" })).text.trim(), local);

  // Detaching is remembered too.
  const fourth = await startPi(t, { cwd: local, statePath, sessionManager });
  assert.equal((await fourth.call("bash", { command: "pwd" })).text.trim(), local);
});

test("cns does not attach while another extension's tools take the same names", { skip: !posix, timeout: 30000 }, async (t) => {
  const local = await temporaryDirectory(t);
  const home = await temporaryDirectory(t, "cns-pi-home-");
  const { address } = await listener(t, home);
  const other: ExtensionFactory = (pi) => {
    pi.registerTool({ ...createBashToolDefinition(local), label: "other bash" });
  };
  // Pi uses the first extension's tool of each name.
  const shadowed = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json"), before: [other] });
  const refused = await shadowed.call("cns", { action: "attach", host: address });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Another extension provides bash \(inline\)/);
  const first = await startPi(t, { cwd: local, statePath: path.join(local, "daemon.json"), after: [other] });
  assert.equal((await first.call("cns", { action: "attach", host: address })).isError, false);
  assert.equal((await first.call("bash", { command: "pwd" })).text.trim(), home);
});
