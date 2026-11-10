import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../package.json" with { type: "json" };
import { infoSchema } from "./commands/connect-device.js";
import { localShellInfo } from "./shell.js";
import { CNS_VERSION, compareVersions, daemonDrift, describeVersion, reportedVersion, restartAdvice, versionOrder, type RestartFacts } from "./version.js";

test("this cns's version is package.json's, and its handshake reports it", () => {
  assert.equal(CNS_VERSION, manifest.version);
  assert.equal(localShellInfo().version, CNS_VERSION);
});

test("versions order by major, minor and patch, as numbers", () => {
  assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
  assert.ok(compareVersions("2.0.0", "1.99.99") > 0);
  assert.equal(compareVersions("1.4.0-rc.1", "1.4.0"), 0);
  assert.deepEqual(["1.3.0", "1.4.0", "1.5.0", undefined].map((other) => versionOrder(other, "1.4.0")), ["older", "same", "newer", "unknown"]);
});

test("only a version is taken from what another device reports", () => {
  for (const good of ["1.4.0", "10.0.12", "1.4.0-rc.1", "1.4.0+abc123"]) assert.equal(reportedVersion(good), good);
  for (const bad of [undefined, null, 140, "", "1.4", "v1.4.0", "1.4.0\u001b[2J", "1.4.0 ", `1.4.0-${"x".repeat(100)}`]) assert.equal(reportedVersion(bad), undefined, String(bad));
  assert.equal(describeVersion(undefined), "a cns too old to report its version");
});

test("a device's handshake is read with or without a version, and an odd one is dropped rather than refused", () => {
  const info = { platform: "linux", name: "linux", shell: "Bash", hostname: "studio", cwd: "/home/me", pid: 7 };
  assert.equal(infoSchema.parse({ ...info, version: "1.4.0" }).version, "1.4.0");
  // Releases before versions were reported send none; that must keep working.
  assert.equal(infoSchema.parse(info).version, undefined);
  assert.equal(infoSchema.parse({ ...info, version: "\u001b]0;pwned\u0007" }).version, undefined);
  assert.equal(infoSchema.parse({ ...info, version: { major: 1 } }).version, undefined);
});

const self = { version: "1.4.0", executable: "/opt/cns-1.4.0/cns" };
const drift = (daemon: { version?: string; executable?: string }) => daemonDrift({ daemon, self, advice: "ADVICE", which: "command -v cns" });

test("a daemon on this version gets no warning; an older, newer or silent one says what that means", () => {
  assert.equal(drift({ version: "1.4.0", executable: "/elsewhere/cns" }), undefined);
  assert.equal(drift({ version: "1.2.0", executable: "/opt/cns-1.2.0/cns" }),
    "The daemon runs cns 1.2.0 (/opt/cns-1.2.0/cns), but this cns is 1.4.0 (/opt/cns-1.4.0/cns), so paired devices and commands that use the daemon get the older one. ADVICE");
  assert.equal(drift({}),
    "The daemon runs a cns too old to report its version, but this cns is 1.4.0 (/opt/cns-1.4.0/cns), so paired devices and commands that use the daemon get the older one. ADVICE");
  // A newer daemon means this command is the stale one: an older cns earlier on PATH.
  assert.equal(drift({ version: "1.5.0", executable: "/opt/cns-1.5.0/cns" }),
    "The daemon runs cns 1.5.0 (/opt/cns-1.5.0/cns), newer than this cns 1.4.0 (/opt/cns-1.4.0/cns). An older cns may come first on PATH: command -v cns shows which one a shell runs.");
  // Whatever the daemon reports, a non-version is never printed.
  assert.match(drift({ version: "1.2.0\u001b[2J" })!, /^The daemon runs a cns too old to report its version,/);
});

test("the advice fits how the daemon runs", () => {
  const advice = (facts: Omit<RestartFacts, "platform">, platform: NodeJS.Platform = "linux") => restartAdvice({ ...facts, platform });
  const ends = "Restarting ends the named sessions it holds.";
  const table: Array<[string, Omit<RestartFacts, "platform">, string]> = [
    ["started by cns up", { service: false }, `Restart it: cns stop, then cns up. ${ends}`],
    ["too old to say how it runs", {}, `Restart it: cns stop, then cns up, or restart the service that runs it. ${ends}`],
    ["cns up --install's service, this executable", { service: true, installed: { kind: "systemd", managedByNix: false, runsThis: true } },
      `Restart it: cns stop, then cns up. ${ends}`],
    // mise installs each version under its own path, so a service installed by an older one keeps running it.
    ["cns up --install's service, another executable", { service: true, installed: { kind: "launchd", managedByNix: false, runsThis: false } },
      `Its service runs another executable: run cns up --install with this cns, which points the service here and restarts it. ${ends}`],
    // Home Manager names the new cns, but a running daemon, or a drop-in, can still be the old one.
    ["Home Manager's service, this executable", { installed: { kind: "systemd", managedByNix: true, runsThis: true } },
      `Home Manager's service already names this cns; restart it: cns stop, then cns up. ${ends} If it still runs the old one afterwards, systemctl --user cat cns shows what overrides it.`],
    ["Home Manager's service, another executable", { service: true, installed: { kind: "launchd", managedByNix: true, runsThis: false } },
      `Home Manager owns its service: switch to a configuration with this cns (home-manager switch), which restarts it. ${ends}`],
    ["a service cns did not install", { service: true },
      `A service manager cns did not install runs it: update cns there and restart it, such as sudo systemctl restart cns for the NixOS module. ${ends}`],
  ];
  for (const [situation, facts, expected] of table) assert.equal(advice(facts), expected, situation);
  // Never rewrite a file Nix owns: cns up --install is not offered for one.
  for (const runsThis of [true, false]) {
    for (const kind of ["systemd", "launchd"] as const) assert.doesNotMatch(advice({ service: true, installed: { kind, managedByNix: true, runsThis } }), /cns up --install/);
  }
  assert.equal(advice({ service: true }, "darwin"), `A service manager cns did not install runs it: update cns there and restart it. ${ends}`);
});
