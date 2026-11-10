import { serve, type Server } from "bun";
import { ACCEPTED_CLIENT_KEYS, CLIENT_HEADER, MAX_RELAY_MESSAGE_BYTES, PairingRooms, RELAY_HEALTH, RelayRoom, route, verifyClient, type RelayData, type RelayHandlers } from "./relay-hub.js";
import { endpointUrl } from "./options.js";

interface Data { handlers?: RelayHandlers; key: string; kind: "accept" | "dial" | "answer" | "room" | "join"; id?: string; room?: number; host: string; address: string }

export interface RelayOptions {
  bind: string;
  port: number;
  /** The client keys a request's Cns-Client header may be made with (default: the one built into cns). */
  clientKeys?: readonly string[];
  /** The host:port devices use for this relay, which their registration proofs must name. Without it, each request's Host header. */
  publicHost?: string;
}

/** Sockets one address may hold at once, and sockets in all. */
export const MAX_SOCKETS_PER_ADDRESS = 64;
export const MAX_SOCKETS = 4096;
/** A pipe whose reader falls this far behind is closed rather than having its data dropped. */
const BACKPRESSURE_BYTES = 4 * 1024 * 1024;

/**
 * The relay of src/relay-hub.ts as a Bun server. The relay devices use is the Cloudflare
 * Worker in relay/; this one runs the same code for tests and local development, with
 * CNS_RELAY pointing cns at it. It holds rooms in memory, one per registered key, and
 * forgets a room once nobody uses it. Given the public host devices use, it never accepts
 * a proof or a client header made for another relay.
 */
export function startRelay(options: RelayOptions): { url: string; server: Server<Data>; stop(): Promise<void> } {
  // A room lives while any socket for its key is open, including a daemon still proving
  // its key, so a dial refused meanwhile never discards the room the daemon registers in.
  const rooms = new Map<string, { room: RelayRoom; sockets: number }>();
  const join = (key: string, host: string) => {
    let entry = rooms.get(key);
    if (!entry) { entry = { room: new RelayRoom(key, host), sockets: 0 }; rooms.set(key, entry); }
    entry.sockets++;
    return entry.room;
  };
  const leave = (key: string) => {
    const entry = rooms.get(key);
    if (entry && --entry.sockets <= 0) rooms.delete(key);
  };
  // Pairing rooms, numbered across the whole relay.
  const pairingRooms = new PairingRooms();
  const perAddress = new Map<string, number>();
  let total = 0;
  const server = serve<Data>({
    hostname: options.bind, port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url);
      const target = route(url);
      if (!target) return new Response("Not found", { status: 404 });
      if (target.kind === "health") return new Response(RELAY_HEALTH);
      if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
      const host = options.publicHost ?? url.host;
      // Only cns: anything without a valid client header is refused before it reaches a room.
      if (!(await verifyClient(request.headers.get(CLIENT_HEADER), host, url.pathname, options.clientKeys ?? ACCEPTED_CLIENT_KEYS))) return new Response("Only cns may use this relay", { status: 401 });
      const address = server.requestIP(request)?.address ?? "unknown";
      if (total >= MAX_SOCKETS || (perAddress.get(address) ?? 0) >= MAX_SOCKETS_PER_ADDRESS) return new Response("Too many connections", { status: 429 });
      if (target.kind === "dial") {
        const check = rooms.get(target.key)?.room.dialable(address) ?? { ok: false as const, status: 404, reason: "No device with this key is registered at this relay." };
        if (!check.ok) return new Response(check.reason, { status: check.status });
      }
      if (target.kind === "room" || target.kind === "join") {
        // Refusals of a join arrive as close reasons, which the joining device shows as they are.
        if (server.upgrade(request, { data: { key: "", kind: target.kind, ...target.kind === "join" ? { room: target.room } : {}, host, address } })) return undefined;
        return new Response("WebSocket upgrade required", { status: 400 });
      }
      if (server.upgrade(request, { data: { key: target.key, kind: target.kind, id: target.kind === "answer" ? target.id : undefined, host, address } })) return undefined;
      return new Response("WebSocket upgrade required", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: MAX_RELAY_MESSAGE_BYTES,
      backpressureLimit: BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        total++;
        perAddress.set(ws.data.address, (perAddress.get(ws.data.address) ?? 0) + 1);
        const socket = {
          // Bun drops a message it cannot queue (send returns 0): end the pipe instead of losing data silently.
          send: (data: RelayData) => { if (ws.send(data) === 0) throw new Error("The reader fell too far behind."); },
          close: (code: number, reason: string) => ws.close(code, reason),
        };
        if (ws.data.kind === "room") { ws.data.handlers = pairingRooms.open(socket); return; }
        if (ws.data.kind === "join") { ws.data.handlers = pairingRooms.join(ws.data.room!, socket, ws.data.address); return; }
        const room = join(ws.data.key, ws.data.host);
        ws.data.handlers = ws.data.kind === "accept" ? room.listen(socket, ws.data.host)
          : ws.data.kind === "dial" ? room.dial(socket, ws.data.address)
          : room.answer(ws.data.id!, socket);
      },
      message(ws, message) { ws.data.handlers?.message(typeof message === "string" ? message : new Uint8Array(message)); },
      close(ws) {
        ws.data.handlers?.close();
        if (ws.data.kind !== "room" && ws.data.kind !== "join") leave(ws.data.key);
        total--;
        const left = (perAddress.get(ws.data.address) ?? 1) - 1;
        if (left > 0) perAddress.set(ws.data.address, left); else perAddress.delete(ws.data.address);
      },
    },
  });
  return { url: endpointUrl(options.bind, server.port ?? options.port), server, stop: async () => { await server.stop(true); } };
}
