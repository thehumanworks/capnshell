import type { ConnectionController } from "../console.js";
import { errorMessage } from "../errors.js";
import type { PeerConfig } from "../options.js";
import { MAX_SCREEN_HISTORY, type PtyScreen, type PtySessionInfo, type PtySessionOptions } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";
import { describeExit } from "../session-text.js";
import { commandExitCode } from "./one-shot.js";
import { startNext } from "./paired-shell.js";

/** How long a session that is starting is given to show its prompt, in milliseconds. */
export interface Readiness {
  /** How often the session is asked how much it has printed. */
  pollMs: number;
  /** A shell is ready once it has printed something, its prompt, and then nothing for this long. */
  quietMs: number;
  /** The longest to wait for that: a shell that prints nothing, or never stops, gets the command anyway. */
  capMs: number;
  /** With --screen: a command has ended once its shell has had the terminal back, and printed nothing, for this long. */
  endMs: number;
  /** With --screen, when the device cannot say whether its shell runs a command: printing nothing for this long is taken as the end. */
  guessMs: number;
}
const READINESS: Readiness = { pollMs: 100, quietMs: 400, capMs: 5000, endMs: 300, guessMs: 2000 };

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
 *
 * With --screen it waits for the command to end, prints what the session showed from the
 * line it was typed on, and returns, leaving the session running. The command has ended once
 * the session's shell has its terminal back (Pty.busy on the device) and the output stops.
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
      const busy = await busyOf(handle);
      const before = config.screen ? { screen: await plain(handle.capture({ history: MAX_SCREEN_HISTORY })), bytes: (await plain(handle.info())).outputBytes } : undefined;
      await handle.write(`${command}\r`);
      if (busy) process.stderr.write(`cns: a program was running in the session ${name} on ${device}, and the command was typed into it\n`);
      if (before) {
        if (busy === undefined) process.stderr.write(`cns: ${device} runs a cns from before 2.1.0, which cannot say when the command ends; its screen is printed once it shows nothing new for ${readiness.guessMs / 1000} seconds\n`);
        else if (busy === null) process.stderr.write(`cns: ${device} cannot say when the command ends; its screen is printed once it shows nothing new for ${readiness.guessMs / 1000} seconds\n`);
        return await printWhenDone(handle, { name, device, ...before, known: typeof busy === "boolean" }, signal, readiness);
      }
    }
    // A name this command chose is the one thing a script cannot know.
    if (config.name === undefined) process.stdout.write(`${name}\n`);
    return 0;
  } finally {
    handle[Symbol.dispose]();
  }
}

/** Whether the session's shell runs a command: null when the device cannot tell, undefined when its cns is from before 2.1.0 and cannot be asked. */
async function busyOf(handle: RemoteNamedPty): Promise<boolean | null | undefined> {
  try { return await handle.busy(); }
  catch (error) {
    if (/'busy' is not a function/.test(errorMessage(error))) return undefined;
    throw error;
  }
}

/**
 * For -d --screen: wait for the command typed into the session to end, then print what the
 * session shows from the line it was typed on, scrollback included. The session keeps running.
 */
async function printWhenDone(handle: RemoteNamedPty, typed: { name: string; device: string; screen: PtyScreen; bytes: number; known: boolean }, signal: AbortSignal, timing: Readiness): Promise<number> {
  const { name, device } = typed;
  const end = await finished(handle, typed, signal, timing);
  if (end === "stopped") {
    process.stderr.write(`cns: stopped waiting; the command goes on in the session ${name} on ${device}: cns screen ${device} ${name}\n`);
    return 130;
  }
  const after = await plain(handle.capture({ history: MAX_SCREEN_HISTORY }));
  process.stdout.write(outputSince(typed.screen, after).replace(/\n+$/, "") + "\n");
  if (end.running) return 0;
  process.stderr.write(`cns: the session ${name} on ${device} has ended (${end.exit ? describeExit(end.exit) : "its shell exited"})\n`);
  return end.exit ? commandExitCode(end.exit) : 1;
}

/**
 * Wait until the command has ended: the shell has the terminal back and the session has
 * printed nothing for a moment, or, when the device cannot say who has the terminal, has
 * printed nothing for longer. A job in the background can go on printing after the command
 * ends, so a shell that has had the terminal back for that longer while is taken as the end
 * too. The session's info when it ended, or "stopped" on Ctrl-C.
 */
async function finished(handle: RemoteNamedPty, { bytes: from, known }: { bytes: number; known: boolean }, signal: AbortSignal, { pollMs, endMs, guessMs }: Readiness): Promise<PtySessionInfo | "stopped"> {
  let bytes = from;
  let since = Date.now();
  /** Since when the shell has had the terminal, while it echoed or printed something. */
  let back: number | undefined;
  try {
    while (!signal.aborted) {
      await pause(pollMs, signal);
      if (signal.aborted) break;
      const info = await plain(handle.info());
      if (!info.running) return info;
      const busy = known && await handle.busy();
      back = busy || !known || info.outputBytes === from ? undefined : back ?? Date.now();
      if (back !== undefined && Date.now() - back >= guessMs) return info;
      if (busy || info.outputBytes !== bytes) {
        bytes = info.outputBytes;
        since = Date.now();
        continue;
      }
      // Until the shell has echoed the command, it may not have read it yet.
      if (Date.now() - since >= (known && bytes > from ? endMs : guessMs)) return info;
    }
  } catch (error) {
    // Ctrl-C closes the connection under the call that was waiting.
    if (!signal.aborted) throw error;
  }
  return "stopped";
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * What a session shows from the line the cursor was on in `before`, the line a command was
 * then typed on, to the end of `after`. Both are captures with the whole scrollback. The
 * lines above that one are unchanged, unless the device dropped its oldest lines to make
 * room for new ones: the smallest shift that lines them up again says how many. When none
 * does, as after clear, all of `after` is the command's.
 */
export function outputSince(before: PtyScreen, after: PtyScreen): string {
  const old = before.text.split("\n");
  const now = after.text.split("\n");
  const start = old.length - before.rows + before.cursor.y;
  const kept = (dropped: number) => {
    for (let line = dropped; line < start; line++) if (old[line] !== now[line - dropped]) return false;
    return true;
  };
  for (let dropped = 0; dropped < start; dropped++) if (kept(dropped)) return now.slice(start - dropped).join("\n");
  return now.join("\n");
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
