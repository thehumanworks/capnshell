import { AuthError } from "./auth.js";
import { errorMessage, printable } from "./errors.js";
import { explainDenial, type Permission } from "./peers.js";
import { describeExit } from "./session-text.js";
import type { PtySessionInfo } from "./shell.js";

/**
 * Every paired device's named sessions at once, for `cns sessions` without a device and for
 * `cns ui`. Each device is asked over its own connection, in parallel, so one that is slow or
 * unreachable delays the answer by at most `timeoutMs` and never hides the others.
 */

/** How long one device has to answer before it is reported unreachable. */
export const LIST_TIMEOUT_MS = 10_000;

/** A saved paired device, as much of it as deciding whether to ask it needs. */
export interface FleetDevice {
  name: string;
  /** What the device said it lets this one do; the daemon refreshes it whenever it links. */
  outgoing: readonly Permission[];
}

export type DeviceSessions =
  /** The device answered. */
  | { device: string; state: "listed"; sessions: PtySessionInfo[]; via: "direct" | "relay" }
  /** Not asked: as saved, the device does not let this one list its sessions. */
  | { device: string; state: "not-granted"; reason: string }
  /** Asked, and the device refused: it no longer accepts this one, or a grant was taken back. */
  | { device: string; state: "refused"; reason: string }
  /** Asked, and no answer came: offline, unreachable or too slow. */
  | { device: string; state: "unreachable"; reason: string };

/** Ask one device for its sessions; `signal` aborts when the device has taken too long. */
export type AskDevice<T extends FleetDevice = FleetDevice> = (device: T, signal: AbortSignal) => Promise<{ sessions: PtySessionInfo[]; via: "direct" | "relay" }>;

/** Whether to ask a device at all: listing needs `sessions:list`, which a device without it would refuse. */
export function shouldAsk(device: FleetDevice): DeviceSessions | undefined {
  if (device.outgoing.includes("sessions:list")) return undefined;
  return {
    device: device.name, state: "not-granted",
    reason: `${device.name} does not let this device list its sessions (sessions:list); cns doctor ${device.name} checks what it grants now`,
  };
}

/** What a failed ask means: refused by the device, or no answer from it. `timedOutMs` is set when it took too long. */
export function failure(device: string, error: unknown, timedOutMs?: number): DeviceSessions {
  if (timedOutMs !== undefined) return { device, state: "unreachable", reason: `no answer within ${timedOutMs < 1000 ? `${timedOutMs} ms` : `${Math.round(timedOutMs / 1000)} seconds`}` };
  const message = printable(errorMessage(error));
  if (error instanceof AuthError || /^Permission denied/.test(message)) return { device, state: "refused", reason: explainDenial(message, device) };
  return { device, state: "unreachable", reason: message };
}

/** Ask every device that may be asked, in parallel, and report each in the order given. */
export async function listEverywhere<T extends FleetDevice>(devices: readonly T[], ask: AskDevice<T>, { timeoutMs = LIST_TIMEOUT_MS, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DeviceSessions[]> {
  return await Promise.all(devices.map(async (device): Promise<DeviceSessions> => {
    const skipped = shouldAsk(device);
    if (skipped) return skipped;
    const deadline = AbortSignal.timeout(timeoutMs);
    const aborted = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const answer = await new Promise<Awaited<ReturnType<AskDevice<T>>>>((resolve, reject) => {
        const stop = () => reject(aborted.reason);
        if (aborted.aborted) return stop();
        aborted.addEventListener("abort", stop, { once: true });
        ask(device, aborted).then(resolve, reject).finally(() => aborted.removeEventListener("abort", stop));
      });
      return { device: device.name, state: "listed", sessions: answer.sessions, via: answer.via };
    } catch (error) {
      signal?.throwIfAborted();
      return failure(device.name, error, deadline.aborted ? timeoutMs : undefined);
    }
  }));
}

/** One table of every listed session, with a header, or "" when no device holds any. */
export function formatEverywhere(results: readonly DeviceSessions[]): string {
  const rows = results.flatMap((result) => result.state !== "listed" ? [] : result.sessions.map((session) => [
    result.device, session.name, session.exit ? describeExit(session.exit) : "running", `${session.cols}x${session.rows}`,
    String(session.viewers), printable(session.title || session.command || "(login shell)"),
  ]));
  if (!rows.length) return "";
  const table = [["DEVICE", "NAME", "STATUS", "SIZE", "ATTACHED", "TITLE OR COMMAND"], ...rows];
  const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
  return table.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index]!)).join("  ")).join("\n");
}

/** A line for each device that could not be listed, and a summary when nothing was listed at all. */
export function notesEverywhere(results: readonly DeviceSessions[]): string[] {
  const notes = results.flatMap((result) => result.state === "listed" ? [] : [`${result.device}: ${result.state === "not-granted" ? "not listed" : result.state}: ${result.reason}`]);
  const listed = results.filter((result) => result.state === "listed");
  if (!results.length) notes.push("No paired devices. Run cns pair to pair with another device.");
  else if (listed.length && listed.every((result) => !result.sessions.length)) {
    notes.push(`No named sessions on ${listed.map((result) => result.device).join(", ")}.`);
  }
  return notes;
}

/** The exit status: 1 when a device that was asked did not answer, else 0. */
export const everywhereExitCode = (results: readonly DeviceSessions[]) => results.some((result) => result.state === "refused" || result.state === "unreachable") ? 1 : 0;
