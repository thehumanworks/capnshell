import { serve, type Server } from "bun";
import { authorized, RelayRoom, route, type RelayHandlers } from "../relay-hub.js";
import { endpointUrl } from "../options.js";

interface Data { handlers?: RelayHandlers; key: string; kind: "accept" | "dial" | "answer"; id?: string; host: string }

export interface RelayOptions { bind: string; port: number; token?: string }

/**
 * `cns relay`: the relay of src/relay-hub.ts as a Bun server, for running your own.
 * It holds rooms in memory, one per registered key, and forgets a room once nobody
 * uses it. Put it behind a TLS reverse proxy to serve wss://.
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
  const server = serve<Data>({
    hostname: options.bind, port: options.port,
    fetch(request, server) {
      const url = new URL(request.url);
      const target = route(url);
      if (!target) return new Response("Not found", { status: 404 });
      if (target.kind === "health") return new Response("cns relay\n");
      if (!authorized(url, options.token)) return new Response("This relay needs its token: ?token=TOKEN", { status: 401 });
      if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
      if (target.kind === "dial") {
        const check = rooms.get(target.key)?.room.dialable() ?? { ok: false as const, status: 404, reason: "No device with this key is registered at this relay." };
        if (!check.ok) return new Response(check.reason, { status: check.status });
      }
      if (server.upgrade(request, { data: { key: target.key, kind: target.kind, id: target.kind === "answer" ? target.id : undefined, host: url.host } })) return undefined;
      return new Response("WebSocket upgrade required", { status: 400 });
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        const room = join(ws.data.key, ws.data.host);
        const socket = { send: (data: string | ArrayBuffer | Uint8Array) => { ws.send(data); }, close: (code: number, reason: string) => ws.close(code, reason) };
        ws.data.handlers = ws.data.kind === "accept" ? room.listen(socket) : ws.data.kind === "dial" ? room.dial(socket) : room.answer(ws.data.id!, socket);
      },
      message(ws, message) { ws.data.handlers?.message(typeof message === "string" ? message : new Uint8Array(message)); },
      close(ws) {
        ws.data.handlers?.close();
        leave(ws.data.key);
      },
    },
  });
  return { url: endpointUrl(options.bind, server.port ?? options.port), server, stop: async () => { await server.stop(true); } };
}
