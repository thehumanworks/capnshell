import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { commandLine, installPath, reportLine, shellWord, statusFacts, upgradeDevice, upgradeExitCode, type Device, type Outcome, type Reach } from "./upgrade.js";

test("how cns came to a device is told by its daemon's executable", () => {
  assert.equal(installPath("/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.7.0/cns"), "mise");
  assert.equal(installPath("/opt/mise-data/installs/github-thehumanworks-capnshell/2.7.0/cns"), "mise");
  assert.equal(installPath("C:\\Users\\a\\AppData\\Local\\mise\\installs\\github-thehumanworks-capnshell\\2.7.0\\cns.exe"), "mise");
  assert.equal(installPath("/nix/store/abc-cns-2.7.0/bin/cns"), "nix");
  // Another mise backend is another tool to mise, which mise use -g github:... would install beside it.
  assert.equal(installPath("/home/a/.local/share/mise/installs/ubi-thehumanworks-capnshell/2.7.0/cns"), "unknown");
  assert.equal(installPath("/usr/local/bin/cns"), "unknown");
  assert.equal(installPath("/home/a/src/capnshell/src/cli.ts"), "unknown");
  assert.equal(installPath(undefined), "unknown");
});

test("words reach Bash as they are, and PowerShell commands exit with the program's status", () => {
  for (const word of ["/home/a/it's here/cns", "$(touch pwned)", "`id`", "a;b|c&d", "\"q\"", "%PATH%", "C:\\x y\\cns.exe"]) {
    const echoed = spawnSync("bash", ["--noprofile", "--norc", "-c", `printf %s ${shellWord(word, "Bash")}`], { encoding: "utf8" });
    assert.equal(echoed.stdout, word);
  }
  assert.equal(shellWord("C:\\Users\\o'brien\\cns.exe", "PowerShell"), "'C:\\Users\\o''brien\\cns.exe'");
  assert.equal(shellWord("C:\\Users\\o\u2019brien", "PowerShell"), "'C:\\Users\\o\u2019\u2019brien'");
  assert.throws(() => shellWord("/a\nb", "Bash"), /control characters/);
  assert.equal(commandLine("Bash", "mise", ["use", "-g", "'github:thehumanworks/capnshell@2.9.0'"]), "mise use -g 'github:thehumanworks/capnshell@2.9.0'");
  assert.equal(commandLine("PowerShell", "'C:\\m\\cns.exe'", ["status", "--json"]), "& 'C:\\m\\cns.exe' status --json; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE");
});

test("cns status --json is read for the daemon's executable and sessions and the service, whatever else it holds", () => {
  assert.deepEqual(statusFacts(JSON.stringify({ version: "2.9.0", daemon: { executable: "/x/cns", pid: 1, sessions: ["build"] }, service: { kind: "systemd", path: "/u", managedByNix: false, runsThis: false } })),
    { version: "2.9.0", daemon: { executable: "/x/cns", sessions: ["build"] }, service: { managedByNix: false, runsThis: false } });
  // A cns from before the service and sessions were reported, and one with no daemon.
  assert.deepEqual(statusFacts(JSON.stringify({ version: "2.7.0", daemon: { executable: "/x/cns" } })), { version: "2.7.0", daemon: { executable: "/x/cns" } });
  assert.deepEqual(statusFacts(JSON.stringify({ version: "2.7.0", daemon: null })), { version: "2.7.0", daemon: null });
  assert.equal(statusFacts(JSON.stringify({ version: "x" }))?.version, undefined);
  assert.equal(statusFacts("cns: command not found"), undefined);
});

interface Simulated {
  shell: "Bash" | "PowerShell";
  platform: NodeJS.Platform;
  version: string;
  executable: string;
  /** What the old cns's status --json says of the service: undefined for a cns too old to say. */
  probeService: object | null;
  /** The daemon's named sessions; null for a daemon too old to say. */
  sessions: string[] | null;
  service: object | null;
  answers: Record<string, { code: number; stdout?: string; stderr?: string }>;
}

/** A device as cns upgrade reaches it: a daemon running a mise-installed cns, with no named sessions, unless told otherwise. */
function device(overrides: Partial<Simulated> = {}) {
  const shell = overrides.shell ?? "Bash";
  const windows = shell === "PowerShell";
  const fresh = windows ? "C:\\Users\\a\\AppData\\Local\\mise\\installs\\github-thehumanworks-capnshell\\2.9.0\\cns.exe" : "/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.9.0/cns";
  const state = {
    pid: 100, version: overrides.version ?? "2.7.0", up: true, commands: [] as string[],
    /** What the daemon runs once a restart takes it onto another cns. */
    restartsInto: "2.9.0",
  };
  const sessions = overrides.sessions === undefined ? [] : overrides.sessions;
  const status = (version: string, extra: object = {}) => ({
    code: 0,
    stdout: JSON.stringify({ version, daemon: { version: state.version, executable: overrides.executable ?? fresh.replace("2.9.0", "2.7.0"), ...sessions ? { sessions } : {} }, ...extra }),
  });
  const answer = (command: string): { code: number; stdout?: string; stderr?: string } => {
    for (const [prefix, result] of Object.entries(overrides.answers ?? {})) if (command.includes(prefix)) return result;
    if (/^(& )?cns status --json/.test(command)) return status(state.version, overrides.probeService === undefined ? {} : { service: overrides.probeService });
    if (command.includes("mise --version")) return { code: 0, stdout: "2026.11.3 linux-x64 (2026-11-20)" };
    if (command.includes("mise use -g")) return { code: 0, stderr: "mise github:thehumanworks/capnshell@2.9.0 ✓ installed" };
    if (command.includes("mise which cns")) return { code: 0, stdout: `${fresh}\n` };
    if (command.includes("status --json")) return status("2.9.0", { service: overrides.service === undefined ? null : overrides.service });
    if (command.includes("daemon restart") || command.includes("up --install")) {
      state.pid += 1;
      state.version = state.restartsInto;
      return { code: 0, stdout: "Restarting the daemon in a moment." };
    }
    return { code: 127, stderr: "not found" };
  };
  const reach: Reach = async (name) => {
    if (!state.up) throw new Error(`Cannot connect to ${name}: connect ECONNREFUSED 192.168.1.9:47381.`);
    const reached: Device = {
      platform: overrides.platform ?? (windows ? "win32" : "linux"), shell, pid: state.pid, version: state.version,
      run: async (command) => { state.commands.push(command); const result = answer(command); return { stdout: "", stderr: "", ...result }; },
      close() {},
    };
    return reached;
  };
  return { state, reach, fresh };
}

const quick = { backMs: 0, sleep: async () => {} };

test("a device that runs a cns from mise is upgraded with the exact version, then its daemon restarts on the new cns", async () => {
  const studio = device();
  const outcome = await upgradeDevice("studio", "2.9.0", studio.reach, quick);
  assert.deepEqual(outcome, { device: "studio", result: "upgraded", from: "2.7.0", to: "2.9.0" });
  assert.equal(reportLine(outcome), "studio: upgraded from 2.7.0 to 2.9.0");
  assert.deepEqual(studio.state.commands, [
    "cns status --json",
    "mise use -g 'github:thehumanworks/capnshell@2.9.0'",
    "mise which cns --tool 'github:thehumanworks/capnshell@2.9.0'",
    `'${studio.fresh}' status --json`,
    `'${studio.fresh}' daemon restart`,
  ]);
});

test("a service that runs the old cns is pointed at the new one with cns up --install, which restarts through the worker", async () => {
  const studio = device({ service: { kind: "systemd", managedByNix: false, runsThis: false } });
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", studio.reach, quick)), "studio: upgraded from 2.7.0 to 2.9.0");
  assert.equal(studio.state.commands.at(-1), `'${studio.fresh}' up --install`);
  // A service that runs it already, or that Home Manager owns, is only restarted.
  for (const service of [{ managedByNix: false, runsThis: true }, { managedByNix: true, runsThis: false }]) {
    const other = device({ service });
    await upgradeDevice("other", "2.9.0", other.reach, quick);
    assert.equal(other.state.commands.at(-1), `'${other.fresh}' daemon restart`);
  }
});

test("on Windows the same steps run in PowerShell, quoted for it, each exiting with the program's status", async () => {
  const pc = device({ shell: "PowerShell" });
  assert.equal(reportLine(await upgradeDevice("pc", "2.9.0", pc.reach, quick)), "pc: upgraded from 2.7.0 to 2.9.0");
  const status = "; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE";
  assert.deepEqual(pc.state.commands, [
    `& cns status --json${status}`,
    `& mise use -g 'github:thehumanworks/capnshell@2.9.0'${status}`,
    `& mise which cns --tool 'github:thehumanworks/capnshell@2.9.0'${status}`,
    `& '${pc.fresh}' status --json${status}`,
    `& '${pc.fresh}' daemon restart${status}`,
  ]);
  // mise on Windows may print the path with forward slashes.
  const slashes = device({ shell: "PowerShell", answers: { "mise which": { code: 0, stdout: "C:/Users/a/mise/installs/github-thehumanworks-capnshell/2.9.0/cns.exe\r\n" } } });
  assert.equal(reportLine(await upgradeDevice("pc", "2.9.0", slashes.reach, quick)), "pc: upgraded from 2.7.0 to 2.9.0");
  assert.equal(slashes.state.commands.at(-1), `& 'C:/Users/a/mise/installs/github-thehumanworks-capnshell/2.9.0/cns.exe' daemon restart${status}`);
});

test("--dry-run reads what each device runs and plans, changing nothing", async () => {
  const pins = "mise use -g github:thehumanworks/capnshell@2.9.0, which pins that version in mise's global config there";
  const studio = device();
  const plan = await upgradeDevice("studio", "2.9.0", studio.reach, { ...quick, dryRun: true });
  assert.equal(reportLine(plan), `studio: would upgrade from 2.7.0 to 2.9.0: ${pins}, then cns up --install from the new cns if a service runs the old one, else cns daemon restart`);
  assert.deepEqual(studio.state.commands, ["cns status --json", "mise --version"]);
  assert.equal(studio.state.pid, 100);
  assert.equal(upgradeExitCode([plan]), 0);
  // A cns that reports its service says which.
  const service = device({ probeService: { kind: "launchd", path: "/p", managedByNix: false, runsThis: true } });
  assert.equal(reportLine(await upgradeDevice("mac", "2.9.0", service.reach, { ...quick, dryRun: true })),
    `mac: would upgrade from 2.7.0 to 2.9.0: ${pins}, then cns up --install from the new cns, which moves its service onto it and restarts the daemon`);
  const none = device({ probeService: null });
  assert.equal(reportLine(await upgradeDevice("pi", "2.9.0", none.reach, { ...quick, dryRun: true })), `pi: would upgrade from 2.7.0 to 2.9.0: ${pins}, then cns daemon restart from the new cns`);
  // Without mise there, the upgrade would fail: the plan says so.
  const noMise = device({ answers: { "mise --version": { code: 127, stderr: "bash: mise: command not found" } } });
  const failing = await upgradeDevice("box", "2.9.0", noMise.reach, { ...quick, dryRun: true });
  assert.equal(reportLine(failing), "box: needs a manual step: mise --version failed (mise is not on its daemon's PATH). There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
  assert.equal(upgradeExitCode([plan, failing]), 1);
});

test("a daemon with named sessions, or too old to say, is left alone unless --end-sessions, and the plan names them", async () => {
  const busy = device({ sessions: ["build", "shell-1"] });
  const left = await upgradeDevice("studio", "2.9.0", busy.reach, quick);
  assert.equal(reportLine(left), "studio: needs a manual step: restarting its daemon would end its named sessions build, shell-1. To end them and upgrade, run cns upgrade studio --end-sessions.");
  assert.deepEqual(busy.state.commands, ["cns status --json"]);
  assert.equal(upgradeExitCode([left]), 4);
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", busy.reach, { ...quick, dryRun: true, endSessions: true })),
    /, then cns up --install from the new cns if a service runs the old one, else cns daemon restart, which ends its named sessions build, shell-1$/);
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", busy.reach, { ...quick, endSessions: true })), "studio: upgraded from 2.7.0 to 2.9.0");

  const old = device({ sessions: null });
  assert.equal(reportLine(await upgradeDevice("pi", "2.9.0", old.reach, quick)),
    "pi: needs a manual step: its daemon, cns 2.7.0, cannot say whether it holds named sessions, which restarting it would end. To end any and upgrade, run cns upgrade pi --end-sessions.");
  assert.match(reportLine(await upgradeDevice("pi", "2.9.0", old.reach, { ...quick, dryRun: true, endSessions: true })), /, which ends any named sessions it holds$/);
});

test("a device already on the release, or newer, is left alone without running anything", async () => {
  for (const version of ["2.9.0", "3.0.0"]) {
    const nas = device({ version });
    assert.equal(reportLine(await upgradeDevice("nas", "2.9.0", nas.reach, quick)), `nas: already current (${version})`);
    assert.deepEqual(nas.state.commands, []);
  }
  // A prerelease of it is behind it.
  const candidate = device({ version: "2.9.0-rc.1" });
  candidate.state.restartsInto = "2.9.0";
  assert.equal(reportLine(await upgradeDevice("nas", "2.9.0", candidate.reach, quick)), "nas: upgraded from 2.9.0-rc.1 to 2.9.0");
  // What counts is the daemon: one behind the cns on its PATH, as after mise ran there by hand, is restarted on the release.
  const lagging = device({ answers: { "cns status --json": { code: 0, stdout: JSON.stringify({ version: "2.9.0", daemon: { version: "2.7.0", executable: "/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.7.0/cns", sessions: [] } }) } } });
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", lagging.reach, quick)), "studio: upgraded from 2.7.0 to 2.9.0");
});

test("Nix and installs cns cannot tell are not changed, and the report says what to run there", async () => {
  const nix = device({ executable: "/nix/store/abc-capnweb-shell-2.7.0/bin/cns" });
  const nixos = await upgradeDevice("nixbox", "2.9.0", nix.reach, quick);
  assert.equal(reportLine(nixos),
    "nixbox: needs a manual step: Nix manages cns there. In its flake directory, run nix flake update capnshell (use your flake's name for this input if it differs, for example cns), " +
    "then sudo nixos-rebuild switch --flake . (home-manager switch --flake . for Home Manager); or, for a nix profile install: nix profile upgrade capnshell, then cns daemon restart.");
  assert.deepEqual(nix.state.commands, ["cns status --json"]);
  const mac = device({ executable: "/nix/store/abc-capnweb-shell-2.7.0/bin/cns", platform: "darwin" });
  assert.equal(reportLine(await upgradeDevice("mac", "2.9.0", mac.reach, quick)),
    "mac: needs a manual step: Nix manages cns there. In its flake directory, run nix flake update capnshell (use your flake's name for this input if it differs, for example cns), " +
    "then sudo darwin-rebuild switch --flake . (home-manager switch --flake . for Home Manager); or, for a nix profile install: nix profile upgrade capnshell, then cns daemon restart.");

  const manual = device({ executable: "/usr/local/bin/cns" });
  const unknown = await upgradeDevice("box", "2.9.0", manual.reach, quick);
  assert.equal(reportLine(unknown),
    "box: needs a manual step: cns cannot tell how cns was installed there: its daemon runs /usr/local/bin/cns. There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
  assert.deepEqual(manual.state.commands, ["cns status --json"]);
  assert.equal(upgradeExitCode([nixos, unknown, { device: "nas", result: "current", version: "2.9.0" }]), 4);
  // No cns on the daemon's PATH there to ask.
  const bare = device({ answers: { "cns status": { code: 127, stderr: "bash: cns: command not found" } } });
  assert.equal(reportLine(await upgradeDevice("bare", "2.9.0", bare.reach, quick)),
    "bare: needs a manual step: cns cannot tell how cns was installed there: cns is not on its daemon's PATH. There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
});

test("a failed step stops that device with what to run there, and nothing after it runs", async () => {
  const noMise = device({ answers: { "mise use": { code: 127, stderr: "bash: mise: command not found" } } });
  const failed = await upgradeDevice("studio", "2.9.0", noMise.reach, quick);
  assert.equal(reportLine(failed),
    "studio: needs a manual step: mise use -g github:thehumanworks/capnshell@2.9.0 failed (mise is not on its daemon's PATH). There, run mise use -g github:thehumanworks/capnshell@2.9.0, then restart its daemon on it (cns status there says how).");
  assert.equal(noMise.state.commands.length, 2);
  assert.equal(upgradeExitCode([failed, { device: "nixbox", result: "manual", reason: "", next: "" }]), 1);
  const offline = device({ answers: { "mise use": { code: 1, stderr: "mise ERROR failed to download\nmise ERROR HTTP status client error (404 Not Found)." } } });
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", offline.reach, quick)), /failed \(mise ERROR HTTP status client error \(404 Not Found\)\)\. There, run mise use/);
  const refused = device({ answers: { "daemon restart": { code: 1, stderr: "A service manager cns did not install runs this daemon, so cns cannot start it again." } } });
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", refused.reach, quick)), /^studio: needs a manual step: cns daemon restart failed \(A service manager cns did not install runs this daemon, so cns cannot start it again\)\./);
  assert.equal(refused.state.pid, 100);
});

test("only an absolute path from mise which is run, and a failed mise which stops there", async () => {
  for (const [answer, reason] of [
    [{ code: 0, stdout: "cns\n" }, "cns"],
    [{ code: 0, stdout: "./cns" }, "./cns"],
    [{ code: 0, stdout: "" }, "exit 0"],
    [{ code: 1, stderr: "mise ERROR cns is not a mise bin" }, "mise ERROR cns is not a mise bin"],
  ] as const) {
    const odd = device({ answers: { "mise which": answer } });
    const outcome = await upgradeDevice("studio", "2.9.0", odd.reach, quick);
    assert.equal(reportLine(outcome), `studio: needs a manual step: mise did not say where it installed cns 2.9.0 (${reason}). There, run mise use -g github:thehumanworks/capnshell@2.9.0, then restart its daemon on it (cns status there says how).`);
    assert.equal(outcome.result, "failed");
    assert.equal(odd.state.commands.length, 3, "nothing runs after it");
  }
});

test("a device that refuses the shell, or does not answer, is reported with what to run, and the others go on", async () => {
  const denied = device({ answers: { "cns status": { code: 0 } } });
  const reach: Reach = async (name) => {
    const reached = await denied.reach(name);
    return { ...reached, run: async () => { throw new Error("Permission denied: shell not granted to laptop."); } };
  };
  const refused = await upgradeDevice("studio", "2.9.0", reach, quick);
  assert.equal(reportLine(refused),
    "studio: needs a manual step: Permission denied: shell not granted to laptop. To allow it, run on studio: cns peer grant laptop shell. Then run cns upgrade studio again.");
  assert.equal(upgradeExitCode([refused]), 4);
  const away = device();
  away.state.up = false;
  const outcomes: Outcome[] = await Promise.all([upgradeDevice("pi", "2.9.0", away.reach, quick), upgradeDevice("studio", "2.9.0", device().reach, quick)]);
  assert.deepEqual(outcomes.map(reportLine), [
    "pi: unreachable (Cannot connect to pi: connect ECONNREFUSED 192.168.1.9:47381). Later, run cns upgrade pi",
    "studio: upgraded from 2.7.0 to 2.9.0",
  ]);
  assert.equal(upgradeExitCode(outcomes), 1);
});

test("after the restart the upgrade waits for a new daemon on the new cns, and says when none comes", async () => {
  // The service brought the old cns back: a new daemon, the old version.
  const stale = device();
  stale.state.restartsInto = "2.7.0";
  const back = await upgradeDevice("studio", "2.9.0", stale.reach, quick);
  assert.equal(reportLine(back),
    `studio: needs a manual step: mise installed cns 2.9.0 (${stale.fresh}), but its daemon came back with cns 2.7.0. There, run ${stale.fresh} status, which says how to restart the daemon on it.`);
  assert.equal(upgradeExitCode([back]), 1);
  // No daemon answers since the restart.
  const gone = device();
  const lost = await upgradeDevice("studio", "2.9.0", async (name) => {
    if (gone.state.pid !== 100) throw new Error("Cannot connect to studio: connect ECONNREFUSED");
    return await gone.reach(name);
  }, { backMs: 2000, sleep: () => new Promise((resolve) => setTimeout(resolve, 100)) });
  assert.equal(reportLine(lost), "studio: unreachable (its daemon has not answered in the 2 seconds since it restarted: Cannot connect to studio: connect ECONNREFUSED). Later, run cns up on studio, whose ~/.cns/restart.log says what happened");
  // The old daemon goes on answering: the restart never happened.
  const stuck = device();
  stuck.state.restartsInto = stuck.state.version;
  const still: Reach = async (name) => { const reached = await stuck.reach(name); return { ...reached, pid: 100 }; };
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", still, quick)), /^studio: needs a manual step: mise installed cns 2\.9\.0 \(.*\), but its daemon did not restart in 0 seconds\./);
});
