import assert from "node:assert/strict";
import test from "node:test";
import { isLoopback, parseOptions } from "./options.js";

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

test("run requires an explicit delimiter and exactly one nonempty shell string", () => {
  for (const args of [
    ["run", "ws://localhost", "echo ok"],
    ["run", "ws://localhost", "--", "echo", "ok"],
    ["run", "ws://localhost", "--"],
    ["run", "ws://localhost", "--", " "],
    ["run", "ws://localhost", "--timeout", "-1", "--", "echo ok"],
    ["run", "ws://localhost", "--timeout", "2147483648", "--", "echo ok"],
    ["run", "ws://localhost", "--timeout", "1.5", "--", "echo ok"],
  ]) assert.throws(() => parseOptions(args), `Expected rejection: ${args.join(" ")}`);
});
