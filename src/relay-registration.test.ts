import assert from "node:assert/strict";
import test from "node:test";
import { isRegistered, registrationWord, RELAY_PING_MS, RELAY_STABLE_MS, startRegistration, stepRegistration, type Registration, type RegistrationEffect, type RegistrationEvent, type RegistrationPhase } from "./relay-registration.js";
import { selfCheck } from "./self-check.js";

const HOST = "relay.example";
const NOW = 1_000_000;
const NONCE = "N".repeat(22);
const ID = "D".repeat(22);
const LAST = "Timed out connecting to wss://relay.example/relay/v1/accept/KEY.";
const OTHER = "Cannot connect to wss://relay.example/relay/v1/accept/KEY. certificate has expired";
/** When the relay was last heard from, and when it said ready. */
const HEARD = NOW - 1000;
const READY = NOW - 10_000;

/** A registration in each state, three retries into its backoff, with LAST logged before it registered. */
const states: Record<RegistrationPhase, Registration> = {
  connecting: { phase: "connecting", host: HOST, attempt: 3, lastFailure: LAST, heardAt: 0, readyAt: 0 },
  proving: { phase: "proving", host: HOST, attempt: 3, lastFailure: LAST, heardAt: HEARD, readyAt: 0 },
  registered: { phase: "registered", host: HOST, attempt: 3, lastFailure: "", heardAt: HEARD, readyAt: READY },
  waiting: { phase: "waiting", host: HOST, attempt: 3, lastFailure: LAST, heardAt: 0, readyAt: 0 },
  stopped: { phase: "stopped", host: HOST, attempt: 3, lastFailure: LAST, heardAt: 0, readyAt: 0 },
};

const message = (value: unknown): RegistrationEvent => ({ t: "message", data: JSON.stringify(value) });
const relayClosed: RegistrationEvent = { t: "closed", code: 4008, reason: "Invalid relay message." };

/** Each event, and when it happens. */
const events = {
  "the connection opens": [{ t: "opened" }, NOW],
  "opening fails as it did last time": [{ t: "open-failed", error: LAST }, NOW],
  "opening fails another way": [{ t: "open-failed", error: OTHER }, NOW],
  "the relay challenges": [message({ t: "challenge", nonce: NONCE }), NOW],
  "the relay sends a challenge that is not one": [message({ t: "challenge", nonce: "../../etc" }), NOW],
  "the relay says ready": [message({ t: "ready" }), NOW],
  "the relay announces a dialer": [message({ t: "incoming", id: ID }), NOW],
  "the relay answers a ping": [message({ t: "pong" }), NOW],
  "a ping is due": [{ t: "tick" }, NOW],
  "a ping is due 90 s after the relay was last heard": [{ t: "tick" }, HEARD + 3 * RELAY_PING_MS],
  "a ping is due after more than 90 s of silence": [{ t: "tick" }, HEARD + 3 * RELAY_PING_MS + 1],
  // 10 s after the registered state said ready, and 30 s after it.
  "the relay closes the connection": [relayClosed, NOW],
  "the relay closes the connection 20 s later": [relayClosed, READY + RELAY_STABLE_MS],
  "the wait is over": [{ t: "waited" }, NOW],
  "the daemon stops": [{ t: "stop" }, NOW],
} satisfies Record<string, [RegistrationEvent, number]>;

const say = (text: string): RegistrationEffect => ({ do: "say", message: text });
const wait = (ms: number): RegistrationEffect => ({ do: "wait", ms });
const close = (reason: string): RegistrationEffect => ({ do: "close", reason });
const prove: RegistrationEffect = { do: "prove", nonce: NONCE };
const ping: RegistrationEffect = { do: "ping" };
const cannot = (failure: string) => say(`Cannot register at the relay relay.example: ${failure} Retrying automatically.`);
const REGISTERED = say("Registered at the relay relay.example; devices that cannot reach this one directly can reach it there.");
const LEFT = say("Left the relay relay.example: Invalid relay message.; registering again.");
const CLOSED_EARLY = "Connection closed before registration (4008): Invalid relay message.";

/** Nothing changes: the event cannot happen in this state, or means nothing there. */
const IGNORED = "ignored";
/** The next state, and what the daemon does. */
type Row = typeof IGNORED | [RegistrationPhase, ...RegistrationEffect[]];

const table: Record<RegistrationPhase, Record<keyof typeof events, Row>> = {
  connecting: {
    "the connection opens": ["proving"],
    // The same outage is logged once; the backoff goes on either way (attempt 3: 8 s).
    "opening fails as it did last time": ["waiting", wait(8000)],
    "opening fails another way": ["waiting", cannot(OTHER), wait(8000)],
    "the relay challenges": IGNORED,
    "the relay sends a challenge that is not one": IGNORED,
    "the relay says ready": IGNORED,
    "the relay announces a dialer": IGNORED,
    "the relay answers a ping": IGNORED,
    "a ping is due": IGNORED,
    "a ping is due 90 s after the relay was last heard": IGNORED,
    "a ping is due after more than 90 s of silence": IGNORED,
    "the relay closes the connection": IGNORED,
    "the relay closes the connection 20 s later": IGNORED,
    "the wait is over": IGNORED,
    // Stopping aborts the connection being opened; its failure then arrives here stopped.
    "the daemon stops": ["stopped"],
  },
  proving: {
    "the connection opens": IGNORED,
    "opening fails as it did last time": IGNORED,
    "opening fails another way": IGNORED,
    "the relay challenges": ["proving", prove],
    "the relay sends a challenge that is not one": ["proving", close("Invalid challenge")],
    "the relay says ready": ["registered", REGISTERED],
    // Only a registered daemon answers dialers.
    "the relay announces a dialer": ["proving"],
    "the relay answers a ping": ["proving"],
    "a ping is due": ["proving", ping],
    "a ping is due 90 s after the relay was last heard": ["proving", ping],
    "a ping is due after more than 90 s of silence": ["proving", close("The relay stopped answering")],
    "the relay closes the connection": ["waiting", cannot(CLOSED_EARLY), wait(8000)],
    "the relay closes the connection 20 s later": ["waiting", cannot(CLOSED_EARLY), wait(8000)],
    "the wait is over": IGNORED,
    "the daemon stops": ["stopped", close("The daemon is stopping")],
  },
  registered: {
    "the connection opens": IGNORED,
    "opening fails as it did last time": IGNORED,
    "opening fails another way": IGNORED,
    "the relay challenges": ["registered", prove],
    "the relay sends a challenge that is not one": ["registered", close("Invalid challenge")],
    // Said once per registration.
    "the relay says ready": ["registered"],
    "the relay announces a dialer": ["registered", { do: "answer", id: ID }],
    "the relay answers a ping": ["registered"],
    "a ping is due": ["registered", ping],
    "a ping is due 90 s after the relay was last heard": ["registered", ping],
    "a ping is due after more than 90 s of silence": ["registered", close("The relay stopped answering")],
    // Lost after 10 s: the backoff goes on. Lost after 30 s: it starts again at 1 s.
    "the relay closes the connection": ["waiting", LEFT, wait(8000)],
    "the relay closes the connection 20 s later": ["waiting", LEFT, wait(1000)],
    "the wait is over": IGNORED,
    "the daemon stops": ["stopped", close("The daemon is stopping")],
  },
  waiting: {
    "the connection opens": IGNORED,
    "opening fails as it did last time": IGNORED,
    "opening fails another way": IGNORED,
    "the relay challenges": IGNORED,
    "the relay sends a challenge that is not one": IGNORED,
    "the relay says ready": IGNORED,
    "the relay announces a dialer": IGNORED,
    "the relay answers a ping": IGNORED,
    "a ping is due": IGNORED,
    "a ping is due 90 s after the relay was last heard": IGNORED,
    "a ping is due after more than 90 s of silence": IGNORED,
    "the relay closes the connection": IGNORED,
    "the relay closes the connection 20 s later": IGNORED,
    "the wait is over": ["connecting", { do: "connect" }],
    // The wait runs out later, and finds the registration stopped.
    "the daemon stops": ["stopped"],
  },
  stopped: {
    "the connection opens": IGNORED,
    "opening fails as it did last time": IGNORED,
    "opening fails another way": IGNORED,
    "the relay challenges": IGNORED,
    "the relay sends a challenge that is not one": IGNORED,
    "the relay says ready": IGNORED,
    "the relay announces a dialer": IGNORED,
    "the relay answers a ping": IGNORED,
    "a ping is due": IGNORED,
    "a ping is due 90 s after the relay was last heard": IGNORED,
    "a ping is due after more than 90 s of silence": IGNORED,
    "the relay closes the connection": IGNORED,
    "the relay closes the connection 20 s later": IGNORED,
    "the wait is over": IGNORED,
    "the daemon stops": IGNORED,
  },
};

for (const phase of Object.keys(table) as RegistrationPhase[]) {
  test(`a registration ${phase} answers every event as the table says`, () => {
    for (const [name, [event, now]] of Object.entries(events) as Array<[keyof typeof events, [RegistrationEvent, number]]>) {
      const label = `${phase}: ${name}`;
      const before = states[phase];
      const { state, effects } = stepRegistration(before, event, now);
      const row = table[phase][name];
      if (row === IGNORED) {
        assert.deepEqual({ state, effects }, { state: before, effects: [] }, label);
        continue;
      }
      const [then, ...does] = row;
      assert.equal(state.phase, then, label);
      assert.deepEqual(effects, does, label);
      // Anything the relay sends shows that it is still there.
      if (event.t === "message") assert.equal(state.heardAt, now, label);
    }
  });
}

test("a daemon starts by connecting, with nothing logged and no backoff yet", () => {
  assert.deepEqual(startRegistration(HOST), {
    state: { phase: "connecting", host: HOST, attempt: 0, lastFailure: "", heardAt: 0, readyAt: 0 },
    effects: [{ do: "connect" }],
  });
});

/** A registration taken through events, keeping what it said and how long it waited. */
class Run {
  state: Registration;
  now = NOW;
  said: string[] = [];
  waits: number[] = [];
  effects: RegistrationEffect[] = [];
  constructor() { this.state = startRegistration(HOST).state; }
  on(event: RegistrationEvent, after = 0) {
    this.now += after;
    const next = stepRegistration(this.state, event, this.now);
    this.state = next.state;
    this.effects = next.effects;
    for (const effect of next.effects) {
      if (effect.do === "say") this.said.push(effect.message);
      if (effect.do === "wait") this.waits.push(effect.ms);
    }
    return this;
  }
  /** The wait runs out, and the connection opens. */
  reconnect() {
    if (this.state.phase === "waiting") this.on({ t: "waited" }, this.waits.at(-1));
    return this.on({ t: "opened" });
  }
  register() { return this.reconnect().on(message({ t: "challenge", nonce: NONCE })).on(message({ t: "ready" })); }
}

test("against a relay that keeps dropping the registration, the wait doubles to 30 s, and a registration that lasted 30 s resets it", () => {
  const run = new Run();
  for (let drops = 0; drops < 8; drops++) run.register().on({ t: "closed", code: 1006, reason: "" }, 5000);
  assert.deepEqual(run.waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  // Each drop is logged, and none is a failure to register.
  assert.equal(run.said.filter((line) => line.startsWith("Registered at the relay")).length, 8);
  assert.equal(run.said.filter((line) => line === "Left the relay relay.example; registering again.").length, 8);

  // Up just short of 30 s: the backoff goes on. Up for 30 s: it starts again.
  run.register().on({ t: "closed", code: 1006, reason: "" }, RELAY_STABLE_MS - 1);
  run.register().on({ t: "closed", code: 1006, reason: "" }, RELAY_STABLE_MS);
  run.register().on({ t: "closed", code: 1006, reason: "" }, 5000);
  assert.deepEqual(run.waits.slice(8), [30000, 1000, 2000]);
});

test("a relay that refuses every registration is logged once per reason, and a registration clears that", () => {
  const run = new Run();
  const refuse = { t: "closed", code: 4003, reason: "The proof does not match the key." } as const;
  for (let tries = 0; tries < 4; tries++) run.reconnect().on(message({ t: "challenge", nonce: NONCE })).on(refuse);
  const refused = "Cannot register at the relay relay.example: Connection closed before registration (4003): The proof does not match the key. Retrying automatically.";
  assert.deepEqual(run.said, [refused]);
  assert.deepEqual(run.waits, [1000, 2000, 4000, 8000]);
  // Another reason is logged, and going back to the first is a change too.
  run.on({ t: "waited" }, 8000).on({ t: "open-failed", error: OTHER });
  run.reconnect().on(refuse);
  assert.deepEqual(run.said.slice(1), [`Cannot register at the relay relay.example: ${OTHER} Retrying automatically.`, refused]);
  // Once registered, the same failure after the registration is lost is news again.
  run.register().on({ t: "closed", code: 1006, reason: "" }, 5000);
  run.reconnect().on(refuse);
  assert.deepEqual(run.said.slice(3), ["Registered at the relay relay.example; devices that cannot reach this one directly can reach it there.", "Left the relay relay.example; registering again.", refused]);
  // A failure with no message is not logged, and does not replace the last one logged.
  run.on({ t: "waited" }, run.waits.at(-1)).on({ t: "open-failed", error: "" });
  run.reconnect().on(refuse);
  assert.equal(run.said.length, 6);
});

test("a registration that hears nothing for more than 90 s closes, and anything the relay sends counts", () => {
  // Counted from the last message, or from the moment the connection opened.
  for (const silent of [new Run().register(), new Run().reconnect()]) {
    const ticks = [1, 2, 3, 4].map(() => silent.on({ t: "tick" }, RELAY_PING_MS).effects);
    assert.deepEqual(ticks, [[ping], [ping], [ping], [close("The relay stopped answering")]], silent.state.phase);
  }

  // Binary data, or text that is not JSON, still shows the relay is there.
  for (const data of [new Uint8Array([1, 2]), "not json"]) {
    const heard = new Run().register();
    heard.on({ t: "tick" }, RELAY_PING_MS).on({ t: "tick" }, RELAY_PING_MS).on({ t: "message", data }, RELAY_PING_MS - 1);
    assert.deepEqual(heard.on({ t: "tick" }, 1).effects, [ping]);
    assert.deepEqual(heard.on({ t: "tick" }, RELAY_PING_MS).effects, [ping]);
  }
});

test("what a hostile relay sends cannot make the daemon throw, answer junk or answer before registering", () => {
  const junk: Array<[unknown, RegistrationEffect[]]> = [
    [new Uint8Array([123, 125]), []],
    ["{", []],
    ["null", []],
    ["[]", []],
    ["7", []],
    [JSON.stringify("ready"), []],
    [JSON.stringify({ t: "incoming", id: "../../etc/passwd/xx" }), []],
    [JSON.stringify({ t: "incoming", id: "A".repeat(500) }), []],
    [JSON.stringify({ t: "incoming", id: 7 }), []],
    [JSON.stringify({ t: "incoming" }), []],
    [JSON.stringify({ t: "challenge" }), [close("Invalid challenge")]],
    [JSON.stringify({ t: "challenge", nonce: 7 }), [close("Invalid challenge")]],
    [JSON.stringify({ t: "challenge", nonce: "!!!not base64url!!!!!!" }), [close("Invalid challenge")]],
    [JSON.stringify({ t: "challenge", nonce: `${NONCE}A` }), [close("Invalid challenge")]],
  ];
  for (const [data, effects] of junk) {
    const label = typeof data === "string" ? data.slice(0, 40) : "binary";
    for (const phase of ["proving", "registered"] as const) {
      const next = stepRegistration(states[phase], { t: "message", data }, NOW);
      assert.deepEqual([next.state.phase, next.effects], [phase, effects], `${phase}: ${label}`);
    }
  }
});

test("what the relay or the network says reaches the log without control characters", () => {
  const reason = "gone\u001b[2J";
  const failed = stepRegistration(states.connecting, { t: "open-failed", error: `Cannot connect.\u0007 ${reason}` }, NOW);
  assert.deepEqual(failed.effects[0], cannot("Cannot connect.? gone?[2J"));
  const early = stepRegistration(states.proving, { t: "closed", code: 4000, reason }, NOW);
  assert.deepEqual(early.effects[0], cannot("Connection closed before registration (4000): gone?[2J"));
  const lost = stepRegistration(states.registered, { t: "closed", code: 4000, reason }, NOW);
  assert.deepEqual(lost.effects[0], say("Left the relay relay.example: gone?[2J; registering again."));
});

test("only a registered daemon reports itself registered to cns status and cns doctor", () => {
  const facts = { identity: { fingerprint: "abcd-efgh", publicKey: "K".repeat(43) }, identityPath: "/cfg/identity.json", self: { version: "2.4.0", executable: "/opt/cns" }, paired: 1, relay: "wss://relay.example" };
  const daemon = { running: true as const, pid: 42, url: "ws://0.0.0.0:47381", addresses: ["ws://10.0.0.2:47381", `wss://relay.example/v1/dial/${"K".repeat(43)}`], relay: "wss://relay.example" };
  const expected: Record<RegistrationPhase, { status: string; doctor: string; warns: boolean }> = {
    connecting: { status: "registering", doctor: "not registered", warns: true },
    proving: { status: "registering", doctor: "not registered", warns: true },
    registered: { status: "registered", doctor: "registered", warns: false },
    waiting: { status: "registering", doctor: "not registered", warns: true },
    stopped: { status: "registering", doctor: "not registered", warns: true },
  };
  for (const [phase, state] of Object.entries(states) as Array<[RegistrationPhase, Registration]>) {
    // What the daemon's status() answers, and what cns status and cns doctor make of it.
    const relayRegistered = isRegistered(state);
    const { lines, report } = selfCheck({ ...facts, daemon: { ...daemon, relayRegistered } });
    assert.equal(registrationWord(relayRegistered), expected[phase].status, phase);
    assert.ok(lines.includes(`Relay:     wss://relay.example (${expected[phase].doctor})`), phase);
    assert.equal(report.relay?.registered, relayRegistered, phase);
    assert.equal(report.reachableBeyondNetwork, relayRegistered, phase);
    assert.equal(report.warnings.some((warning) => warning.includes("not registered at the relay right now")), expected[phase].warns, phase);
  }
  // Before the registration has started, the daemon is not registered either.
  assert.equal(isRegistered(undefined), false);
  // A daemon too old to say is shown as registering.
  assert.deepEqual([registrationWord(undefined), registrationWord(null)], ["registering", "registering"]);
});
