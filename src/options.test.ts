import assert from "node:assert/strict";
import test from "node:test";
import { isLoopback, parseMcpOptions, parseOptions as parsePeerOptions } from "./options.js";

// Exercise Commander's real environment handling without inheriting user defaults
// or leaking an individual test's environment to other tests.
function withEnvironment<T>(env: NodeJS.ProcessEnv, parse: () => T): T {
  const names = ["CNS_BIND", "CNS_PORT", "CNS_CWD"];
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

const parseOptions = (argv: string[], env: NodeJS.ProcessEnv = {}) => withEnvironment(env, () => parsePeerOptions(argv));
const parseMcp = (argv: string[], env: NodeJS.ProcessEnv = {}) => withEnvironment(env, () => parseMcpOptions(argv));

test("mcp serves stdio for a local listener by default", () => {
  assert.deepEqual(parseMcp([]), { url: "ws://127.0.0.1:47381", daemon: false, state: undefined, cwd: undefined, http: undefined });
  assert.equal(parseMcp([], { CNS_BIND: "::1", CNS_PORT: "4000", CNS_CWD: "/srv" }).url, "ws://[::1]:4000");
  assert.equal(parseMcp([], { CNS_CWD: "/srv" }).cwd, "/srv");
  assert.equal(parseMcp(["wss://example.test/rpc"], { CNS_PORT: "not a port" }).url, "wss://example.test/rpc");
  assert.deepEqual(parseMcp(["--daemon", "--state", "/tmp/d.json"], { CNS_PORT: "4000" }), {
    url: "ws://127.0.0.1:47381", daemon: true, state: "/tmp/d.json", cwd: undefined, http: undefined,
  });
});

test("mcp serves HTTP on loopback unless remote access is explicit", () => {
  assert.deepEqual(parseMcp(["--http", "47382"]).http, { bind: "127.0.0.1", port: 47382, remote: false });
  assert.deepEqual(parseMcp(["--http", "47382", "--http-bind", "::1"]).http, { bind: "::1", port: 47382, remote: false });
  assert.throws(() => parseMcp(["--http", "47382", "--http-bind", "0.0.0.0"]), /--allow-remote/);
  assert.deepEqual(parseMcp(["--http", "47382", "--http-bind", "0.0.0.0", "--allow-remote"]).http, { bind: "0.0.0.0", port: 47382, remote: true });
});

test("mcp rejects conflicting or incomplete options", () => {
  for (const argv of [
    ["ws://example.test", "--daemon"], ["ws://example.test", "--port", "1"], ["--daemon", "--bind", "::1"],
    ["--state", "/tmp/d.json"], ["--http-bind", "::1"], ["--allow-remote"], ["--http", "0"], ["--http", "http"],
    ["--http", "1", "--http", "2"], ["http://example.test"], ["ws://user:pass@example.test"], ["--http", "1", "--http-bind", "localhost"],
  ]) assert.throws(() => parseMcp(argv), `Expected rejection: ${argv.join(" ")}`);
});

test("a listener defaults to loopback", () => {
  const config = parseOptions(["listen"]);
  assert.equal(config.mode, "listen");
  assert.equal(config.bind, "127.0.0.1");
  assert.equal(config.url, "ws://127.0.0.1:47381");
  assert.equal(config.remote, false);
});

test("non-loopback listeners require explicit opt-in", () => {
  assert.throws(() => parseOptions(["listen", "--bind", "192.168.1.50"]), /--allow-remote/);
  const config = parseOptions(["listen", "--bind", "192.168.1.50", "--allow-remote", "--port", "47382"]);
  assert.equal(config.url, "ws://192.168.1.50:47382");
  assert.equal(config.remote, true);
  assert.throws(() => parseOptions(["listen", "--bind", "0.0.0.0"]), /--allow-remote/);
});

test("a connecting peer needs no listener, bind option or local port", () => {
  const config = parseOptions(["connect", "ws://192.168.1.50:47381"]);
  assert.equal(config.mode, "connect");
  assert.equal(config.url, "ws://192.168.1.50:47381/");
  assert.equal(config.remote, true);
  assert.throws(() => parseOptions(["connect", "ws://example.test", "--bind", "0.0.0.0"]), /unknown option/);
});

test("IPv6 loopback listeners and secure WebSocket destinations work", () => {
  assert.equal(parseOptions(["listen", "--bind", "::1"]).url, "ws://[::1]:47381");
  assert.equal(parseOptions(["connect", "ws://[::1]:47381"]).remote, false);
  assert.equal(parseOptions(["connect", "wss://example.test/rpc", "--no-repl"]).noRepl, true);
  assert.ok(isLoopback("127.0.0.2"));
  assert.ok(!isLoopback("127.0.0.1.example.test"));
});

test("rejects invalid or ambiguous arguments", () => {
  for (const argv of [
    [], ["bogus"], ["connect"], ["connect", "https://example.test"],
    ["connect", "ws://user:pass@example.test"], ["connect", "ws://example.test/#fragment"],
    ["connect", "not-a-url"], ["listen", "--bind"], ["listen", "--bind", "example.test"],
    ["listen", "--port"], ["listen", "--port", "0"], ["listen", "--port", "65536"],
    ["listen", "--port", "47381", "--port", "47382"], ["listen", "--unknown"],
    ["connect", "ws://example.test", "extra"],
  ]) assert.throws(() => parseOptions(argv), `Expected rejection: ${argv.join(" ")}`);
});

test("daemon mode and custom state are explicit listener options", () => {
  const config = parseOptions(["listen", "--daemon", "--state", "/tmp/cns-state.json"]);
  assert.equal(config.daemon, true);
  assert.equal(config.state, "/tmp/cns-state.json");
  assert.equal(parseOptions(["listen"]).daemon, false);
  assert.throws(() => parseOptions(["connect", "ws://localhost", "--daemon"]), /unknown option/);
});

test("run preserves the single shell string, working directory and timeout", () => {
  const command = "printf '%s\\n' \"a b\" && printf '$HOME'";
  const config = parseOptions(["run", "ws://localhost:47381", "--cwd", "/tmp", "--timeout", "5000", "--", command]);
  assert.equal(config.mode, "connect");
  assert.equal(config.noRepl, true);
  assert.equal(config.command, command);
  assert.equal(config.cwd, "/tmp");
  assert.equal(config.timeoutMs, 5000);
  assert.equal(parseOptions(["run", "ws://localhost", "--timeout", "0", "--", "echo ok"]).timeoutMs, 0);
  assert.equal(parseOptions(["run", "ws://localhost", "--timeout", "2147483647", "--", "echo ok"]).timeoutMs, 2147483647);
});

test("run defaults to loopback without a URL and accepts endpoint flags", () => {
  const config = parseOptions(["run", "--", "echo ok"]);
  assert.equal(config.url, "ws://127.0.0.1:47381");
  assert.equal(config.command, "echo ok");
  assert.equal(config.remote, false);
  assert.equal(config.cwd, undefined);
  assert.equal(config.noRepl, true);
  assert.equal(parseOptions(["run", "--bind", "::1", "--port", "47382", "--", "echo ok"]).url,
    "ws://[::1]:47382");
});

test("environment defaults configure run endpoints and remote working directories", () => {
  const env = { CNS_BIND: "192.168.1.50", CNS_PORT: "47382", CNS_CWD: "/srv/my project" };
  const config = parseOptions(["run", "--", "echo ok"], env);
  assert.equal(config.url, "ws://192.168.1.50:47382");
  assert.equal(config.bind, env.CNS_BIND);
  assert.equal(config.port, 47382);
  assert.equal(config.cwd, env.CNS_CWD);
  assert.equal(config.remote, true);
  assert.equal(parseOptions(["run", "--", "echo ok"], { CNS_BIND: "::1" }).url, "ws://[::1]:47381");
  assert.equal(parseOptions(["run", "--", "echo ok"], { CNS_PORT: "47382" }).url, "ws://127.0.0.1:47382");
  assert.equal(parseOptions(["run", "--", "echo ok"], { CNS_CWD: "C:\\My Project" }).cwd, "C:\\My Project");
});

test("explicit flags override environment defaults independently and before validation", () => {
  const env = { CNS_BIND: "invalid", CNS_PORT: "invalid", CNS_CWD: "" };
  for (const role of ["run", "listen"]) {
    const args = [role, "--bind", "::1", "--port", "47383"];
    if (role === "run") args.push("--cwd", "/tmp", "--", "echo ok");
    const config = parseOptions(args, env);
    assert.equal(config.url, "ws://[::1]:47383");
    assert.equal(config.cwd, role === "run" ? "/tmp" : undefined);
  }
  const defaults = { CNS_BIND: "::1", CNS_PORT: "47382", CNS_CWD: "/srv/project" };
  const port = parseOptions(["run", "--port", "47383", "--", "echo ok"], defaults);
  assert.equal(port.url, "ws://[::1]:47383");
  assert.equal(port.cwd, defaults.CNS_CWD);
  const bind = parseOptions(["run", "--bind", "127.0.0.2", "--", "echo ok"], defaults);
  assert.equal(bind.url, "ws://127.0.0.2:47382");
  const cwd = parseOptions(["run", "--cwd", "/tmp", "--", "echo ok"], defaults);
  assert.equal(cwd.url, "ws://[::1]:47382");
  assert.equal(cwd.cwd, "/tmp");
});

test("explicit URLs replace endpoint env defaults but retain the remote cwd default", () => {
  const env = { CNS_BIND: "invalid", CNS_PORT: "invalid", CNS_CWD: "/srv/project" };
  const url = "wss://example.test:443/rpc?peer=1";
  const config = parseOptions(["run", url, "--", "echo ok"], env);
  assert.equal(config.url, new URL(url).href);
  assert.equal(config.cwd, env.CNS_CWD);
  assert.equal(parseOptions(["run", url, "--cwd", "/tmp", "--", "echo ok"], env).cwd, "/tmp");
  const connected = parseOptions(["connect", url], env);
  assert.equal(connected.url, new URL(url).href);
  assert.equal(connected.cwd, undefined);
  for (const option of [["--bind", "127.0.0.1"], ["--port", "47381"]]) {
    assert.throws(() => parseOptions(["run", url, ...option, "--", "echo ok"], env), /Use either a URL/);
  }
});

test("listener environment defaults still require explicit non-loopback opt-in", () => {
  const env = { CNS_BIND: "192.168.1.50", CNS_PORT: "47382", CNS_CWD: "" };
  assert.throws(() => parseOptions(["listen"], env), /--allow-remote/);
  const config = parseOptions(["listen", "--allow-remote", "--daemon"], env);
  assert.equal(config.url, "ws://192.168.1.50:47382");
  assert.equal(config.remote, true);
  assert.equal(config.daemon, true);
  assert.equal(config.cwd, undefined);
  assert.equal(parseOptions(["listen"], { CNS_BIND: "::1" }).remote, false);
});

test("environment defaults use the same validation as flags", () => {
  for (const env of [
    { CNS_BIND: "" }, { CNS_BIND: "example.test" }, { CNS_BIND: "999.1.2.3" },
    { CNS_PORT: "" }, { CNS_PORT: "0" }, { CNS_PORT: "65536" },
    { CNS_PORT: "1.5" }, { CNS_PORT: "-1" }, { CNS_PORT: "47381junk" },
  ]) {
    assert.throws(() => parseOptions(["run", "--", "echo ok"], env));
    assert.throws(() => parseOptions(["listen"], env));
  }
  assert.throws(() => parseOptions(["run", "--", "echo ok"], { CNS_CWD: "" }));
});

test("run requires an explicit delimiter and exactly one nonempty shell string", () => {
  for (const args of [
    ["run"], ["run", "--"], ["run", "echo ok"],
    ["run", "--", ""], ["run", "--", " "], ["run", "--", "echo", "ok"],
    ["run", "--bind", "::1", "--bind", "::1", "--", "echo ok"],
    ["run", "--port", "47381", "--port", "47382", "--", "echo ok"],
    ["run", "--cwd", "/tmp", "--cwd", "/srv", "--", "echo ok"],
    ["run", "ws://localhost", "echo ok"],
    ["run", "ws://localhost", "--", "echo", "ok"],
    ["run", "ws://localhost", "--"],
    ["run", "ws://localhost", "--", " "],
    ["run", "ws://localhost", "--timeout", "-1", "--", "echo ok"],
    ["run", "ws://localhost", "--timeout", "2147483648", "--", "echo ok"],
    ["run", "ws://localhost", "--timeout", "1.5", "--", "echo ok"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("tty opens a login shell or one quoted command with optional terminal settings", () => {
  const shell = parseOptions(["tty"]);
  assert.equal(shell.role, "tty");
  assert.equal(shell.mode, "connect");
  assert.equal(shell.noRepl, true);
  assert.equal(shell.command, undefined);
  assert.equal(shell.url, "ws://127.0.0.1:47381");
  const command = "claude --resume 'a b'";
  const config = parseOptions(["tty", "ws://localhost:47382", "--cwd", "/srv", "--timeout", "1000",
    "--cols", "120", "--rows", "40", "--term", "screen-256color", "--", command]);
  assert.equal(config.url, "ws://localhost:47382/");
  assert.equal(config.command, command);
  assert.deepEqual([config.cwd, config.timeoutMs, config.cols, config.rows, config.term], ["/srv", 1000, 120, 40, "screen-256color"]);
  assert.equal(parseOptions(["tty", "--", "htop"]).command, "htop");
  assert.equal(parseOptions(["tty", "--", "htop"]).screen, undefined);
  assert.deepEqual(parseOptions(["tty", "--screen", "--", "htop"]).screen, { history: 0 });
  assert.deepEqual(parseOptions(["tty", "--screen", "--history", "1000"]).screen, { history: 1000 });
  assert.equal(parseOptions(["tty", "ws://[::1]:47381"]).command, undefined);
  assert.equal(parseOptions(["tty", "--", "htop"], { CNS_PORT: "47382", CNS_CWD: "/srv" }).url, "ws://127.0.0.1:47382");
  for (const args of [
    ["tty", "htop"], ["tty", "ws://localhost", "htop"], ["tty", "--"], ["tty", "--", " "],
    ["tty", "--", "echo", "ok"], ["tty", "--cols", "0"], ["tty", "--rows", "1001"], ["tty", "--cols", "8x"],
    ["tty", "--term", "xterm 256"], ["tty", "--no-repl"], ["tty", "--timeout", "-1"],
    ["tty", "--history", "5"], ["tty", "--screen", "--history", "1001"], ["tty", "--screen", "--history", "x"],
    ["run", "--screen", "--", "echo ok"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});

test("named session commands take an optional URL, a session name and their own options", () => {
  const started = parseOptions(["tty", "--name", "build", "--timeout", "5000", "--", "make watch"]);
  assert.deepEqual([started.name, started.attach, started.command, started.timeoutMs], ["build", false, "make watch", 5000]);
  const attached = parseOptions(["tty", "ws://[::1]:9", "--attach", "build"]);
  assert.deepEqual([attached.name, attached.attach, attached.url], ["build", true, "ws://[::1]:9/"]);
  // An environment cwd default is not an explicit change to the session.
  assert.equal(parseOptions(["tty", "--attach", "build"], { CNS_CWD: "/srv" }).attach, true);

  const keys = parseOptions(["keys", "build", "make test", "Enter"]);
  assert.deepEqual([keys.role, keys.name, keys.keys, keys.literal, keys.url], ["keys", "build", ["make test", "Enter"], undefined, "ws://127.0.0.1:47381"]);
  const remote = parseOptions(["keys", "wss://peer.example:9/", "build", "--literal", "--", "-n", "Enter"]);
  assert.deepEqual([remote.url, remote.name, remote.keys, remote.literal], ["wss://peer.example:9/", "build", ["-n", "Enter"], true]);

  const screen = parseOptions(["screen", "build", "--history", "20", "--until", "PASS", "--timeout", "0"]);
  assert.deepEqual([screen.name, screen.screen, screen.until, screen.timeoutMs], ["build", { history: 20 }, "PASS", 0]);
  assert.deepEqual(parseOptions(["screen", "ws://localhost:9", "build"]).screen, { history: 0 });
  assert.equal(parseOptions(["sessions", "--json"]).json, true);
  assert.equal(parseOptions(["sessions", "ws://localhost:9"]).url, "ws://localhost:9/");
  assert.equal(parseOptions(["kill", "build"], { CNS_PORT: "47390" }).url, "ws://127.0.0.1:47390");

  for (const args of [
    ["tty", "--name", "a", "--attach", "a"], ["tty", "--attach", "a", "--", "ls"], ["tty", "--attach", "a", "--cwd", "/srv"],
    ["tty", "--attach", "a", "--timeout", "5"], ["tty", "--attach", "a", "--term", "vt100"], ["tty", "--name", "a", "--screen"],
    ["tty", "--name", "bad name"], ["tty", "--attach", ".hidden"], ["tty", "--name", "x".repeat(65)],
    ["keys"], ["keys", "build"], ["keys", "ws://localhost:9", "build"], ["keys", "bad:name", "Enter"],
    ["keys", "build", ...Array.from({ length: 1001 }, () => "x")],
    ["screen"], ["screen", "a", "b"], ["screen", "a", "--timeout", "5"], ["screen", "a", "--until", ""], ["screen", "a", "--history", "1001"],
    ["kill"], ["kill", "a", "b"], ["sessions", "a", "b"], ["sessions", "--literal"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});
