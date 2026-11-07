import assert from "node:assert/strict";
import test from "node:test";
import { selfCheck, type SelfFacts } from "./self-check.js";

const key = "K".repeat(43);
const identity = { fingerprint: "abcd-efgh", publicKey: key };
const base = { identity, identityPath: "/cfg/identity.json", paired: 1 } satisfies Partial<SelfFacts>;
const daemon = (extra: Partial<Extract<SelfFacts["daemon"], { running: true }>> = {}): SelfFacts["daemon"] =>
  ({ running: true, pid: 42, url: "ws://0.0.0.0:47381", paired: true, identity, addresses: ["ws://192.168.1.5:47381"], ...extra });

test("a device with only private addresses and no relay is ready, with a warning that names the fix", () => {
  const { report, lines, exitCode } = selfCheck({ ...base, daemon: daemon() });
  assert.equal(exitCode, 0);
  assert.equal(report.reachableBeyondNetwork, false);
  assert.deepEqual(report.problems, []);
  assert.match(report.warnings.join("\n"), /Every address here is private.*cns config relay URL/);
  assert.match(lines.join("\n"), /^Identity: +abcd-efgh \(\/cfg\/identity\.json\)\nDaemon: +pid 42 at ws:\/\/0\.0\.0\.0:47381\nRelay: +none\nAddresses:\n  ws:\/\/192\.168\.1\.5:47381: private, this network only\nPaired: +1 device\n/);
});

test("a registered public relay or a public direct address makes the device reachable from elsewhere", () => {
  const relayed = selfCheck({ ...base, daemon: daemon({ relay: "wss://relay.example/?token=secret", relayRegistered: true, addresses: ["ws://10.0.0.2:47381", `wss://relay.example/v1/dial/${key}`] }) });
  assert.deepEqual([relayed.exitCode, relayed.report.reachableBeyondNetwork, relayed.report.warnings], [0, true, []]);
  assert.ok(!relayed.lines.join("\n").includes("secret"), "the relay token is hidden");
  assert.match(relayed.lines.join("\n"), /\[relay\]: reachable from other networks/);
  assert.equal(relayed.lines.at(-1), "Ready for paired devices.");
  const tailnet = selfCheck({ ...base, daemon: daemon({ addresses: ["ws://100.101.102.103:47381"] }) });
  assert.equal(tailnet.report.reachableBeyondNetwork, true);
});

test("a relay that is not registered does not count, and says so", () => {
  const { report, exitCode } = selfCheck({ ...base, daemon: daemon({ relay: "wss://relay.example/", relayRegistered: false, addresses: ["ws://10.0.0.2:47381", `wss://relay.example/v1/dial/${key}`] }) });
  assert.equal(exitCode, 0);
  assert.equal(report.reachableBeyondNetwork, false);
  assert.match(report.warnings.join("\n"), /not registered at its relay/);
});

test("a configured relay that the running daemon does not use is a warning naming where it is set", () => {
  const env = selfCheck({ ...base, configuredRelay: { url: "wss://other.example/?token=t", source: "env" }, daemon: daemon() });
  assert.match(env.report.warnings.join("\n"), /CNS_RELAY names wss:\/\/other\.example.*uses no relay/);
  assert.ok(!env.lines.join("\n").includes("token=t"), "the token is hidden");
  const saved = selfCheck({ ...base, configuredRelay: { url: "wss://other.example/", source: "config" }, daemon: daemon({ relay: "wss://relay.example/" }) });
  assert.match(saved.report.warnings.join("\n"), /cns config relay saved wss:\/\/other\.example.*uses wss:\/\/relay\.example/);
  const same = selfCheck({ ...base, configuredRelay: { url: "wss://relay.example/", source: "config" }, daemon: daemon({ relay: "wss://relay.example/", relayRegistered: true, addresses: [`wss://relay.example/v1/dial/${key}`] }) });
  assert.deepEqual(same.report.warnings, []);
});

test("settings that cannot be read are a warning", () => {
  const { report, exitCode } = selfCheck({ ...base, settingsError: "Settings are not valid JSON", daemon: daemon({ addresses: ["ws://100.64.0.1:47381"] }) });
  assert.equal(exitCode, 0);
  assert.match(report.warnings.join("\n"), /settings cannot be read.*not valid JSON/);
});

test("no identity, no daemon, a legacy daemon, a daemon with another identity and no address are problems", () => {
  const missing = selfCheck({ ...base, identity: { missing: true }, daemon: { running: false } });
  assert.equal(missing.exitCode, 5);
  assert.equal(missing.report.problems.length, 2);
  assert.match(missing.lines.join("\n"), /Problem: No daemon runs here.*cns up/);
  assert.equal(selfCheck({ ...base, identity: { error: "too open" }, daemon: daemon() }).exitCode, 5);
  assert.equal(selfCheck({ ...base, daemon: daemon({ paired: false }) }).exitCode, 5);
  const other = selfCheck({ ...base, daemon: daemon({ identity: { fingerprint: "zzzz", publicKey: "Z".repeat(43) } }) });
  assert.deepEqual([other.exitCode, other.report.daemon?.matchesIdentity], [3, false]);
  assert.equal(selfCheck({ ...base, daemon: daemon({ addresses: [] }) }).exitCode, 5);
});
