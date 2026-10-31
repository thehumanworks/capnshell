import { isIP } from "node:net";
import { connectControl, daemonStatePath, startDaemon, type ControlConnection, type DaemonStatus } from "../src/commands/daemon.js";
import { errorMessage } from "../src/errors.js";
import { endpointUrl, isLoopback } from "../src/options.js";
import { plain } from "../src/terminal.js";
import type { Invocation } from "./program.js";
import { DEFAULT_PORT } from "./target.js";

/** Where `/cns listen` listens: CNS_BIND and CNS_PORT, else every interface on the default port. */
export interface ListenSettings {
  bind: string;
  port: number;
  /** The daemon's state file; by default ~/.cns/daemon.json, which cns attach and stop use too. */
  state?: string;
}

export function listenSettings(env: NodeJS.ProcessEnv = process.env, state?: string): ListenSettings {
  const bind = env.CNS_BIND?.trim() || "0.0.0.0";
  if (isIP(bind) === 0) throw new Error(`CNS_BIND must be a numeric IP address, not ${bind}.`);
  const portText = env.CNS_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error(`CNS_PORT must be a port number, not ${portText}.`);
  return { bind, port, state };
}

/**
 * CNS_LISTEN: whether Pi listens from the start, as with --cns-listen. 1, true,
 * yes or on starts listening; 0, false, no, off or nothing does not.
 */
export function listenAtStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CNS_LISTEN?.trim().toLowerCase() ?? "";
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`CNS_LISTEN must be 1 to listen when Pi starts, or 0 not to, not ${env.CNS_LISTEN}.`);
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
    if (/is not a function/.test(errorMessage(error))) {
      throw new Error("The running cns daemon is too old for Pi. Stop it with /cns stop, then run /cns listen again.");
    }
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
export async function listen(settings: ListenSettings, invocation: () => Invocation): Promise<Listener> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const running = await findDaemon(settings.state);
    if (running) return running;
    try {
      const started = await startDaemon({
        bind: settings.bind, port: settings.port, url: endpointUrl(settings.bind, settings.port),
        remote: !isLoopback(settings.bind), state: daemonStatePath(settings.state),
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
