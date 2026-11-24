import type { ConnectionController } from "../console.js";
import { errorMessage } from "../errors.js";
import type { PeerConfig } from "../options.js";
import type { PtySessionInfo, PtySessionOptions } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import { describeExit } from "../session-text.js";
import { startNext } from "./paired-shell.js";

/** How long a session that is starting is given to show its prompt, in milliseconds. */
export interface Readiness {
  /** How often the session is asked how much it has printed. */
  pollMs: number;
  /** A shell is ready once it has printed something, its prompt, and then nothing for this long. */
  quietMs: number;
  /** The longest to wait for that: a shell that prints nothing, or never stops, gets the command anyway. */
  capMs: number;
}
const READINESS: Readiness = { pollMs: 100, quietMs: 400, capMs: 5000 };

/** What -d needs of a connection: the device's named sessions. */
type Sessions = Pick<ConnectionController, "ptySessions" | "startPtySession" | "ptySession">;

/**
 * `cns shell DEVICE -d [--session NAME] [-- COMMAND]`: type a command into a named session
 * and return, leaving the session running on the device.
 *
 * The session is a login shell, as `cns shell DEVICE` starts one, and not the command
 * itself: it outlives every command typed into it, so the next `-d --session NAME` types
 * another into the same shell, whose directory and variables carry over. The first use of
 * a name starts the session; without a name it is the next free shell-N, printed on stdout.
 * The command is typed as a person would type it at the prompt, followed by Enter. A
 * program still running in the session therefore receives it, as it would from a keyboard.
 *
 * --cwd, --timeout, --term, --cols, --rows and --secret describe a session being started.
 * A running one cannot take them, and is not typed into when they are given: a command
 * that was meant for another directory, or needed a secret, must not run without it.
 */
export async function runDetached(config: PeerConfig, controller: Sessions, id: string, signal: AbortSignal, readiness: Readiness = READINESS): Promise<number> {
  const { command, cwd, timeoutMs, cols, rows, term } = config;
  const device = config.expect.name;
  const options: PtySessionOptions = { cwd, timeoutMs, cols, rows, term, ...config.env ? { env: config.env } : {} };
  let name = config.name;
  /** The session this command started, as the device described it then. */
  let begun: PtySessionInfo | undefined;
  if (name === undefined) {
    name = await startNext(() => controller.ptySessions(id), async (next) => { begun = await controller.startPtySession(id, next, options); });
  }
  let handle = begun ? await controller.ptySession(id, name) : await find(controller, id, name);
  if (!handle) {
    try {
      begun = await controller.startPtySession(id, name, options);
    } catch (error) {
      // Another command started it between the look and the start: type into theirs.
      if (!/already exists/.test(errorMessage(error))) throw error;
    }
    handle = await controller.ptySession(id, name);
  }
  try {
    const info = await plain(handle.info());
    // The name can pass to another session between the start and the handle: one killed and started again.
    if (begun && (info.pid !== begun.pid || info.startedAt !== begun.startedAt)) {
      throw new Error(`The session ${name} on ${device} was replaced by another as it started, so nothing was typed. Run this again.`);
    }
    if (!info.running) {
      throw new Error(`The session ${name} on ${device} has ended (${info.exit ? describeExit(info.exit) : "its program exited"}). Remove it, then run this again: cns kill ${device} ${name}.`);
    }
    if (!begun && info.command !== null) {
      throw new Error(`The session ${name} on ${device} runs ${JSON.stringify(info.command)}, not a shell, so -d cannot type a command into it. Send it keys with cns keys ${device} ${name}, or name another session.`);
    }
    const startOnly = config.startOnly ?? [];
    if (!begun && startOnly.length) {
      throw new Error(`The session ${name} is already running on ${device}, and --${startOnly[0]} applies only when a session starts. Nothing was typed. Run the command without it, or in a new session.`);
    }
    if (begun) process.stderr.write(`cns: started the session ${name} on ${device}\n`);
    if (command !== undefined) {
      // A session that has printed nothing is still starting, whoever started it.
      if (begun || info.outputBytes === 0) {
        const settled = await ready(handle, signal, readiness);
        if (signal.aborted) throw new Error(`Stopped before the session ${name} on ${device} showed its prompt, so nothing was typed. The session is still running.`);
        if (!settled) process.stderr.write(`cns: the session ${name} did not settle at a prompt within ${readiness.capMs / 1000} seconds; the command was typed anyway\n`);
      }
      await handle.write(`${command}\r`);
    }
    // A name this command chose is the one thing a script cannot know.
    if (config.name === undefined) process.stdout.write(`${name}\n`);
    return 0;
  } finally {
    handle[Symbol.dispose]();
  }
}

/** A handle on the session `name`, or undefined when the device has none by that name. */
async function find(controller: Sessions, id: string, name: string): Promise<RemoteNamedPty | undefined> {
  try { return await controller.ptySession(id, name); }
  catch (error) {
    if (/No PTY session named/.test(errorMessage(error))) return undefined;
    throw error;
  }
}

/**
 * Wait until a shell that is starting has printed its prompt and gone quiet, and say
 * whether it did before the longest wait passed or the command was stopped. What is typed
 * sooner is usually kept for the shell, but a startup script that reads its input, such as
 * one asking whether to update, would take the command as its answer.
 */
async function ready(handle: RemoteNamedPty, signal: AbortSignal, { pollMs, quietMs, capMs }: Readiness): Promise<boolean> {
  const deadline = Date.now() + capMs;
  let bytes = 0;
  let since = Date.now();
  while (Date.now() < deadline && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const info = await plain(handle.info());
    if (!info.running) throw new Error(`The session ${info.name} ended as it started (${info.exit ? describeExit(info.exit) : "its shell exited"}); nothing was typed.`);
    if (info.outputBytes !== bytes) { bytes = info.outputBytes; since = Date.now(); }
    else if (bytes > 0 && Date.now() - since >= quietMs) return true;
  }
  return false;
}
