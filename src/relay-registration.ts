import { printable } from "./errors.js";
import { redialDelay } from "./link-rules.js";

/**
 * A daemon's registration at its relay. The daemon keeps one connection to the relay's
 * accept endpoint: it proves its key there, the relay says it is ready, and from then on
 * the relay tells it of each device dialing it through the relay. When the connection
 * fails or drops, the daemon waits and registers again, with backoff.
 *
 *   connecting ──opened──▶ proving ──ready──▶ registered
 *       ▲
 *       └──waited── waiting ◀── opening failed (connecting), the connection closed
 *                               (proving), or the registration was lost (registered)
 *
 *   any state ──stop──▶ stopped
 *
 * The steps are pure: src/commands/peer.ts opens and closes the sockets, runs the timers
 * and does what each step returns, and relay-registration.test.ts takes every state through
 * every event as a table. Only `registered` counts as registered for `cns status` and
 * `cns doctor`; in every other state the daemon is still trying.
 */

/** A registered daemon pings the relay this often, and registers again if it hears nothing for three times as long. */
export const RELAY_PING_MS = 30_000;
/** A registration that stayed up this long resets the backoff, so a relay that keeps dropping it is not hammered. */
export const RELAY_STABLE_MS = 30_000;

export type RegistrationPhase = "connecting" | "proving" | "registered" | "waiting" | "stopped";

export interface Registration {
  readonly phase: RegistrationPhase;
  /** The relay's host, as the daemon's log names it. */
  readonly host: string;
  /** Retries since a registration last stayed up RELAY_STABLE_MS: the next wait is redialDelay(attempt). */
  readonly attempt: number;
  /** The failure last logged, so the same outage is logged once rather than on every retry. A registration clears it. */
  readonly lastFailure: string;
  /** While proving or registered: when the relay was last heard from. */
  readonly heardAt: number;
  /** While registered: when the relay said ready. */
  readonly readyAt: number;
}

export type RegistrationEvent =
  /** The connection to the relay opened. */
  | { t: "opened" }
  /** Opening it failed, with this message. */
  | { t: "open-failed"; error: string }
  /** The relay sent this, a WebSocket message's data. */
  | { t: "message"; data: unknown }
  /** The ping interval came round. */
  | { t: "tick" }
  /** The connection closed. */
  | { t: "closed"; code: number; reason: string }
  /** The wait before registering again is over. */
  | { t: "waited" }
  /** The daemon is stopping. */
  | { t: "stop" };

export type RegistrationEffect =
  /** Open a connection to the relay's accept endpoint. */
  | { do: "connect" }
  /** Sign the relay's challenge for this nonce and send the proof. */
  | { do: "prove"; nonce: string }
  | { do: "ping" }
  /** Close the connection, saying why. */
  | { do: "close"; reason: string }
  /** Answer a dialer the relay announced. */
  | { do: "answer"; id: string }
  /** Log this line. */
  | { do: "say"; message: string }
  /** Wait this long, then step with "waited". */
  | { do: "wait"; ms: number };

export interface RegistrationStep {
  state: Registration;
  effects: RegistrationEffect[];
}

/** The relay's nonces and dialer ids: 16 random bytes, base64url. */
const RELAY_ID = /^[A-Za-z0-9_-]{22}$/;

/** What a message from the relay says. Anything else, such as a pong, only shows the relay is there. */
type RelayMessage = { t: "challenge"; nonce: string } | { t: "invalid-challenge" } | { t: "ready" } | { t: "incoming"; id: string } | { t: "other" };

function read(data: unknown): RelayMessage {
  if (typeof data !== "string") return { t: "other" };
  let message: unknown;
  try { message = JSON.parse(data); } catch { return { t: "other" }; }
  // JSON that is not an object, such as null, says nothing.
  if (typeof message !== "object" || message === null) return { t: "other" };
  const { t, nonce, id } = message as { t?: unknown; nonce?: unknown; id?: unknown };
  if (t === "challenge") return typeof nonce === "string" && RELAY_ID.test(nonce) ? { t: "challenge", nonce } : { t: "invalid-challenge" };
  if (t === "ready") return { t: "ready" };
  if (t === "incoming" && typeof id === "string" && RELAY_ID.test(id)) return { t: "incoming", id };
  return { t: "other" };
}

/** A daemon starts registering at the relay on `host`. */
export function startRegistration(host: string): RegistrationStep {
  return { state: { phase: "connecting", host, attempt: 0, lastFailure: "", heardAt: 0, readyAt: 0 }, effects: [{ do: "connect" }] };
}

/** Whether `cns status` and `cns doctor` report the daemon registered. */
export function isRegistered(state: Registration | undefined): boolean {
  return state?.phase === "registered";
}

/** How `cns status` and `cns up` name the registration the daemon reported. */
export function registrationWord(registered: unknown): "registered" | "registering" {
  return registered ? "registered" : "registering";
}

/** Wait to register again, after a failure before registering or a lost registration. */
function retry(state: Registration, effects: RegistrationEffect[], attempt = state.attempt): RegistrationStep {
  return { state: { ...state, phase: "waiting", attempt: attempt + 1 }, effects: [...effects, { do: "wait", ms: redialDelay(attempt) }] };
}

/** A failure before registering: logged if it is new, so the same outage is logged once. */
function failed(state: Registration, failure: string): RegistrationStep {
  if (!failure || failure === state.lastFailure) return retry(state, []);
  return retry({ ...state, lastFailure: failure }, [{ do: "say", message: `Cannot register at the relay ${state.host}: ${failure} Retrying automatically.` }]);
}

/** What the registration does on `event` at `now`, in milliseconds since the epoch. */
export function stepRegistration(state: Registration, event: RegistrationEvent, now: number): RegistrationStep {
  const same: RegistrationStep = { state, effects: [] };
  const { phase } = state;
  const stopping: RegistrationEffect = { do: "close", reason: "The daemon is stopping" };
  if (phase === "stopped") {
    // A connection that finishes opening just after the daemon stopped is closed at once.
    return event.t === "opened" ? { state, effects: [stopping] } : same;
  }
  if (event.t === "stop") {
    // While connecting, stopping aborts the connection itself; while waiting, the wait runs out unanswered.
    const open = phase === "proving" || phase === "registered";
    return { state: { ...state, phase: "stopped" }, effects: open ? [stopping] : [] };
  }
  if (phase === "connecting") {
    if (event.t === "opened") return { state: { ...state, phase: "proving", heardAt: now }, effects: [] };
    if (event.t === "open-failed") return failed(state, printable(event.error));
    return same;
  }
  if (phase === "waiting") {
    if (event.t === "waited") return { state: { ...state, phase: "connecting" }, effects: [{ do: "connect" }] };
    return same;
  }
  // Proving or registered: a connection to the relay is open.
  if (event.t === "message") {
    const heard = { ...state, heardAt: now };
    const message = read(event.data);
    if (message.t === "challenge") return { state: heard, effects: [{ do: "prove", nonce: message.nonce }] };
    if (message.t === "invalid-challenge") return { state: heard, effects: [{ do: "close", reason: "Invalid challenge" }] };
    if (message.t === "ready" && phase === "proving") {
      return {
        state: { ...heard, phase: "registered", readyAt: now, lastFailure: "" },
        effects: [{ do: "say", message: `Registered at the relay ${state.host}; devices that cannot reach this one directly can reach it there.` }],
      };
    }
    if (message.t === "incoming" && phase === "registered") return { state: heard, effects: [{ do: "answer", id: message.id }] };
    return { state: heard, effects: [] };
  }
  if (event.t === "tick") {
    if (now - state.heardAt > 3 * RELAY_PING_MS) return { state, effects: [{ do: "close", reason: "The relay stopped answering" }] };
    return { state, effects: [{ do: "ping" }] };
  }
  if (event.t === "closed") {
    const reason = event.reason ? `: ${printable(event.reason)}` : "";
    if (phase === "proving") return failed(state, `Connection closed before registration (${event.code})${reason}`);
    const stable = now - state.readyAt >= RELAY_STABLE_MS;
    return retry(state, [{ do: "say", message: `Left the relay ${state.host}${reason}; registering again.` }], stable ? 0 : state.attempt);
  }
  return same;
}
