import assert from "node:assert/strict";
import test from "node:test";
import { selfCheck, type SelfFacts } from "./self-check.js";

const key = "K".repeat(43);
const identity = { fingerprint: "abcd-efgh", publicKey: key };
const base = { identity, identityPath: "/cfg/identity.json", paired: 1 } satisfies Partial<SelfFacts>;
const daemon = (extra: Partial<Extract<SelfFacts["daemon"], { running: true }>> = {}): SelfFacts["daemon"] =>
  ({ running: true, pid: 42, url: "ws://0.0.0.0:47381", identity, addresses: ["ws://192.168.1.5:47381"], ...extra });

test("a device with only private addresses and the relay off is ready, with a warning that names the fix", () => {
  const { report, lines, exitCode } = selfCheck({ ...base, daemon: daemon() });
  assert.equal(exitCode, 0);
  assert.equal(report.reachableBeyondNetwork, false);
  assert.deepEqual(report.problems, []);
  assert.match(report.warnings.join("\n"), /Every address here is private and the relay is off.*Unset CNS_RELAY/);
  assert.match(lines.join("\n"), /^Identity: +abcd-efgh \(\/cfg\/identity\.json\)\nDaemon: +pid 42 at ws:\/\/0\.0\.0\.0:47381\nRelay: +off \(CNS_RELAY=off\)\nAddresses:\n  ws:\/\/192\.168\.1\.5:47381: private, this network only\nPaired: +1 device\n/);
});

test("a registered public relay or a public direct address makes the device reachable from elsewhere", () => {
  const relayed = selfCheck({ ...base, relay: "wss://relay.example", daemon: daemon({ relay: "wss://relay.example", relayRegistered: true, addresses: ["ws://10.0.0.2:47381", `wss://relay.example/v1/dial/${key}`] }) });
  assert.deepEqual([relayed.exitCode, relayed.report.reachableBeyondNetwork, relayed.report.warnings], [0, true, []]);
  assert.match(relayed.lines.join("\n"), /Relay: +wss:\/\/relay\.example \(registered\)/);
  assert.match(relayed.lines.join("\n"), /\[relay\]: reachable from other networks/);
  assert.equal(relayed.lines.at(-1), "Ready for paired devices.");
  const tailnet = selfCheck({ ...base, daemon: daemon({ addresses: ["ws://100.101.102.103:47381"] }) });
  assert.equal(tailnet.report.reachableBeyondNetwork, true);
});

test("a relay that is not registered does not count, and says so", () => {
  const { report, exitCode } = selfCheck({ ...base, relay: "wss://relay.example", daemon: daemon({ relay: "wss://relay.example", relayRegistered: false, addresses: ["ws://10.0.0.2:47381", `wss://relay.example/v1/dial/${key}`] }) });
  assert.equal(exitCode, 0);
  assert.equal(report.reachableBeyondNetwork, false);
  assert.match(report.warnings.join("\n"), /not registered at the relay/);
});

test("a daemon started with another CNS_RELAY than this command's is a warning", () => {
  const off = selfCheck({ ...base, relay: "wss://relay.example", daemon: daemon() });
  assert.match(off.report.warnings.join("\n"), /running daemon uses no relay, but a daemon started now would use wss:\/\/relay\.example/);
  const other = selfCheck({ ...base, daemon: daemon({ relay: "wss://relay.example" }) });
  assert.match(other.report.warnings.join("\n"), /uses the relay wss:\/\/relay\.example, but a daemon started now would use none/);
});

test("no identity, no daemon, a daemon with another identity and no address are problems", () => {
  const missing = selfCheck({ ...base, identity: { missing: true }, daemon: { running: false } });
  assert.equal(missing.exitCode, 5);
  assert.equal(missing.report.problems.length, 2);
  assert.match(missing.lines.join("\n"), /Problem: No daemon runs here.*cns up/);
  assert.equal(selfCheck({ ...base, identity: { error: "too open" }, daemon: daemon() }).exitCode, 5);
  const other = selfCheck({ ...base, daemon: daemon({ identity: { fingerprint: "zzzz", publicKey: "Z".repeat(43) } }) });
  assert.deepEqual([other.exitCode, other.report.daemon?.matchesIdentity], [3, false]);
  assert.equal(selfCheck({ ...base, daemon: daemon({ addresses: [] }) }).exitCode, 5);
});
