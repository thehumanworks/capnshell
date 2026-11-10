import assert from "node:assert/strict";
import test from "node:test";
import { AuthError } from "./auth.js";
import { afterOpenFailure, Final, RETRY_MAX_MS, RETRY_MIN_MS, sessionReplaced, type AfterOpenFailure, type OpenFailure } from "./tty-recovery.js";

const MINUTES_10 = 10 * 60 * 1000;
const NOW = 1_000_000;

/** Where `cns tty studio` is when a try to reach its session fails. */
const situations = {
  "cns tty studio, first try": { first: true, own: true, name: undefined },
  "--attach work, first try": { first: true, own: false, name: "work" },
  "cns tty studio, reconnecting": { first: false, own: true, name: "tty-1" },
  "--attach work, reconnecting": { first: false, own: false, name: "work" },
} satisfies Record<string, Pick<OpenFailure, "first" | "own" | "name">>;

const at = (situation: keyof typeof situations, more: Partial<OpenFailure> = {}): OpenFailure => ({
  device: "studio", ...situations[situation], aborted: false, now: NOW, deadline: NOW + MINUTES_10, reconnectMs: MINUTES_10, wait: RETRY_MIN_MS, ...more,
});

const denied = (grant: string) => new Error(`Permission denied: ${grant} not granted to laptop.`);
const unreachable = new Error("connect ECONNREFUSED 127.0.0.1:7777");

/** How each failure arrives, as the device, the link or the local terminal reports it. */
const failures = {
  "studio does not know this device": new AuthError("not-paired", "Not paired."),
  "studio's key changed": new AuthError("identity-changed", "Its key changed."),
  "studio rejects the proof": new AuthError("invalid-proof", "Bad proof."),
  "studio refuses the link for now": new AuthError("refused", "Too many links."),
  "the session grants are missing": denied("sessions:create"),
  "only watching is missing": denied("sessions:view"),
  "control of sessions is missing": denied("sessions:control"),
  "the session is not there": new Error("No PTY session named work."),
  "the session ended while being attached": new Error("PTY session work no longer exists."),
  "studio keeps as many sessions as it may": new Error("Too many named PTY sessions; kill finished ones first."),
  "another session took its name": new Final("work on studio ended and was replaced while disconnected.", 1),
  "studio cannot be reached": unreachable,
};

type Outcome = AfterOpenFailure["kind"] | { final: number; says: string };
const final = (code: number, says: string) => ({ final: code, says });
/** The same outcome for both situations of a first try, or of reconnecting. */
const both = (outcome: Outcome): [Outcome, Outcome] => [outcome, outcome];

const notAccepted = (why: string) => [...both(final(3, `studio does not accept this device (${why}).`)), ...both(final(3, `studio no longer accepts this device (${why}).`))];
const grant = (permission: string) => `Permission denied: ${permission} not granted to laptop. To allow it, run on studio: cns peer grant laptop ${permission}`;

/** Each failure in each situation, in the order of `situations`. */
const table: Record<keyof typeof failures, Outcome[]> = {
  "studio does not know this device": notAccepted("Not paired."),
  "studio's key changed": notAccepted("Its key changed."),
  "studio rejects the proof": notAccepted("Bad proof."),
  // Any other refusal may pass: a first try reports it, and reconnecting tries again.
  "studio refuses the link for now": [...both("throw"), ...both("retry")],
  // A device that may not start sessions still gives a terminal that ends with the connection.
  "the session grants are missing": [
    "no-sessions", final(4, `studio does not let this device use that session: ${grant("sessions:create")}`),
    ...both(final(4, `access to studio's sessions was revoked: ${grant("sessions:create")}`)),
  ],
  "only watching is missing": [
    "no-sessions", final(4, `studio does not let this device use that session: ${grant("sessions:view")}`),
    ...both(final(4, `access to studio's sessions was revoked: ${grant("sessions:view")}`)),
  ],
  "control of sessions is missing": [
    ...both(final(4, `studio does not let this device use that session: ${grant("sessions:control")}`)),
    ...both(final(4, `access to studio's sessions was revoked: ${grant("sessions:control")}`)),
  ],
  "the session is not there": [
    final(1, "there is no session a new session on studio"), final(1, "there is no session work on studio; cns sessions studio lists them."),
    final(1, "the session tty-1 no longer exists on studio: it was killed, its time limit passed, or studio's daemon restarted."),
    final(1, "the session work no longer exists on studio: it was killed"),
  ],
  "the session ended while being attached": [
    final(1, "the session a new session no longer exists on studio."), final(1, "the session work no longer exists on studio."),
    final(1, "the session tty-1 no longer exists on studio."), final(1, "the session work no longer exists on studio."),
  ],
  "studio keeps as many sessions as it may": [...both(final(1, "studio already holds as many named sessions as it keeps")), ...both(final(1, "cns kill studio NAME ends one."))],
  "another session took its name": [...both(final(1, "work on studio ended and was replaced while disconnected.")), ...both(final(1, "was replaced"))],
  // Only an outage is waited out, and only once attached.
  "studio cannot be reached": [...both("throw"), ...both("retry")],
};

function check(next: AfterOpenFailure, expected: Outcome, label: string) {
  if (typeof expected === "string") return assert.equal(next.kind, expected, label);
  assert.equal(next.kind, "final", label);
  const { code, message } = next as Extract<AfterOpenFailure, { kind: "final" }>;
  assert.equal(code, expected.final, label);
  assert.ok(message.includes(expected.says), `${label}: ${JSON.stringify(message)} says ${JSON.stringify(expected.says)}`);
}

test("every failure in every situation ends, falls back or retries as the table says", () => {
  const names = Object.keys(situations) as Array<keyof typeof situations>;
  for (const [failure, outcomes] of Object.entries(table) as Array<[keyof typeof failures, Outcome[]]>) {
    assert.equal(outcomes.length, names.length, failure);
    names.forEach((situation, i) => check(afterOpenFailure(failures[failure], at(situation)), outcomes[i]!, `${failure}, ${situation}`));
  }
});

test("Ctrl-C, Ctrl-] or a signal stops the attach whatever the failure", () => {
  for (const [failure, error] of Object.entries(failures)) {
    for (const situation of Object.keys(situations) as Array<keyof typeof situations>) {
      assert.deepEqual(afterOpenFailure(error, at(situation, { aborted: true })), { kind: "stopped" }, `${failure}, ${situation}`);
    }
  }
});

test("reconnecting waits 0.5 s, doubling to 15 s, and gives up only once the deadline has passed", () => {
  const waits: number[] = [];
  for (let wait = RETRY_MIN_MS, tries = 0; tries < 8; tries++) {
    const next = afterOpenFailure(unreachable, at("--attach work, reconnecting", { wait }));
    assert.ok(next.kind === "retry");
    waits.push(next.waitMs);
    wait = next.nextWaitMs;
  }
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);

  const deadline = NOW + MINUTES_10;
  assert.equal(afterOpenFailure(unreachable, at("cns tty studio, reconnecting", { now: deadline })).kind, "retry");
  assert.deepEqual(afterOpenFailure(unreachable, at("cns tty studio, reconnecting", { now: deadline + 1 })), {
    kind: "give-up", message: "gave up reaching studio after 10 minutes: connect ECONNREFUSED 127.0.0.1:7777",
  });
  // Past the deadline, a failure that has a reason still says it, and a first try still reports its own.
  check(afterOpenFailure(denied("sessions:control"), at("--attach work, reconnecting", { now: deadline + 1 })), final(4, "was revoked"), "revoked after the deadline");
  assert.equal(afterOpenFailure(unreachable, at("--attach work, first try", { now: deadline + 1 })).kind, "throw");
  // Control characters a device sends cannot reach the terminal.
  const given = afterOpenFailure(new Error("lost\u001b[2J"), at("--attach work, reconnecting", { now: deadline + 1 }));
  assert.equal(given.kind === "give-up" && given.message.endsWith("lost?[2J"), true);
});

test("a reattach reaches only the session it first attached to", () => {
  const first = { pid: 41, startedAt: "2026-11-10T12:00:00.000Z" };
  assert.equal(sessionReplaced(first, { ...first }, "studio", "tty-1", true), undefined);
  for (const other of [{ ...first, pid: 42 }, { ...first, startedAt: "2026-11-10T12:05:00.000Z" }]) {
    const own = sessionReplaced(first, other, "studio", "tty-1", true);
    assert.deepEqual([own?.message, own?.code], ["tty-1 on studio ended and was replaced while disconnected; cns tty studio opens a new terminal.", 1]);
    const joined = sessionReplaced(first, other, "studio", "work", false);
    assert.equal(joined?.message, "work on studio ended and was replaced while disconnected; run cns tty studio --attach work again to attach to the new one.");
    // It ends the attach with that message.
    check(afterOpenFailure(joined, at("--attach work, reconnecting")), final(1, joined!.message), "replaced");
  }
});
