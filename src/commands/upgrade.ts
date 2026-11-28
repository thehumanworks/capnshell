import { z } from "zod";
import { AuthError } from "../auth.js";
import { errorMessage, printable, strictlyPrintable } from "../errors.js";
import { explainDenial, getPeer, reachablePeers, resolvePeer, type PeerEntry } from "../peers.js";
import { latestRelease } from "../releases.js";
import type { RunResult } from "../shell.js";
import { plain } from "../terminal.js";
import { CNS_VERSION, compareVersions, describeVersion, reportedVersion } from "../version.js";
import { connectDevice, type DeviceConnection } from "./connect-device.js";

/**
 * `cns upgrade`: upgrade cns on paired devices from here, each through the shell grant it gives
 * this device, with the commands cns run would run there: mise installs the release, then the
 * new cns restarts the daemon through the restart worker, as `cns daemon restart` does, so that
 * no device is left without a daemon. Nix and unknown installs are left alone, with what to run,
 * and so is a daemon whose named sessions the restart would end, unless --end-sessions.
 */

/** The mise tool that installs cns from its GitHub releases. */
export const MISE_TOOL = "github:thehumanworks/capnshell";

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
  daemon: z.object({
    executable: z.string().max(4096).nullish(),
    // Absent from a cns too old to report them, whose daemon cannot say which named sessions a restart would end.
    sessions: z.array(z.string().max(200)).max(1000).nullish(),
  }).nullish(),
  // Absent from a cns too old to report it, which cannot say whether its service runs another one.
  service: z.object({ managedByNix: z.boolean(), runsThis: z.boolean() }).nullish(),
});

export function statusFacts(text: string): z.infer<typeof statusSchema> | undefined {
  try { return statusSchema.parse(JSON.parse(text)); } catch { return undefined; }
}

/** The path `mise which` prints: absolute, on one line. */
function executablePath(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/).pop()?.trim();
  return line && /^(\/|[A-Za-z]:[\\/])/.test(line) && !/[\u0000-\u001f\u007f-\u009f]/.test(line) ? line : undefined;
}

/** A paired device as each step reaches it: over its shell grant, as cns run does. */
export interface Device {
  platform: NodeJS.Platform;
  shell: Shell;
  /** Its daemon's version, as the link's handshake reports it. */
  version?: string;
  run(command: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>;
  close(): void;
}

export type Reach = (name: string) => Promise<Device>;

/** What became of one device, or for --dry-run, what would. */
export type Outcome =
  | { device: string; result: "upgraded"; from?: string; to: string }
  | { device: string; result: "current"; version: string }
  /** Left for a person to act on: Nix, an install cns cannot tell, a refused grant, or named sessions. */
  | { device: string; result: "manual"; reason: string; next: string }
  /** A step failed there. */
  | { device: string; result: "failed"; reason: string; next: string }
  | { device: string; result: "unreachable"; reason: string; later: string }
  | { device: string; result: "planned"; from?: string; to: string; steps: string[] }
  /** Not a device cns upgrades, such as the cns gateway. */
  | { device: string; result: "skipped"; reason: string };

/** The report's line for one device. */
export function reportLine(outcome: Outcome): string {
  const { device } = outcome;
  const line = (() => {
    switch (outcome.result) {
      case "upgraded": return `${device}: upgraded from ${outcome.from ?? describeVersion(undefined)} to ${outcome.to}`;
      case "current": return `${device}: already current (${outcome.version})`;
      case "manual": case "failed": return `${device}: needs a manual step: ${outcome.reason}. ${outcome.next}`;
      case "unreachable": return `${device}: unreachable (${outcome.reason}). Later, run ${outcome.later}`;
      case "planned": return `${device}: would upgrade from ${outcome.from ?? describeVersion(undefined)} to ${outcome.to}: ${outcome.steps.join(", then ")}`;
      case "skipped": return `${device}: not upgraded here: ${outcome.reason}`;
    }
  })();
  // Devices chose much of it: each character shows as itself.
  return strictlyPrintable(line);
}

/** As for cns peer remove --everywhere: 1 when a device did not answer or a step failed, else 4 when one is left for a person, else 0. */
export function upgradeExitCode(outcomes: readonly Outcome[]): number {
  if (outcomes.some((outcome) => outcome.result === "failed" || outcome.result === "unreachable")) return 1;
  return outcomes.some((outcome) => outcome.result === "manual") ? 4 : 0;
}

/** How long a step may take on the device, so that one device that never answers holds up --all for minutes, not more; mise downloads the release. */
const STEP_MS = 15_000;
const MISE_MS = 3 * 60_000;
/** How long a restarted daemon has to come back with the new cns. */
const BACK_MS = 60_000;
const RESTART_THERE = "then restart its daemon on it (cns status there says how)";

export interface UpgradeOptions {
  dryRun?: boolean;
  /** Restart a daemon even though that ends its named sessions. */
  endSessions?: boolean;
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
function fault(device: string, error: unknown): Outcome {
  const message = printable(errorMessage(error));
  if (error instanceof AuthError || /^Permission denied/.test(message)) {
    return { device, result: "manual", reason: explainDenial(message, device).replace(/\.$/, ""), next: `Then run cns upgrade ${device} again.` };
  }
  return { device, result: "unreachable", reason: message.replace(/\.$/, ""), later: `cns upgrade ${device}` };
}

/** What to run on a device whose cns Nix manages. */
function nixSteps(platform: NodeJS.Platform): string {
  const rebuild = platform === "darwin" ? "sudo darwin-rebuild switch --flake ." : "sudo nixos-rebuild switch --flake .";
  return "In its flake directory, run nix flake update capnshell (use your flake's name for this input if it differs, for example cns), " +
    `then ${rebuild} (home-manager switch --flake . for Home Manager); or, for a nix profile install: nix profile upgrade capnshell, then cns daemon restart.`;
}

/**
 * Upgrade cns on one paired device to `target`, a releaseVersion. Reading what the device runs
 * changes nothing there, so --dry-run does that much. Only a cns that mise installed is upgraded,
 * with the exact version, which mise installs even while it holds back a new release as latest.
 */
export async function upgradeDevice(name: string, target: string, reach: Reach, options: UpgradeOptions = {}): Promise<Outcome> {
  let device: Device;
  try { device = await reach(name); } catch (error) { return fault(name, error); }
  const from = device.version;
  try {
    // The daemon is what other devices use, whatever cns comes first on PATH there.
    if (from !== undefined && compareVersions(from, target) >= 0) return { device: name, result: "current", version: from };
    const word = (value: string) => shellWord(value, device.shell);
    const run = (program: string, args: string[], timeoutMs = STEP_MS) => device.run(commandLine(device.shell, program, args), timeoutMs);
    const probe = await run("cns", ["status", "--json"]);
    const facts = probe.code === 0 ? statusFacts(probe.stdout) : undefined;
    const executable = facts?.daemon?.executable ?? undefined;
    const how = installPath(executable);
    if (how === "nix") return { device: name, result: "manual", reason: "Nix manages cns there", next: nixSteps(device.platform) };
    if (how === "unknown") {
      const runs = executable ? `its daemon runs ${printable(executable)}` : probe.code === 0 ? "cns status --json there does not say what its daemon runs" : why(probe, "cns");
      return { device: name, result: "manual", reason: `cns cannot tell how cns was installed there: ${runs}`, next: `There, install cns ${target}, ${RESTART_THERE}.` };
    }
    // Restarting the daemon ends its named sessions, where an agent may be at work.
    const sessions = facts?.daemon?.sessions?.map(printable);
    if (!options.endSessions && sessions?.length !== 0) return sessionsLeft(name, sessions, from);
    const ends = `, which ends ${!sessions ? "any named sessions it holds and " : sessions.length ? `its named sessions ${sessions.join(", ")} and ` : ""}any open shells`;
    const tool = `${MISE_TOOL}@${target}`;
    const fail = (reason: string): Outcome => ({ device: name, result: "failed", reason, next: `There, run mise use -g ${tool}, ${RESTART_THERE}.` });
    if (options.dryRun) {
      const mise = await run("mise", ["--version"]);
      if (mise.code !== 0) return { device: name, result: "failed", reason: `mise --version failed (${why(mise, "mise")})`, next: `There, install cns ${target}, ${RESTART_THERE}.` };
      return {
        device: name, result: "planned", from, to: target,
        steps: [`mise use -g ${tool}, which pins that version in mise's global config there`, `cns up --install from the new cns if a service runs the old one, else cns daemon restart${ends}`],
      };
    }
    const installed = await run("mise", ["use", "-g", word(tool)], MISE_MS);
    if (installed.code !== 0) return fail(`mise use -g ${tool} failed (${why(installed, "mise")})`);
    const which = await run("mise", ["which", "cns", "--tool", word(tool)]);
    const path = which.code === 0 ? executablePath(which.stdout) : undefined;
    if (!path) return fail(`mise did not say where it installed cns ${target} (${why(which, "mise")})`);
    const status = await run(word(path), ["status", "--json"]);
    const fresh = status.code === 0 ? statusFacts(status.stdout) : undefined;
    if (!fresh?.version) return fail(`the cns mise installed, ${printable(path)}, does not run (${why(status, path)})`);
    if (fresh.version !== target) {
      return { device: name, result: "failed", reason: `the cns mise gave for ${target}, ${printable(path)}, is cns ${fresh.version}`, next: `There, mise ls ${MISE_TOOL} lists what mise has; run mise install --force ${tool}, ${RESTART_THERE}.` };
    }
    // Sessions started while mise worked: this daemon names its sessions, as the first look showed.
    const current = fresh.daemon?.sessions?.map(printable);
    if (!options.endSessions && current?.length) return sessionsLeft(name, current, from);
    // A service keeps the cns it names, so only cns up --install, from the new cns, moves it onto that one.
    const restart = fresh.service && !fresh.service.managedByNix && !fresh.service.runsThis ? ["up", "--install"] : ["daemon", "restart"];
    let ran: Awaited<ReturnType<Device["run"]>> | undefined;
    // Both hand the restart to a process of their own, which outlives this command and the daemon.
    try { ran = await run(word(path), restart); } catch { /* The link may drop as the daemon restarts; what answers next tells. */ }
    if (ran && ran.code !== 0) return fail(`cns ${restart.join(" ")} failed (${why(ran, path)})`);
    return settled(name, from, { path, version: fresh.version }, reach, options);
  } catch (error) { return fault(name, error); }
  finally { device.close(); }
}

/** A device left alone because restarting its daemon would end named sessions, or might. */
function sessionsLeft(name: string, sessions: string[] | null | undefined, from: string | undefined): Outcome {
  if (sessions) {
    return { device: name, result: "manual", reason: `restarting its daemon would end its named sessions ${sessions.join(", ")}`, next: `To end them and upgrade, run cns upgrade ${name} --end-sessions.` };
  }
  return {
    device: name, result: "manual",
    reason: `its daemon, ${describeVersion(from)}, cannot say whether it holds named sessions, which restarting it would end`,
    next: `To end any and upgrade, run cns upgrade ${name} --end-sessions. Once is enough: the new cns names its sessions.`,
  };
}

/** Once the restart is under way: wait for a daemon to answer with the new cns. */
async function settled(name: string, from: string | undefined, restarted: { path: string; version: string }, reach: Reach, options: UpgradeOptions): Promise<Outcome> {
  const { backMs = BACK_MS, sleep = wait } = options;
  const deadline = Date.now() + backMs;
  let seen: { version?: string } | undefined;
  let reason = "";
  for (;;) {
    await sleep(1000);
    try {
      const device = await reach(name);
      device.close();
      if (device.version === restarted.version) return { device: name, result: "upgraded", from, to: restarted.version };
      seen = { version: device.version };
    } catch (error) { reason = printable(errorMessage(error)).replace(/\.$/, ""); }
    if (Date.now() >= deadline) break;
  }
  const since = `${Math.round(backMs / 1000)} seconds`;
  if (!seen) return { device: name, result: "unreachable", reason: `its daemon has not answered in the ${since} since it restarted${reason ? `: ${reason}` : ""}`, later: `cns up on ${name}, whose ~/.cns/restart.log says what happened` };
  return {
    device: name, result: "failed",
    reason: `mise installed cns ${restarted.version} (${printable(restarted.path)}), but its daemon still runs ${describeVersion(seen.version)} ${since} later`,
    next: `There, run ${printable(restarted.path)} status, which says how to restart the daemon on it.`,
  };
}

/** Reach a paired device as cns run does: through the local daemon's link to it, else by dialing it. */
type Connection = Pick<DeviceConnection, "remote" | "info" | "close">;
const dial = (name: string): Promise<Connection> => connectDevice(resolvePeer(name), AbortSignal.timeout(20_000));

/**
 * Reach a paired device over `connect`. The device ends each command at its limit; one that has
 * not answered `graceMs` later is given up on, so that it holds up nothing for longer.
 */
export async function reachDevice(name: string, connect: (name: string) => Promise<Connection> = dial, graceMs = 5000): Promise<Device> {
  const connection = await connect(name);
  const { info } = connection;
  return {
    platform: info.platform, shell: info.shell, ...info.version ? { version: info.version } : {},
    async run(command, timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${(timeoutMs + graceMs) / 1000} seconds`)), timeoutMs + graceMs); });
      try {
        const result = await Promise.race([plain(connection.remote.run(command, { timeoutMs }) as unknown as Promise<RunResult>), late]);
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } finally { clearTimeout(timer); }
    },
    close: connection.close,
  };
}

/**
 * The saved devices cns upgrade asks, each named with the mesh it came from, if one; and lines for
 * the cns gateway, a Worker that is deployed again rather than upgraded and is never dialed.
 */
export function fleet(peers: readonly Pick<PeerEntry, "name" | "mesh" | "gateway">[]): { devices: string[]; named: string[]; skipped: Outcome[] } {
  const devices = peers.filter((peer) => !peer.gateway);
  return {
    devices: devices.map((peer) => peer.name),
    named: devices.map((peer) => peer.mesh ? `${peer.name} (from mesh ${peer.mesh})` : peer.name),
    skipped: peers.flatMap((peer) => peer.gateway ? [{ device: peer.name, result: "skipped", reason: "it is the cns gateway, a Worker to deploy again after upgrading cns (gateway/README.md)" } as const] : []),
  };
}

/** The saved record of the device a command names, refused as resolvePeer refuses it: not saved, or removed here. */
function namedPeer(name: string): PeerEntry {
  resolvePeer(name);
  return getPeer(name)!;
}

/**
 * `cns upgrade DEVICE` or `cns upgrade --all`: upgrade cns there to the latest release, and say what
 * became of each device. Returns the exit status, as upgradeExitCode gives it.
 */
export async function upgrade(name: string | undefined, options: { all?: boolean; dryRun?: boolean; endSessions?: boolean }, reach: Reach = reachDevice): Promise<number> {
  if ((name === undefined) === !options.all) throw new Error("Name one paired device, or --all for every one: cns upgrade DEVICE, or cns upgrade --all.");
  const peers = name === undefined ? reachablePeers() : [namedPeer(name)];
  if (!peers.length) { console.error("No paired devices. Run cns pair to pair with another device."); return 0; }
  const { devices, named, skipped } = fleet(peers);
  for (const outcome of skipped) console.log(reportLine(outcome));
  if (!devices.length) return 0;
  let target: string;
  // Always asked: what cns peers learned may be a day old.
  try { target = await latestRelease(); }
  catch (error) { throw new Error(`Cannot learn the latest cns release (${errorMessage(error)}). Try again once this device reaches GitHub.`, { cause: error }); }
  console.error(`${options.dryRun ? "Checking" : "Upgrading"} ${named.join(", ")} ${options.dryRun ? "against" : "to"} cns ${target}, the latest release.`);
  const outcomes = await Promise.all(devices.map(async (device) => {
    const outcome = await upgradeDevice(device, target, reach, { dryRun: options.dryRun, endSessions: options.endSessions });
    // As soon as it is known: a device that is slow to answer holds up only its own line.
    console.log(reportLine(outcome));
    return outcome;
  }));
  if (compareVersions(CNS_VERSION, target) < 0) console.error(`This device runs cns ${CNS_VERSION}: upgrade it here too, then restart its daemon (cns status says how).`);
  return upgradeExitCode(outcomes);
}
