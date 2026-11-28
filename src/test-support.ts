import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, cp, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { connectControl, processExited, stopDaemon } from "./commands/daemon.js";
import { makePrivateDirectory } from "./config.js";
import { holderDirectory } from "./held-sessions.js";
import { KeyboardModes } from "./kitty-keyboard.js";
import { selfInvocation } from "./runtime.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function cliInvocation(args: string[]): { file: string; args: string[] } {
  const binary = process.env.CAPNWEB_TEST_BINARY;
  if (!binary) return selfInvocation(args);
  return {
    file: binary === "1" ? path.join(PROJECT_ROOT, "dist", process.platform === "win32" ? "cns.exe" : "cns") : path.resolve(binary),
    args,
  };
}

/**
 * Where tests put their daemons' directories: /tmp rather than os.tmpdir(), which is 49 bytes
 * on a Mac before a test adds to it, so that the sockets of a daemon's holders fit in macOS's
 * 104-byte socket paths (held-sessions.ts).
 */
export const TEST_TMP = process.platform === "win32" ? os.tmpdir() : "/tmp";

/**
 * A temporary home for a daemon that a test starts, with its state at .cns/daemon.json.
 * Hooks run in the order they were added, so one hook stops the daemon and then removes
 * the directory: removing the state file first would leave the daemon running.
 */
export async function daemonHome(t: TestContext, prefix = "cns-daemon-"): Promise<{ home: string; statePath: string }> {
  const home = await realpath(await mkdtemp(path.join(TEST_TMP, prefix)));
  const statePath = path.join(home, ".cns", "daemon.json");
  t.after(async () => {
    try { await stopDaemon(statePath); } catch { /* Not running. */ }
    await endHolders(statePath);
    await rm(home, { force: true, recursive: true });
  });
  return { home, statePath };
}

/**
 * End the holders of the named sessions a test's daemon started, which outlive the daemon
 * (held-sessions.ts): each hangs up its program and removes its record on SIGTERM.
 */
export async function endHolders(statePath: string): Promise<void> {
  const dir = holderDirectory(statePath);
  let files: string[];
  try { files = (await readdir(dir)).filter((file) => file.endsWith(".json")); } catch { return; }
  const pids: number[] = [];
  for (const file of files) {
    try {
      const { pid } = JSON.parse(await readFile(path.join(dir, file), "utf8")) as { pid: number };
      if (pid === process.pid) continue;
      process.kill(pid, "SIGTERM");
      pids.push(pid);
    } catch { /* Gone already. */ }
  }
  for (const pid of pids) {
    if (!(await processExited(pid, 5000))) try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ }
  }
}

/**
 * The loopback address tests bind: `::1` where the host has IPv6, else `127.0.0.1`.
 * Some containers, including Claude Code's cloud sessions, have no IPv6 at all.
 */
export const LOOPBACK = Object.values(os.networkInterfaces()).flat().some((entry) => entry?.address === "::1") ? "::1" : "127.0.0.1";
/** `LOOPBACK` as it appears in a URL: an IPv6 address is bracketed. */
export const LOOPBACK_HOST = LOOPBACK.includes(":") ? `[${LOOPBACK}]` : LOOPBACK;

/** A port that is free on `host`, which should be the address the test then binds. */
export async function unusedPort(host = LOOPBACK): Promise<string> {
  const probe = net.createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing probe address");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return String(address.port);
}

/** Keep user CLI defaults out of tests unless explicitly supplied. */
export function cliEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, CNS_BIND: undefined, CNS_PORT: undefined, CNS_CWD: undefined, CNS_KEY: undefined, CNS_KITTY_KEYS: undefined, ...overrides };
}

/**
 * A copy of this cns's source that says it is `version` in its package.json, as an older or newer
 * release would; returns the command that runs it, for launchCli.
 */
export async function cnsAs(root: string, version: string): Promise<string[]> {
  const dir = path.join(root, `cns-${version}`);
  await cp(path.join(PROJECT_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ ...manifest, version }));
  await symlink(path.join(PROJECT_ROOT, "node_modules"), path.join(dir, "node_modules"), "junction");
  return [process.execPath, path.join(dir, "src", "cli.ts")];
}

/** Exercise actual CLI processes, keeping exact streams available for run assertions. `cns` runs another cns, as from cnsAs. */
export function launchCli(t: TestContext, args: string[], options: SpawnOptionsWithoutStdio = {}, cns?: string[]) {
  const invocation = cns ? { file: cns[0]!, args: [...cns.slice(1), ...args] } : cliInvocation(args);
  const child = spawn(invocation.file, invocation.args, {
    ...options, env: cliEnvironment(options.env), stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  let output = "";
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; output += chunk; events.emit("change"); });
  child.stderr.on("data", (chunk) => { stderr += chunk; output += chunk; events.emit("change"); });
  child.on("error", (error) => { output += error.message; events.emit("change"); });
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => {
    closed = true;
    events.emit("change");
    resolve(code);
  }));
  t.after(async () => {
    if (closed) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(timer);
  });
  const waitFor = (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      events.off("change", check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (output.includes(needle, from)) finish();
      else if (closed) finish(new Error(`CLI exited before ${needle}:\n${output}`));
    };
    const timer = setTimeout(() => finish(new Error(`Waiting for ${needle}:\n${output}`)), 15000);
    events.on("change", check);
    check();
  });
  return {
    child, exited, waitFor,
    get output() { return output; },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get closed() { return closed; },
    async send(command: string, expected: string) {
      const from = output.length;
      child.stdin.write(command + "\n");
      await waitFor(expected, from);
      return output.slice(from);
    },
  };
}

/** A device a test runs: its own configuration directory, identity, peers and daemon state. */
export interface TestDevice {
  name: string;
  dir: string;
  env: Record<string, string>;
  state: string;
  /** Where its daemon listens, once `up` started it. */
  port?: string;
}

/**
 * Devices for a test, each with its own configuration, that run `cns up` and pair with each
 * other as people do. Hooks stop every daemon started here and then remove the directories.
 */
export async function testDevices(t: TestContext, prefix = "cns-devices-") {
  const root = await realpath(await mkdtemp(path.join(TEST_TMP, prefix)));
  const daemons: TestDevice[] = [];
  t.after(async () => {
    for (const device of daemons.reverse()) {
      try { await stopDaemon(device.state); } catch { /* Not running. */ }
      await endHolders(device.state);
    }
    await rm(root, { recursive: true, force: true });
  });
  const cli = async (device: TestDevice, args: string[], input = "", cns?: string[]) => {
    const child = launchCli(t, args, { env: device.env }, cns);
    child.child.stdin.end(input);
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };
  return {
    root,
    cli,
    async device(name: string, env: Record<string, string> = {}): Promise<TestDevice> {
      const dir = path.join(root, name);
      makePrivateDirectory(dir); // Applies the private ACL as well as mode 0700 on the respective platforms.
      return { name, dir, env: { CNS_CONFIG_DIR: dir, HOME: dir, ...env }, state: path.join(dir, "daemon.json") };
    },
    /** Start the device's daemon on loopback, with this cns or with `cns`. */
    async up(device: TestDevice, port?: string, cns?: string[]): Promise<string> {
      device.port = port ?? await unusedPort("127.0.0.1");
      const result = await cli(device, ["up", "--bind", "127.0.0.1", "--port", device.port, "--state", device.state], "", cns);
      if (result.code !== 0) throw new Error(`cns up failed on ${device.name}:\n${result.output}`);
      daemons.push(device);
      return device.port;
    },
    /**
     * Pair two devices: `host`, whose daemon runs, prints an invite that `guest` pastes. Each
     * saves the other under its name. `hostGrants` is what the guest may do on the host;
     * `guestGrants` what the host may do on the guest. Returns what each side printed.
     */
    async pair(host: TestDevice, guest: TestDevice, { hostGrants = "all", guestGrants = "none" }: { hostGrants?: string; guestGrants?: string } = {}) {
      // --long: an invite to paste, even for a device that has a relay to show a code through.
      const inviting = launchCli(t, ["pair", "--long", "--yes", "--name", guest.name, "--grant", hostGrants, "--state", host.state], { env: host.env });
      inviting.child.stdin.end();
      await inviting.waitFor("Invite: cns1:");
      const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
      const accepting = await cli(guest, ["pair", invite, "--yes", "--name", host.name, "--grant", guestGrants, "--state", guest.state]);
      if (accepting.code !== 0) throw new Error(`Pairing failed on ${guest.name}:\n${accepting.output}`);
      if (await inviting.exited !== 0) throw new Error(`Pairing failed on ${host.name}:\n${inviting.output}`);
      return { host: inviting.output, guest: accepting.output };
    },
  };
}

/**
 * The ID a daemon gave its link to the paired device saved as `name`. Once paired, both
 * daemons dial each other and keep one of the two links, so this waits until one settles.
 */
export async function settledLink(control: Awaited<ReturnType<typeof connectControl>>, name: string, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen: string | undefined;
  let since = 0;
  for (;;) {
    const links = (await control.controller.peers()).filter((peer) => peer.peer?.name === name && peer.peer.daemon);
    const id = links.length === 1 ? links[0]!.id : undefined;
    if (id && id === seen && Date.now() - since >= 1000) return id;
    if (id !== seen) { seen = id; since = Date.now(); }
    if (Date.now() > deadline) throw new Error(`No settled link to ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The part of a model terminal (an @xterm/headless Terminal) that kittyKeyboard needs. */
interface ModelTerminal {
  buffer: { active: { type: string } };
  parser: { registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): unknown };
}

/**
 * Make a model terminal speak the kitty keyboard protocol, as kitty and Ghostty do: it keeps
 * a keyboard mode for each of its screens and answers `CSI ? u` through `reply`. Returns the
 * mode of the screen it shows: `flags` in force and `depth` of what is pushed under them.
 */
export function kittyKeyboard(screen: ModelTerminal, reply: (text: string) => void) {
  const modes = new KeyboardModes();
  const mode = () => screen.buffer.active.type === "alternate" ? modes.alternate : modes.main;
  for (const prefix of [">", "<", "="]) {
    screen.parser.registerCsiHandler({ prefix, final: "u" }, (params) => {
      mode().apply(prefix, params.map((param) => typeof param === "number" ? param : param[0] ?? 0));
      return true;
    });
  }
  screen.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => { reply(`\x1b[?${mode().flags}u`); return true; });
  return {
    get flags() { return mode().flags; },
    get depth() { return mode().depth; },
    /** Both screens: the flags in force and the depth, normal screen first. */
    get all() { return [modes.main.flags, modes.main.depth, modes.alternate.flags, modes.alternate.depth]; },
  };
}

/**
 * A stand-in for systemctl --user that runs the unit's ExecStart as systemd would, and stops it
 * with cns stop. It finds the unit as cns does, so it also works for the commands of the daemon
 * it started, which has only HOME and the unit's environment. FAKE_LOG, when set, logs each call;
 * FAKE_SYSTEMCTL_FAIL, when set, makes that command, such as restart, fail as a broken unit's does.
 */
const FAKE_SYSTEMCTL = String.raw`
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, args.join(" ") + "\n");
if (process.env.FAKE_SYSTEMCTL_FAIL && args.includes(process.env.FAKE_SYSTEMCTL_FAIL)) {
  console.error("Job for cns.service failed because the control process exited with error code.");
  process.exit(1);
}
const unitPath = (process.env.XDG_CONFIG_HOME || process.env.HOME + "/.config") + "/systemd/user/cns.service";
const unquote = (word) => word.slice(1, -1).replace(/\\(.)/g, "$1").replace(/%%/g, "%").replace(/\$\$/g, "$");
function unit() {
  const text = readFileSync(unitPath, "utf8");
  const exec = text.match(/^ExecStart=(.*)$/m)[1].match(/"(?:[^"\\]|\\.)*"/g).map(unquote);
  const env = {};
  for (const [, line] of text.matchAll(/^Environment=("(?:[^"\\]|\\.)*")$/gm)) { const pair = unquote(line); env[pair.slice(0, pair.indexOf("="))] = pair.slice(pair.indexOf("=") + 1); }
  return { exec, env };
}
const { exec, env } = (args.includes("restart") || args.includes("start") || args.includes("--now")) ? unit() : { exec: [], env: {} };
const stop = () => spawnSync(exec[0], [...exec.slice(1, exec.indexOf("daemon")), "stop", "--state", exec[exec.indexOf("--state") + 1]], { stdio: "ignore" });
if (args.includes("restart") || args.includes("start")) {
  if (args.includes("restart")) stop();
  spawn(exec[0], exec.slice(1), { detached: true, stdio: "ignore", env: { HOME: process.env.HOME, ...env } }).unref();
}
if (args.includes("--now")) stop();
`;

/** Put the stand-in for systemctl in `bin`, which goes first on the PATH of the processes that should use it. */
export async function fakeSystemctl(bin: string): Promise<void> {
  const file = path.join(bin, "systemctl");
  await writeFile(file, `#!${process.execPath}\n${FAKE_SYSTEMCTL}`);
  await chmod(file, 0o755);
}
