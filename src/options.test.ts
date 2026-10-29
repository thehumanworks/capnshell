import assert from "node:assert/strict";
import test from "node:test";
import { isLoopback, parseOptions } from "./options.js";

test("a generic listener defaults to loopback on every supported OS", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const config = parseOptions(["listen"], platform);
    assert.equal(config.mode, "listen");
    assert.equal(config.bind, "127.0.0.1");
    assert.equal(config.url, "ws://127.0.0.1:47381");
    assert.equal(config.remote, false);
  }
});

test("non-loopback listeners require explicit opt-in", () => {
  assert.throws(() => parseOptions(["listen", "--bind", "192.168.1.50"], "darwin"), /--allow-remote/);
  const config = parseOptions(["listen", "--bind", "192.168.1.50", "--allow-remote", "--port", "47382"], "darwin");
  assert.equal(config.url, "ws://192.168.1.50:47382");
  assert.equal(config.remote, true);
  assert.throws(() => parseOptions(["listen", "--bind", "0.0.0.0"]), /--allow-remote/);
});

test("a connecting peer needs no listener, bind option or local port", () => {
  const config = parseOptions(["connect", "ws://192.168.1.50:47381"], "linux");
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

test("old Windows/WSL shortcuts still work and enforce their platforms", () => {
  assert.equal(parseOptions(["windows"], "win32").mode, "listen");
  assert.equal(parseOptions(["wsl", "--port", "47382"], "linux").url, "ws://127.0.0.1:47382");
  assert.throws(() => parseOptions(["windows"], "linux"), /Windows/);
  assert.throws(() => parseOptions(["wsl"], "darwin"), /Linux/);
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
