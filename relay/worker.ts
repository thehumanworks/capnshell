/**
 * The relay of src/relay-hub.ts as a Cloudflare Worker. Each device key gets its own
 * Durable Object, which holds that key's registered daemon and the dialers connected
 * to it. Sockets use the WebSocket hibernation API, so a registered daemon that is not
 * in use costs nothing while it waits, and relay pings are answered without waking the
 * object. Only cns may use it: every request must carry a valid Cns-Client header.
 * Deploy with `wrangler deploy` from this directory; see relay/README.md.
 */
import {
  ACCEPTED_CLIENT_KEYS, ANSWER_MS, CHALLENGE_MS, CLIENT_HEADER, MAX_DIALS_PER_ADDRESS, MAX_HELD_BYTES, MAX_HELD_MESSAGES, MAX_PIPES_PER_KEY, MAX_RELAY_MESSAGE_BYTES,
  PairingRooms, RELAY_HEALTH, randomId, route, size, verifyClient, verifyProof, type RelayData,
} from "../src/relay-hub.js";

// The few Workers runtime types this file uses, so it typechecks without @cloudflare/workers-types.
interface CfWebSocket extends WebSocket {
  accept(): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
declare const WebSocketPair: { new(): { 0: CfWebSocket; 1: CfWebSocket } };
declare const WebSocketRequestResponsePair: { new(request: string, response: string): unknown };
interface DurableObjectState {
  acceptWebSocket(socket: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
  setWebSocketAutoResponse(pair: unknown): void;
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Env { RELAY_KEYS: DurableObjectNamespace; RELAY_ROOMS: DurableObjectNamespace }

type Attachment =
  | { role: "listener"; key: string; nonce: string; host: string; proved: boolean; since: number }
  | { role: "dialer"; id: string; address: string }
  | { role: "answer"; id: string };

const upgrade = (client: CfWebSocket) => new Response(null, { status: 101, webSocket: client } as ResponseInit);
const attachment = (socket: CfWebSocket) => socket.deserializeAttachment() as Attachment;
function safeClose(socket: CfWebSocket, code: number, reason: string) { try { socket.close(code, reason); } catch { /* Already closed. */ } }
/** Sockets still open: getWebSockets also returns ones that are closing. */
const open = (sockets: CfWebSocket[]) => sockets.filter((socket) => socket.readyState === 1);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const target = route(url);
    if (!target) return new Response("Not found", { status: 404 });
    if (target.kind === "health") return new Response(RELAY_HEALTH);
    if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
    // Only cns: anything without a valid client header is refused before it reaches a Durable Object, so it costs nothing.
    if (!(await verifyClient(request.headers.get(CLIENT_HEADER), url.host, url.pathname, ACCEPTED_CLIENT_KEYS))) return new Response("Only cns may use this relay", { status: 401 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    // Pairing rooms are numbered across the relay, so one object holds them all.
    if (target.kind === "room" || target.kind === "join") return env.RELAY_ROOMS.get(env.RELAY_ROOMS.idFromName("rooms")).fetch(request);
    return env.RELAY_KEYS.get(env.RELAY_KEYS.idFromName(target.key)).fetch(request);
  },
};

/** One device key: its registered daemon and the dialers connected to it. */
export class RelayKey {
  #ctx: DurableObjectState;
  /** Dialers' first messages until the daemon answers. Lost on eviction, which only drops a dialer that then retries. */
  #held = new Map<string, { messages: RelayData[]; bytes: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(ctx: DurableObjectState) {
    this.#ctx = ctx;
    this.#ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(JSON.stringify({ t: "ping" }), JSON.stringify({ t: "pong" })));
  }

  /** The newest proved, open listener, other than `except`. */
  #listener(except?: CfWebSocket): CfWebSocket | undefined {
    const proved = open(this.#ctx.getWebSockets("listener")).filter((socket) => { const data = attachment(socket); return socket !== except && data.role === "listener" && data.proved; });
    return proved.sort((a, b) => (attachment(b) as { since: number }).since - (attachment(a) as { since: number }).since)[0];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const target = route(url);
    if (!target || target.kind === "health" || target.kind === "room" || target.kind === "join") return new Response("Not found", { status: 404 });
    if (target.kind === "dial") {
      const listener = this.#listener();
      if (!listener) return new Response("No device with this key is registered at this relay.", { status: 404 });
      const dialers = open(this.#ctx.getWebSockets("dialer"));
      if (dialers.length >= MAX_PIPES_PER_KEY) return new Response("Too many connections to this device through the relay.", { status: 503 });
      const address = request.headers.get("CF-Connecting-IP") ?? "";
      if (address && dialers.filter((socket) => (attachment(socket) as { address?: string }).address === address).length >= MAX_DIALS_PER_ADDRESS) {
        return new Response("Too many connections to this device from this address.", { status: 429 });
      }
      const id = randomId();
      // Announce first: if the daemon's socket has gone, refuse before accepting the dialer.
      try { listener.send(JSON.stringify({ t: "incoming", id })); }
      catch { return new Response("The device's relay connection failed.", { status: 503 }); }
      const { 0: client, 1: server } = new WebSocketPair();
      this.#ctx.acceptWebSocket(server, ["dialer", `dial:${id}`]);
      server.serializeAttachment({ role: "dialer", id, address } satisfies Attachment);
      this.#held.set(id, { messages: [], bytes: 0, timer: setTimeout(() => this.#drop(id, 4004, "The device did not answer through the relay."), ANSWER_MS) });
      return upgrade(client);
    }
    if (target.kind === "answer") {
      const dialer = open(this.#ctx.getWebSockets(`dial:${target.id}`))[0];
      const held = this.#held.get(target.id);
      if (!dialer || this.#ctx.getWebSockets(`answer:${target.id}`).length) return new Response("No dialer is waiting with this id.", { status: 404 });
      // The dialer's first messages are gone if the object was evicted meanwhile: end the pipe rather than continue without them.
      if (!held) { this.#drop(target.id, 4004, "The relay lost the dialer's first messages."); return new Response("No dialer is waiting with this id.", { status: 404 }); }
      const { 0: client, 1: server } = new WebSocketPair();
      this.#ctx.acceptWebSocket(server, ["answer", `answer:${target.id}`]);
      server.serializeAttachment({ role: "answer", id: target.id } satisfies Attachment);
      this.#held.delete(target.id);
      clearTimeout(held.timer);
      for (const message of held.messages) server.send(message);
      return upgrade(client);
    }
    // A daemon registering: it must sign the challenge before it is the key's listener.
    const { 0: client, 1: server } = new WebSocketPair();
    const nonce = randomId();
    this.#ctx.acceptWebSocket(server, ["listener"]);
    server.serializeAttachment({ role: "listener", key: target.key, nonce, host: url.host, proved: false, since: Date.now() } satisfies Attachment);
    server.send(JSON.stringify({ t: "challenge", nonce }));
    setTimeout(() => { const data = attachment(server); if (data.role === "listener" && !data.proved) safeClose(server, 4008, "No proof of the key in time."); }, CHALLENGE_MS);
    return upgrade(client);
  }

  async webSocketMessage(socket: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    const data = attachment(socket);
    if (size(message) > MAX_RELAY_MESSAGE_BYTES) { safeClose(socket, 4009, "Message too large for the relay."); return; }
    if (data.role === "listener") {
      if (data.proved) return;
      if (typeof message !== "string" || message.length > 4096) { safeClose(socket, 4008, "Invalid relay message."); return; }
      let parsed: { t?: unknown; sig?: unknown };
      try { parsed = JSON.parse(message); } catch { safeClose(socket, 4008, "Invalid relay message."); return; }
      if (parsed.t !== "proof" || typeof parsed.sig !== "string") { safeClose(socket, 4008, "Invalid relay message."); return; }
      if (!(await verifyProof(data.host, data.key, data.nonce, parsed.sig))) { safeClose(socket, 4003, "The proof does not match the key."); return; }
      // A socket that left while its proof was checked must not displace the live one.
      if (socket.readyState !== 1) return;
      // The newest registration wins: it is the daemon that restarted.
      for (const other of this.#ctx.getWebSockets("listener")) if (other !== socket && (attachment(other) as { proved?: boolean }).proved) safeClose(other, 4000, "Another daemon registered for this key.");
      socket.serializeAttachment({ ...data, proved: true, since: Date.now() } satisfies Attachment);
      socket.send(JSON.stringify({ t: "ready" }));
      return;
    }
    if (data.role === "dialer") {
      const answer = this.#ctx.getWebSockets(`answer:${data.id}`)[0];
      if (answer) { try { answer.send(message); } catch { this.#drop(data.id, 4000, "The device's connection failed."); } return; }
      const held = this.#held.get(data.id);
      if (!held) { this.#drop(data.id, 4004, "The device did not answer through the relay."); return; }
      held.messages.push(message);
      held.bytes += size(message);
      if (held.messages.length > MAX_HELD_MESSAGES || held.bytes > MAX_HELD_BYTES) this.#drop(data.id, 4009, "Too much sent before the device answered.");
      return;
    }
    const dialer = this.#ctx.getWebSockets(`dial:${data.id}`)[0];
    if (!dialer) { safeClose(socket, 1000, "The other side closed the connection."); return; }
    try { dialer.send(message); } catch { this.#drop(data.id, 4000, "The dialer's connection failed."); }
  }

  async webSocketClose(socket: CfWebSocket, code: number, reason: string): Promise<void> {
    const data = attachment(socket);
    safeClose(socket, code === 1005 || code === 1006 ? 1000 : code, reason);
    if (data.role === "listener") {
      if (this.#listener(socket)) return;
      // No daemon left: dialers still waiting for an answer will not get one.
      for (const dialer of this.#ctx.getWebSockets("dialer")) {
        const { id } = attachment(dialer) as { id: string };
        if (!this.#ctx.getWebSockets(`answer:${id}`).length) this.#drop(id, 4004, "The device left the relay.");
      }
      return;
    }
    this.#drop(data.id, 1000, "The other side closed the connection.");
  }

  async webSocketError(socket: CfWebSocket): Promise<void> { await this.webSocketClose(socket, 1011, "The connection failed."); }

  #drop(id: string, code: number, reason: string) {
    const held = this.#held.get(id);
    if (held) { clearTimeout(held.timer); this.#held.delete(id); }
    for (const socket of [...this.#ctx.getWebSockets(`dial:${id}`), ...this.#ctx.getWebSockets(`answer:${id}`)]) safeClose(socket, code, reason);
  }
}

/**
 * The pairing rooms of src/relay-hub.ts (PairingRooms), in one object for the whole relay
 * so that room numbers stay short. Rooms last minutes and are rare, so these sockets do not
 * hibernate: the object keeps the same in-memory rooms the Bun relay does, and a room's
 * host pings it to keep the connection up.
 */
export class RelayRooms {
  #rooms = new PairingRooms();

  async fetch(request: Request): Promise<Response> {
    const target = route(new URL(request.url));
    if (target?.kind !== "room" && target?.kind !== "join") return new Response("Not found", { status: 404 });
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const socket = { send: (data: RelayData) => server.send(data), close: (code: number, reason: string) => safeClose(server, code, reason) };
    // Refusals of a join arrive as close reasons, which the joining device shows as they are.
    const handlers = target.kind === "room" ? this.#rooms.open(socket) : this.#rooms.join(target.room, socket, request.headers.get("CF-Connecting-IP") ?? "");
    server.addEventListener("message", (event) => handlers.message((event as MessageEvent).data as string | ArrayBuffer));
    server.addEventListener("close", () => handlers.close());
    server.addEventListener("error", () => handlers.close());
    return upgrade(client);
  }
}
