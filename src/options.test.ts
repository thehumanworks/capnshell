import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { mock } from "bun:test";
import * as config from "./config.js";
import { generateIdentity } from "./identity.js";
import { isLoopback, parseMcpOptions, parseOptions as parsePeerOptions, splitRemote, type DaemonConfig, type PeerConfig } from "./options.js";
import { expandGrants, savePairedPeer } from "./peers.js";

const posix = process.platform !== "win32";
// These tests are about parsing, not about trusting the filesystem, and `nix build` runs
// them in a sandbox whose / is owned by an unmapped user, which checkAncestors rightly
// refuses. Keep the private-directory check on the test's own directory and leave the
// ancestor walk to the tests of config and peers, which run outside the sandbox.
// Bun's module mocks outlive the file, so the real module is put back once these tests end.
const real = { ...config };
const { checkPrivateDirectory, configDirectory } = real;
mock.module("./config.js", () => ({
  ...real,
  checkAncestors: () => {},
  checkConfigDirectory: () => { const directory = configDirectory(); checkPrivateDirectory(directory); return directory; },
}));
const studio = generateIdentity();
let dir: string;
const previous = process.env.CNS_CONFIG_DIR;
before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "cns-options-"));
  process.env.CNS_CONFIG_DIR = dir;
  if (posix) savePairedPeer("studio", { publicKey: studio.publicKey, addresses: ["ws://192.168.1.10:47381"], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: expandGrants(["all"]) } });
});
after(() => {
  mock.module("./config.js", () => real);
  if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

// Exercise Commander's real environment handling without inheriting user defaults
// or leaking an individual test's environment to other tests.
function withEnvironment<T>(env: NodeJS.ProcessEnv, parse: () => T): T {
  const names = ["CNS_BIND", "CNS_PORT", "CNS_CWD", "CNS_KEY", "CNS_KITTY_KEYS"];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    return parse();
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

const parseOptions = (argv: string[], env: NodeJS.ProcessEnv = {}) => withEnvironment(env, () => parsePeerOptions(argv)) as PeerConfig;
const parseDaemon = (argv: string[]) => withEnvironment({}, () => parsePeerOptions(["daemon", ...argv])) as DaemonConfig;
const parseMcp = (argv: string[], env: NodeJS.ProcessEnv = {}) => withEnvironment(env, () => parseMcpOptions(argv));
const expected = { name: "studio", publicKey: studio.publicKey, outgoing: expandGrants(["all"]), addresses: ["ws://192.168.1.10:47381"] };

test("every command names a paired device, which it must reach as that device", { skip: !posix }, () => {
  for (const args of [
    ["run", "studio", "--", "pwd"], ["shell", "studio"], ["sessions", "studio"], ["keys", "studio", "build", "Enter"],
    ["screen", "studio", "build"], ["kill", "studio", "build"], ["cp", "a", "studio:/b"],
  ]) assert.deepEqual(parseOptions(args).expect, expected, args.join(" "));
  for (const args of [
    ["run", "missing", "--", "pwd"], ["shell", "ws://localhost:47381"], ["shell"], ["run", "--", "pwd"],
    ["keys", "build", "Enter"], ["screen", "build"], ["kill", "build"], ["cp", "a", ":/b"], ["cp", "a", "missing:/b"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
  assert.throws(() => parseOptions(["run", "missing", "--", "pwd"]), /No paired device is saved as missing/);
  assert.throws(() => parseOptions(["run", "--", "pwd"]), /requires a paired device's name/);
  assert.throws(() => parseOptions(["shell", "--", "htop"]), /requires a paired device's name/);
});

test("the removed unauthenticated commands and options are gone", { skip: !posix }, () => {
  for (const argv of [
    ["listen"], ["connect", "ws://localhost:47381"], ["run", "studio", "--one-way", "--", "pwd"],
    ["run", "--peer", "studio", "--", "pwd"], ["run", "studio", "--bind", "::1", "--", "pwd"], ["run", "studio", "--port", "1", "--", "pwd"],
    ["shell", "studio", "--no-repl"],
  ]) assert.throws(() => parseOptions(argv), `Expected rejection: ${argv.join(" ")}`);
});

test("the internal daemon command takes its listener and state from cns up", () => {
  const config = parseDaemon(["--bind", "0.0.0.0", "--port", "47382", "--state", "/tmp/d.json"]);
  assert.deepEqual(config, { role: "daemon", bind: "0.0.0.0", port: 47382, url: "ws://0.0.0.0:47382", remote: true, service: false, state: "/tmp/d.json" });
  assert.equal(parseDaemon(["--bind", "::1", "--port", "47381", "--state", "/tmp/d.json", "--service"]).service, true);
  assert.equal(parseDaemon(["--bind", "::1", "--port", "47381", "--state", "/tmp/d.json"]).url, "ws://[::1]:47381");
  assert.equal(parseDaemon(["--bind", "::1", "--port", "47381", "--state", "/tmp/d.json"]).remote, false);
  for (const argv of [
    [], ["--bind", "::1", "--port", "47381"], ["--bind", "example.test", "--port", "1", "--state", "s"],
    ["--bind", "::1", "--port", "0", "--state", "s"], ["--bind", "::1", "--port", "65536", "--state", "s"],
    ["--bind", "::1", "--bind", "::1", "--port", "1", "--state", "s"], ["--bind", "::1", "--port", "1", "--state", "s", "--allow-remote"],
  ]) assert.throws(() => parseDaemon(argv), `Expected rejection: daemon ${argv.join(" ")}`);
});

test("mcp uses the daemon's linked devices, or one named paired device", { skip: !posix }, () => {
  assert.deepEqual(parseMcp([]), { state: undefined, cwd: undefined, http: undefined });
  assert.equal(parseMcp([], { CNS_CWD: "/srv" }).cwd, "/srv");
  assert.deepEqual(parseMcp(["--state", "/tmp/d.json"]), { state: "/tmp/d.json", cwd: undefined, http: undefined });
  assert.deepEqual(parseMcp(["studio"]).expect, { name: "studio", publicKey: studio.publicKey, addresses: expected.addresses });
});

test("mcp serves HTTP on loopback unless remote access is explicit", () => {
  assert.deepEqual(parseMcp(["--http", "47382"]).http, { bind: "127.0.0.1", port: 47382, remote: false });
  assert.deepEqual(parseMcp(["--http", "47382", "--http-bind", "::1"]).http, { bind: "::1", port: 47382, remote: false });
  assert.throws(() => parseMcp(["--http", "47382", "--http-bind", "0.0.0.0"]), /--allow-remote/);
  assert.deepEqual(parseMcp(["--http", "47382", "--http-bind", "0.0.0.0", "--allow-remote"]).http, { bind: "0.0.0.0", port: 47382, remote: true });
});

test("mcp rejects conflicting, removed or incomplete options", { skip: !posix }, () => {
  for (const argv of [
    ["studio", "--state", "/tmp/d.json"], ["--daemon"], ["--bind", "::1"], ["--port", "1"], ["ws://example.test"], ["missing"],
    ["--http-bind", "::1"], ["--allow-remote"], ["--http", "0"], ["--http", "http"],
    ["--http", "1", "--http", "2"], ["--http", "1", "--http-bind", "localhost"],
  ]) assert.throws(() => parseMcp(argv), `Expected rejection: ${argv.join(" ")}`);
});

test("loopback addresses are told from others", () => {
  assert.ok(isLoopback("127.0.0.2"));
  assert.ok(isLoopback("::1"));
  assert.ok(!isLoopback("127.0.0.1.example.test"));
  assert.ok(!isLoopback("192.168.1.50"));
});

test("rejects unknown commands", () => {
  for (const argv of [[], ["bogus"]]) assert.throws(() => parseOptions(argv), `Expected rejection: ${argv.join(" ")}`);
});

test("run preserves the single shell string, working directory and timeout", { skip: !posix }, () => {
  const command = "printf '%s\\n' \"a b\" && printf '$HOME'";
  const config = parseOptions(["run", "studio", "--cwd", "/tmp", "--timeout", "5000", "--", command]);
  assert.equal(config.role, "run");
  assert.equal(config.command, command);
  assert.equal(config.cwd, "/tmp");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(parseOptions(["run", "studio", "--timeout", "0", "--", "echo ok"]).timeoutMs, 0);
  assert.equal(parseOptions(["run", "studio", "--timeout", "2147483647", "--", "echo ok"]).timeoutMs, 2147483647);
  assert.equal(parseOptions(["run", "studio", "--", "echo ok"], { CNS_CWD: "C:\\My Project" }).cwd, "C:\\My Project");
  assert.equal(parseOptions(["run", "studio", "--cwd", "/tmp", "--", "echo ok"], { CNS_CWD: "/srv" }).cwd, "/tmp");
  assert.throws(() => parseOptions(["run", "studio", "--", "echo ok"], { CNS_CWD: "" }));
});

test("run takes everything after the first -- as the command, joining words with spaces as ssh does", { skip: !posix }, () => {
  assert.equal(parseOptions(["run", "studio", "--", "ls", "-la", "/tmp"]).command, "ls -la /tmp");
  assert.equal(parseOptions(["run", "studio", "--", "git", "status"]).command, "git status");
  // Options and a second -- after the first belong to the command.
  assert.equal(parseOptions(["run", "studio", "--", "grep", "--cwd", "--", "-n", "x"]).command, "grep --cwd -- -n x");
  assert.equal(parseOptions(["run", "studio", "--cwd", "/srv", "--", "make", "test"]).cwd, "/srv");
  assert.equal(parseOptions(["run", "studio", "--", "printf '%s' \"a b\""]).command, "printf '%s' \"a b\"");
});

test("run requires an explicit delimiter and a nonempty command", { skip: !posix }, () => {
  for (const args of [
    ["run"], ["run", "studio"], ["run", "studio", "--"], ["run", "studio", "echo ok"], ["run", "studio", "echo", "--", "ok"], ["run", "--", "studio"],
    ["run", "studio", "--", ""], ["run", "studio", "--", " "], ["run", "studio", "--", " ", " "], ["run", "studio", "--", "x".repeat(4096), "y".repeat(4096)],
    ["run", "studio", "--cwd", "/tmp", "--cwd", "/srv", "--", "echo ok"],
    ["run", "studio", "--timeout", "-1", "--", "echo ok"],
    ["run", "studio", "--timeout", "2147483648", "--", "echo ok"],
    ["run", "studio", "--timeout", "1.5", "--", "echo ok"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("shell --key names the key that detaches, CNS_KEY does when it is not given, and none leaves every key to the session", { skip: !posix }, () => {
  assert.equal(parseOptions(["shell", "studio"]).detachKey, undefined, "Ctrl-] unless something says otherwise");
  assert.deepEqual(parseOptions(["shell", "studio", "--key", "C-b"]).detachKey, { byte: 0x02, label: "Ctrl-B" });
  assert.deepEqual(parseOptions(["shell", "studio", "--attach", "build"], { CNS_KEY: "c-a" }).detachKey, { byte: 0x01, label: "Ctrl-A" });
  assert.deepEqual(parseOptions(["shell", "studio", "--key", "C-b"], { CNS_KEY: "C-a" }).detachKey, { byte: 0x02, label: "Ctrl-B" });
  assert.equal(parseOptions(["shell", "studio", "--key", "none"]).detachKey, null);
  assert.equal(parseOptions(["shell", "studio"], { CNS_KEY: "None" }).detachKey, null);
  assert.throws(() => parseOptions(["shell", "studio", "--key", "C-c"]), /--key cannot be Ctrl-C: the session needs it/);
  assert.throws(() => parseOptions(["shell", "studio", "--key", "F5"]), /--key takes a control key such as C-\] or C-b/);
  // The key belongs to terminals: other commands neither take it nor read CNS_KEY.
  assert.equal(parseOptions(["run", "studio", "--", "pwd"], { CNS_KEY: "bogus" }).detachKey, undefined);
  assert.throws(() => parseOptions(["run", "studio", "--key", "C-b", "--", "pwd"]));
});

test("shell --kitty-keys is off unless asked for, on the command line or with CNS_KITTY_KEYS", { skip: !posix }, () => {
  assert.equal(parseOptions(["shell", "studio"]).kittyKeys, undefined);
  assert.equal(parseOptions(["shell", "studio", "--kitty-keys"]).kittyKeys, true);
  assert.equal(parseOptions(["shell", "studio", "--attach", "build", "--kitty-keys"]).kittyKeys, true);
  for (const on of ["1", "true", "YES", " on "]) assert.equal(parseOptions(["shell", "studio"], { CNS_KITTY_KEYS: on }).kittyKeys, true, on);
  for (const off of ["", "0", "false", "no", "off", "2"]) assert.equal(parseOptions(["shell", "studio"], { CNS_KITTY_KEYS: off }).kittyKeys, undefined, off);
  // It belongs to terminals: other commands neither take it nor read the variable.
  assert.equal(parseOptions(["run", "studio", "--", "pwd"], { CNS_KITTY_KEYS: "1" }).kittyKeys, undefined);
  assert.throws(() => parseOptions(["run", "studio", "--kitty-keys", "--", "pwd"]));
});

test("shell opens a login shell or one quoted command with optional terminal settings", { skip: !posix }, () => {
  const shell = parseOptions(["shell", "studio"]);
  assert.equal(shell.role, "shell");
  assert.equal(shell.command, undefined);
  const command = "claude --resume 'a b'";
  const config = parseOptions(["shell", "studio", "--cwd", "/srv", "--timeout", "1000",
    "--cols", "120", "--rows", "40", "--term", "screen-256color", "--", command]);
  assert.equal(config.command, command);
  assert.deepEqual([config.cwd, config.timeoutMs, config.cols, config.rows, config.term], ["/srv", 1000, 120, 40, "screen-256color"]);
  assert.equal(parseOptions(["shell", "studio", "--", "htop"]).command, "htop");
  assert.equal(parseOptions(["shell", "studio", "--", "vim", "notes.md"]).command, "vim notes.md");
  assert.equal(parseOptions(["shell", "studio", "--", "htop"]).screen, undefined);
  assert.deepEqual(parseOptions(["shell", "studio", "--screen", "--", "htop"]).screen, { history: 0 });
  assert.deepEqual(parseOptions(["shell", "studio", "--screen", "--history", "1000"]).screen, { history: 1000 });
  for (const args of [
    ["shell", "studio", "htop"], ["shell", "studio", "--"], ["shell", "studio", "--", " "], ["shell", "studio", "vim", "--", "x"], ["shell", "studio", "--cols", "0"], ["shell", "studio", "--rows", "1001"], ["shell", "studio", "--cols", "8x"],
    ["shell", "studio", "--term", "xterm 256"], ["shell", "studio", "--timeout", "-1"],
    ["shell", "studio", "--history", "5"], ["shell", "studio", "--screen", "--history", "1001"], ["shell", "studio", "--screen", "--history", "x"],
    ["run", "studio", "--screen", "--", "echo ok"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("named session commands take the device, a session name and their own options", { skip: !posix }, () => {
  const started = parseOptions(["shell", "studio", "--name", "build", "--timeout", "5000", "--", "make watch"]);
  assert.deepEqual([started.name, started.attach, started.command, started.timeoutMs], ["build", false, "make watch", 5000]);
  const attached = parseOptions(["shell", "studio", "--attach", "build"]);
  assert.deepEqual([attached.name, attached.attach], ["build", true]);
  // An environment cwd default is not an explicit change to the session.
  assert.equal(parseOptions(["shell", "studio", "--attach", "build"], { CNS_CWD: "/srv" }).attach, true);

  const keys = parseOptions(["keys", "studio", "build", "make test", "Enter"]);
  assert.deepEqual([keys.role, keys.name, keys.keys, keys.literal], ["keys", "build", ["make test", "Enter"], undefined]);
  const literal = parseOptions(["keys", "studio", "build", "--literal", "--", "-n", "Enter"]);
  assert.deepEqual([literal.name, literal.keys, literal.literal], ["build", ["-n", "Enter"], true]);

  const screen = parseOptions(["screen", "studio", "build", "--history", "20", "--until", "PASS", "--timeout", "0"]);
  assert.deepEqual([screen.name, screen.screen, screen.until, screen.timeoutMs], ["build", { history: 20 }, "PASS", 0]);
  assert.deepEqual(parseOptions(["screen", "studio", "build"]).screen, { history: 0 });
  assert.equal(parseOptions(["sessions", "studio", "--json"]).json, true);
  // Without a device, sessions lists every paired device's.
  assert.deepEqual(parseOptions(["sessions"]) as unknown, { role: "sessions", everywhere: true, json: false });
  assert.deepEqual(parseOptions(["sessions", "--json"]) as unknown, { role: "sessions", everywhere: true, json: true });
  assert.throws(() => parseOptions(["sessions", "--literal"]));
  assert.equal(parseOptions(["kill", "studio", "build"]).name, "build");

  for (const args of [
    ["shell", "studio", "--name", "a", "--attach", "a"], ["shell", "studio", "--attach", "a", "--", "ls"], ["shell", "studio", "--attach", "a", "--cwd", "/srv"],
    ["shell", "studio", "--attach", "a", "--timeout", "5"], ["shell", "studio", "--attach", "a", "--term", "vt100"], ["shell", "studio", "--name", "a", "--screen"],
    ["shell", "studio", "--name", "bad name"], ["shell", "studio", "--attach", ".hidden"], ["shell", "studio", "--name", "x".repeat(65)],
    ["keys", "studio"], ["keys", "studio", "build"], ["keys", "studio", "bad:name", "Enter"],
    ["keys", "studio", "build", ...Array.from({ length: 1001 }, () => "x")],
    ["screen", "studio"], ["screen", "studio", "a", "b"], ["screen", "studio", "a", "--timeout", "5"], ["screen", "studio", "a", "--until", ""],
    ["screen", "studio", "a", "--history", "1001"],
    ["kill", "studio"], ["kill", "studio", "a", "b"], ["sessions", "studio", "a"], ["sessions", "studio", "--literal"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("shell -d names the session it types into, and what it was given that only a new session can take", { skip: !posix }, () => {
  const first = parseOptions(["shell", "studio", "-d", "--session", "work", "--cwd", "/srv", "--cols", "100", "--", "make", "watch"]);
  assert.deepEqual([first.role, first.detached, first.name, first.attach, first.command, first.startOnly], ["shell", true, "work", false, "make watch", ["cwd", "cols"]]);
  const next = parseOptions(["shell", "studio", "--detached", "--session", "work", "--command", "echo 'a  b'"]);
  assert.deepEqual([next.detached, next.name, next.command, next.startOnly], [true, "work", "echo 'a  b'", []]);
  // An environment default is not something this command asked the session for.
  assert.deepEqual(parseOptions(["shell", "studio", "-d", "--session", "work"], { CNS_CWD: "/srv" }).startOnly, []);
  const unnamed = parseOptions(["shell", "studio", "-d"]);
  assert.deepEqual([unnamed.detached, unnamed.name, unnamed.command], [true, undefined, undefined]);
  assert.equal(parseOptions(["shell", "studio", "--command", "htop"]).command, "htop");
  assert.equal(parseOptions(["shell", "studio"]).detached, undefined);
  for (const args of [
    ["shell", "studio", "--session", "work", "--", "ls"], ["shell", "studio", "-d", "--name", "work"], ["shell", "studio", "-d", "--attach", "work"],
    ["shell", "studio", "-d", "--screen", "--", "ls"], ["shell", "studio", "-d", "--key", "ctrl-]"], ["shell", "studio", "-d", "--kitty-keys"],
    ["shell", "studio", "-d", "--session", "bad name"], ["shell", "studio", "-d", "--session", "a", "--session", "b"],
    ["shell", "studio", "-d", "--command", "ls", "--", "ls"], ["shell", "studio", "-d", "--command", " "], ["run", "studio", "-d", "--", "ls"],
    ["run", "studio", "--command", "ls", "--", "ls"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("--secret names secrets, repeated or separated by commas, for a program that is being started", { skip: !posix }, () => {
  assert.deepEqual(parseOptions(["run", "studio", "--secret", "API_KEY", "--secret", "home:TOKEN,OTHER", "--", "env"]).secrets, ["API_KEY", "home:TOKEN,OTHER"]);
  assert.deepEqual(parseOptions(["shell", "studio", "--secret", "API_KEY"]).secrets, ["API_KEY"]);
  assert.deepEqual(parseOptions(["shell", "studio", "--name", "app", "--secret", "API_KEY", "--", "serve"]).secrets, ["API_KEY"]);
  assert.deepEqual(parseOptions(["shell", "studio", "-d", "--session", "app", "--secret", "API_KEY"]).startOnly, ["secret"]);
  assert.equal(parseOptions(["run", "studio", "--", "env"]).secrets, undefined);
  assert.equal(parseOptions(["run", "studio", "--", "env"]).env, undefined);
  for (const args of [["shell", "studio", "--attach", "app", "--secret", "API_KEY"], ["keys", "studio", "app", "--secret", "API_KEY", "Enter"], ["run", "studio", "--secret"], ["run", "studio", "--secret", "--", "env"]]) {
    assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
  }
});

test("run forwards stdin unless --no-stdin says otherwise", { skip: !posix }, () => {
  assert.equal(parseOptions(["run", "studio", "--", "cat"]).stdin, true);
  assert.equal(parseOptions(["run", "studio", "--no-stdin", "--", "cat"]).stdin, false);
  assert.equal(parseOptions(["run", "studio", "-n", "--", "cat"]).stdin, false);
  assert.equal(parseOptions(["shell", "studio"]).stdin, undefined);
});

test("cp takes a local path and a DEVICE:PATH, or two DEVICE:PATHs, scp style", { skip: !posix }, () => {
  const upload = parseOptions(["cp", "./a.txt", "studio:/tmp/"]);
  assert.deepEqual(upload.copy, { source: { path: "./a.txt" }, destination: { device: "studio", path: "/tmp/" }, recursive: false });
  assert.equal(upload.expect.name, "studio");
  assert.equal(upload.copyTo, undefined);
  assert.deepEqual(parseOptions(["cp", "studio:notes.txt", "."]).copy, { source: { device: "studio", path: "notes.txt" }, destination: { path: "." }, recursive: false });
  assert.deepEqual(parseOptions(["cp", "report.pdf", "studio:"]).copy?.destination, { device: "studio", path: "" });
  assert.equal(parseOptions(["cp", "-r", "site", "studio:/srv/"]).copy?.recursive, true);
  assert.equal(parseOptions(["cp", "studio:site", "out", "--recursive"]).copy?.recursive, true);
  // Within one device, one connection serves both ends.
  const within = parseOptions(["cp", "studio:a", "studio:b"]);
  assert.deepEqual(within.copy, { source: { device: "studio", path: "a" }, destination: { device: "studio", path: "b" }, recursive: false });
  assert.equal(within.copyTo, undefined);
  for (const argv of [["cp", "a", "b"], ["cp", "a"], ["cp", "", "studio:b"], ["cp", "studio:b", ""], ["cp", "missing:/x", "."], ["cp", "studio:x", "missing:/y"], ["cp", ":x", "."], ["cp", "ws://box:47381/x", "."], ["cp", "-r", "-r", "a", "studio:"]]) {
    assert.throws(() => parseOptions(argv), argv.join(" "));
  }
});

test("cp between two paired devices connects to the source and names the destination", { skip: !posix }, () => {
  const other = generateIdentity();
  savePairedPeer("nas", { publicKey: other.publicKey, addresses: ["ws://192.168.1.11:47381"], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: expandGrants(["files"]) } });
  const config = parseOptions(["cp", "-r", "studio:~/photos", "nas:backup/"]);
  assert.equal(config.expect.name, "studio");
  assert.deepEqual([config.copyTo?.name, config.copyTo?.publicKey], ["nas", other.publicKey]);
  assert.deepEqual(config.copy, { source: { device: "studio", path: "~/photos" }, destination: { device: "nas", path: "backup/" }, recursive: true });
});

test("DEVICE:PATH is told from local paths", () => {
  assert.deepEqual(splitRemote("studio:/srv/app"), { target: "studio", path: "/srv/app" });
  assert.throws(() => splitRemote(":~/x"), /Name the paired device/);
  assert.equal(splitRemote("./a:b"), undefined);
  assert.equal(splitRemote("dir/a:b"), undefined);
  assert.equal(splitRemote("C:\\Users\\me", "win32"), undefined);
  assert.deepEqual(splitRemote("C:/Users", "linux"), { target: "C", path: "/Users" });
});
