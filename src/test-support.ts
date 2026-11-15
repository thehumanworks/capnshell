import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { connectControl, stopDaemon } from "./commands/daemon.js";
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
 * A temporary home for a daemon that a test starts, with its state at .cns/daemon.json.
 * Hooks run in the order they were added, so one hook stops the daemon and then removes
 * the directory: removing the state file first would leave the daemon running.
 */
export async function daemonHome(t: TestContext, prefix = "cns-daemon-"): Promise<{ home: string; statePath: string }> {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const statePath = path.join(home, ".cns", "daemon.json");
  t.after(async () => {
    try { await stopDaemon(statePath); } catch { /* Not running. */ }
    await rm(home, { force: true, recursive: true });
  });
  return { home, statePath };
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
  return { ...process.env, CNS_BIND: undefined, CNS_PORT: undefined, CNS_CWD: undefined, ...overrides };
}

/** Exercise actual CLI processes, keeping exact streams available for run assertions. */
export function launchCli(t: TestContext, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const invocation = cliInvocation(args);
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const daemons: TestDevice[] = [];
  t.after(async () => {
    for (const device of daemons.reverse()) {
      try { await stopDaemon(device.state); } catch { /* Not running. */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  const cli = async (device: TestDevice, args: string[], input = "") => {
    const child = launchCli(t, args, { env: device.env });
    child.child.stdin.end(input);
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };
  return {
    root,
    cli,
    async device(name: string, env: Record<string, string> = {}): Promise<TestDevice> {
      const dir = path.join(root, name);
      await mkdir(dir, { mode: 0o700 });
      return { name, dir, env: { CNS_CONFIG_DIR: dir, HOME: dir, ...env }, state: path.join(dir, "daemon.json") };
    },
    /** Start the device's daemon on loopback. */
    async up(device: TestDevice, port?: string): Promise<string> {
      device.port = port ?? await unusedPort("127.0.0.1");
      const result = await cli(device, ["up", "--bind", "127.0.0.1", "--port", device.port, "--state", device.state]);
      if (result.code !== 0) throw new Error(`cns up failed on ${device.name}:\n${result.output}`);
      daemons.push(device);
      return device.port;
    },
    /**
     * Pair two devices: `host`, whose daemon runs, prints an invite that `guest` pastes. Each
     * saves the other under its name. `hostGrants` is what the guest may do on the host;
     * `guestGrants` what the host may do on the guest.
     */
    async pair(host: TestDevice, guest: TestDevice, { hostGrants = "all", guestGrants = "none" }: { hostGrants?: string; guestGrants?: string } = {}) {
      const inviting = launchCli(t, ["pair", "--yes", "--name", guest.name, "--grant", hostGrants, "--state", host.state], { env: host.env });
      inviting.child.stdin.end();
      await inviting.waitFor("Invite: cns1:");
      const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
      const accepting = await cli(guest, ["pair", invite, "--yes", "--name", host.name, "--grant", guestGrants, "--state", guest.state]);
      if (accepting.code !== 0) throw new Error(`Pairing failed on ${guest.name}:\n${accepting.output}`);
      if (await inviting.exited !== 0) throw new Error(`Pairing failed on ${host.name}:\n${inviting.output}`);
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
