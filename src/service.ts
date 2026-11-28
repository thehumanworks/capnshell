import { spawn, spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDirectory, system32 } from "./config.js";
import { selfInvocation } from "./runtime.js";

/** The launchd label and the systemd unit name of the installed daemon. */
export const SERVICE_LABEL = "com.thehumanworks.cns";
export const SERVICE_UNIT = "cns.service";

/** The Windows scheduled task's name: one per account, since all accounts' tasks share one folder. */
export const taskName = (user = os.userInfo().username) => `cns-${user}`;
/** schtasks.exe in System32, never one that the current directory or PATH has first. */
export const schtasks = () => path.join(system32(), "schtasks.exe");

/** schtasks is a Windows Task Scheduler task that starts at sign-in. */
export type ServiceKind = "launchd" | "systemd" | "schtasks";

/** What the service runs: the daemon in the foreground, as `cns up` would start it. */
export interface ServiceSpec {
  /** The executable and arguments that run `cns daemon --service ...`. */
  program: { file: string; args: string[] };
  /** Environment for the daemon: PATH and the like. */
  env: Record<string, string>;
  /** Where launchd writes the daemon's output; systemd sends it to the journal. */
  log: string;
  /** The account a scheduled task runs as, and whose sign-in starts it: its SID. */
  user?: string;
}

export interface ServiceFile {
  kind: ServiceKind;
  path: string;
  contents: string;
}

/** The service manager this platform uses for a per-user daemon, if cns supports it. */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | undefined {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  if (platform === "win32") return "schtasks";
  return undefined;
}

/**
 * launchd and systemd run on macOS and Linux, so their paths are POSIX ones on every platform. Task
 * Scheduler keeps its tasks to itself; cns keeps the definition it registered, which only Windows
 * reads, so that path has this platform's separators.
 */
export function servicePath(kind: ServiceKind, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (kind === "schtasks") return path.join(home, ".cns", "service.xml");
  if (kind === "launchd") return path.posix.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const config = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.posix.join(home, ".config");
  return path.posix.join(config, "systemd", "user", SERVICE_UNIT);
}

/** The variables a daemon started from a login shell would have, which launchd and systemd do not pass on. */
export function serviceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  // CA paths are trust configuration, not credentials. Without them a service can
  // fail to reach the relay even though the same binary works in the login shell.
  // Never inherit TLS-verification bypasses or the rest of the shell's environment.
  for (const name of ["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "CNS_CONFIG_DIR", "CNS_RELAY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    const value = env[name];
    if (value) kept[name] = value;
  }
  return kept;
}

function refuseNewlines(values: string[]): void {
  if (values.some((value) => /[\0\r\n]/.test(value))) throw new Error("A service setting cannot contain a newline or NUL character.");
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.program.file, ...spec.program.args];
  refuseNewlines([...args, ...Object.entries(spec.env).flat(), spec.log]);
  const strings = (values: string[], indent: string) => values.map((value) => `${indent}<string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(spec.env).map(([name, value]) => `\t\t<key>${xml(name)}</key>\n\t\t<string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${SERVICE_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(args, "\t\t")}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

/** One systemd word, double-quoted: specifiers (%) and variables ($) are taken literally. */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const args = [spec.program.file, ...spec.program.args];
  refuseNewlines([...args, ...Object.entries(spec.env).flat()]);
  // Environment= expands specifiers but not variables, so only % needs doubling there.
  const env = Object.entries(spec.env).map(([name, value]) => `Environment="${`${name}=${value}`.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/%/g, "%%")}"`);
  return [
    "[Unit]",
    "Description=cns peer daemon for paired devices",
    "Wants=network-online.target",
    "After=network-online.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${args.map(systemdQuote).join(" ")}`,
    ...env,
    // cns stop ends the daemon with status 0, and it then stays stopped until cns up or the next login.
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** One word of a Windows command line, always quoted, as programs that parse it like the C runtime read it back. */
export function windowsQuote(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The scheduled task: started at this account's sign-in, as this account and unelevated, so that
 * registering it needs no administrator. cns is a console program, which Windows would show a
 * console window for, so conhost --headless runs it, as the pseudo-console API does. Task Scheduler
 * restarts only a task it could not start, so the task's program, `cns daemon --supervise`,
 * supervises the daemon itself (superviseDaemon). It passes no environment: the daemon gets the account's.
 */
export function scheduledTask(spec: ServiceSpec): string {
  const args = [spec.program.file, ...spec.program.args];
  if (!spec.user) throw new Error("A scheduled task needs the account it runs as.");
  refuseNewlines([...args, spec.user]);
  // Task Scheduler expands %NAME% in a command line, and has no escape for it.
  if (args.some((value) => /%[^%]+%/.test(value))) throw new Error("Task Scheduler would expand %NAME% in a service setting. Use paths without percent signs.");
  const user = xml(spec.user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>cns peer daemon for paired devices</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>10</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>%SystemRoot%\\System32\\conhost.exe</Command>
      <Arguments>--headless ${xml(args.map(windowsQuote).join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function serviceFile(kind: ServiceKind, spec: ServiceSpec, home?: string, env?: NodeJS.ProcessEnv): ServiceFile {
  const contents = kind === "launchd" ? launchdPlist(spec) : kind === "systemd" ? systemdUnit(spec) : scheduledTask(spec);
  return { kind, path: servicePath(kind, home, env), contents };
}

/** schtasks reads a task's definition as UTF-16, as Task Scheduler writes one. */
const encodeService = (file: ServiceFile) => file.kind === "schtasks" ? Buffer.from(`\ufeff${file.contents}`, "utf16le") : file.contents;
const readService = (kind: ServiceKind, file: string) => readFileSync(file, kind === "schtasks" ? "utf16le" : "utf8");

/** One word of the daemon's command as the service file writes it, so that it never matches part of another word. */
function serviceWord(kind: ServiceKind, value: string): string {
  if (kind === "launchd") return `<string>${xml(value)}</string>`;
  return kind === "systemd" ? systemdQuote(value) : xml(windowsQuote(value));
}

/** Runs the service manager; tests replace it. */
export type Runner = (file: string, args: string[]) => { code: number; output: string };

export const runCommand: Runner = (file, args) => {
  // windowsHide: a console program run from a process without a console, as the restart worker is, would open a window.
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, windowsHide: true });
  if (result.error) return { code: 127, output: result.error.message };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

function must(runner: Runner, file: string, args: string[], next?: string): void {
  const result = runner(file, args);
  if (result.code === 0) return;
  const failed = `${[file, ...args].join(" ")} failed${result.output ? `: ${result.output}` : ` (exit ${result.code})`}`;
  throw new Error(next ? `${failed.replace(/\.$/, "")}. ${next}` : failed);
}

const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`;

/** Write the service file, privately, and start the daemon through the service manager. */
export async function installService(file: ServiceFile, runner: Runner = runCommand): Promise<void> {
  await mkdir(path.dirname(file.path), { recursive: true });
  // launchd opens the log itself, so its directory must exist first.
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  try { if ((await lstat(file.path)).isSymbolicLink()) throw new Error(`Refusing to replace the symbolic link at ${file.path}.`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const temporary = `${file.path}.${process.pid}.tmp`;
  await writeFile(temporary, encodeService(file), { mode: 0o600, flag: "wx" });
  await rename(temporary, file.path);
  if (file.kind === "schtasks") {
    must(runner, schtasks(), ["/Create", "/TN", taskName(), "/XML", file.path, "/F"], "Run cns up to start the daemon without a service.");
    runTask(runner, "The task starts the daemon at your next sign-in; run cns up to start it now.");
  } else if (file.kind === "launchd") {
    // Replace a loaded copy; bootout fails when none is loaded, which is fine.
    runner("launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`]);
    must(runner, "launchctl", ["bootstrap", launchdDomain(), file.path]);
  } else {
    must(runner, "systemctl", ["--user", "daemon-reload"]);
    must(runner, "systemctl", ["--user", "enable", SERVICE_UNIT]);
    must(runner, "systemctl", ["--user", "restart", SERVICE_UNIT]);
  }
}

/** Stop the daemon through the service manager and remove the service file. Returns whether one was installed. */
export async function uninstallService(kind: ServiceKind, runner: Runner = runCommand, home?: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const file = servicePath(kind, home, env);
  if (kind === "schtasks") {
    const name = taskName();
    if (runner(schtasks(), ["/Query", "/TN", name]).code !== 0) return false;
    // Ending the task ends its supervisor, not the daemon, which the caller stops first.
    runner(schtasks(), ["/End", "/TN", name]);
    must(runner, schtasks(), ["/Delete", "/TN", name, "/F"], `Delete ${name} in Task Scheduler, or run schtasks /Delete /TN "${name}" /F.`);
    if (existsSync(file)) await unlink(file);
    return true;
  }
  if (!existsSync(file)) return false;
  if (kind === "launchd") runner("launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`]);
  else runner("systemctl", ["--user", "disable", "--now", SERVICE_UNIT]);
  await unlink(file);
  if (kind === "systemd") runner("systemctl", ["--user", "daemon-reload"]);
  return true;
}

/**
 * The installed service's file, if there is one on this platform and it runs the daemon with this
 * state file. A scheduled task counts only while Task Scheduler still has it.
 */
export function installedService(state: string, home?: string, env?: NodeJS.ProcessEnv, runner: Runner = runCommand, platform = process.platform): { kind: ServiceKind; path: string } | undefined {
  const kind = serviceKind(platform);
  if (!kind) return undefined;
  const file = servicePath(kind, home, env);
  let contents: string;
  try { contents = readService(kind, file); }
  catch { return undefined; }
  if (!contents.includes(serviceWord(kind, state))) return undefined;
  if (kind === "schtasks" && runner(schtasks(), ["/Query", "/TN", taskName()]).code !== 0) return undefined;
  return { kind, path: file };
}

/**
 * Whether Task Scheduler has this account's task, and the state file of the daemon it runs, from
 * the --state in the definition cns registered. Windows paths hold no quotes, so the first one ends it.
 */
export function registeredTask(home?: string, env?: NodeJS.ProcessEnv, runner: Runner = runCommand): { state?: string } | undefined {
  if (runner(schtasks(), ["/Query", "/TN", taskName()]).code !== 0) return undefined;
  let contents = "";
  try { contents = readService("schtasks", servicePath("schtasks", home, env)); } catch { /* Not kept: the state is unknown. */ }
  const state = /&quot;--state&quot; &quot;(.*?)&quot;/.exec(contents)?.[1];
  return state === undefined ? {} : { state: state.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") };
}

/**
 * What an installed service runs, for advice on restarting it: whether its file is a link into the
 * Nix store, as Home Manager installs it, and whether it runs `executable`.
 */
export function installedServiceRuns(service: { kind: ServiceKind; path: string }, executable: string, store = "/nix/store/"): { managedByNix: boolean; runsThis: boolean } {
  let contents = "";
  try { contents = readService(service.kind, service.path); } catch { /* Gone since it was found: it runs nothing. */ }
  let target = service.path;
  try { target = realpathSync(service.path); } catch { /* A broken link: not the Nix store's. */ }
  return { managedByNix: target.startsWith(store), runsThis: contents.includes(serviceWord(service.kind, executable)) };
}

/**
 * The systemd drop-ins whose ExecStart runs something other than `executable`. Whatever the unit
 * file says, every restart then brings back what they name, such as a runtime drop-in left under
 * /run/user/UID/systemd/user/cns.service.d from an earlier recovery. Empty for launchd and Task Scheduler, and when
 * systemd cannot say.
 */
export function serviceOverrides(kind: ServiceKind, executable: string, runner: Runner = runCommand): string[] {
  if (kind !== "systemd") return [];
  const result = runner("systemctl", ["--user", "show", SERVICE_UNIT, "--property=DropInPaths", "--value"]);
  if (result.code !== 0) return [];
  return result.output.split(/\s+/).filter((file) => {
    if (!path.posix.isAbsolute(file)) return false;
    let contents: string;
    try { contents = readFileSync(file, "utf8"); } catch { return false; }
    // A bare `ExecStart=` only clears the unit's command; the lines after it set the new one.
    const commands = [...contents.matchAll(/^[ \t]*ExecStart[ \t]*=[ \t]*(\S.*)$/gm)].map((match) => match[1]!);
    return commands.some((command) => !command.includes(executable));
  });
}

/** Start an installed daemon that is not running, as after cns stop. */
export function startService(kind: ServiceKind, runner: Runner = runCommand): void {
  if (kind === "launchd") must(runner, "launchctl", ["kickstart", `${launchdDomain()}/${SERVICE_LABEL}`]);
  else if (kind === "schtasks") runTask(runner, "Run cns up --install to register the task again.");
  else must(runner, "systemctl", ["--user", "start", SERVICE_UNIT]);
}

/**
 * Run the scheduled task. Task Scheduler ignores a run while it counts an earlier one as running,
 * which may be ending, or supervising an old command, and schtasks /Run still reports success. So
 * end that one first; /End fails when none runs, which is fine.
 */
function runTask(runner: Runner, next: string): void {
  runner(schtasks(), ["/End", "/TN", taskName()]);
  must(runner, schtasks(), ["/Run", "/TN", taskName()], next);
}

/** Restart the systemd service's daemon, or start it if it is not running, with the command the unit and its drop-ins give it now. */
export function restartService(runner: Runner = runCommand): void {
  must(runner, "systemctl", ["--user", "restart", SERVICE_UNIT]);
}

/**
 * Whether the installed daemon has already failed since it was started: systemd shows it failed, or
 * waiting to restart after a failure. Undefined where the service manager cannot tell.
 */
export function serviceFailed(kind: ServiceKind, runner: Runner = runCommand): boolean | undefined {
  if (kind !== "systemd") return undefined;
  const result = runner("systemctl", ["--user", "show", SERVICE_UNIT, "--property=ActiveState,SubState"]);
  if (result.code !== 0) return undefined;
  return /^ActiveState=failed$/m.test(result.output) || /^SubState=auto-restart$/m.test(result.output);
}

/** Where to read the installed daemon's output. */
export function serviceLog(kind: ServiceKind, state: string): string {
  return kind === "systemd" ? "journalctl --user -u cns" : path.join(path.dirname(state), "service.log");
}

/** Whether systemd keeps this user's services running without a login session. */
export function lingering(runner: Runner = runCommand): boolean | undefined {
  const user = os.userInfo().username;
  const result = runner("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  if (result.code !== 0) return undefined;
  return result.output.trim() === "yes";
}

export function serviceName(kind: ServiceKind): string {
  return kind === "launchd" ? "launchd agent" : kind === "systemd" ? "systemd user service" : "scheduled task";
}

export function describeService(kind: ServiceKind): string {
  return `a ${serviceName(kind)}`;
}

/** What superviseDaemon uses to run and check the daemon; tests replace them. */
export interface Supervision {
  launch?: typeof spawn;
  sleep?: (ms: number) => Promise<unknown>;
  runner?: Runner;
  /** Whether a daemon answers at this state file. */
  answers?: (state: string) => Promise<boolean>;
}

async function daemonAnswers(state: string): Promise<boolean> {
  const { connectControl } = await import("./commands/daemon.js");
  try { (await connectControl(state)).close(); return true; } catch { return false; }
}

/**
 * What `cns daemon --supervise`, which only the scheduled task runs, does: run the daemon with
 * --service, and start it again 5 seconds after it fails, as launchd and systemd do, since Task
 * Scheduler restarts only a task it could not start. It stops instead once the task is gone or a
 * daemon answers at the state file, so that two of them never take turns failing. The daemon runs
 * detached, as cns up starts it, and appends its output to service.log. Returns once the daemon
 * exits with status 0, as after cns stop.
 */
export async function superviseDaemon(daemon: { state: string; bind: string; port: number }, supervision: Supervision = {}): Promise<void> {
  const { launch = spawn, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), runner = runCommand, answers = daemonAnswers } = supervision;
  const program = selfInvocation(["daemon", "--service", "--state", daemon.state, "--bind", daemon.bind, "--port", String(daemon.port)]);
  const log = serviceLog("schtasks", daemon.state);
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  for (;;) {
    const output = await open(log, "a", 0o600);
    let ended: number | string;
    try {
      const child = launch(program.file, program.args, { detached: true, windowsHide: true, stdio: ["ignore", output.fd, output.fd] });
      ended = await new Promise<number | string>((resolve) => {
        child.once("error", (error) => resolve(error.message));
        child.once("exit", (code, signal) => resolve(code ?? signal ?? "unknown"));
      });
    } finally { await output.close(); }
    if (ended === 0) return;
    await appendFile(log, `[cns: the daemon ended (${ended}); starting it again in 5 seconds]\n`);
    await sleep(5000);
    const reason = runner(schtasks(), ["/Query", "/TN", taskName()]).code !== 0 ? "its scheduled task is gone"
      : await answers(daemon.state) ? "a daemon answers at its state file" : undefined;
    if (reason) { await appendFile(log, `[cns: not starting it again: ${reason}]\n`); return; }
  }
}
