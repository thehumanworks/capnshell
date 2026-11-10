import assert from "node:assert/strict";
import test from "node:test";
import { DECISION_MS, DECLINED, ENDED, InviteBook, NOT_OPEN, NOTHING_TO_DECIDE, SAVE_FAILED, UNKNOWN, type Clock, type InvitePhase } from "./invites.js";
import type { Decision, Proposal } from "./pairing.js";

const TTL = 5 * 60 * 1000;
const PROPOSER = "P".repeat(43);
const STRANGER = "S".repeat(43);
const SECRET = new Uint8Array(16).fill(7);
const PROPOSAL: Proposal = { name: "laptop", requests: ["shell", "sessions:list"], offers: ["files"] };

/** A clock whose timers run only when a test moves it on. */
class TestClock implements Clock {
  #now = 1_000_000;
  #timers = new Set<{ at: number; run: () => void }>();
  now() { return this.#now; }
  set(run: () => void, ms: number) { const timer = { at: this.#now + ms, run }; this.#timers.add(timer); return timer; }
  clear(timer: unknown) { this.#timers.delete(timer as never); }
  advance(ms: number) {
    this.#now += ms;
    for (const timer of [...this.#timers].sort((a, b) => a.at - b.at)) {
      if (timer.at > this.#now || !this.#timers.has(timer)) continue;
      this.#timers.delete(timer);
      timer.run();
    }
  }
}

/** A promise's outcome so far, read after pending callbacks ran. */
function watch<T>(promise: Promise<T>) {
  const seen: { state: "pending" | "resolved" | "rejected"; value?: unknown } = { state: "pending" };
  promise.then((value) => { seen.state = "resolved"; seen.value = value; }, (error: Error) => { seen.state = "rejected"; seen.value = error.message; });
  return seen;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** An invite in `phase`, with a `cns pair` already waiting on it and, once proposed, the proposing device waiting for the decision. */
function inviteIn(phase: InvitePhase) {
  const clock = new TestClock();
  const book = new InviteBook(clock);
  const saved: Array<{ name: string; granted: string[] }> = [];
  book.open("inv", SECRET, clock.now() + TTL, TTL);
  const pair = watch(book.awaitProposal("inv"));
  const device = phase === "proposed" ? watch(book.propose("inv", PROPOSER, PROPOSAL)) : undefined;
  const save = (_proposed: unknown, name: string, granted: string[]) => { saved.push({ name, granted }); };
  return { clock, book, pair, device, saved, save };
}
type Invite = ReturnType<typeof inviteIn>;

interface Expected {
  /** What the event returned, or threw. */
  result?: unknown;
  throws?: string;
  /** Where the invite is after the event; undefined once it has ended. */
  then: InvitePhase | undefined;
  /** What the waiting `cns pair` (awaitProposal) and proposing device then see. */
  pair?: { state: string; value?: unknown; proposer?: string };
  device?: { state: string; value?: unknown };
}

/** cns pair sees the proposal `peer` made. */
const proposedBy = (peer: string) => ({ state: "resolved", proposer: peer });
const ended = (why: string) => ({ state: "rejected", value: why });

const events: Record<string, (invite: Invite) => unknown> = {
  "the secret is asked for": ({ book }) => book.secretFor("inv"),
  "a device proposes": ({ book }) => { void book.propose("inv", STRANGER, PROPOSAL).catch(() => {}); return "proposed"; },
  "cns pair waits for the proposal": ({ book }) => { void book.awaitProposal("inv").catch(() => {}); return "waiting"; },
  "cns pair accepts, granting more than was requested": ({ book, save }) => book.decide("inv", { accept: true, granted: ["shell", "files"] }, save),
  "cns pair accepts under another name": ({ book, save }) => book.decide("inv", { accept: true, name: "work", granted: ["sessions:list"] }, save),
  "cns pair declines": ({ book, save }) => book.decide("inv", { accept: false }, save),
  "saving the device fails": ({ book }) => book.decide("inv", { accept: true, granted: ["shell"] }, () => { throw new Error("disk full"); }),
  "the proposing device leaves": ({ book }) => book.left("inv", PROPOSER),
  "another device leaves": ({ book }) => book.left("inv", STRANGER),
  "cns pair goes away": ({ book }) => book.cancel("inv"),
  "the daemon stops": ({ book }) => book.endAll(),
  "the invite's lifetime passes": ({ clock }) => clock.advance(TTL),
  "the decision time passes": ({ clock }) => clock.advance(DECISION_MS),
};

const table: Record<InvitePhase, Record<keyof typeof events, Expected>> = {
  open: {
    "the secret is asked for": { result: SECRET, then: "open", pair: { state: "pending" } },
    "a device proposes": { result: "proposed", then: "proposed", pair: proposedBy(STRANGER) },
    "cns pair waits for the proposal": { result: "waiting", then: "open", pair: { state: "pending" } },
    "cns pair accepts, granting more than was requested": { throws: NOTHING_TO_DECIDE, then: "open" },
    "cns pair accepts under another name": { throws: NOTHING_TO_DECIDE, then: "open" },
    "cns pair declines": { throws: NOTHING_TO_DECIDE, then: "open" },
    "saving the device fails": { throws: NOTHING_TO_DECIDE, then: "open" },
    "the proposing device leaves": { then: "open", pair: { state: "pending" } },
    "another device leaves": { then: "open", pair: { state: "pending" } },
    "cns pair goes away": { then: undefined, pair: ended(ENDED.cancelled) },
    "the daemon stops": { then: undefined, pair: ended(ENDED.stopped) },
    "the invite's lifetime passes": { then: undefined, pair: ended(ENDED.expired) },
    "the decision time passes": { then: undefined, pair: ended(ENDED.expired) },
  },
  proposed: {
    // The first proposal took the invite: its secret proves nothing more.
    "the secret is asked for": { result: undefined, then: "proposed", device: { state: "pending" } },
    "a device proposes": { throws: NOT_OPEN, then: "proposed", device: { state: "pending" } },
    "cns pair waits for the proposal": { result: "waiting", then: "proposed", pair: proposedBy(PROPOSER) },
    // A decision grants at most what the device requested.
    "cns pair accepts, granting more than was requested": {
      result: { accept: true, name: "laptop", granted: ["shell"] }, then: undefined,
      device: { state: "resolved", value: { accept: true, name: "laptop", granted: ["shell"] } },
    },
    "cns pair accepts under another name": {
      result: { accept: true, name: "work", granted: ["sessions:list"] }, then: undefined,
      device: { state: "resolved", value: { accept: true, name: "work", granted: ["sessions:list"] } },
    },
    "cns pair declines": { result: { accept: false, reason: DECLINED }, then: undefined, device: { state: "resolved", value: { accept: false, reason: DECLINED } } },
    // The device hears no, so it saves nothing either.
    "saving the device fails": { throws: "disk full", then: undefined, device: { state: "resolved", value: { accept: false, reason: SAVE_FAILED } } },
    "the proposing device leaves": { then: undefined, device: ended(ENDED.left) },
    "another device leaves": { then: "proposed", device: { state: "pending" } },
    "cns pair goes away": { then: undefined, device: ended(ENDED.cancelled) },
    "the daemon stops": { then: undefined, device: ended(ENDED.stopped) },
    // Once proposed, only the decision time counts.
    "the invite's lifetime passes": { then: "proposed", device: { state: "pending" } },
    "the decision time passes": { then: undefined, device: ended(ENDED.undecided) },
  },
};

function check(seen: { state: string; value?: unknown }, expected: { state: string; value?: unknown; proposer?: string }, label: string) {
  assert.equal(seen.state, expected.state, label);
  if (expected.proposer) {
    const value = seen.value as { peer: string; proposal: Proposal; fingerprint: string };
    assert.deepEqual([value.peer, value.proposal, typeof value.fingerprint], [expected.proposer, PROPOSAL, "string"], label);
  } else if ("value" in expected) assert.deepEqual(seen.value, expected.value, label);
}

for (const phase of ["open", "proposed"] as const) {
  test(`an ${phase} invite answers every event as the table says`, async () => {
    for (const [event, expected] of Object.entries(table[phase])) {
      const label = `${phase}: ${event}`;
      const invite = inviteIn(phase);
      let result: unknown;
      if (expected.throws) assert.throws(() => events[event]!(invite), { message: expected.throws }, label);
      else result = events[event]!(invite);
      if ("result" in expected) assert.deepEqual(result, expected.result, label);
      assert.equal(invite.book.phase("inv"), expected.then, label);
      await settle();
      if (expected.pair) check(invite.pair, expected.pair, `${label}, cns pair`);
      if (expected.device) check(invite.device!, expected.device, `${label}, the proposing device`);
      // Only an accepted decision saves the device, under the name and grants it was told.
      const accepted = expected.result as Decision | undefined;
      assert.deepEqual(invite.saved, accepted?.accept ? [{ name: accepted.name, granted: accepted.granted }] : [], `${label}, saved`);
    }
  });
}

test("an invite that has ended, however it ended, takes nothing more", async () => {
  const endings: Record<string, (invite: Invite) => void> = {
    accepted: ({ book, save }) => { book.decide("inv", { accept: true, granted: ["shell"] }, save); },
    declined: ({ book, save }) => { book.decide("inv", { accept: false }, save); },
    left: ({ book }) => book.left("inv", PROPOSER),
    cancelled: ({ book }) => book.cancel("inv"),
    stopped: ({ book }) => book.endAll(),
    undecided: ({ clock }) => clock.advance(DECISION_MS),
  };
  for (const [ending, end] of Object.entries(endings)) {
    const invite = inviteIn("proposed");
    end(invite);
    const { book, save } = invite;
    assert.equal(book.phase("inv"), undefined, ending);
    assert.equal(book.secretFor("inv"), undefined, ending);
    assert.throws(() => book.propose("inv", STRANGER, PROPOSAL), { message: NOT_OPEN }, ending);
    await assert.rejects(book.awaitProposal("inv"), { message: UNKNOWN }, ending);
    assert.throws(() => book.decide("inv", { accept: true }, save), { message: NOTHING_TO_DECIDE }, ending);
    // Ending it again tells nobody anything.
    book.cancel("inv");
    book.endAll();
  }
});

test("an open invite's secret stops working at its expiry, even before its timer runs", () => {
  const clock = new TestClock();
  const book = new InviteBook({ now: () => clock.now(), set: () => undefined, clear: () => {} });
  book.open("inv", SECRET, clock.now() + TTL, TTL);
  clock.advance(TTL - 1);
  assert.equal(book.secretFor("inv"), SECRET);
  clock.advance(1);
  assert.equal(book.secretFor("inv"), undefined);
  assert.equal(book.secretFor("other"), undefined);
});

test("invites are independent: ending one leaves the others, and stopping ends them all", () => {
  const clock = new TestClock();
  const book = new InviteBook(clock);
  book.open("a", SECRET, clock.now() + TTL, TTL);
  book.open("b", SECRET, clock.now() + 2 * TTL, 2 * TTL);
  void book.propose("b", PROPOSER, PROPOSAL).catch(() => {});
  clock.advance(TTL);
  assert.deepEqual([book.phase("a"), book.phase("b")], [undefined, "proposed"]);
  book.open("c", SECRET, clock.now() + TTL, TTL);
  book.endAll();
  assert.deepEqual([book.phase("b"), book.phase("c")], [undefined, undefined]);
});
