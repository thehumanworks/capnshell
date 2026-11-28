import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { AuthError } from "../auth.js";
import { connectFirst, connectSecure, rpcSession, type SecureChannel } from "../secure.js";
import { dialAddresses, isRelayAddress } from "../relay-hub.js";
import { builtInRelay } from "../relay-config.js";
import { registrationWord } from "../relay-registration.js";
import { errorMessage } from "../errors.js";
import { ensureIdentity, fingerprint as fingerprintOf, identityPath, loadIdentity } from "../identity.js";
import { allPrivate } from "../addresses.js";
import { endpointUrl } from "../options.js";
import { decisionSchema, decodeInvite, DEFAULT_INVITE_MS, INVITE_PREFIX, MAX_INVITE_MS, suggestedName, type Decision, type Invite, type PairingApi, type Proposal } from "../pairing.js";
import { hostCode, inviteForCode, isPairingCode, MAX_WRONG_CODES, PairingCodeError, parseCode, type HostedCode } from "../pairing-code.js";
import { peerFileExists, peerNamePattern, removePeerFile, validatePeerUrl } from "../peer-files.js";
import { describeGrants, expandGrants, findPairedPeer, getPeer, isRevoked, listPeers, refuseRemoved, revokeDevice, revokedDevices, savedKey, savePairedPeer, updatePairedPeer, PERMISSIONS, type Permission } from "../peers.js";
import { plain } from "../terminal.js";
import { selfCheck, type SelfFacts } from "../self-check.js";
import type { ShellApi } from "../shell.js";
import type { RpcStub } from "capnweb";
import type { Pointer } from "bun:ffi";
import { RefusingShell } from "../refusing-shell.js";
import { connectControl, daemonStatePath, processExited, removeStaleState, runsUnder, startDaemon, stopDaemon, type ControlConnection, type DaemonStatus } from "./daemon.js";
import { selfInvocation, selfPath } from "../runtime.js";
import { behindHint, CNS_VERSION, daemonDrift, describeVersion, reportedVersion, restartAdvice, versionOrder } from "../version.js";
import { latestRelease } from "./upgrade.js";
import { describeService, installService, installedService, installedServiceRuns, lingering, loadLaunchAgent, registeredTask, restartService, runTask, serviceEnvironment, serviceFailed, serviceFile, serviceKind, serviceLog, serviceName, serviceOverrides, SETTING_VARIABLES, startService, taskName, uninstallService, type ServiceKind } from "../service.js";
import { windowsUserSid } from "../config.js";

/** How long the invited device waits for the inviting person to decide. */
const PROPOSAL_WAIT_MS = 10 * 60 * 1000;

export interface UpOptions { bind?: string; port?: string; state?: string; install?: boolean; uninstall?: boolean }
export interface PairOptions { name?: string; yes?: boolean; request?: string; grant?: string; expires?: string; state?: string; long?: boolean }
export interface PeersOptions { json?: boolean; state?: string }
export interface StatusOptions { json?: boolean; state?: string }
export interface DoctorOptions { json?: boolean; state?: string }

interface Prompt {
  /** --yes: every question takes its default. */
  yes: boolean;
  ask(question: string, fallback: string): Promise<string>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

/** Ask on the terminal; without one, only --yes can answer. Close it, or stdin keeps the process alive. */
function prompter(yes: boolean | undefined): Prompt {
  if (yes) return { yes: true, ask: async (_question, fallback) => fallback, confirm: async () => true, close() {} };
  if (!process.stdin.isTTY) throw new Error("Pairing asks for confirmation on a terminal. Pass --yes to accept without asking.");
  const lines = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (question: string, fallback: string) => new Promise<string>((resolve) => lines.question(`${question}${fallback ? ` [${fallback}]` : ""}: `, (answer) => resolve(answer.trim() || fallback)));
  return {
    yes: false,
    ask,
    async confirm(question, defaultYes = false) {
      const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
      return answer ? answer.startsWith("y") : defaultYes;
    },
    close() { lines.close(); },
  };
}

function parseGrants(value: string | undefined, fallback: readonly string[]): Permission[] {
  const words = value === undefined ? fallback : value.split(",").map((word) => word.trim()).filter(Boolean);
  if (value !== undefined && !words.length) return [];
  return expandGrants(words);
}

/** Ask what a newly paired device may use here, until the answer is one `--grant` would take. */
async function chooseGrants(prompt: Prompt, name: string): Promise<Permission[]> {
  for (;;) {
    const answer = await prompt.ask(`What may ${name} use on this device? none, shell, files, skills, sessions, all, or a comma-separated list`, "none");
    try { return parseGrants(answer, []); }
    catch { console.error(`Answer none, shell, files, skills, sessions, all, or a comma-separated list of those or of ${PERMISSIONS.join(", ")}.`); }
  }
}

/** Refuse a name that is not a valid alias or that a saved peer, of any kind, already uses. */
function checkFreeName(name: string): void {
  if (!peerNamePattern.test(name)) throw new Error("Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  if (peerFileExists(name)) throw new Error(`A saved peer is already named ${name}. Choose another with --name, or remove it first with cns peer remove ${name}.`);
}

/** `wanted` if no saved peer uses it, else the first free wanted-2, wanted-3, ... */
function freeName(wanted: string): string {
  const base = peerNamePattern.test(wanted) ? wanted : "peer";
  if (!peerFileExists(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 60)}-${n}`;
    if (!peerFileExists(candidate)) return candidate;
  }
}

/** The alias for a newly paired device: --name, which must be free, else asked for until a free one is given. */
async function chooseName(prompt: Prompt, question: string, given: string | undefined, suggested: string): Promise<string> {
  if (given !== undefined) { checkFreeName(given); return given; }
  for (;;) {
    const name = await prompt.ask(question, freeName(suggested));
    try { checkFreeName(name); return name; }
    catch (error) {
      if (prompt.yes) throw error;
      console.error(errorMessage(error));
    }
  }
}

/** Where the paired daemon listens, from the options, then the environment, then the defaults. */
function daemonSettings(options: { bind?: string; port?: string }): { bind: string; port: number } {
  const bind = options.bind ?? process.env.CNS_BIND ?? "0.0.0.0";
  const port = Number(options.port ?? process.env.CNS_PORT ?? 47381);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port requires an integer from 1 to 65535.");
  return { bind, port };
}

/**
 * The control connection of a daemon that is starting, once it answers. With `failed`, stop
 * waiting as soon as the service manager reports that the daemon failed.
 */
async function awaitControl(statePath: string | undefined, timeoutMs = 15_000, failed?: () => string | undefined): Promise<ControlConnection> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { return await connectControl(statePath); }
    catch (error) {
      const failure = failed?.();
      if (failure) throw new Error(failure, { cause: error });
      if (Date.now() >= deadline) throw new Error(`The daemon did not start within ${timeoutMs / 1000} seconds: ${errorMessage(error)}`, { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** A probe for awaitControl: the installed service's daemon exited with an error. */
function serviceFailure(kind: ServiceKind, state: string): () => string | undefined {
  return () => serviceFailed(kind) ? `The ${serviceName(kind)} failed to start the daemon. See ${serviceLog(kind, state)}` : undefined;
}

/** The local paired daemon, started if it is not running, or if the one that was has crashed. */
async function pairedDaemon(options: { bind?: string; port?: string; state?: string }, quiet = false): Promise<{ control: ControlConnection; started: boolean }> {
  const { created } = ensureIdentity();
  if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
  let running: ControlConnection | undefined;
  try { running = await connectControl(options.state); }
  catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    // A daemon that crashed, or a reboot, leaves its state file behind; remove it once its process is gone.
    if (!missing && !(await removeStaleState(options.state))) throw error;
  }
  if (running) return { control: running, started: false };
  const service = installedService(daemonStatePath(options.state));
  if (service) {
    // The installed service owns the daemon's settings; start it rather than a second, unsupervised daemon.
    const given = (["bind", "port"] as const).filter((name) => options[name] !== undefined);
    if (given.length) console.error(`The installed service's settings apply, not --${given.join(", --")}. Run cns up --install with them to change it.`);
    let control: ControlConnection | undefined;
    try {
      if (service.kind === "schtasks") control = await startTask(daemonStatePath(options.state));
      else {
        startService(service.kind);
        control = await awaitControl(options.state, undefined, serviceFailure(service.kind, daemonStatePath(options.state)));
      }
    } catch (error) {
      console.error(`Cannot start the installed service (${errorMessage(error)}); starting the daemon without it.`);
    }
    if (control) {
      if (!quiet) console.error(`Started the peer daemon through ${describeService(service.kind)}.`);
      return { control, started: true };
    }
  }
  const { bind, port } = daemonSettings(options);
  const daemon = await startDaemon({ bind, port, url: endpointUrl(bind, port), state: options.state });
  if (!quiet) console.error(`Started the peer daemon (pid ${daemon.pid}) listening at ${daemon.url}. Log: ${daemon.log}`);
  return { control: await connectControl(options.state), started: true };
}

/** `cns up`, or `cns daemon start`: run this device as a paired peer. */
export async function up(options: UpOptions): Promise<void> {
  if (options.install && options.uninstall) throw new Error("Use either --install or --uninstall, not both.");
  if (options.uninstall) { await uninstall(options); return; }
  if (options.install && await install(options)) return;
  const { control, started } = await pairedDaemon(options, true);
  await report(control, started ? "Started" : "Running", options.state);
}

/** Print what the daemon behind `control` runs as, where it listens and which devices it reaches, then close it. */
async function report(control: ControlConnection, verb: string, state?: string): Promise<void> {
  try {
    const status = await control.remote.status();
    const peers = await control.controller.peers();
    const service = installedService(daemonStatePath(state));
    const version = reportedVersion(status.version);
    console.log(`${verb} as ${status.identity?.fingerprint} (${version ? `cns ${version}, ` : ""}pid ${status.pid}${service ? `, ${describeService(service.kind)}` : ""}), listening at ${status.url}.`);
    if (status.addresses?.length) console.log(`Reachable at ${status.addresses.join(", ")}.`);
    if (status.relay) console.log(`Relay: ${status.relay}, ${registrationWord(status.relayRegistered)}.`);
    const paired = listPeers();
    console.log(paired.length
      ? `Paired devices: ${paired.map((peer) => `${peer.name}${peers.some((connected) => connected.peer?.daemon && connected.peer.fingerprint === peer.fingerprint) ? " (online)" : ""}`).join(", ")}.`
      : "No paired devices yet. Run cns pair here and type the code it shows on the other device.");
    const drift = driftWarning(status, state);
    if (drift) console.error(`Warning: ${drift}`);
  } finally { control.close(); }
}

export interface RestartOptions { state?: string; worker?: string }

/** How long a restart that runs inside the daemon waits, so that this command's output reaches whoever ran it first. */
const RESTART_DELAY_MS = 1000;

/**
 * How `cns daemon restart` brings the daemon back. systemd restarts a daemon that runs as its
 * service, with whatever command the unit and its drop-ins give it. Any other daemon is stopped,
 * then started again: through the installed service if there is one, else detached with its
 * --bind and --port. A daemon that a service manager cns did not install runs, such as the NixOS
 * module's system service, is left to that manager, which alone can start it again.
 */
export function restartPlan(service: boolean | undefined, installed: ServiceKind | undefined): { stop: boolean; start: ServiceKind | "detached" } {
  if (service && !installed) {
    throw new Error(`A service manager cns did not install runs this daemon, so cns cannot start it again. Restart it there${process.platform === "linux" ? ", such as sudo systemctl restart cns for the NixOS module" : ""}.`);
  }
  return { stop: !(service && installed === "systemd"), start: installed ?? "detached" };
}

/**
 * `cns daemon restart`: stop the daemon and start it again as it runs now. A process of its own,
 * in a session of its own, does the work, so the restart completes when this command ends with
 * the daemon, as it does for `cns run DEVICE -- cns daemon restart` from another device: this
 * command then returns at once and the restart follows. Run anywhere else, it waits and reports
 * the daemon that answers.
 */
export async function restart(options: RestartOptions): Promise<void> {
  if (options.worker !== undefined) { await restartNow(options.state, Number(options.worker)); return; }
  const state = daemonStatePath(options.state);
  const { control, started } = await pairedDaemon({ state }, true);
  if (started) {
    console.error("The daemon was not running, so it was started.");
    await report(control, "Started", state);
    return;
  }
  let status: DaemonStatus;
  try { status = await control.remote.status(); } finally { control.close(); }
  const installed = installedService(state);
  const plan = restartPlan(status.service, installed?.kind);
  // A drop-in that pins another cns comes back with every restart; say so before the device is cut off.
  const overrides = installed ? serviceOverrides(installed.kind, selfPath()).map(printable) : [];
  if (overrides.length) console.error(`Warning: ${restartAdvice({ service: status.service, installed: { kind: installed!.kind, ...installedServiceRuns(installed!, selfPath()), overrides }, platform: process.platform })}`);
  const inside = runsUnder(status.pid);
  const log = path.join(path.dirname(state), "restart.log");
  await keepHandlesHere();
  const handle = await open(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  const invocation = selfInvocation(["daemon", "restart", "--state", state, "--worker", String(inside === false ? 0 : RESTART_DELAY_MS)]);
  const worker = spawn(invocation.file, invocation.args, { detached: true, windowsHide: true, stdio: ["ignore", handle.fd, handle.fd] });
  await handle.close();
  const through = plan.start === "detached" ? "" : ` through its ${serviceName(plan.start)}`;
  if (inside !== false) {
    // Inside the daemon, or where that cannot be told: the daemon may end this command any moment now.
    worker.unref();
    console.log(`Restarting the daemon${through} in a moment. Links to this device drop and come back within seconds, and the named sessions it holds end. Check with cns status; the restart's log is ${log}.`);
    return;
  }
  const code = await new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("exit", resolve); });
  if (code !== 0) throw new Error(`The daemon did not restart${through}:\n${(await readFile(log, "utf8")).trim()}`);
  await report(await connectControl(state), "Restarted", state);
}

/**
 * On Windows a new process inherits every inheritable handle of the one that starts it, not only
 * the standard handles it is given. Started from PowerShell, as a paired device's command is, this
 * process holds handles to that command's pipes, so the restart would hold them open, and the
 * command would not end until the daemon cut it off. Mark every handle here as not inherited:
 * handles are multiples of 4, and a process like this one has far fewer than 2^18 of them.
 */
async function keepHandlesHere(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      GetHandleInformation: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      SetHandleInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.bool },
    });
    const flags = new Uint32Array(1);
    const flagsAt = ptr(flags);
    try {
      // HANDLE_FLAG_INHERIT is 1.
      for (let value = 4; value < 1 << 20; value += 4) {
        const handle = value as Pointer;
        if (kernel32.symbols.GetHandleInformation(handle, flagsAt) && (flags[0]! & 1)) kernel32.symbols.SetHandleInformation(handle, 1, 0);
      }
    } finally { kernel32.close(); }
  } catch (error) {
    console.error(`Cannot keep this command's handles from the restart (${errorMessage(error)}); the command may end only when the daemon restarts.`);
  }
}

/**
 * The daemon, started through the scheduled task; undefined if the task does not start it, and the
 * caller starts it detached: a restart or install from another device must not leave this one without a daemon.
 */
async function startTask(state: string): Promise<ControlConnection | undefined> {
  let failure = "no daemon answered within 15 seconds";
  try { if (await runTask(state)) return await awaitControl(state); }
  catch (error) { failure = errorMessage(error); }
  console.error(`The scheduled task did not start the daemon (${failure}); starting it without the task. See ${serviceLog("schtasks", state)}.`);
  return undefined;
}

/** The restart itself, in its own process: wait `delayMs`, stop the daemon, then start it again as restartPlan says. */
async function restartNow(statePath: string | undefined, delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const state = daemonStatePath(statePath);
  const control = await connectControl(state);
  let status: DaemonStatus;
  try { status = await control.remote.status(); } finally { control.close(); }
  const installed = installedService(state);
  const plan = restartPlan(status.service, installed?.kind);
  console.error(`Restarting the daemon (pid ${status.pid}).`);
  // The daemon started below would otherwise hold this log open.
  await keepHandlesHere();
  if (plan.stop) {
    // Once stopped, always try to start it again: nobody may be left to run cns up on this device.
    try {
      const pid = await stopDaemon(state);
      // A service manager can take a process that is still exiting for one still running.
      if (plan.start !== "detached" && !(await processExited(pid, 10_000))) console.error(`The old daemon (pid ${pid}) has not exited yet.`);
    } catch (error) { console.error(`Stopping the daemon: ${errorMessage(error)}`); }
  }
  let started: ControlConnection | undefined;
  let detached = plan.start === "detached";
  try {
    if (plan.start === "systemd") restartService();
    // Not a kickstart, which runs the agent launchd loaded before: cns up --install may just have rewritten its file.
    else if (plan.start === "launchd") loadLaunchAgent(installed!.path);
    else if (plan.start === "schtasks") detached = !(started = await startTask(state));
  } catch (error) {
    // Stopped here, so nothing else starts it: start it without the service rather than leave the device without a daemon.
    if (!plan.stop || plan.start === "detached") throw error;
    console.error(`The ${serviceName(plan.start)} did not start the daemon (${errorMessage(error)}); starting it without the service.`);
    detached = true;
  }
  if (detached) {
    // Nothing else starts it again, so try more than once: its port can take a moment to come free.
    for (let attempt = 1; ; attempt++) {
      try { await startDaemon({ bind: status.bind, port: status.port, url: endpointUrl(status.bind, status.port), state }); break; }
      catch (error) {
        if (attempt === 3) throw error;
        console.error(`${errorMessage(error)} Trying again.`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  started ??= await awaitControl(state, undefined, detached || plan.start === "detached" ? undefined : serviceFailure(plan.start, state));
  try { console.error(`Restarted the daemon (pid ${(await started.remote.status()).pid}).`); } finally { started.close(); }
}

/**
 * When the running daemon is not this cns's version: what that means and what to run, or undefined
 * when it is. A daemon keeps the executable it started with, so an upgrade reaches paired devices,
 * and commands that use the daemon's links, only once the daemon restarts.
 */
function driftWarning(status: DaemonStatus, state?: string): string | undefined {
  // The advice asks the service manager, so skip it when there is no drift to explain.
  if (versionOrder(reportedVersion(status.version)) === "same") return undefined;
  const self = { version: CNS_VERSION, executable: selfPath() };
  const installed = installedService(daemonStatePath(state));
  return daemonDrift({
    daemon: { version: status.version, ...status.executable ? { executable: printable(status.executable) } : {} },
    self,
    advice: restartAdvice({
      service: status.service,
      ...installed ? {
        installed: {
          kind: installed.kind, ...installedServiceRuns(installed, self.executable),
          overrides: serviceOverrides(installed.kind, self.executable).map(printable),
        },
      } : {},
      platform: process.platform,
    }),
    which: process.platform === "win32" ? "Get-Command cns" : "command -v cns",
  });
}

function requireServiceKind() {
  const kind = serviceKind();
  if (!kind) throw new Error("cns up --install supports macOS (launchd), Linux (systemd) and Windows (Task Scheduler). On this platform, start cns up from your system's startup mechanism.");
  return kind;
}

/**
 * `cns up --install`: run the daemon as a launchd agent, systemd user service or scheduled task, so
 * it starts at login and restarts after a crash. Returns whether a restart in the background took
 * over, which reports for it.
 */
async function install(options: UpOptions): Promise<boolean> {
  const kind = requireServiceKind();
  const { created } = ensureIdentity();
  if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
  const state = daemonStatePath(options.state);
  // One task per account, so it runs one daemon: refuse to take it from another one that runs.
  const other = kind === "schtasks" ? registeredTask()?.state : undefined;
  if (other && other.toLowerCase() !== state.toLowerCase() && await serviceDaemonAt(other)) {
    throw new Error(`The scheduled task runs the daemon at ${other}, not ${state}. Run cns up --uninstall first.`);
  }
  // Settings not given now are kept from a daemon that is running, so installing makes it permanent as it is.
  let running: { bind: string; port: number } | undefined;
  let control: ControlConnection | undefined;
  try { control = await connectControl(state); }
  catch { await removeStaleState(state); }
  if (control) {
    try {
      const status = await control.remote.status();
      running = { bind: status.bind, port: status.port };
    } finally { control.close(); }
  }
  const settings = daemonSettings({
    bind: options.bind ?? running?.bind,
    port: options.port ?? (running ? String(running.port) : undefined),
  });
  const file = serviceFile(kind, {
    // Only the scheduled task supervises: launchd and systemd restart the daemon themselves.
    program: selfInvocation(["daemon", kind === "schtasks" ? "--supervise" : "--service", "--state", state, "--bind", settings.bind, "--port", String(settings.port)]),
    env: serviceEnvironment(),
    log: path.join(path.dirname(state), "service.log"),
    ...kind === "schtasks" ? { user: taskUser() } : {},
  });
  // A running daemon is left to the restart below: stopping it here would end this command too,
  // which may run through that daemon for a paired device, and leave the device without a daemon.
  await installService(file, undefined, !running);
  const where = kind === "schtasks" ? `named ${taskName()}, defined in ${file.path}` : `at ${file.path}`;
  console.error(`Installed ${describeService(kind)} ${where}. It starts the daemon at login and restarts it if it fails; cns stop stops it until the next cns up or login.`);
  console.error(`Its log: ${serviceLog(kind, state)}.`);
  if (kind === "systemd") {
    if (lingering() === false) console.error(`systemd stops user services when you log out. To keep the daemon running without a login, run: loginctl enable-linger ${os.userInfo().username}`);
  }
  // A scheduled task passes no environment, so the daemon gets these from the account, not from this shell.
  const unseen = kind === "schtasks" ? SETTING_VARIABLES.filter((name) => process.env[name]) : [];
  if (unseen.length) {
    console.error(`The task's daemon gets your account's environment, not this shell's. If ${unseen.join(", ")} ${unseen.length === 1 ? "is" : "are"} set only here, set ${unseen.length === 1 ? "it" : "each"} for your account with setx NAME VALUE, then run cns daemon restart.`);
  }
  console.error("Run cns up --install again after moving or upgrading cns to a new path, or to change --bind or --port.");
  // The restart's own process stops the daemon and starts the service's, as cns daemon restart does.
  if (running) { await restart({ state }); return true; }
  if (kind !== "schtasks") { (await awaitControl(options.state, undefined, serviceFailure(kind, state))).close(); return false; }
  const started = await startTask(state);
  if (started) { started.close(); return false; }
  const daemon = await startDaemon({ bind: settings.bind, port: settings.port, url: endpointUrl(settings.bind, settings.port), state });
  throw new Error(`The daemon runs without the task for now (pid ${daemon.pid}). cns up --install tries the task again; cns up --uninstall removes it.`);
}

/** The SID the scheduled task runs as, and whose sign-in starts it. */
function taskUser(): string {
  try { return windowsUserSid(); }
  catch (error) { throw new Error(`${errorMessage(error).replace(/\.?$/, ".")} Run cns up to start the daemon without a service.`, { cause: error }); }
}

/** `cns up --uninstall`: stop the service's daemon and remove the service. */
async function uninstall(options: UpOptions): Promise<void> {
  if (options.bind !== undefined || options.port !== undefined) throw new Error("--uninstall takes no --bind or --port.");
  const kind = requireServiceKind();
  // The task goes first, then the daemon at the state file it names: its supervisor then does not
  // start the daemon again, and this command, if a paired device runs it through that daemon, has
  // removed the task before stopping the daemon ends it.
  const task = kind === "schtasks" ? registeredTask() : undefined;
  const state = task && (task.state ?? daemonStatePath(options.state));
  if (!(await uninstallService(kind))) { console.log(`No ${serviceName(kind)} is installed.`); return; }
  if (state && await serviceDaemonAt(state)) {
    try { await stopDaemon(state); } catch (error) { console.error(`Stopping the daemon: ${errorMessage(error)}`); }
    if (await serviceDaemonAt(state)) throw new Error(`Removed the ${serviceName(kind)}, but its daemon still runs. Stop it with cns stop --state "${state}".`);
  }
  console.log(`Removed the ${serviceName(kind)}; the daemon is stopped. Run cns up to start it without the service.`);
}

/** Whether a daemon that a service runs answers at this state file. */
async function serviceDaemonAt(state: string): Promise<boolean> {
  let control: ControlConnection;
  try { control = await connectControl(state); } catch { return false; }
  try { return (await control.remote.status()).service === true; } finally { control.close(); }
}

/**
 * `cns pair`: show a pairing code (or with --long, print an invite) and wait for the other
 * device; `cns pair CODE` or `cns pair INVITE`: pair with the device that showed it.
 */
export async function pair(typed: string | readonly string[] | undefined, options: PairOptions): Promise<void> {
  const parts = typed === undefined ? [] : typeof typed === "string" ? [typed] : [...typed];
  if (!parts.length) { await inviteAndWait(options); return; }
  if (parts.length === 1 && parts[0]!.startsWith(INVITE_PREFIX)) { await acceptInvite(parts[0]!, options); return; }
  // A code works once: check what can fail here before using it up.
  if (!options.yes && !process.stdin.isTTY) throw new Error("Pairing asks for confirmation on a terminal. Pass --yes to accept without asking.");
  if (options.name !== undefined) checkFreeName(options.name);
  let text: string;
  try { text = await inviteFromCode(parts); }
  catch (error) {
    process.exitCode = error instanceof PairingCodeError && (error.code === "relay" || error.code === "busy") ? 1 : 3;
    throw error;
  }
  await acceptInvite(text, options);
}

/** The invite behind a pairing code the other device shows, exchanged with it through the relay. */
export async function inviteFromCode(parts: readonly string[]): Promise<string> {
  if (!isPairingCode(parts[0] ?? "")) throw new Error("Type the code cns pair shows on the other device, such as 42-orbit-canyon-velvet, or paste a whole cns1: invite.");
  const code = parseCode(parts);
  const relay = builtInRelay();
  if (!relay) throw new PairingCodeError("relay", "Pairing codes go through the relay, which is off here (CNS_RELAY=off). Run cns pair --long on the other device and paste its invite here.");
  return await inviteForCode(relay, code);
}

async function inviteAndWait(options: PairOptions): Promise<void> {
  const minutes = options.expires === undefined ? DEFAULT_INVITE_MS / 60_000 : Number(options.expires);
  if (!(minutes > 0 && minutes * 60_000 <= MAX_INVITE_MS)) throw new Error(`--expires takes minutes, up to ${MAX_INVITE_MS / 60_000}.`);
  const grants = parseGrants(options.grant, []);
  // Check what can fail before another device starts waiting on this one.
  if (options.name !== undefined) checkFreeName(options.name);
  let prompt: Prompt | undefined;
  let control: ControlConnection | undefined;
  let hosted: HostedCode | undefined;
  try {
    prompt = prompter(options.yes);
    ({ control } = await pairedDaemon(options));
    const created = await control.remote.invite(minutes * 60_000);
    const expiry = `${minutes} minute${minutes === 1 ? "" : "s"}`;
    // A short code to type on the other device, unless --long asks for the invite itself or there is no relay to exchange it.
    const relay = builtInRelay();
    if (!options.long && relay) {
      try { hosted = await hostCode(relay, created.text, { wrong: (tries) => console.error(`A device typed a wrong code (${tries} of ${MAX_WRONG_CODES} tries).`) }); }
      catch (error) { console.error(`Cannot get a pairing code from the relay (${errorMessage(error)}), so here is the invite to paste instead.`); }
    }
    const printInvite = () => {
      console.log(`Invite: ${created.text}`);
      // An invite that only names private addresses reaches nothing beyond this network; say so now, not after it expires unused.
      const invited = decodeInvite(created.text).addresses;
      if (!invited.some(isRelayAddress) && allPrivate(invited)) console.error(`This invite lists only private addresses (${invited.join(", ") || "none"}). A device on another network cannot reach them: the relay is off (CNS_RELAY=off).`);
      console.error(`On the other device, run: cns pair '${created.text}'`);
    };
    if (hosted) {
      console.log(`Code: ${hosted.code}`);
      console.error(`On the other device, run: cns pair ${hosted.code}\nWaiting for it (the code works once and expires in ${expiry})...`);
    } else {
      printInvite();
      console.error(`Waiting for it (the invite expires in ${expiry})...`);
    }
    const proposed = Promise.resolve(control.remote.awaitProposal(created.id) as Promise<{ peer: string; fingerprint: string; proposal: Proposal }>);
    proposed.catch(() => {});
    // Three wrong codes end the pairing; a room the relay lost leaves the invite, which still works.
    const codeFailed = new Promise<never>((_resolve, reject) => {
      hosted?.delivered.catch((error: unknown) => {
        if (error instanceof PairingCodeError && error.code === "wrong") { reject(error); return; }
        console.error(`${errorMessage(error)} Paste this invite on the other device instead:`);
        printInvite();
      });
    });
    let answered: { peer: string; fingerprint: string; proposal: Proposal };
    try { answered = await Promise.race([proposed, codeFailed]); }
    catch (error) {
      if (error instanceof PairingCodeError) process.exitCode = 3;
      throw error;
    } finally { hosted?.close(); }
    const { peer, fingerprint, proposal } = answered;
    console.error([
      `\n${proposal.name} (fingerprint ${fingerprint}) wants to pair.`,
      `  It asks to use this machine's: ${describeGrants(proposal.requests)}`,
      `  It lets this machine use its:  ${describeGrants(proposal.offers)}`,
      ...proposal.addresses?.length ? [`  This machine will dial it at:  ${proposal.addresses.join(", ")}`] : [],
      ...isRevoked(peer) ? [REMOVED_BEFORE] : [],
    ].join("\n"));
    const decline = async (reason: string, message: string) => {
      await control!.remote.decide(created.id, { accept: false, reason });
      console.log(message);
      process.exitCode = 3;
    };
    const existing = findPairedPeer(peer);
    if (existing) {
      await decline("The other device already has this device paired. Remove it there with cns peer remove, then pair again.", `Not paired: this device is already paired with it as ${existing.name}.`);
      return;
    }
    if (!(await prompt.confirm(`Pair with ${proposal.name}? Compare the fingerprint on its screen`, false))) {
      await decline("Declined on the inviting device.", "Not paired.");
      return;
    }
    const name = await chooseName(prompt, "Save it as", options.name, proposal.name);
    // --grant, or --yes alone, decides without asking; --yes never grants what --grant does not name.
    let granted: Permission[] = [];
    if (options.grant !== undefined || prompt.yes) granted = grants.filter((permission) => proposal.requests.includes(permission));
    else if (proposal.requests.length && await prompt.confirm(`Allow ${name} to use this machine's ${describeGrants(proposal.requests)}?`, false)) granted = proposal.requests;
    let decision: Decision;
    try { decision = await control.remote.decide(created.id, { accept: true, name, granted }) as Decision; }
    catch (error) { process.exitCode = 3; throw error; }
    console.log(`Paired with ${decision.name} (${fingerprint}). It may use this machine's: ${describeGrants(decision.granted ?? [])}. This machine may use its: ${describeGrants(proposal.offers)}.`);
  } finally {
    hosted?.close();
    prompt?.close();
    control?.close();
  }
}

/** Said on either side, with --yes too, when the other device was removed here (revokeDevice), which pairing again ends. */
const REMOVED_BEFORE = "  It was removed from this device before (cns peer remove); pairing again lets it back in, and meshes here give it records again.";

async function acceptInvite(text: string, options: PairOptions): Promise<void> {
  let invite: Invite;
  // An expired or unreadable invite is a refused pairing, as an unknown one is.
  try { invite = decodeInvite(text); }
  catch (error) { process.exitCode = 3; throw error; }
  const requests = parseGrants(options.request, ["all"]);
  let offers = parseGrants(options.grant, []);
  let prompt: Prompt | undefined;
  let control: ControlConnection | undefined;
  let channel: SecureChannel | undefined;
  try {
    prompt = prompter(options.yes);
    const { identity, created } = ensureIdentity();
    if (created) console.error(`Created this device's identity at ${identityPath()}. Keep the file private; losing it means pairing again.`);
    // Check what can fail before the other device saves anything.
    const existing = findPairedPeer(invite.key);
    if (existing) throw new Error(`This device is already paired with it as ${existing.name}. To pair again, remove it first with cns peer remove ${existing.name}.`);
    if (options.name !== undefined) checkFreeName(options.name);
    const removedBefore = isRevoked(invite.key);
    const peerFingerprint = fingerprintOf(invite.key);
    // --grant, or --yes alone, decides without asking; --yes never grants what --grant does not name.
    const askGrants = options.grant === undefined && !prompt.yes;
    console.error([
      `The invite is from ${invite.name ?? "a device"} with fingerprint ${peerFingerprint}, reachable at ${invite.addresses.join(", ")}.`,
      `  This device will ask to use its: ${describeGrants(requests)}`,
      ...askGrants ? [] : [`  and let it use this device's:   ${describeGrants(offers)}`],
      `  This device is ${identity.fingerprint}; the other side will see that.`,
      ...removedBefore ? [REMOVED_BEFORE] : [],
    ].join("\n"));
    if (!(await prompt.confirm("Pair with it?", true))) { console.log("Not paired."); process.exitCode = 3; return; }
    const name = await chooseName(prompt, "Save it as", options.name, invite.name ?? "peer");
    if (askGrants) offers = await chooseGrants(prompt, name);
    // Our own daemon's addresses, if it runs, so the other device can dial back.
    let addresses: string[] | undefined;
    let daemonRuns = false;
    try { control = await connectControl(options.state); } catch { control = undefined; }
    if (control) {
      try {
        addresses = (await control.remote.status()).addresses;
        daemonRuns = true;
      } catch { /* A daemon that does not answer; pair without dialing back. */ }
    }
    try { ({ channel } = await connectFirst(invite.addresses, identity, { expect: invite.key, invite: { id: invite.id, secret: invite.secret } })); }
    catch (error) {
      process.exitCode = error instanceof AuthError && error.code !== "closed" ? 3 : 1;
      throw error;
    }
    const remote = rpcSession<PairingApi>(channel, new RefusingShell());
    console.error("Connected. Waiting for the other device to confirm...");
    const open = channel;
    const timer = setTimeout(() => open.close("Pairing timed out"), PROPOSAL_WAIT_MS);
    let answer: unknown;
    try { answer = await plain(remote.propose({ name: suggestedName(os.hostname()), requests, offers, ...addresses?.length ? { addresses } : {} })); }
    catch (error) {
      console.log(`Not paired: ${errorMessage(error)}`);
      process.exitCode = 3;
      return;
    } finally {
      clearTimeout(timer);
      remote[Symbol.dispose]();
    }
    const parsed = decisionSchema.safeParse(answer);
    if (!parsed.success) throw new Error("The other device sent an answer this cns cannot read; nothing was saved here.");
    const decision = parsed.data;
    if (!decision.accept) { console.log(`Not paired: ${decision.reason ?? "the other device declined."}`); process.exitCode = 3; return; }
    try {
      savePairedPeer(name, { publicKey: invite.key, addresses: invite.addresses, pairedAt: new Date().toISOString(), grants: { incoming: offers, outgoing: decision.granted ?? [] } });
    } catch (error) {
      throw new Error(`The other device saved the pairing, but this device could not: ${errorMessage(error)}. Remove this device there with cns peer remove, then pair again.`);
    }
    console.log(`Paired with ${name} (${peerFingerprint}). This device may use its: ${describeGrants(decision.granted ?? [])}. It may use this device's: ${describeGrants(offers)}.`);
    if (control && daemonRuns) await control.remote.dial(name);
  } finally {
    channel?.close();
    control?.close();
    prompt?.close();
  }
}

/** The running daemon's control connection, or undefined when none runs. */
async function daemonIfRunning(state?: string): Promise<ControlConnection | undefined> {
  try { return await connectControl(state); } catch { return undefined; }
}

/** Text another device sent, made safe to print: no terminal control sequences. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

/** The paired devices the local daemon has a standing link to, by fingerprint. */
async function standingLinks(control: ControlConnection): Promise<Map<string, { name: string; hostname: string; via: "direct" | "relay"; version: string | undefined }>> {
  return new Map((await control.controller.peers()).flatMap((peer) => peer.peer?.daemon
    ? [[peer.peer.fingerprint, { name: peer.peer.name, hostname: printable(peer.info.hostname), via: peer.peer.via, version: reportedVersion(peer.info.version) }]]
    : []));
}

/** `cns status`: this device, its daemon and its links. */
export async function status(options: StatusOptions): Promise<void> {
  const identity = loadIdentity();
  const control = await daemonIfRunning(options.state);
  let daemon: Record<string, unknown> | null = null;
  let drift: string | undefined;
  const links: Array<{ name: string; fingerprint: string; address: string; hostname: string; version: string | null }> = [];
  if (control) {
    try {
      const info = await control.remote.status();
      drift = driftWarning(info, options.state);
      daemon = {
        pid: info.pid, url: info.url, addresses: info.addresses ?? [], relay: info.relay ?? null, relayRegistered: info.relayRegistered ?? null, startedAt: new Date(info.startedAt).toISOString(),
        version: reportedVersion(info.version) ?? null, executable: info.executable ? printable(info.executable) : null, warning: drift ?? null,
      };
      for (const [fingerprint, link] of await standingLinks(control)) links.push({ name: link.name, fingerprint, address: link.via, hostname: link.hostname, version: link.version ?? null });
    } finally { control.close(); }
  }
  const paired = listPeers();
  if (options.json) {
    // The service cns up --install or Home Manager installed, and whether it runs this cns: cns upgrade reads it on other devices.
    const installed = installedService(daemonStatePath(options.state));
    const service = installed ? { kind: installed.kind, path: installed.path, ...installedServiceRuns(installed, selfPath()) } : null;
    console.log(JSON.stringify({ version: CNS_VERSION, identity: identity ? { publicKey: identity.publicKey, fingerprint: identity.fingerprint } : null, daemon, service, links, paired: paired.length }, null, 2));
    return;
  }
  console.log(`This device: ${identity ? identity.fingerprint : "no identity yet (cns identity or cns up creates one)"}`);
  console.log(`This cns:    ${CNS_VERSION} (${selfPath()})`);
  if (!daemon) console.log("Daemon:      not running (cns up starts it)");
  else {
    console.log(`Daemon:      ${describeVersion((daemon.version as string | null) ?? undefined)}, pid ${daemon.pid} at ${daemon.url}${(daemon.addresses as string[]).length ? `, reachable at ${(daemon.addresses as string[]).join(", ")}` : ""}`);
    if (drift) console.log(`             Warning: ${drift}`);
    if (daemon.relay) console.log(`Relay:       ${daemon.relay} (${registrationWord(daemon.relayRegistered)})`);
  }
  console.log(`Paired:      ${paired.length} device${paired.length === 1 ? "" : "s"}${paired.length ? `: ${paired.map((peer) => peer.name).join(", ")}` : ""}`);
  console.log(links.length ? `Links:       ${links.map((link) => `${link.name} (${link.address}, ${link.hostname}, ${link.version ? `cns ${link.version}` : "older cns"})`).join(", ")}` : "Links:       none");
}

/** `cns doctor` with no name: whether paired devices can reach this device, and from where. */
async function doctorSelf(options: DoctorOptions): Promise<void> {
  let identity: SelfFacts["identity"];
  try {
    const loaded = loadIdentity();
    identity = loaded ? { fingerprint: loaded.fingerprint, publicKey: loaded.publicKey } : { missing: true };
  } catch (error) { identity = { error: printable(errorMessage(error)) }; }
  let daemon: SelfFacts["daemon"] = { running: false };
  let control: ControlConnection | undefined;
  try { control = await connectControl(options.state); }
  catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) daemon = { running: false, error: `its state file is there but it does not answer: ${printable(errorMessage(error))}` };
  }
  if (control) {
    try {
      const info = await control.remote.status();
      const version = reportedVersion(info.version);
      const drift = driftWarning(info, options.state);
      daemon = {
        running: true, pid: info.pid, url: info.url, addresses: info.addresses ?? [], ...info.identity ? { identity: info.identity } : {}, ...info.relay ? { relay: info.relay } : {},
        ...info.relayRegistered !== undefined ? { relayRegistered: info.relayRegistered } : {}, ...version ? { version } : {}, ...drift ? { drift } : {},
      };
    } catch (error) {
      daemon = { running: false, error: `it does not answer: ${printable(errorMessage(error))}` };
    } finally { control.close(); }
  }
  const relay = builtInRelay();
  const { report, lines, exitCode } = selfCheck({ identity, identityPath: identityPath(), self: { version: CNS_VERSION, executable: selfPath() }, daemon, paired: listPeers().length, ...relay ? { relay } : {} });
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(lines.join("\n"));
  if (exitCode) process.exitCode = exitCode;
}

/** `cns doctor [NAME]`: with a name, how, and whether, this device reaches a paired device right now; without, a check of this device. */
export async function doctor(name: string | undefined, options: DoctorOptions): Promise<void> {
  if (name === undefined) return doctorSelf(options);
  const entry = getPeer(name);
  if (!entry) throw new Error(`No paired device is saved as ${name}. cns peers lists the paired devices.`);
  refuseRemoved(entry);
  const report: Record<string, unknown> = { name };
  const lines: string[] = [];
  const identity = ensureIdentity().identity;
  report.fingerprint = entry.fingerprint;
  report.access = entry.grants.outgoing;
  report.grants = entry.grants.incoming;
  lines.push(`${name}: paired device ${entry.fingerprint}`, `  This device may use its:  ${describeGrants(entry.grants.outgoing)}`, `  It may use this device's: ${describeGrants(entry.grants.incoming)}`);
  const accessLine = lines.length - 2;
  const control = await daemonIfRunning(options.state);
  let linked = false;
  if (control) {
    let via: string | undefined;
    try { via = (await standingLinks(control)).get(entry.fingerprint)?.via; } finally { control.close(); }
    linked = via !== undefined;
    lines.push(`  Daemon link: ${via ? `online (${via})` : "offline"}`);
  } else lines.push("  Daemon link: no daemon running here (cns up)");
  report.link = control ? (linked ? "online" : "offline") : "no-daemon";
  const attempts: Array<{ address: string; result: string; detail?: string }> = [];
  /** What the device says this one may use there now, from the first address that answers. */
  let live: Permission[] | undefined;
  /** The cns version the device runs, from the first address that answers; undefined for one too old to say. */
  let version: string | undefined;
  let answered = false;
  // The saved addresses and, when none is a relay, the built-in relay, as commands dial them.
  const addresses = dialAddresses(entry, builtInRelay());
  if (!addresses.length) lines.push("  No saved address: cns peer address NAME ws://HOST:PORT adds one.");
  for (const address of addresses) {
    const cancelled = new AbortController();
    // The deadline covers the whole attempt: connecting, authenticating and the first call.
    const timer = setTimeout(() => cancelled.abort(new Error("Timed out after 10 s.")), 10_000);
    try {
      const { channel } = await connectSecure(address, identity, { expect: entry.publicKey, signal: cancelled.signal });
      const hangUp = () => channel.close("Timed out");
      cancelled.signal.addEventListener("abort", hangUp, { once: true });
      try {
        const remote = rpcSession<ShellApi>(channel, new RefusingShell());
        try {
          const info = await plain(remote.info());
          const reported = reportedVersion(info.version);
          attempts.push({ address, result: "ok", detail: printable(`${info.hostname}, ${info.platform}/${info.shell}, ${reported ? `cns ${reported}` : "older cns"}, encrypted`) });
          if (!answered) { answered = true; version = reported; }
          live ??= await liveAccess(remote);
        } finally { remote[Symbol.dispose](); }
      } finally {
        cancelled.signal.removeEventListener("abort", hangUp);
        channel.close();
      }
    } catch (error) {
      const detail = cancelled.signal.aborted ? "Timed out after 10 s." : printable(errorMessage(error));
      attempts.push({ address, result: error instanceof AuthError && !cancelled.signal.aborted ? error.code : "unreachable", detail });
    } finally { clearTimeout(timer); }
  }
  report.attempts = attempts;
  for (const attempt of attempts) lines.push(`  ${attempt.address}${isRelayAddress(attempt.address) ? (entry.addresses.includes(attempt.address) ? " [relay]" : " [built-in relay]") : ""}: ${attempt.result}${attempt.detail ? ` (${attempt.detail})` : ""}`);
  if (answered) {
    report.version = version ?? null;
    const order = versionOrder(version);
    if (order === "older" || order === "unknown") lines.push(`  It runs ${describeVersion(version)}, older than this device's ${CNS_VERSION}: upgrade cns on ${name} and restart its daemon (cns doctor there says how).`);
    else if (order === "newer") lines.push(`  It runs cns ${version}, newer than this device's ${CNS_VERSION}: upgrade cns here.`);
  }
  if (live) {
    report.access = live;
    const saved = entry.grants.outgoing;
    if (live.length !== saved.length || live.some((permission) => !saved.includes(permission))) {
      // Kept for display only, since the other device enforces it: record what it says now.
      updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, outgoing: live! } }));
      lines[accessLine] = `  This device may use its:  ${describeGrants(live)} (changed since it was saved as ${describeGrants(saved)}; saved now)`;
    }
    if (!live.length) lines.push(`  ${noAccessHint([name]).split("\n").slice(0, 2).join("\n  ")}`);
  }
  if (attempts.some((attempt) => attempt.result === "identity-changed")) process.exitCode = 3;
  else if (attempts.some((attempt) => attempt.result === "not-paired")) process.exitCode = 3;
  else if (!attempts.some((attempt) => attempt.result === "ok")) process.exitCode = 5;
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(lines.join("\n"));
}

/** What a paired device says this one may use on it, or undefined if it does not say in a form this cns reads. */
async function liveAccess(remote: RpcStub<ShellApi>): Promise<Permission[] | undefined> {
  try {
    const text: unknown = await (remote as unknown as { grants: Promise<unknown> }).grants;
    return typeof text === "string" && text.length <= 256 ? parseGrants(text.replaceAll(" ", ""), []) : undefined;
  } catch { return undefined; }
}

/** Tell the running daemon that a device's record changed, if there is one. */
async function refresh(name: string, state?: string) {
  const control = await daemonIfRunning(state);
  if (!control) return;
  try { await control.remote.refresh(name); } finally { control.close(); }
}

/** Refuse to change a mesh member's record by hand: the mesh's list and cns mesh allow keep it. */
function notMeshMember(name: string, then: string): void {
  const mesh = getPeer(name)?.mesh;
  if (mesh !== undefined) throw new Error(`${name} is here as a member of the mesh ${mesh}, so cns mesh allow ${mesh} sets what it may use here, as for every member. ${then}`.trimEnd());
}

/** `cns peer grant NAME GRANTS`: let a paired device do more here, at once and without interrupting its links. */
export async function grant(name: string, words: string[], options: { state?: string }): Promise<void> {
  notMeshMember(name, "");
  const added = expandGrants(words.flatMap((word) => word.split(",")).map((word) => word.trim()).filter(Boolean));
  if (!added.length) throw new Error(`Name what to grant: ${["shell", "files", "sessions", "all", ...PERMISSIONS].join(", ")}.`);
  const updated = updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, incoming: expandGrants([...peer.grants.incoming, ...added]) } }));
  await refresh(name, options.state);
  console.log(`${name} may use this device's: ${describeGrants(updated.grants.incoming)}.`);
}

/** `cns peer revoke NAME [GRANTS]`: take access away, now, ending what used it; without grants, all of it. */
export async function revoke(name: string, words: string[], options: { state?: string }): Promise<void> {
  notMeshMember(name, "");
  const removed = words.length ? new Set(expandGrants(words.flatMap((word) => word.split(",")).map((word) => word.trim()).filter(Boolean))) : new Set(PERMISSIONS);
  const updated = updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, incoming: peer.grants.incoming.filter((permission) => !removed.has(permission)) } }));
  await refresh(name, options.state);
  console.log(`${name} may use this device's: ${describeGrants(updated.grants.incoming)}.`);
}

/** `cns peer address NAME URL...`: where to reach a paired device; `--remove` takes addresses away. */
export async function address(name: string, urls: string[], options: { remove?: boolean; state?: string }): Promise<void> {
  const validated = urls.map((url) => validatePeerUrl(url));
  const updated = updatePairedPeer(name, (peer) => ({
    ...peer,
    addresses: options.remove ? peer.addresses.filter((saved) => !validated.includes(validatePeerUrl(saved))) : [...new Set([...peer.addresses, ...validated])],
  }));
  await refresh(name, options.state);
  console.log(updated.addresses.length ? `${name} is dialed at: ${updated.addresses.join(", ")}.` : `${name} has no saved address.`);
}

/**
 * Unpair the device saved as `name`, which must still name the key `publicKey`: put it on the
 * revoked list, so no mesh gives it a record here again (revokeDevice), then forget it, and have
 * the running daemon end its links at once. `cns peer remove` (remove-everywhere.ts) and
 * `cns mesh remove --unpair` call it.
 */
export async function unpair(name: string, publicKey: string, state?: string): Promise<void> {
  // Found by key, then removed by name: never a different device now saved under that name.
  if (savedKey(name)?.publicKey !== publicKey) throw new Error(`${name} now names another device, or none, so it was left as it is. Check cns peers.`);
  // Revoked first, so that no mesh list arriving meanwhile gives it a record once its pairing is gone.
  revokeDevice(fingerprintOf(publicKey), publicKey);
  removePeerFile(name);
  const control = await daemonIfRunning(state);
  if (control) { try { await control.remote.forget(publicKey); } finally { control.close(); } }
}

/** `cns peers`: every paired device with its status. */
export async function peers(options: PeersOptions): Promise<void> {
  const saved = listPeers();
  // A record left or restored of a device removed here: cns neither dials it nor lets it in.
  const removed = revokedDevices();
  let online = new Map<string, { via: "direct" | "relay"; version: string | undefined }>();
  const control = await daemonIfRunning(options.state);
  if (control) {
    try { online = await standingLinks(control); }
    catch { /* A daemon that cannot answer: everything is offline. */ }
    finally { control.close(); }
  }
  const rows = saved.map((peer) => {
    const link = online.get(peer.fingerprint);
    // Known only while linked: what a device runs can change whenever it is offline.
    return { name: peer.name, fingerprint: peer.fingerprint, status: link ? "online" : "offline", connection: link?.via ?? null, version: link?.version ?? null, access: peer.grants.outgoing, grants: peer.grants.incoming, addresses: peer.addresses, mesh: peer.mesh ?? null, revoked: removed.has(peer.fingerprint) };
  });
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("No paired devices. Run cns pair to pair with another device."); return; }
  // Only when there is a mesh member, so the table of a device in no mesh stays as it was.
  const meshes = rows.some((row) => row.mesh !== null);
  const table = [["NAME", "STATUS", "CONNECTION", "VERSION", "ACCESS", ...meshes ? ["MESH"] : [], "FINGERPRINT"], ...rows.map((row) => [
    row.name, row.revoked ? "removed" : row.status, row.connection ?? "-", row.status === "online" ? row.version ?? "older" : "-", describeGrants(row.access), ...meshes ? [row.mesh ?? "-"] : [], row.fingerprint,
  ])];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  console.log(table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n"));
  // A mesh member's access is learned over its first link, and cns mesh allow, not cns peer grant, widens it.
  const blocked = rows.flatMap((row) => !row.access.length && row.mesh === null && !row.revoked ? [row.name] : []);
  if (blocked.length) console.error(`\n${noAccessHint(blocked)}`);
  const left = rows.flatMap((row) => row.revoked ? [row.name] : []);
  if (left.length) {
    const one = left.length === 1;
    console.error(`\n${left.join(", ")} ${one ? "was" : "were"} removed from this device (cns peer remove), so cns neither connects to ${one ? "it" : "them"} nor lets ${one ? "it" : "them"} in; ${one ? "its record is" : "their records are"} left over, as from a backup. To delete ${one ? "it" : "one"}: cns peer remove ${one ? left[0] : "NAME"}.`);
  }
  const linked = rows.flatMap((row) => row.status === "online" ? [{ name: row.name, ...row.version ? { version: row.version } : {} }] : []);
  // Compared with the latest release too, when GitHub answers in time; offline, with this cns alone.
  let latest: string | undefined;
  if (linked.length) { try { latest = await latestRelease(2000); } catch { /* Unknown: say nothing of it. */ } }
  const hint = behindHint(linked, latest);
  if (hint.length) console.error(`\n${hint.join("\n")}`);
}

/** What to do about paired devices that grant this one nothing, which the other device alone can change. */
function noAccessHint(names: readonly string[]): string {
  const fingerprint = loadIdentity()?.fingerprint;
  const which = names.length === 1 ? names[0]! : names.join(", ");
  const where = names.length === 1 ? `on ${names[0]}` : "on each of them";
  return [
    `${which} ${names.length === 1 ? "grants" : "grant"} this device no access. To change that, run ${where}: cns peer grant NAME shell (or files, sessions, all),`,
    `where NAME is what it calls this device; cns peers there lists it${fingerprint ? ` with fingerprint ${fingerprint}` : ""}.`,
    `ACCESS is what was granted when you paired; cns doctor ${names.length === 1 ? names[0] : "NAME"} checks it again.`,
  ].join("\n");
}
