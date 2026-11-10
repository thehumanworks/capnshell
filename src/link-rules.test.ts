import assert from "node:assert/strict";
import test from "node:test";
import type { AuthCode } from "./auth.js";
import { afterDialFailure, DIAL_RACE_MS, dialTurn, keepsOutbound, onDialed, onInbound, redialDelay, UPGRADE_AFTER_MS, worthDialing, type HeldLink } from "./link-rules.js";
import { relayEndpoint } from "./relay-hub.js";

const RELAY = "wss://relay.example/relay";
const SMALL = "A".repeat(43);
const LARGE = "B".repeat(43);
const DIRECT = "ws://192.0.2.1:47381";
const VIA_RELAY = relayEndpoint(RELAY, "dial", LARGE);
const NOW = 1_000_000;

const link = (outbound: boolean, via: "direct" | "relay", age: number): HeldLink => ({ outbound, via, since: NOW - age });

test("redials wait 1 s, doubling to at most 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(redialDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("of two devices, exactly one keeps the link it dialed", () => {
  assert.equal(keepsOutbound(SMALL, LARGE), true);
  assert.equal(keepsOutbound(LARGE, SMALL), false);
});

test("a daemon keeps no standing link to a device that gave no address and grants it nothing, such as the gateway", () => {
  assert.equal(worthDialing({ publicKey: SMALL, addresses: [], grants: { outgoing: [] } }, RELAY), false);
  // It still dials, through the relay, a device that lets it do something.
  assert.equal(worthDialing({ publicKey: SMALL, addresses: [], grants: { outgoing: ["shell"] } }, RELAY), true);
  // And a device it was told where to reach.
  assert.equal(worthDialing({ publicKey: SMALL, addresses: [DIRECT], grants: { outgoing: [] } }, RELAY), true);
  assert.equal(worthDialing({ publicKey: SMALL, addresses: [], grants: { outgoing: ["shell"] } }, undefined), false);
});

test("a dial loop dials without a link, and with one only to replace a relayed link past the race", () => {
  const rows: Array<[string, HeldLink | undefined, string[], ReturnType<typeof dialTurn>]> = [
    ["no link: every address", undefined, [DIRECT, VIA_RELAY], { action: "dial", addresses: [DIRECT, VIA_RELAY], upgrade: false }],
    ["no link, relay only", undefined, [VIA_RELAY], { action: "dial", addresses: [VIA_RELAY], upgrade: false }],
    ["a direct link", link(true, "direct", UPGRADE_AFTER_MS * 10), [DIRECT, VIA_RELAY], { action: "wait" }],
    ["a direct link the other device dialed", link(false, "direct", UPGRADE_AFTER_MS * 10), [DIRECT, VIA_RELAY], { action: "wait" }],
    ["a relayed link still in the race", link(true, "relay", UPGRADE_AFTER_MS - 1), [DIRECT, VIA_RELAY], { action: "wait" }],
    ["a relayed link and no direct address", link(true, "relay", UPGRADE_AFTER_MS * 10), [VIA_RELAY], { action: "wait" }],
    ["a relayed link past the race: direct addresses only", link(true, "relay", UPGRADE_AFTER_MS), [DIRECT, VIA_RELAY], { action: "dial", addresses: [DIRECT], upgrade: true }],
    ["the same when the other device dialed it", link(false, "relay", UPGRADE_AFTER_MS), [DIRECT, VIA_RELAY], { action: "dial", addresses: [DIRECT], upgrade: true }],
  ];
  for (const [label, held, addresses, expected] of rows) assert.deepEqual(dialTurn(held, addresses, NOW), expected, label);
});

test("only a device that answers as another, or forgot this one, ends a dial loop, and never while upgrading", () => {
  const codes: Array<AuthCode | undefined> = [undefined, "protocol", "identity-changed", "refused", "not-paired", "invalid-proof", "closed"];
  for (const code of codes) {
    assert.equal(afterDialFailure(code, false), code === "identity-changed" || code === "not-paired" ? "stop" : "retry", `${code}`);
    assert.equal(afterDialFailure(code, true), "retry", `${code} while upgrading`);
  }
});

test("a link this daemon dialed is taken, replaces the held link, or is dropped", () => {
  const rows: Array<[string, HeldLink | undefined, boolean, boolean, ReturnType<typeof onDialed>]> = [
    ["nothing held", undefined, false, false, "take"],
    ["nothing held, smaller key", undefined, false, true, "take"],
    ["the relayed link it set out to replace", link(true, "relay", UPGRADE_AFTER_MS), true, false, "replace"],
    ["both dialed at once, smaller key", link(false, "direct", 0), false, true, "replace"],
    ["both dialed at once, larger key", link(false, "direct", 0), false, false, "drop"],
    // The relayed link was replaced meanwhile by a link the other device dialed: a race like any other.
    ["another link appeared while upgrading, larger key", link(false, "direct", 0), false, false, "drop"],
  ];
  for (const [label, held, replacing, keeps, expected] of rows) assert.equal(onDialed(held, replacing, keeps), expected, label);
});

test("a link the other daemon dialed is taken, replaces the held link, or is refused within the race", () => {
  const fresh = DIAL_RACE_MS - 1;
  const stale = DIAL_RACE_MS;
  const rows: Array<[string, HeldLink | undefined, boolean, boolean, ReturnType<typeof onInbound>]> = [
    ["nothing held", undefined, true, true, "take"],
    ["a command's connection beside a held link", link(true, "direct", 0), false, true, "take"],
    ["smaller key holding a fresh link it dialed: both dialed at once", link(true, "direct", fresh), true, true, "refuse"],
    ["the same through the relay", link(true, "relay", fresh), true, true, "refuse"],
    ["smaller key holding a link it dialed past the race: dead on the other side", link(true, "direct", stale), true, true, "replace"],
    ["larger key holding a fresh link it dialed: the other side's dial wins", link(true, "direct", fresh), true, false, "replace"],
    ["a held link the other device dialed: it lost it and dialed again", link(false, "direct", 0), true, true, "replace"],
    ["a relayed link the other device dialed, replaced by its direct dial", link(false, "relay", UPGRADE_AFTER_MS), true, false, "replace"],
  ];
  for (const [label, held, daemon, keeps, expected] of rows) assert.equal(onInbound(held, daemon, keeps, NOW), expected, label);
});

// ---- Two daemons applying the rules, in every order their links can open and close ----

type Side = "A" | "B";
type Via = "direct" | "relay";
const otherSide = (side: Side): Side => side === "A" ? "B" : "A";

interface Held extends HeldLink { conn: number }
interface Daemon { key: string; held?: Held; dialing?: { conn: number; upgrade: boolean; replacing?: number } }
interface World {
  now: number;
  next: number;
  A: Daemon;
  B: Daemon;
  /** What each daemon has yet to see on each connection, in order: it opened, then it closed. */
  inbox: Record<Side, Record<number, Array<"open" | "closed">>>;
  conns: Record<number, { dialer: Side; via: Via }>;
  trace: string[];
}

interface Scenario {
  /** Which daemons can dial the other directly; through the relay, each always can. */
  direct: Record<Side, boolean>;
  /** Whether the devices know each other's direct address (else they only have the relay). */
  directAddress: boolean;
  /** A connection both daemons hold at the start, and how old it is. */
  start?: { dialer: Side; via: Via; age: number; holders: Side[]; closedAt?: Side[] };
  /** Daemons whose dial loops take their turn at once, before anything arrives. */
  turns: Side[];
  /** The via the daemons must end up on. */
  expect?: Via;
}

const MAX_CONNECTIONS = 8;

function addressesFor(side: Side, world: World, scenario: Scenario): string[] {
  const relay = relayEndpoint(RELAY, "dial", world[otherSide(side)].key);
  return scenario.directAddress ? [DIRECT, relay] : [relay];
}

function clone(world: World): World { return structuredClone(world); }

function send(world: World, to: Side, conn: number, event: "open" | "closed") {
  (world.inbox[to][conn] ??= []).push(event);
}

/** `side` lets go of the link it holds, telling the other daemon. */
function closeHeld(world: World, side: Side) {
  const held = world[side].held!;
  world[side].held = undefined;
  send(world, otherSide(side), held.conn, "closed");
}

/** Each way a dial loop's turn can go: the dial opens directly or through the relay, or nothing changes. */
function turns(world: World, side: Side, scenario: Scenario): World[] {
  const daemon = world[side];
  if (daemon.dialing) return [];
  const turn = dialTurn(daemon.held, addressesFor(side, world, scenario), world.now);
  if (turn.action === "wait") return [];
  const ways: Via[] = [];
  // connectFirst gives direct addresses a head start, but a slow one can still lose to the relay.
  if (turn.addresses.some((url) => url === DIRECT) && scenario.direct[side]) ways.push("direct");
  if (turn.addresses.some((url) => url !== DIRECT)) ways.push("relay");
  // A dial that fails retries later and changes nothing (afterDialFailure: unreachable is never final).
  return ways.map((via) => {
    const next = clone(world);
    const conn = next.next++;
    next.conns[conn] = { dialer: side, via };
    next[side].dialing = { conn, upgrade: turn.upgrade, ...turn.upgrade ? { replacing: daemon.held!.conn } : {} };
    send(next, side, conn, "open");
    send(next, otherSide(side), conn, "open");
    next.trace.push(`${side} dials c${conn} ${via}${turn.upgrade ? " to replace c" + daemon.held!.conn : ""}`);
    return next;
  });
}

/** `side` sees the next event on `conn`. */
function deliver(world: World, side: Side, conn: number): World {
  const next = clone(world);
  const event = next.inbox[side][conn]!.shift()!;
  if (!next.inbox[side][conn]!.length) delete next.inbox[side][conn];
  const daemon = next[side];
  const keeps = keepsOutbound(daemon.key, next[otherSide(side)].key);
  const { dialer, via } = next.conns[conn]!;
  if (event === "closed") {
    if (daemon.held?.conn === conn) daemon.held = undefined;
    next.trace.push(`${side} sees c${conn} close`);
    return next;
  }
  const take = (outbound: boolean) => { daemon.held = { conn, outbound, via, since: next.now }; };
  if (dialer === side) {
    const dialing = daemon.dialing!;
    daemon.dialing = undefined;
    const outcome = onDialed(daemon.held, dialing.upgrade && daemon.held?.conn === dialing.replacing, keeps);
    next.trace.push(`${side} opens c${conn}: ${outcome}`);
    if (outcome === "drop") { send(next, otherSide(side), conn, "closed"); return next; }
    if (outcome === "replace") closeHeld(next, side);
    take(true);
  } else {
    const outcome = onInbound(daemon.held, true, keeps, next.now);
    next.trace.push(`${side} accepts c${conn}: ${outcome}`);
    if (outcome === "refuse") { send(next, otherSide(side), conn, "closed"); return next; }
    if (outcome === "replace") closeHeld(next, side);
    take(false);
  }
  return next;
}

/**
 * Every state one step on. A daemon's dial loop only takes its turn once what is on its way
 * to it has arrived: redials wait at least a second. Both loops may take their turns at
 * once, as when their backoffs line up. When nothing else can happen, time
 * passes until a relayed link is past the race, so a dial loop may try to replace it.
 */
function successors(world: World, scenario: Scenario): World[] {
  const out: World[] = [];
  for (const side of ["A", "B"] as const) {
    for (const conn of Object.keys(world.inbox[side])) out.push(deliver(world, side, Number(conn)));
    if (!Object.keys(world.inbox[side]).length) out.push(...turns(world, side, scenario));
  }
  if (!Object.keys(world.inbox.A).length && !Object.keys(world.inbox.B).length) {
    out.push(...turns(world, "A", scenario).flatMap((after) => turns(after, "B", scenario)));
  }
  if (out.length || !scenario.directAddress) return out;
  const upgradable = [world.A.held, world.B.held].filter((held) => held?.via === "relay" && world.now - held.since < UPGRADE_AFTER_MS);
  if (!upgradable.length) return out;
  const next = clone(world);
  next.now = Math.min(...upgradable.map((held) => held!.since + UPGRADE_AFTER_MS));
  next.trace.push(`time passes: ${next.now - NOW} ms`);
  return [next];
}

/** Explore every order of events from the scenario's start; return how many settled states were reached. */
function explore(scenario: Scenario, keys: Record<Side, string>): number {
  const initial: World = { now: NOW, next: 1, A: { key: keys.A }, B: { key: keys.B }, inbox: { A: {}, B: {} }, conns: {}, trace: [] };
  if (scenario.start) {
    const { dialer, via, age, holders, closedAt = [] } = scenario.start;
    const conn = initial.next++;
    initial.conns[conn] = { dialer, via };
    for (const side of holders) initial[side].held = { conn, outbound: side === dialer, via, since: NOW - age };
    // A daemon that still holds a link the other lost learns so when the link times out, at any point.
    for (const side of closedAt) send(initial, side, conn, "closed");
  }
  let starts = [initial];
  for (const side of scenario.turns) starts = starts.flatMap((world) => turns(world, side, scenario));
  const seen = new Set<string>();
  let settled = 0;
  const stack = [...starts];
  while (stack.length) {
    const world = stack.pop()!;
    const id = JSON.stringify({ ...world, trace: undefined });
    if (seen.has(id)) continue;
    seen.add(id);
    const fail = (why: string) => assert.fail(`${why}\n  ${world.trace.join("\n  ")}`);
    if (world.next - 1 > MAX_CONNECTIONS) fail(`The daemons made more than ${MAX_CONNECTIONS} connections without settling:`);
    const next = successors(world, scenario);
    if (next.length) { stack.push(...next); continue; }
    // Nothing left to arrive, and neither dial loop would dial: both must hold the same single link.
    settled++;
    const { A, B } = world;
    if (!A.held || !B.held || A.held.conn !== B.held.conn) fail(`The daemons settled on different links (A: c${A.held?.conn}, B: c${B.held?.conn}):`);
    if (A.held!.outbound === B.held!.outbound) fail("Both daemons think they dialed the link:");
    if (scenario.expect && A.held!.via !== scenario.expect) fail(`The daemons settled on a ${A.held!.via} link, not ${scenario.expect}:`);
  }
  return settled;
}

const keyOrders: Array<[string, Record<Side, string>]> = [["A has the smaller key", { A: SMALL, B: LARGE }], ["B has the smaller key", { A: LARGE, B: SMALL }]];
const old = UPGRADE_AFTER_MS * 2;

const scenarios: Array<[string, Scenario]> = [
  ["both dial at once, as after pairing", { direct: { A: true, B: true }, directAddress: true, turns: ["A", "B"], expect: "direct" }],
  ["both dial at once with only the relay", { direct: { A: false, B: false }, directAddress: false, turns: ["A", "B"], expect: "relay" }],
  ["both dial at once and only B can dial directly, as from WSL", { direct: { A: false, B: true }, directAddress: true, turns: ["A", "B"], expect: "direct" }],
  ["one dials", { direct: { A: true, B: true }, directAddress: true, turns: ["A"], expect: "direct" }],
  // B restarted: A still holds the link B lost, whichever of them dialed it, until B dials again or it times out.
  ["B restarted while A held the link A dialed", { direct: { A: true, B: true }, directAddress: true, start: { dialer: "A", via: "direct", age: old, holders: ["A"] }, turns: ["B"], expect: "direct" }],
  ["B restarted while A held the link B dialed", { direct: { A: true, B: true }, directAddress: true, start: { dialer: "B", via: "direct", age: old, holders: ["A"] }, turns: ["B"], expect: "direct" }],
  ["B restarted and A's link times out meanwhile", { direct: { A: true, B: true }, directAddress: true, start: { dialer: "A", via: "direct", age: old, holders: ["A"], closedAt: ["A"] }, turns: ["B"], expect: "direct" }],
  // A relayed link past the race gives way to a direct one, from whichever side can dial directly.
  ["a relayed link that only B can replace", { direct: { A: false, B: true }, directAddress: true, start: { dialer: "A", via: "relay", age: old, holders: ["A", "B"] }, turns: [], expect: "direct" }],
  ["a relayed link that only A can replace", { direct: { A: true, B: false }, directAddress: true, start: { dialer: "A", via: "relay", age: old, holders: ["A", "B"] }, turns: [], expect: "direct" }],
  ["a relayed link both replace at once", { direct: { A: true, B: true }, directAddress: true, start: { dialer: "B", via: "relay", age: old, holders: ["A", "B"] }, turns: ["A", "B"], expect: "direct" }],
  ["a relayed link nobody can replace", { direct: { A: false, B: false }, directAddress: true, start: { dialer: "A", via: "relay", age: old, holders: ["A", "B"] }, turns: [], expect: "relay" }],
  ["a relayed link still in the race is replaced once past it", { direct: { A: true, B: true }, directAddress: true, start: { dialer: "A", via: "relay", age: UPGRADE_AFTER_MS - 1, holders: ["A", "B"] }, turns: [], expect: "direct" }],
];

for (const [label, scenario] of scenarios) {
  for (const [order, keys] of keyOrders) {
    test(`two daemons settle on one link: ${label}, ${order}`, () => {
      assert.ok(explore(scenario, keys) > 0, "no order of events settles");
    });
  }
}
