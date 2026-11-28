import { z } from "zod";
import { AuthError } from "../auth.js";
import { errorMessage, printable } from "../errors.js";
import { explainDenial, listPeers, resolvePeer } from "../peers.js";
import type { RunResult } from "../shell.js";
import { plain } from "../terminal.js";
import { CNS_VERSION, compareVersions, describeVersion, reportedVersion } from "../version.js";
import { connectDevice } from "./connect-device.js";

/**
 * `cns upgrade`: upgrade cns on paired devices from here, each through the shell grant it gives
 * this device, with the commands cns run would run there: mise installs the release, then the
 * new cns restarts the daemon through the restart worker, as `cns daemon restart` does, so that
 * no device is left without a daemon. Nix and unknown installs are left alone, with what to run.
 */

/** The mise tool that installs cns from its GitHub releases. */
export const MISE_TOOL = "github:thehumanworks/capnshell";
const LATEST_RELEASE = "https://api.github.com/repos/thehumanworks/capnshell/releases/latest";

/**
 * A release's version as cns puts it on other devices' command lines: three numbers and two dots,
 * nothing that Bash, PowerShell or cmd reads as anything else. Prereleases are not taken.
 */
export function releaseVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : undefined;
}

/**
 * The latest release's version, from GitHub; throws with the reason when there is none to be had,
 * as offline. CNS_RELEASES replaces the URL for development and tests, or turns the check off.
 */
export async function latestRelease(timeoutMs = 10_000): Promise<string> {
  const url = process.env.CNS_RELEASES || LATEST_RELEASE;
  if (url === "off") throw new Error("CNS_RELEASES is off");
  let tag: unknown;
  try {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "cns" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    tag = ((await response.json()) as { tag_name?: unknown } | null)?.tag_name;
  } catch (error) { throw new Error(`cannot ask GitHub: ${errorMessage(error)}`, { cause: error }); }
  const version = releaseVersion(typeof tag === "string" ? tag.replace(/^v/, "") : undefined);
  if (!version) throw new Error(`the latest release is not named vX.Y.Z: ${printable(String(tag)).slice(0, 40)}`);
  return version;
}

/** How cns came to a device, told by the executable its daemon runs. */
export type InstallPath = "mise" | "nix" | "unknown";

export function installPath(executable: string | undefined): InstallPath {
  if (executable === undefined) return "unknown";
  if (executable.startsWith("/nix/store/")) return "nix";
  // mise's GitHub backend keeps each version in installs/github-thehumanworks-capnshell/VERSION, wherever its data directory is.
  return /[\\/]installs[\\/]github-thehumanworks-capnshell[\\/]/i.test(executable) ? "mise" : "unknown";
}

type Shell = "Bash" | "PowerShell";

/** One word for the device's shell, in single quotes, inside which Bash and PowerShell read nothing. */
export function shellWord(word: string, shell: Shell): string {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(word)) throw new Error(`${printable(word)} holds control characters, which cannot go on a command line.`);
  // PowerShell also ends a string at the typographic single quotes; doubling escapes each.
  return shell === "Bash" ? `'${word.replaceAll("'", "'\\''")}'` : `'${word.replace(/['‘-‛]/g, "$&$&")}'`;
}

/**
 * The command line that runs `program` on the device and exits with its status. PowerShell would
 * exit 1 for any failure, and 0 for a program it did not find, which this makes 127 as in Bash.
 */
export function commandLine(shell: Shell, program: string, args: string[]): string {
  const line = [program, ...args].join(" ");
  return shell === "Bash" ? line : `& ${line}; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE`;
}

/** What `cns status --json` says, as far as the upgrade reads it. */
const statusSchema = z.object({
  version: z.unknown().transform((value) => reportedVersion(value)),
  daemon: z.object({ executable: z.string().max(4096).nullish() }).nullish(),
  // Absent before cns 2.9.0: that cns cannot say whether its service runs another one.
  service: z.object({ managedByNix: z.boolean(), runsThis: z.boolean() }).nullish(),
});

export function statusFacts(text: string): z.infer<typeof statusSchema> | undefined {
  try { return statusSchema.parse(JSON.parse(text)); } catch { return undefined; }
}

/** The path `mise which` prints: absolute, on one line. */
function executablePath(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/).pop()?.trim();
  return line && /^(\/|[A-Za-z]:\\)/.test(line) && !/[\u0000-\u001f\u007f-\u009f]/.test(line) ? line : undefined;
}

/** A paired device as each step reaches it: over its shell grant, as cns run does. */
export interface Device {
  platform: NodeJS.Platform;
  shell: Shell;
  /** Its daemon's version and process, as the link's handshake reports them. */
  version?: string;
  pid: number;
  run(command: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>;
  close(): void;
}

export type Reach = (name: string) => Promise<Device>;

/** What became of one device, or for --dry-run, what would. */
export type Outcome =
  | { device: string; result: "upgraded"; from?: string; to: string }
  | { device: string; result: "current"; version: string }
  | { device: string; result: "manual"; reason: string; next: string }
  | { device: string; result: "unreachable"; reason: string; later: string }
  | { device: string; result: "planned"; from?: string; to: string; steps: string[] };

/** The report's line for one device. */
export function reportLine(outcome: Outcome): string {
  const { device } = outcome;
  const from = (version: string | undefined) => version ?? "a cns too old to report its version";
  switch (outcome.result) {
    case "upgraded": return `${device}: upgraded from ${from(outcome.from)} to ${outcome.to}`;
    case "current": return `${device}: already current (${outcome.version})`;
    case "manual": return `${device}: needs a manual step: ${outcome.reason}. ${outcome.next}`;
    case "unreachable": return `${device}: unreachable (${outcome.reason}). Later, run ${outcome.later}`;
    case "planned": return `${device}: would upgrade from ${from(outcome.from)} to ${outcome.to}: ${outcome.steps.join(", then ")}`;
  }
}

/** How long a step may take on the device; mise downloads the release. */
const STEP_MS = 60_000;
const MISE_MS = 10 * 60_000;
/** How long a restarted daemon has to come back with the new cns. */
const BACK_MS = 60_000;
const RESTART_THERE = "then restart its daemon on it (cns status there says how)";

export interface UpgradeOptions {
  dryRun?: boolean;
  backMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure of the step that `program` ran, for the report. */
function why(result: { code: number | null; stdout: string; stderr: string }, program: string): string {
  if (result.code === 127) return /[\\/]/.test(program) ? `${printable(program)} is not there` : `${program} is not on its daemon's PATH`;
  const line = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).pop()?.trim();
  return line ? printable(line).slice(0, 200).replace(/\.$/, "") : `exit ${result.code}`;
}

/** An error reaching the device or running a step: refused, so a person must act, or no answer. */
function failed(device: string, error: unknown): Outcome {
  const message = printable(errorMessage(error));
  if (error instanceof AuthError || /^Permission denied/.test(message)) {
    return { device, result: "manual", reason: explainDenial(message, device).replace(/\.$/, ""), next: `Then run cns upgrade ${device} again.` };
  }
  return { device, result: "unreachable", reason: message.replace(/\.$/, ""), later: `cns upgrade ${device}` };
}

/**
 * Upgrade cns on one paired device to `target`, a releaseVersion. Reading what the device runs
 * changes nothing there, so --dry-run does that much. Only a cns that mise installed is upgraded,
 * with the exact version, which mise installs even while it holds back a new release as latest.
 */
export async function upgradeDevice(name: string, target: string, reach: Reach, options: UpgradeOptions = {}): Promise<Outcome> {
  let device: Device;
  try { device = await reach(name); } catch (error) { return failed(name, error); }
  const from = device.version;
  let restarted: { path: string; version: string };
  try {
    // The daemon is what other devices use, whatever cns comes first on PATH there.
    if (from !== undefined && compareVersions(from, target) >= 0) return { device: name, result: "current", version: from };
    const word = (value: string) => shellWord(value, device.shell);
    const run = (program: string, args: string[], timeoutMs = STEP_MS) => device.run(commandLine(device.shell, program, args), timeoutMs);
    const probe = await run("cns", ["status", "--json"]);
    const executable = probe.code === 0 ? statusFacts(probe.stdout)?.daemon?.executable ?? undefined : undefined;
    const how = installPath(executable);
    if (how === "nix") {
      const rebuild = device.platform === "darwin" ? "darwin-rebuild switch --flake ." : "sudo nixos-rebuild switch --flake .";
      return { device: name, result: "manual", reason: "Nix manages cns there", next: `In its flake directory, run nix flake update cns, then ${rebuild} (home-manager switch --flake . for Home Manager).` };
    }
    if (how === "unknown") {
      const runs = executable ? `its daemon runs ${printable(executable)}` : "cns status --json there does not say what its daemon runs";
      return { device: name, result: "manual", reason: `cns cannot tell how cns was installed there: ${runs}`, next: `There, install cns ${target}, ${RESTART_THERE}.` };
    }
    const tool = `${MISE_TOOL}@${target}`;
    if (options.dryRun) {
      return { device: name, result: "planned", from, to: target, steps: [`mise use -g ${tool}`, "restart its daemon on the new cns: cns up --install where a service runs the old one, else cns daemon restart"] };
    }
    const manual = (reason: string) => ({ device: name, result: "manual", reason, next: `There, run mise use -g ${tool}, ${RESTART_THERE}.` }) as const;
    const installed = await run("mise", ["use", "-g", word(tool)], MISE_MS);
    if (installed.code !== 0) return manual(`mise use -g ${tool} failed (${why(installed, "mise")})`);
    const which = await run("mise", ["which", "cns", "--tool", word(tool)]);
    const path = which.code === 0 ? executablePath(which.stdout) : undefined;
    if (!path) return manual(`mise did not say where it installed cns ${target} (${why(which, "mise")})`);
    const status = await run(word(path), ["status", "--json"]);
    const facts = status.code === 0 ? statusFacts(status.stdout) : undefined;
    if (!facts?.version) return manual(`the cns mise installed, ${printable(path)}, does not run (${why(status, path)})`);
    // A service keeps the cns it names, so only cns up --install, from the new cns, moves it onto that one.
    const restart = facts.service && !facts.service.managedByNix && !facts.service.runsThis ? ["up", "--install"] : ["daemon", "restart"];
    restarted = { path, version: facts.version };
    let ran: Awaited<ReturnType<Device["run"]>> | undefined;
    // Both hand the restart to a process of their own, which outlives this command and the daemon.
    try { ran = await run(word(path), restart); } catch { /* The link may drop as the daemon restarts; what answers next tells. */ }
    if (ran && ran.code !== 0) return manual(`cns ${restart.join(" ")} failed (${why(ran, path)})`);
  } catch (error) { return failed(name, error); }
  finally { device.close(); }
  return settled(name, from, device.pid, restarted, reach, options);
}

/** Once the restart is under way: wait for another daemon to answer with the new cns. */
async function settled(name: string, from: string | undefined, pid: number, restarted: { path: string; version: string }, reach: Reach, options: UpgradeOptions): Promise<Outcome> {
  const { backMs = BACK_MS, sleep = wait } = options;
  const deadline = Date.now() + backMs;
  let seen: { pid: number; version?: string } | undefined;
  let reason = "";
  for (;;) {
    await sleep(1000);
    try {
      const device = await reach(name);
      device.close();
      if (device.pid !== pid && device.version === restarted.version) return { device: name, result: "upgraded", from, to: restarted.version };
      seen = { pid: device.pid, version: device.version };
    } catch (error) { reason = printable(errorMessage(error)).replace(/\.$/, ""); }
    if (Date.now() >= deadline) break;
  }
  const since = `${Math.round(backMs / 1000)} seconds`;
  if (!seen) return { device: name, result: "unreachable", reason: `its daemon has not answered in the ${since} since it restarted${reason ? `: ${reason}` : ""}`, later: `cns up on ${name}, whose ~/.cns/restart.log says what happened` };
  const daemon = seen.pid === pid ? `its daemon did not restart in ${since}` : `its daemon came back with ${describeVersion(seen.version)}`;
  return { device: name, result: "manual", reason: `mise installed cns ${restarted.version} (${printable(restarted.path)}), but ${daemon}`, next: `There, run ${printable(restarted.path)} status, which says how to restart the daemon on it.` };
}

/** Reach a paired device as cns run does: through the local daemon's link to it, else by dialing it. */
async function reachDevice(name: string): Promise<Device> {
  const connection = await connectDevice(resolvePeer(name), AbortSignal.timeout(20_000));
  const { info } = connection;
  return {
    platform: info.platform, shell: info.shell, pid: info.pid, ...info.version ? { version: info.version } : {},
    async run(command, timeoutMs) {
      const result = await plain(connection.remote.run(command, { timeoutMs }) as unknown as Promise<RunResult>);
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    close: connection.close,
  };
}

/** `cns upgrade DEVICE` or `cns upgrade --all`: upgrade cns there to the latest release, and say what became of each device. */
export async function upgrade(name: string | undefined, options: { all?: boolean; dryRun?: boolean }): Promise<void> {
  if ((name === undefined) === !options.all) throw new Error("Name one paired device, or --all for every one: cns upgrade DEVICE, or cns upgrade --all.");
  const devices = name === undefined ? listPeers().map((peer) => peer.name) : [resolvePeer(name).name];
  if (!devices.length) { console.error("No paired devices. Run cns pair to pair with another device."); return; }
  let target: string;
  try { target = await latestRelease(); }
  catch (error) { throw new Error(`Cannot learn the latest cns release (${errorMessage(error)}). Try again once this device reaches GitHub.`, { cause: error }); }
  console.error(`${options.dryRun ? "Checking" : "Upgrading"} ${devices.join(", ")} ${options.dryRun ? "against" : "to"} cns ${target}, the latest release.`);
  const outcomes = await Promise.all(devices.map((device) => upgradeDevice(device, target, reachDevice, { dryRun: options.dryRun })));
  for (const outcome of outcomes) console.log(reportLine(outcome));
  if (compareVersions(CNS_VERSION, target) < 0) console.error(`This device runs cns ${CNS_VERSION}: upgrade it here too, then restart its daemon (cns status says how).`);
  if (outcomes.some((outcome) => outcome.result === "manual" || outcome.result === "unreachable")) process.exitCode = 1;
}
