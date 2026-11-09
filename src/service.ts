import { spawnSync } from "node:child_process";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDirectory } from "./config.js";

/** The launchd label and the systemd unit name of the installed daemon. */
export const SERVICE_LABEL = "com.thehumanworks.cns";
export const SERVICE_UNIT = "cns.service";

export type ServiceKind = "launchd" | "systemd";

/** What the service runs: the daemon in the foreground, as `cns up` would start it. */
export interface ServiceSpec {
  /** The executable and arguments that run `cns daemon --service ...`. */
  program: { file: string; args: string[] };
  /** Environment for the daemon: PATH and the like. */
  env: Record<string, string>;
  /** Where launchd writes the daemon's output; systemd sends it to the journal. */
  log: string;
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
  return undefined;
}

export function servicePath(kind: ServiceKind, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (kind === "launchd") return path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(config, "systemd", "user", SERVICE_UNIT);
}

/** The variables a daemon started from a login shell would have, which launchd and systemd do not pass on. */
export function serviceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of ["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "CNS_CONFIG_DIR", "CNS_RELAY"]) {
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

export function serviceFile(kind: ServiceKind, spec: ServiceSpec, home?: string, env?: NodeJS.ProcessEnv): ServiceFile {
  return { kind, path: servicePath(kind, home, env), contents: kind === "launchd" ? launchdPlist(spec) : systemdUnit(spec) };
}

/** Runs the service manager; tests replace it. */
export type Runner = (file: string, args: string[]) => { code: number; output: string };

export const runCommand: Runner = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  if (result.error) return { code: 127, output: result.error.message };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

function must(runner: Runner, file: string, args: string[]): void {
  const result = runner(file, args);
  if (result.code !== 0) throw new Error(`${[file, ...args].join(" ")} failed${result.output ? `: ${result.output}` : ` (exit ${result.code})`}`);
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
  await writeFile(temporary, file.contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, file.path);
  if (file.kind === "launchd") {
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
  if (!existsSync(file)) return false;
  if (kind === "launchd") runner("launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`]);
  else runner("systemctl", ["--user", "disable", "--now", SERVICE_UNIT]);
  await unlink(file);
  if (kind === "systemd") runner("systemctl", ["--user", "daemon-reload"]);
  return true;
}

/** The installed service's file, if there is one on this platform and it runs the daemon with this state file. */
export function installedService(state: string, home?: string, env?: NodeJS.ProcessEnv): { kind: ServiceKind; path: string } | undefined {
  const kind = serviceKind();
  if (!kind) return undefined;
  const file = servicePath(kind, home, env);
  let contents: string;
  try { contents = readFileSync(file, "utf8"); }
  catch { return undefined; }
  const needle = kind === "launchd" ? `<string>${xml(state)}</string>` : systemdQuote(state);
  return contents.includes(needle) ? { kind, path: file } : undefined;
}

/** Start an installed daemon that is not running, as after cns stop. */
export function startService(kind: ServiceKind, runner: Runner = runCommand): void {
  if (kind === "launchd") must(runner, "launchctl", ["kickstart", `${launchdDomain()}/${SERVICE_LABEL}`]);
  else must(runner, "systemctl", ["--user", "start", SERVICE_UNIT]);
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
  return kind === "launchd" ? path.join(path.dirname(state), "service.log") : "journalctl --user -u cns";
}

/** Whether systemd keeps this user's services running without a login session. */
export function lingering(runner: Runner = runCommand): boolean | undefined {
  const user = os.userInfo().username;
  const result = runner("loginctl", ["show-user", user, "--property=Linger", "--value"]);
  if (result.code !== 0) return undefined;
  return result.output.trim() === "yes";
}

export function serviceName(kind: ServiceKind): string {
  return kind === "launchd" ? "launchd agent" : "systemd user service";
}

export function describeService(kind: ServiceKind): string {
  return `a ${serviceName(kind)}`;
}
