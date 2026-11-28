import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateIdentity } from "../identity.js";
import { revokeDevice, savePairedPeer } from "../peers.js";
import { CNS_VERSION } from "../version.js";
import { commandLine, fleet, installPath, MISE_TOOL, miseToolsHolding, reachDevice, reportLine, shellWord, statusFacts, toolName, upgrade, upgradeDevice, upgradeExitCode, type Device, type Outcome, type Reach } from "./upgrade.js";

test("the path of its daemon's executable alone tells Nix, and mise's own directory for the tool", () => {
  assert.equal(installPath("/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.7.0/cns"), "mise");
  assert.equal(installPath("/opt/mise-data/installs/github-thehumanworks-capnshell/2.7.0/cns"), "mise");
  assert.equal(installPath("C:\\Users\\a\\AppData\\Local\\mise\\installs\\github-thehumanworks-capnshell\\2.7.0\\cns.exe"), "mise");
  assert.equal(installPath("/nix/store/abc-cns-2.7.0/bin/cns"), "nix");
  // A tool alias, or another backend, is another directory: only mise can say what it holds.
  assert.equal(installPath("/home/a/.local/share/mise/installs/cns/2.7.0/cns"), "unknown");
  assert.equal(installPath("/usr/local/bin/cns"), "unknown");
  assert.equal(installPath("/home/a/src/capnshell/src/cli.ts"), "unknown");
  assert.equal(installPath(undefined), "unknown");
});

test("mise's listing says which tool installed the daemon's cns, by the name its config gives it, on each platform", () => {
  const linux = "/home/a/.local/share/mise/installs";
  const at = (name: string, ...paths: string[]) => ({ [name]: paths.map((install_path) => ({ install_path })) });
  // No alias, as mise use -g github:thehumanworks/capnshell@2.7.0 installs it; a [tool_alias] (or [alias]) named cns; a custom MISE_DATA_DIR.
  assert.deepEqual(miseToolsHolding(at(MISE_TOOL, `${linux}/github-thehumanworks-capnshell/2.7.0`), `${linux}/github-thehumanworks-capnshell/2.7.0/cns`, "linux"), [MISE_TOOL]);
  assert.deepEqual(miseToolsHolding({ ...at("node", `${linux}/node/24.0.0`), ...at("cns", `${linux}/cns/2.6.0`, `${linux}/cns/2.7.0`) }, `${linux}/cns/2.7.0/cns`, "linux"), ["cns"]);
  assert.deepEqual(miseToolsHolding(at("cns", "/opt/mise-data/installs/cns/2.7.0"), "/opt/mise-data/installs/cns/2.7.0/cns", "linux"), ["cns"]);
  assert.deepEqual(miseToolsHolding(at("cns", "/Users/a/.local/share/mise/installs/cns/2.7.0"), "/Users/a/.local/share/mise/installs/cns/2.7.0/cns", "darwin"), ["cns"]);
  // mise's identity layout, as mise 2026.11.14 lists it: the daemon's executable, its real path, is in the installation itself.
  assert.deepEqual(miseToolsHolding(at("cns", `${linux}/capnshell-on3c2hgh`), `${linux}/capnshell-on3c2hgh/cns`, "linux"), ["cns"]);
  // Windows: %LOCALAPPDATA%\mise, with either slash and in any case, and the \\?\ form.
  const windows = "C:\\Users\\a\\AppData\\Local\\mise";
  const listed = at("cns", `${windows}\\installs\\cns\\2.7.0`);
  for (const executable of [`${windows}\\installs\\cns\\2.7.0\\cns.exe`, "c:\\users\\A\\appdata\\local\\MISE\\installs\\cns\\2.7.0\\cns.exe", "C:/Users/a/AppData/Local/mise/installs/cns/2.7.0/cns.exe", `\\\\?\\${windows}\\installs\\cns\\2.7.0\\cns.exe`]) {
    assert.deepEqual(miseToolsHolding(listed, executable, "win32"), ["cns"], executable);
  }
  // There the identity layout keeps installations in mise\i, and a daemon started through the version link, a junction, names the link.
  assert.deepEqual(miseToolsHolding(at("cns", `${windows}\\i\\capnshell-on3c2hgh`), `${windows}\\installs\\cns\\2.7.0\\cns.exe`, "win32"), ["cns"]);
  // A version mise has removed since the daemon started; and MISE_TOOL's own directory, which mise no longer lists.
  assert.deepEqual(miseToolsHolding(at("cns", `${linux}/cns/2.9.0`), `${linux}/cns/2.7.0/cns`, "linux"), ["cns"]);
  assert.deepEqual(miseToolsHolding({}, `${linux}/github-thehumanworks-capnshell/2.7.0/cns`, "linux"), [MISE_TOOL]);
  // Not mise's: elsewhere, another case on Linux, beside a listed directory, or under a root.
  assert.deepEqual(miseToolsHolding(at("cns", `${linux}/cns/2.7.0`), "/usr/local/bin/cns", "linux"), []);
  assert.deepEqual(miseToolsHolding(at("cns", `${linux}/cns/2.7.0`), `${linux}/CNS/2.7.0/cns`, "linux"), []);
  assert.deepEqual(miseToolsHolding(at("Cns", "/opt/tools/c"), "/opt/tools/cns/cns", "linux"), []);
  assert.deepEqual(miseToolsHolding(at("cns", "/", "/opt"), "/opt/cns", "linux"), []);
  assert.deepEqual(miseToolsHolding(at("cns", "C:\\", "C:\\Tools"), "C:\\Tools\\cns.exe", "win32"), []);
  // Another backend is named as mise lists it, for mise tool to tell; two that hold it are both named.
  assert.deepEqual(miseToolsHolding(at("ubi:thehumanworks/capnshell", `${linux}/ubi-thehumanworks-capnshell/2.7.0`), `${linux}/ubi-thehumanworks-capnshell/2.7.0/cns`, "linux"), ["ubi:thehumanworks/capnshell"]);
  assert.deepEqual(miseToolsHolding({ ...at("cns", `${linux}/capnshell-on3c2hgh`), ...at(MISE_TOOL, `${linux}/capnshell-on3c2hgh`) }, `${linux}/capnshell-on3c2hgh/cns`, "linux"), ["cns", MISE_TOOL]);
});

test("only a tool name with no shell or option characters is taken from mise", () => {
  for (const name of ["cns", MISE_TOOL, "my_cns.2", "aqua:a/b", "C-N-S"]) assert.equal(toolName(name), name);
  for (const name of ["", "-g", "--cd=/tmp", "cns@2.9.0", "a b", "a;b", "$(id)", "`id`", "'cns'", "\"cns\"", "c\nns", "c\u202ens", "cns\\x", "%PATH%", "a&b", "a|b", "~", "é", "x".repeat(201)]) {
    assert.equal(toolName(name), undefined, JSON.stringify(name));
  }
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
  /** The daemon's named sessions; null for a daemon too old to say. */
  sessions: string[] | null;
  service: object | null;
  /** The name mise's config gives the tool that installed cns there, such as a [tool_alias], and the backend mise says it comes from. */
  tool: string;
  backend: string;
  answers: Record<string, { code: number; stdout?: string; stderr?: string }>;
}

/** A device as cns upgrade reaches it: a daemon running a cns that mise installed from MISE_TOOL, with no named sessions, unless told otherwise. */
function device(overrides: Partial<Simulated> = {}) {
  const shell = overrides.shell ?? "Bash";
  const windows = shell === "PowerShell";
  const tool = overrides.tool ?? MISE_TOOL;
  const directory = tool.replaceAll(/[:/]/g, "-");
  const fresh = windows ? `C:\\Users\\a\\AppData\\Local\\mise\\installs\\${directory}\\2.9.0\\cns.exe` : `/home/a/.local/share/mise/installs/${directory}/2.9.0/cns`;
  // What mise ls --installed --json lists there: the version the daemon runs.
  const listing = { node: [{ version: "24.0.0", install_path: "/home/a/.local/share/mise/installs/node/24.0.0" }], [tool]: [{ version: "2.7.0", install_path: fresh.replace(/[\\/]cns(\.exe)?$/, "").replace("2.9.0", "2.7.0"), installed: true }] };
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
    if (/^(& )?cns status --json/.test(command)) return status(state.version);
    if (command.includes("mise --version")) return { code: 0, stdout: "2026.11.3 linux-x64 (2026-11-20)" };
    if (command.includes("mise ls --installed --json")) return { code: 0, stdout: JSON.stringify(listing, null, 2) };
    if (command.includes("mise tool ")) return { code: 0, stdout: JSON.stringify({ backend: overrides.backend ?? MISE_TOOL, installed_versions: ["2.7.0"] }) };
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
      platform: overrides.platform ?? (windows ? "win32" : "linux"), shell, version: state.version,
      run: async (command) => { state.commands.push(command); const result = answer(command); return { stdout: "", stderr: "", ...result }; },
      close() {},
    };
    return reached;
  };
  return { state, reach, fresh };
}

const quick = { backMs: 0, sleep: async () => {} };
/** What cns upgrade asks mise before it changes anything there: its version, what it installed, and the backend of the tool that holds the daemon's cns. */
const asks = (tool = MISE_TOOL) => ["cns status --json", "mise --version", "mise ls --installed --json", `mise tool '${tool}' --json`];

test("a device that runs a cns from mise is upgraded with the exact version, then its daemon restarts on the new cns", async () => {
  const studio = device();
  const outcome = await upgradeDevice("studio", "2.9.0", studio.reach, quick);
  assert.deepEqual(outcome, { device: "studio", result: "upgraded", from: "2.7.0", to: "2.9.0" });
  assert.equal(reportLine(outcome), "studio: upgraded from 2.7.0 to 2.9.0");
  assert.deepEqual(studio.state.commands, [
    ...asks(),
    "mise use -g 'github:thehumanworks/capnshell@2.9.0'",
    "mise which cns --tool 'github:thehumanworks/capnshell@2.9.0'",
    `'${studio.fresh}' status --json`,
    `'${studio.fresh}' daemon restart`,
  ]);
});

test("a cns that mise installed under a tool alias is upgraded by the alias, which moves the alias's version", async () => {
  // [tool_alias] cns = "github:thehumanworks/capnshell", or [alias] before mise 2025.12.11: mise installs it in installs/cns.
  const studio = device({ tool: "cns" });
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", studio.reach, quick)), "studio: upgraded from 2.7.0 to 2.9.0");
  assert.deepEqual(studio.state.commands, [...asks("cns"), "mise use -g 'cns@2.9.0'", "mise which cns --tool 'cns@2.9.0'", `'${studio.fresh}' status --json`, `'${studio.fresh}' daemon restart`]);
  const plan = await upgradeDevice("studio", "2.9.0", device({ tool: "cns" }).reach, { ...quick, dryRun: true });
  assert.match(reportLine(plan), /^studio: would upgrade from 2\.7\.0 to 2\.9\.0: mise use -g cns@2\.9\.0, which pins that version/);
  // GitHub tells no owner or repository apart by case.
  const spelled = device({ tool: "capnshell", backend: "github:TheHumanWorks/CapnShell" });
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", spelled.reach, quick)), "studio: upgraded from 2.7.0 to 2.9.0");
  assert.equal(spelled.state.commands[4], "mise use -g 'capnshell@2.9.0'");
  // On Windows, quoted for PowerShell.
  const pc = device({ shell: "PowerShell", tool: "cns" });
  assert.equal(reportLine(await upgradeDevice("pc", "2.9.0", pc.reach, quick)), "pc: upgraded from 2.7.0 to 2.9.0");
  assert.equal(pc.state.commands[3], "& mise tool 'cns' --json; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE");
  assert.equal(pc.state.commands[4], "& mise use -g 'cns@2.9.0'; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE");
});

test("a tool that mise installs from elsewhere is left as it is, with what to run there", async () => {
  for (const [tool, backend] of [["cns", "github:someone-else/capnshell"], ["cns", "github:thehumanworks/capnshell-fork"], ["ubi:thehumanworks/capnshell", "ubi:thehumanworks/capnshell"]]) {
    const other = device({ tool, backend });
    const outcome = await upgradeDevice("studio", "2.9.0", other.reach, quick);
    assert.equal(reportLine(outcome), `studio: needs a manual step: the mise tool ${tool} that installed its cns comes from ${backend}, not from github:thehumanworks/capnshell. ` +
      `There, point ${tool} at github:thehumanworks/capnshell in mise's config ([tool_alias]) and run cns upgrade studio again, or install cns 2.9.0 yourself, then restart its daemon on it (cns status there says how).`);
    assert.equal(upgradeExitCode([outcome]), 4);
    assert.deepEqual(other.state.commands, asks(tool), "nothing changes there");
  }
});

test("mise output cns cannot read stops the device before anything changes there", async () => {
  const byHand = "There, run mise use -g github:thehumanworks/capnshell@2.9.0, or with the name mise's config gives that tool there (its [tool_alias]), then restart its daemon on it (cns status there says how).";
  const held = { install_path: "/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.7.0" };
  for (const [answers, reason, ran] of [
    [{ "mise ls": { code: 0, stdout: "mise WARN  not JSON" } }, "cns cannot read what mise ls --installed --json printed there", 3],
    [{ "mise ls": { code: 0, stdout: JSON.stringify([held]) } }, "cns cannot read what mise ls --installed --json printed there", 3],
    [{ "mise ls": { code: 2, stderr: "error: unexpected argument '--installed' found" } }, "mise ls --installed --json failed (error: unexpected argument '--installed' found)", 3],
    [{ "mise tool": { code: 0, stdout: JSON.stringify({ name: "cns" }) } }, "cns cannot read what mise tool github:thehumanworks/capnshell --json printed there", 4],
    [{ "mise tool": { code: 1, stderr: "mise ERROR cns not found in mise tool registry" } }, "mise tool github:thehumanworks/capnshell --json failed (mise ERROR cns not found in mise tool registry)", 4],
  ] as const) {
    const odd = device({ answers });
    const outcome = await upgradeDevice("studio", "2.9.0", odd.reach, quick);
    assert.equal(reportLine(outcome), `studio: needs a manual step: ${reason}. ${byHand}`);
    assert.equal(outcome.result, "failed");
    assert.equal(odd.state.commands.length, ran, "nothing runs after it");
  }
  // mise --version only says that mise is there: whatever it prints, the listing decides.
  const odd = device({ answers: { "mise --version": { code: 0, stdout: "mise, the front-end to your dev env" } } });
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", odd.reach, quick)), "studio: upgraded from 2.7.0 to 2.9.0");
});

test("a tool name from mise reaches the command line only when it holds no shell or option characters", async () => {
  const held = [{ install_path: "/home/a/.local/share/mise/installs/github-thehumanworks-capnshell/2.7.0" }];
  for (const name of ["cns'; touch /tmp/pwned; '", "$(touch pwned)", "--cd=/tmp", "cns‮"]) {
    const odd = device({ answers: { "mise ls": { code: 0, stdout: JSON.stringify({ [name]: held }) } } });
    const outcome = await upgradeDevice("studio", "2.9.0", odd.reach, quick);
    assert.equal(outcome.result, "failed");
    assert.match(reportLine(outcome), /^studio: needs a manual step: mise there names the tool that installed cns .*, which cns does not put on a command line\. /);
    assert.doesNotMatch(reportLine(outcome), /‮/);
    assert.deepEqual(odd.state.commands, ["cns status --json", "mise --version", "mise ls --installed --json"]);
  }
  // Two tools that hold it: cns cannot say which one mise's config means.
  const both = device({ answers: { "mise ls": { code: 0, stdout: JSON.stringify({ cns: held, [MISE_TOOL]: held }) } } });
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", both.reach, quick)), /: its daemon runs \S+, which mise there lists under several tools: cns, github:thehumanworks\/capnshell\. There, run mise use -g /);
  assert.equal(both.state.commands.length, 3);
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
    ...asks().map((command) => `& ${command}${status}`),
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
  assert.equal(reportLine(plan), `studio: would upgrade from 2.7.0 to 2.9.0: ${pins}, then cns up --install from the new cns if a service runs the old one, else cns daemon restart, which ends any open shells`);
  assert.deepEqual(studio.state.commands, asks());
  assert.equal(studio.state.pid, 100);
  assert.equal(upgradeExitCode([plan]), 0);
  // Without mise there, the upgrade would fail: the plan says so.
  const noMise = device({ answers: { "mise --version": { code: 127, stderr: "bash: mise: command not found" } } });
  const failing = await upgradeDevice("box", "2.9.0", noMise.reach, { ...quick, dryRun: true });
  assert.equal(reportLine(failing), "box: needs a manual step: mise --version failed (mise is not on its daemon's PATH). There, run mise use -g github:thehumanworks/capnshell@2.9.0, or with the name mise's config gives that tool there (its [tool_alias]), then restart its daemon on it (cns status there says how).");
  assert.equal(upgradeExitCode([plan, failing]), 1);
  // A cns elsewhere, with no mise to ask: cns cannot tell how it came there.
  const elsewhere = device({ executable: "/usr/local/bin/cns", answers: { "mise --version": { code: 127, stderr: "bash: mise: command not found" } } });
  assert.equal(reportLine(await upgradeDevice("box", "2.9.0", elsewhere.reach, { ...quick, dryRun: true })),
    "box: needs a manual step: cns cannot tell how cns was installed there: its daemon runs /usr/local/bin/cns, and mise --version failed there (mise is not on its daemon's PATH). There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
});

test("a daemon with named sessions, or too old to say, is left alone unless --end-sessions, and the plan names them", async () => {
  const busy = device({ sessions: ["build", "shell-1"] });
  const left = await upgradeDevice("studio", "2.9.0", busy.reach, quick);
  assert.equal(reportLine(left), "studio: needs a manual step: restarting its daemon would end its named sessions build, shell-1. To end them and upgrade, run cns upgrade studio --end-sessions.");
  assert.deepEqual(busy.state.commands, asks(), "only reads");
  assert.equal(upgradeExitCode([left]), 4);
  assert.match(reportLine(await upgradeDevice("studio", "2.9.0", busy.reach, { ...quick, dryRun: true, endSessions: true })),
    /, then cns up --install from the new cns if a service runs the old one, else cns daemon restart, which ends its named sessions build, shell-1 and any open shells$/);
  assert.equal(reportLine(await upgradeDevice("studio", "2.9.0", busy.reach, { ...quick, endSessions: true })), "studio: upgraded from 2.7.0 to 2.9.0");

  const old = device({ sessions: null });
  assert.equal(reportLine(await upgradeDevice("pi", "2.9.0", old.reach, quick)),
    "pi: needs a manual step: its daemon, cns 2.7.0, cannot say whether it holds named sessions, which restarting it would end. To end any and upgrade, run cns upgrade pi --end-sessions. Once is enough: the new cns names its sessions.");
  assert.match(reportLine(await upgradeDevice("pi", "2.9.0", old.reach, { ...quick, dryRun: true, endSessions: true })), /, which ends any named sessions it holds and any open shells$/);

  // A session started while mise installed the release: the new cns sees it, and nothing restarts.
  const late = device({ answers: { "2.9.0/cns' status --json": { code: 0, stdout: JSON.stringify({ version: "2.9.0", daemon: { version: "2.9.0-rc.1", sessions: ["agent"] }, service: null }) } }, version: "2.9.0-rc.1" });
  const started = await upgradeDevice("studio", "2.9.0", late.reach, quick);
  assert.equal(reportLine(started), "studio: needs a manual step: restarting its daemon would end its named sessions agent. To end them and upgrade, run cns upgrade studio --end-sessions.");
  assert.equal(late.state.pid, 100, "not restarted");
  assert.equal(late.state.commands.length, 7);
});

test("the cns mise gives must be the release, or nothing restarts", async () => {
  const other = device({ answers: { "2.9.0/cns' status --json": { code: 0, stdout: JSON.stringify({ version: "2.8.9", daemon: { sessions: [] }, service: null }) } } });
  const outcome = await upgradeDevice("studio", "2.9.0", other.reach, quick);
  assert.equal(reportLine(outcome), `studio: needs a manual step: the cns mise gave for 2.9.0, ${other.fresh}, is cns 2.8.9. There, mise ls github:thehumanworks/capnshell lists what mise has; run mise install --force github:thehumanworks/capnshell@2.9.0, then restart its daemon on it (cns status there says how).`);
  assert.equal(outcome.result, "failed");
  assert.equal(other.state.pid, 100);
});

test("the report's lines carry no control, format or separator characters a device sent", async () => {
  const sneaky = device({ executable: "/usr/local/bin/cns\u202e\u2028\u200b\u0007x" });
  assert.equal(reportLine(await upgradeDevice("box", "2.9.0", sneaky.reach, quick)),
    "box: needs a manual step: cns cannot tell how cns was installed there: its daemon runs /usr/local/bin/cns????x, which no tool that mise lists there holds. There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
  const backend = device({ tool: "cns", backend: "github:evil/\u202ecns\u2066\u0007" });
  assert.match(reportLine(await upgradeDevice("box", "2.9.0", backend.reach, quick)), /comes from github:evil\/\?cns\?\?, not from /);
});

test("--all leaves out the cns gateway, with a line for it, and names the mesh each device came from", () => {
  const { devices, named, skipped } = fleet([{ name: "gw", mesh: "home", gateway: true }, { name: "nas", mesh: "home" }, { name: "studio" }]);
  assert.deepEqual(devices, ["nas", "studio"]);
  assert.deepEqual(named, ["nas (from mesh home)", "studio"]);
  assert.deepEqual(skipped.map(reportLine), ["gw: not upgraded here: it is the cns gateway, a Worker to deploy again after upgrading cns (gateway/README.md)"]);
  assert.equal(upgradeExitCode(skipped), 0);
});

test("cns upgrade reaches the saved devices, never the cns gateway or a device removed here", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-upgrade-fleet-")));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ tag_name: `v${CNS_VERSION}` }) });
  const saved = { CNS_CONFIG_DIR: process.env.CNS_CONFIG_DIR, CNS_RELEASES: process.env.CNS_RELEASES };
  t.after(async () => {
    for (const name of ["CNS_CONFIG_DIR", "CNS_RELEASES"] as const) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });
  process.env.CNS_CONFIG_DIR = dir;
  process.env.CNS_RELEASES = `http://127.0.0.1:${server.port}/latest`;
  const record = (publicKey: string, more: { mesh?: string; gateway?: true } = {}) => ({ publicKey, addresses: ["ws://127.0.0.1:9"], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: ["shell" as const] }, ...more });
  savePairedPeer("gw", record(generateIdentity().publicKey, { mesh: "home", gateway: true }));
  savePairedPeer("nas", record(generateIdentity().publicKey, { mesh: "home" }));
  savePairedPeer("studio", record(generateIdentity().publicKey));
  // Removed here, its record left over, as from a backup.
  const lost = generateIdentity();
  savePairedPeer("phone", record(lost.publicKey));
  revokeDevice(lost.fingerprint, lost.publicKey);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => printed.push(line));
  t.mock.method(console, "error", (line: string) => printed.push(line));
  const reached: string[] = [];
  const reach: Reach = async (name) => { reached.push(name); throw new Error(`Cannot connect to ${name}.`); };

  assert.equal(await upgrade(undefined, { all: true }, reach), 1);
  assert.deepEqual(reached.sort(), ["nas", "studio"]);
  assert.deepEqual(printed.slice(0, 2), [
    "gw: not upgraded here: it is the cns gateway, a Worker to deploy again after upgrading cns (gateway/README.md)",
    `Upgrading nas (from mesh home), studio to cns ${CNS_VERSION}, the latest release.`,
  ]);
  assert.deepEqual(printed.slice(2).sort(), ["nas: unreachable (Cannot connect to nas). Later, run cns upgrade nas", "studio: unreachable (Cannot connect to studio). Later, run cns upgrade studio"]);

  // Named, the gateway is still not dialed, and the removed device is refused as other commands refuse it.
  reached.length = 0;
  printed.length = 0;
  assert.equal(await upgrade("gw", {}, reach), 0);
  assert.deepEqual(printed, ["gw: not upgraded here: it is the cns gateway, a Worker to deploy again after upgrading cns (gateway/README.md)"]);
  await assert.rejects(upgrade("phone", {}, reach), /^Error: phone was removed from this device \(cns peer remove\), so cns does not connect to it\. To delete the record of it left here, run: cns peer remove phone\./);
  assert.deepEqual(reached, []);
});

test("a device that does not answer a step is given up on soon after the step's limit", async () => {
  const silent = { remote: { run: () => new Promise(() => {}) }, info: { platform: "linux", shell: "Bash", version: "2.7.0" }, close() {} };
  const reached = await reachDevice("studio", async () => silent as never, 50);
  const started = Date.now();
  await assert.rejects(reached.run("cns status --json", 100), /^Error: no answer within 0\.15 seconds$/);
  assert.ok(Date.now() - started < 2000);
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
    "box: needs a manual step: cns cannot tell how cns was installed there: its daemon runs /usr/local/bin/cns, which no tool that mise lists there holds. There, install cns 2.9.0, then restart its daemon on it (cns status there says how).");
  assert.deepEqual(manual.state.commands, ["cns status --json", "mise --version", "mise ls --installed --json"]);
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
  assert.equal(noMise.state.commands.length, 5);
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
    assert.equal(odd.state.commands.length, 6, "nothing runs after it");
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

test("after the restart the upgrade waits for a daemon on the new cns, and says when none comes", async () => {
  // The service brought the old cns back, or the restart never happened: the old version answers.
  const stale = device();
  stale.state.restartsInto = "2.7.0";
  const back = await upgradeDevice("studio", "2.9.0", stale.reach, quick);
  assert.equal(reportLine(back),
    `studio: needs a manual step: mise installed cns 2.9.0 (${stale.fresh}), but its daemon still runs cns 2.7.0 0 seconds later. There, run ${stale.fresh} status, which says how to restart the daemon on it.`);
  assert.equal(upgradeExitCode([back]), 1);
  // No daemon answers since the restart.
  const gone = device();
  const lost = await upgradeDevice("studio", "2.9.0", async (name) => {
    if (gone.state.pid !== 100) throw new Error("Cannot connect to studio: connect ECONNREFUSED");
    return await gone.reach(name);
  }, { backMs: 2000, sleep: () => new Promise((resolve) => setTimeout(resolve, 100)) });
  assert.equal(reportLine(lost), "studio: unreachable (its daemon has not answered in the 2 seconds since it restarted: Cannot connect to studio: connect ECONNREFUSED). Later, run cns up on studio, whose ~/.cns/restart.log says what happened");
});
