import assert from "node:assert/strict";
import test from "node:test";
import { isLoopback, parseOptions as parsePeerOptions } from "./options.js";

// Exercise Commander's real environment handling without inheriting user defaults
// or leaking an individual test's environment to other tests.
function parseOptions(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const names = ["CNS_BIND", "CNS_PORT", "CNS_CWD"];
  const saved = names.map((name) => process.env[name]);
  try {
    for (const name of names) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    return parsePeerOptions(argv);
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

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
