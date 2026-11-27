import { mock } from "bun:test";
import { Database } from "bun:sqlite";
import type { Env } from "./object.js";

/**
 * The gateway's Durable Object (object.ts) outside the Workers runtime, for tests: its own
 * methods run against SQLite in memory, standing in for its storage.
 */

// The Durable Object base class exists only in the Workers runtime.
mock.module("cloudflare:workers", () => ({
  DurableObject: class { ctx: unknown; env: unknown; constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env; } },
}));
export const { Gateway, CONSENT_MS, reachable, meshMembers } = await import("./object.js");
export type GatewayObject = InstanceType<typeof Gateway>;

type Exec = (query: string, ...bindings: unknown[]) => { toArray(): Record<string, unknown>[]; one(): Record<string, unknown> | undefined };

/** A gateway with fresh storage. `secret`, a base64url Ed25519 key, makes its identity a known one. */
export async function gatewayObject({ env = {}, secret }: { env?: Partial<Env>; secret?: string } = {}): Promise<{ object: GatewayObject; exec: Exec }> {
  const db = new Database(":memory:");
  const exec: Exec = (query, ...bindings) => {
    const rows = db.query(query).all(...bindings as never[]) as Record<string, unknown>[];
    return { toArray: () => rows, one: () => rows[0] };
  };
  const stored = new Map<string, unknown>(secret ? [["identity", { secret, createdAt: new Date().toISOString() }]] : []);
  let ready!: Promise<unknown>;
  const ctx = {
    storage: { sql: { exec }, get: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value); } },
    blockConcurrencyWhile: (setup: () => Promise<unknown>) => (ready = setup()),
  };
  const object = new Gateway(ctx as never, env as never);
  await ready;
  return { object, exec };
}

/** Save a device as paired with the gateway, as Gateway.pair does once the device accepts. */
export function pairDevice(exec: Exec, name: string, key: string, addresses: string[] = []): void {
  exec("INSERT INTO devices (name, public_key, addresses, granted, paired_at) VALUES (?, ?, ?, '[\"shell\"]', ?)", name, key, JSON.stringify(addresses), new Date().toISOString());
}
