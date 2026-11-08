/**
 * The gateway's Durable Object: the gateway's own device identity, the devices paired with
 * it, connector approvals waiting for an owner, revoked connectors, and the audit log. Only
 * the gateway Worker (worker.ts) reaches it, so nothing here is exposed to the internet
 * except through the Worker's checks: OAuth for /mcp and owner signatures for /admin.
 */
import { DurableObject } from "cloudflare:workers";
import { createMcpHandler, isLegacyRequest, type McpServer } from "@modelcontextprotocol/server";
import { ed25519 } from "@noble/curves/ed25519.js";
import { errorMessage } from "../src/errors.js";
import { fingerprint, type Identity, type PublicKey } from "../src/identity.js";
import { LegacySessions } from "../src/mcp/legacy-sessions.js";
import { createMcpServer, TOOL_NAMES, type ToolCall, type ToolName } from "../src/mcp/server.js";
import { decisionSchema, decodeInvite, type PairingApi } from "../src/pairing.js";
import { expandGrants, type Permission } from "../src/peers.js";
import { DEFAULT_RELAY } from "../src/relay-config.js";
import { connectFirst, rpcSession } from "../src/secure.js";
import { plain } from "../src/terminal.js";
import { describeCall } from "./audit.js";
import { GatewayMain, gatewayAddresses, gatewayTarget, type GatewayDevice } from "./target.js";

export interface Env {
  GATEWAY: DurableObjectNamespace<Gateway>;
  /** Device public keys allowed to administer the gateway, separated by commas or spaces. */
  OWNER_KEYS?: string;
  /** Where the gateway is served, such as https://gateway.cns.nothuman.work. */
  GATEWAY_ORIGIN?: string;
  /** The relay to reach devices through; the one built into cns by default. */
  RELAY?: string;
  /** The name the gateway suggests for itself when it pairs. */
  GATEWAY_NAME?: string;
}

/** What an approved connector may use, stored encrypted with its OAuth grant and sent with each of its requests. */
export interface GrantProps {
  /** This approval's ID, which `cns gateway revoke` takes. */
  grant: string;
  client: string;
  devices: PublicKey[];
  tools: ToolName[];
}

/** The header the Worker passes a connector's GrantProps in. The Worker removes any a client sent. */
export const GRANT_HEADER = "Cns-Gateway-Grant";

export interface DeviceRecord { name: string; publicKey: PublicKey; fingerprint: string; addresses: string[]; granted: Permission[]; pairedAt: string }

export interface ConsentRecord {
  code: string;
  clientId: string;
  clientName: string;
  /** For a client identified by a metadata document, the domain that published it. */
  clientDomain: string | null;
  redirectHost: string;
  loopback: boolean;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "approved" | "denied" | "done";
  devices: PublicKey[];
  tools: ToolName[];
  approvedBy: string | null;
}

export interface AuditEntry { at: string; grant: string; client: string; tool: string; peer: string | null; detail: string; ok: boolean; elapsedMs: number }

/** A connector approval waits this long for an owner, as long as the consent page itself lasts. */
export const CONSENT_MS = 10 * 60 * 1000;
/** How long a device's person has to decide on the gateway's pairing proposal. */
const PROPOSAL_WAIT_MS = 10 * 60 * 1000;
/** Audit entries kept; older ones are dropped. */
const MAX_AUDIT = 10_000;
/** What `cns gateway pair` asks a device for unless told otherwise: commands, files and sessions of its own, never others' sessions. */
export const DEFAULT_REQUESTS: readonly Permission[] = ["shell", "files", "sessions:create"];
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** A short code a person can read off the consent page and type: two groups of four. */
function newCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const letters = [...random].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export class Gateway extends DurableObject<Env> {
  #identity!: Identity;
  /** Per connector: its stateless handler and the sessions of 2025-era clients. */
  #servers = new Map<string, { modern: ReturnType<typeof createMcpHandler>; legacy: LegacySessions }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS devices (name TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, addresses TEXT NOT NULL, granted TEXT NOT NULL, paired_at TEXT NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS consents (code TEXT PRIMARY KEY, handle TEXT NOT NULL, client_id TEXT NOT NULL, client_name TEXT NOT NULL, client_domain TEXT, redirect_host TEXT NOT NULL,
        loopback INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL, devices TEXT NOT NULL, tools TEXT NOT NULL, approved_by TEXT)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS revoked (grant_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, until INTEGER NOT NULL)`);
      sql.exec(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, grant_id TEXT NOT NULL, client TEXT NOT NULL, tool TEXT NOT NULL, peer TEXT, detail TEXT NOT NULL, ok INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL)`);
      // The gateway's device key is made here once and never leaves this object.
      let stored = await ctx.storage.get<{ secret: string; createdAt: string }>("identity");
      if (!stored) {
        stored = { secret: base64url(ed25519.utils.randomSecretKey()), createdAt: new Date().toISOString() };
        await ctx.storage.put("identity", stored);
      }
      const secret = Buffer.from(stored.secret, "base64url");
      const publicKey = base64url(ed25519.getPublicKey(secret));
      this.#identity = { publicKey, fingerprint: fingerprint(publicKey), createdAt: stored.createdAt, sign: (data) => ed25519.sign(data, secret) };
    });
  }

  get #relay(): string { return this.env.RELAY || DEFAULT_RELAY; }
  get #sql() { return this.ctx.storage.sql; }

  #devices(): DeviceRecord[] {
    return this.#sql.exec<{ name: string; public_key: string; addresses: string; granted: string; paired_at: string }>("SELECT * FROM devices ORDER BY name").toArray()
      .map((row) => ({ name: row.name, publicKey: row.public_key, fingerprint: fingerprint(row.public_key), addresses: JSON.parse(row.addresses), granted: JSON.parse(row.granted), pairedAt: row.paired_at }));
  }

  #consent(code: string): (ConsentRecord & { handle: string }) | undefined {
    const row = this.#sql.exec<Record<string, string | number | null>>("SELECT * FROM consents WHERE code = ?", code.toUpperCase()).toArray()[0];
    if (!row) return undefined;
    const record = {
      code: String(row.code), handle: String(row.handle), clientId: String(row.client_id), clientName: String(row.client_name), clientDomain: row.client_domain === null ? null : String(row.client_domain),
      redirectHost: String(row.redirect_host), loopback: row.loopback === 1, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
      status: String(row.status) as ConsentRecord["status"], devices: JSON.parse(String(row.devices)), tools: JSON.parse(String(row.tools)), approvedBy: row.approved_by === null ? null : String(row.approved_by),
    };
    return record;
  }

  #pruneConsents() { this.#sql.exec("DELETE FROM consents WHERE expires_at < ?", Date.now()); }

  /** The gateway's identity, devices and approvals waiting for an owner. */
  status() {
    this.#pruneConsents();
    const pending = this.#sql.exec<{ code: string }>("SELECT code FROM consents WHERE status = 'pending' ORDER BY created_at").toArray().map((row) => this.#public(this.#consent(row.code)!));
    return { publicKey: this.#identity.publicKey, fingerprint: this.#identity.fingerprint, createdAt: this.#identity.createdAt, name: this.env.GATEWAY_NAME || "gateway", relay: this.#relay, devices: this.#devices(), pending };
  }

  /** Remember an owner request's nonce; false when it was seen before. */
  claimNonce(nonce: string, until: number): boolean {
    this.#sql.exec("DELETE FROM nonces WHERE until < ?", Date.now());
    if (this.#sql.exec("SELECT 1 FROM nonces WHERE nonce = ?", nonce).toArray().length) return false;
    this.#sql.exec("INSERT INTO nonces (nonce, until) VALUES (?, ?)", nonce, until);
    return true;
  }

  /**
   * Pair with the device that printed `invite`, as `cns pair INVITE` does: the gateway proves the
   * invite's secret, proposes to use `requests` and offers nothing, and the person at the device
   * sees the gateway's fingerprint and decides.
   */
  async pair(invite: string, options: { name?: string; requests?: Permission[] }) {
    const decoded = decodeInvite(invite);
    const requests = options.requests ?? [...DEFAULT_REQUESTS];
    expandGrants(requests);
    if (this.#devices().some((device) => device.publicKey === decoded.key)) throw new Error("The gateway is already paired with this device. Remove it first with cns gateway remove NAME.");
    const name = options.name ?? this.#freeName(decoded.name ?? "device");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
    if (this.#devices().some((device) => device.name === name)) throw new Error(`The gateway already has a device named ${name}; pass another name with --name.`);
    const { channel } = await connectFirst(gatewayAddresses({ publicKey: decoded.key, addresses: decoded.addresses }, this.#relay), this.#identity, {
      expect: decoded.key, invite: { id: decoded.id, secret: decoded.secret },
    });
    const timer = setTimeout(() => channel.close("Pairing timed out"), PROPOSAL_WAIT_MS);
    const remote = rpcSession<PairingApi>(channel, new GatewayMain());
    let answer: unknown;
    try { answer = await plain(remote.propose({ name: this.env.GATEWAY_NAME || "gateway", requests, offers: [] })); }
    finally {
      clearTimeout(timer);
      remote[Symbol.dispose]();
      channel.close();
    }
    const parsed = decisionSchema.safeParse(answer);
    if (!parsed.success) throw new Error("The device sent an answer the gateway cannot read; nothing was saved.");
    if (!parsed.data.accept) return { paired: false as const, reason: parsed.data.reason ?? "The device declined." };
    const granted = parsed.data.granted ?? [];
    // Only the relay reaches a device from Cloudflare; its own saved address there is kept if the invite named one.
    const addresses = decoded.addresses.filter((address) => gatewayAddresses({ publicKey: decoded.key, addresses: [address] }, this.#relay).includes(address));
    this.#sql.exec("INSERT INTO devices (name, public_key, addresses, granted, paired_at) VALUES (?, ?, ?, ?, ?)", name, decoded.key, JSON.stringify(addresses), JSON.stringify(granted), new Date().toISOString());
    return { paired: true as const, name, fingerprint: fingerprint(decoded.key), granted };
  }

  #freeName(wanted: string): string {
    const taken = new Set(this.#devices().map((device) => device.name));
    const base = wanted.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 60) || "device";
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  /** Forget a device. Connectors approved for it no longer reach it; on the device, cns peer remove ends the pairing there too. */
  removeDevice(name: string): boolean {
    const found = this.#devices().some((device) => device.name === name);
    this.#sql.exec("DELETE FROM devices WHERE name = ?", name);
    return found;
  }

  /** A connector's authorization request, waiting for an owner to run cns gateway approve CODE. */
  startConsent(request: { handle: string; clientId: string; clientName: string; clientDomain?: string; redirectHost: string; loopback: boolean }): string {
    this.#pruneConsents();
    const pending = this.#sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM consents WHERE status = 'pending'").one().count;
    if (pending >= 20) throw new Error("Too many connector approvals are waiting; try again in a few minutes.");
    const code = newCode();
    const now = Date.now();
    this.#sql.exec(
      "INSERT INTO consents (code, handle, client_id, client_name, client_domain, redirect_host, loopback, created_at, expires_at, status, devices, tools, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', '[]', NULL)",
      code, request.handle, request.clientId, request.clientName, request.clientDomain ?? null, request.redirectHost, request.loopback ? 1 : 0, now, now + CONSENT_MS,
    );
    return code;
  }

  #public(record: ConsentRecord & { handle?: string }): ConsentRecord {
    const { handle: _handle, ...rest } = record;
    return rest;
  }

  /** What an owner sees before approving a code. */
  consent(code: string): ConsentRecord | null {
    this.#pruneConsents();
    const record = this.#consent(code);
    return record ? this.#public(record) : null;
  }

  /** An owner's answer to a waiting approval. `devices` are names, or all for every device paired now. */
  decide(code: string, decision: { approve: boolean; devices?: string[] | "all"; tools?: ToolName[]; owner: string }): ConsentRecord {
    this.#pruneConsents();
    const record = this.#consent(code);
    if (!record || record.status !== "pending") throw new Error(`No connector is waiting with code ${code}. Codes last ${CONSENT_MS / 60_000} minutes; start again from the connector.`);
    if (!decision.approve) {
      this.#sql.exec("UPDATE consents SET status = 'denied', approved_by = ? WHERE code = ?", decision.owner, record.code);
      return this.#public(this.#consent(record.code)!);
    }
    const devices = this.#devices();
    const chosen = decision.devices === undefined || decision.devices === "all" ? devices : decision.devices.map((name) => {
      const device = devices.find((candidate) => candidate.name === name);
      if (!device) throw new Error(`The gateway has no device named ${name}. It has: ${devices.map((candidate) => candidate.name).join(", ") || "none"}.`);
      return device;
    });
    if (!chosen.length) throw new Error("The gateway is paired with no device yet; run cns gateway pair first.");
    const tools = decision.tools ?? [...TOOL_NAMES];
    for (const tool of tools) if (!TOOL_NAMES.includes(tool)) throw new Error(`Unknown tool ${tool}.`);
    this.#sql.exec("UPDATE consents SET status = 'approved', devices = ?, tools = ?, approved_by = ? WHERE code = ?",
      JSON.stringify(chosen.map((device) => device.publicKey)), JSON.stringify(tools), decision.owner, record.code);
    return this.#public(this.#consent(record.code)!);
  }

  /**
   * The consent page asking whether its code was decided. `handle` must be the page's own, so
   * nobody else's page can collect an approval. An approval is handed out once.
   */
  pollConsent(code: string, handle: string): { status: "pending" | "denied" | "expired" } | { status: "approved"; props: GrantProps } {
    this.#pruneConsents();
    const record = this.#consent(code);
    if (!record || record.handle !== handle || record.status === "done") return { status: "expired" };
    if (record.status === "pending" || record.status === "denied") return { status: record.status };
    this.#sql.exec("UPDATE consents SET status = 'done' WHERE code = ?", record.code);
    return { status: "approved", props: { grant: crypto.randomUUID(), client: record.clientName, devices: record.devices, tools: record.tools } };
  }

  /** Stop a connector's requests at once, before its access token expires. */
  revoke(grant: string) {
    this.#sql.exec("INSERT OR REPLACE INTO revoked (grant_id, at) VALUES (?, ?)", grant, Date.now());
    this.#servers.get(grant)?.legacy.close();
    this.#servers.delete(grant);
  }

  /** The newest audit entries first. */
  auditLog(limit = 100): AuditEntry[] {
    return this.#sql.exec<Record<string, string | number | null>>("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Math.min(Math.max(1, limit), 1000)).toArray().map((row) => ({
      at: String(row.at), grant: String(row.grant_id), client: String(row.client), tool: String(row.tool), peer: row.peer === null ? null : String(row.peer),
      detail: String(row.detail), ok: row.ok === 1, elapsedMs: Number(row.elapsed_ms),
    }));
  }

  #record(props: GrantProps, devices: () => GatewayDevice[], call: ToolCall) {
    const peer = typeof call.args.peer === "string" ? call.args.peer : devices().length === 1 ? devices()[0]!.name : null;
    this.#sql.exec("INSERT INTO audit (at, grant_id, client, tool, peer, detail, ok, elapsed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      new Date().toISOString(), props.grant, props.client, call.tool, peer, describeCall(call), call.ok ? 1 : 0, call.elapsedMs);
    this.#sql.exec("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - ?", MAX_AUDIT);
  }

  /** An MCP request from a connector, with the GrantProps the Worker verified. */
  override async fetch(request: Request): Promise<Response> {
    const header = request.headers.get(GRANT_HEADER);
    if (!header) return new Response("Not found", { status: 404 });
    const props = JSON.parse(header) as GrantProps;
    if (this.#sql.exec("SELECT 1 FROM revoked WHERE grant_id = ?", props.grant).toArray().length) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32001, message: "This connector was revoked on the gateway. Remove it and connect again to ask for a new approval." }, id: null }, { status: 403 });
    }
    let server = this.#servers.get(props.grant);
    if (!server) {
      // Devices are looked up for each call, so a device removed from the gateway is gone at once.
      const devices = () => this.#devices().filter((device) => props.devices.includes(device.publicKey));
      const build = (): McpServer => createMcpServer(gatewayTarget(devices, this.#identity, this.#relay), {
        tools: props.tools, onCall: (call) => this.#record(props, devices, call),
      });
      const onerror = (error: Error) => console.error(`MCP: ${errorMessage(error)}`);
      server = { modern: createMcpHandler(build, { legacy: "reject", onerror }), legacy: new LegacySessions(build, onerror) };
      this.#servers.set(props.grant, server);
    }
    const forwarded = new Request(request.url, request);
    forwarded.headers.delete(GRANT_HEADER);
    return await (await isLegacyRequest(forwarded) ? server.legacy.fetch(forwarded) : server.modern.fetch(forwarded));
  }
}
