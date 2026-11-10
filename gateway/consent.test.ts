import assert from "node:assert/strict";
import test from "node:test";
import { mock, setSystemTime } from "bun:test";
import { Database } from "bun:sqlite";
import { TOOL_NAMES } from "../src/mcp/server.js";

/**
 * A connector's consent on the gateway (gateway/object.ts) is a state machine kept in the
 * `consents` table: pending, then approved or denied by an owner, then done once the
 * consent page collected the approval; it expires CONSENT_MS after it started. These tests
 * run the Durable Object's own methods against SQLite, standing in for its storage, and
 * check every state against every event.
 */

// The Durable Object base class exists only in the Workers runtime.
mock.module("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; } },
}));
const { Gateway, CONSENT_MS } = await import("./object.js");

const KEYS = { studio: "A".repeat(43), laptop: "B".repeat(43) };
const PAGE = "the-consent-page-handle";
const CLIENT = { handle: PAGE, clientId: "client", clientName: "Claude", redirectHost: "claude.ai", loopback: false };

/** A gateway with fresh storage, paired with `devices`. */
async function gateway(devices: Array<keyof typeof KEYS> = ["studio", "laptop"]) {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.query(query).all(...bindings as never[]) as Record<string, unknown>[];
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
  const stored = new Map<string, unknown>();
  let ready!: Promise<unknown>;
  const ctx = {
    storage: { sql, get: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value); } },
    blockConcurrencyWhile: (setup: () => Promise<unknown>) => (ready = setup()),
  };
  const object = new Gateway(ctx as never, {} as never);
  await ready;
  for (const name of devices) {
    sql.exec("INSERT INTO devices (name, public_key, addresses, granted, paired_at) VALUES (?, ?, '[]', '[\"shell\"]', ?)", name, KEYS[name], new Date().toISOString());
  }
  return object;
}

type Object = Awaited<ReturnType<typeof gateway>>;
type State = "pending" | "approved" | "denied" | "done" | "expired";

/** A gateway holding one consent in `state`, and its code. */
async function consentIn(state: State): Promise<{ object: Object; code: string }> {
  const object = await gateway();
  const code = object.startConsent(CLIENT);
  if (state === "approved" || state === "done") object.decide(code, { approve: true, owner: "studio" });
  if (state === "denied") object.decide(code, { approve: false, owner: "studio" });
  if (state === "done") object.pollConsent(code, PAGE);
  if (state === "expired") setSystemTime(new Date(Date.now() + CONSENT_MS + 1));
  return { object, code };
}

/** What a consent is now, as an owner and the page see it. */
function stateOf(object: Object, code: string): State {
  return object.consent(code)?.status ?? "expired";
}

const NO_CONNECTOR = /No connector is waiting with code/;

test("every consent state answers every event as the table says", async () => {
  type Outcome = { poll?: unknown; throws?: RegExp; then: State };
  const events: Record<string, (object: Object, code: string) => unknown> = {
    "the page polls": (object, code) => object.pollConsent(code, PAGE),
    "another page polls": (object, code) => object.pollConsent(code, "someone-else"),
    "an owner approves": (object, code) => object.decide(code, { approve: true, owner: "studio" }),
    "an owner denies": (object, code) => object.decide(code, { approve: false, owner: "studio" }),
  };
  const table: Record<State, Record<keyof typeof events, Outcome>> = {
    pending: {
      "the page polls": { poll: { status: "pending" }, then: "pending" },
      "another page polls": { poll: { status: "expired" }, then: "pending" },
      "an owner approves": { then: "approved" },
      "an owner denies": { then: "denied" },
    },
    approved: {
      // The approval is handed out once, to the page that asked for it.
      "the page polls": { poll: "approved", then: "done" },
      "another page polls": { poll: { status: "expired" }, then: "approved" },
      "an owner approves": { throws: NO_CONNECTOR, then: "approved" },
      "an owner denies": { throws: NO_CONNECTOR, then: "approved" },
    },
    denied: {
      "the page polls": { poll: { status: "denied" }, then: "denied" },
      "another page polls": { poll: { status: "expired" }, then: "denied" },
      "an owner approves": { throws: NO_CONNECTOR, then: "denied" },
      "an owner denies": { throws: NO_CONNECTOR, then: "denied" },
    },
    done: {
      "the page polls": { poll: { status: "expired" }, then: "done" },
      "another page polls": { poll: { status: "expired" }, then: "done" },
      "an owner approves": { throws: NO_CONNECTOR, then: "done" },
      "an owner denies": { throws: NO_CONNECTOR, then: "done" },
    },
    expired: {
      "the page polls": { poll: { status: "expired" }, then: "expired" },
      "another page polls": { poll: { status: "expired" }, then: "expired" },
      "an owner approves": { throws: NO_CONNECTOR, then: "expired" },
      "an owner denies": { throws: NO_CONNECTOR, then: "expired" },
    },
  };
  try {
    for (const [state, row] of Object.entries(table) as Array<[State, Record<string, Outcome>]>) {
      for (const [event, expected] of Object.entries(row)) {
        const label = `${state}, ${event}`;
        const { object, code } = await consentIn(state);
        let result: unknown;
        if (expected.throws) assert.throws(() => events[event]!(object, code), expected.throws, label);
        else result = events[event]!(object, code);
        if (expected.poll === "approved") {
          assert.equal((result as { status: string }).status, "approved", label);
          assert.deepEqual((result as { props: { devices: string[] } }).props.devices, [KEYS.laptop, KEYS.studio], label);
        } else if (expected.poll) assert.deepEqual(result, expected.poll, label);
        assert.equal(stateOf(object, code), expected.then, label);
        setSystemTime();
      }
    }
  } finally { setSystemTime(); }
});

test("an approval names the devices and tools it allows, and refusing a bad one leaves the consent pending", async () => {
  const object = await gateway();
  const code = object.startConsent(CLIENT);
  assert.throws(() => object.decide(code, { approve: true, devices: ["nas"], owner: "studio" }), /no device named nas\. It has: laptop, studio/);
  assert.throws(() => object.decide(code, { approve: true, tools: ["format_disk" as never], owner: "studio" }), /Unknown tool format_disk/);
  assert.equal(stateOf(object, code), "pending");
  const approved = object.decide(code, { approve: true, devices: ["studio"], tools: ["list_peers", "read_file"], owner: "studio" });
  assert.deepEqual([approved.status, approved.devices, approved.tools, approved.approvedBy], ["approved", [KEYS.studio], ["list_peers", "read_file"], "studio"]);
  const handedOut = object.pollConsent(code, PAGE);
  assert.ok(handedOut.status === "approved");
  assert.deepEqual({ ...handedOut.props, grant: undefined }, { grant: undefined, client: "Claude", devices: [KEYS.studio], tools: ["list_peers", "read_file"] });

  // Without devices or tools named, an approval allows every device paired now and every tool.
  const all = object.startConsent(CLIENT);
  const everything = object.decide(all, { approve: true, owner: "studio" });
  assert.deepEqual([everything.devices, everything.tools], [[KEYS.laptop, KEYS.studio], [...TOOL_NAMES]]);
  // Each approval is its own grant, which cns gateway revoke takes.
  const second = object.pollConsent(all, PAGE);
  assert.ok(second.status === "approved" && second.props.grant !== handedOut.props.grant);
});

test("a gateway with no device cannot approve, and the consent stays pending", async () => {
  const object = await gateway([]);
  const code = object.startConsent(CLIENT);
  assert.throws(() => object.decide(code, { approve: true, owner: "studio" }), /paired with no device yet/);
  assert.equal(stateOf(object, code), "pending");
});

test("codes are typed in any case, only pending consents are listed, and at most 20 wait at once", async () => {
  const object = await gateway();
  const code = object.startConsent(CLIENT);
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(object.consent(code.toLowerCase())?.code, code);
  const denied = object.startConsent(CLIENT);
  object.decide(denied.toLowerCase(), { approve: false, owner: "studio" });
  assert.deepEqual(object.status().pending.map((consent) => consent.code), [code]);
  // The page's handle never leaves the object.
  assert.equal("handle" in object.consent(code)!, false);
  for (let i = 1; i < 20; i++) object.startConsent(CLIENT);
  assert.throws(() => object.startConsent(CLIENT), /Too many connector approvals are waiting/);
  // Deciding one frees its place.
  object.decide(code, { approve: false, owner: "studio" });
  assert.doesNotThrow(() => object.startConsent(CLIENT));
});
