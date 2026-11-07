import { isIP } from "node:net";
import { connectControl, daemonStatePath, startDaemon, type ControlConnection, type DaemonStatus } from "../src/commands/daemon.js";
import { endpointUrl } from "../src/options.js";
import { plain } from "../src/terminal.js";
import type { Invocation } from "./program.js";
import { DEFAULT_PORT } from "./target.js";

/** Where the daemon `/cns up` starts listens: CNS_BIND and CNS_PORT, else every interface on the default port. */
export interface UpSettings {
  bind: string;
  port: number;
  /** The daemon's state file; by default ~/.cns/daemon.json, which cns attach and stop use too. */
  state?: string;
}

export function upSettings(env: NodeJS.ProcessEnv = process.env, state?: string): UpSettings {
  const bind = env.CNS_BIND?.trim() || "0.0.0.0";
  if (isIP(bind) === 0) throw new Error(`CNS_BIND must be a numeric IP address, not ${bind}.`);
  const portText = env.CNS_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error(`CNS_PORT must be a port number, not ${portText}.`);
  return { bind, port, state };
}

/**
 * CNS_UP: whether Pi starts the daemon from the start, as with --cns-up. 1, true,
 * yes or on starts it; 0, false, no, off or nothing does not.
 */
export function upAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CNS_UP?.trim().toLowerCase() ?? "";
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`CNS_UP must be 1 to start the daemon when Pi starts, or 0 not to, not ${env.CNS_UP}.`);
}

export interface Listener {
  control: ControlConnection;
  status: DaemonStatus;
  /** This process started the daemon, rather than finding one running. */
  started: boolean;
  /** The daemon's log, when this process started it. */
  log?: string;
}

async function daemonStatus(control: ControlConnection): Promise<DaemonStatus> {
  try {
    return await plain(control.remote.status());
  } catch (error) {
    control.close();
    throw error;
  }
}

/** The daemon this state file names, if it answers. */
export async function findDaemon(state?: string): Promise<Listener | undefined> {
  let control: ControlConnection;
  try { control = await connectControl(state); }
  catch { return undefined; }
  return { control, status: await daemonStatus(control), started: false };
}

/**
 * Use this machine's cns daemon, starting one if none answers. Every Pi process
 * shares one daemon per state file: the first to ask starts it and the others
 * use it. When several start at once, the state file's exclusive creation lets
 * one win and the rest find the winner. The daemon outlives Pi.
 */
export async function up(settings: UpSettings, invocation: () => Invocation): Promise<Listener> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const running = await findDaemon(settings.state);
    if (running) return running;
    try {
      const started = await startDaemon({
        bind: settings.bind, port: settings.port, url: endpointUrl(settings.bind, settings.port),
        state: daemonStatePath(settings.state),
      }, { invocation: invocation() });
      const control = await connectControl(started.state);
      return { control, status: await daemonStatus(control), started: true, log: started.log };
    } catch (error) {
      // Another process may have started a daemon meanwhile; look again.
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 100 + 200 * attempt));
    }
  }
  throw failure;
}
