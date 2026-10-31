import {
  isInitializeRequest, isJSONRPCNotification, isJSONRPCRequest, WebStandardStreamableHTTPServerTransport, type McpServer,
} from "@modelcontextprotocol/server";

/** Sessions open or starting at once; past this, the longest-idle session makes room. */
export const MAX_SESSIONS = 64;
/** Close a session after this long with no request or stream open. */
export const SESSION_IDLE_MS = 60 * 60_000;

type RequestId = string | number;

/** The requests one POST carried, whose responses stream back on its response. */
interface Call {
  ids: RequestId[];
  cancelled: Set<RequestId>;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  /** Responses still being delivered: a call in progress or a client's event stream. */
  open: number;
  lastActive: number;
  calls: Map<RequestId, Call>;
}

const NOT_JSON = Symbol("not JSON");

const jsonRpcError = (status: number, code: number, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });

const messages = (body: unknown): unknown[] => body === NOT_JSON ? [] : Array.isArray(body) ? body : [body];
const requestIds = (body: unknown) => messages(body).flatMap((message) => isJSONRPCRequest(message) ? [message.id] : []);
const cancelledIds = (body: unknown) => messages(body).flatMap((message) => {
  if (!isJSONRPCNotification(message) || message.method !== "notifications/cancelled") return [];
  const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
  return typeof id === "string" || typeof id === "number" ? [id] : [];
});

async function readJson(request: Request): Promise<unknown> {
  if (request.method.toUpperCase() !== "POST") return NOT_JSON;
  try { return await request.clone().json(); }
  catch { return NOT_JSON; }
}

/**
 * Streamable HTTP sessions for 2025-era clients. These clients cancel a call by
 * posting notifications/cancelled, which only reaches the call when the same
 * server instance serves the whole session. The 2026-07-28 protocol needs no
 * sessions: closing a request's stream cancels it.
 *
 * The 2025 protocol does not treat a dropped response stream as cancellation,
 * since a client could resume it. These sessions keep no events to resume from,
 * so a dropped stream's calls are cancelled: nobody can receive their results.
 */
export class LegacySessions {
  #sessions = new Map<string, Session>();
  /** Sessions being initialized, counted against MAX_SESSIONS before they have an ID. */
  #starting = 0;
  #build: () => McpServer;
  #onerror: (error: Error) => void;
  #sweeper = setInterval(() => this.#sweep(), 60_000);

  constructor(build: () => McpServer, onerror: (error: Error) => void) {
    this.#build = build;
    this.#onerror = onerror;
    this.#sweeper.unref();
  }

  get size(): number { return this.#sessions.size; }

  async fetch(request: Request): Promise<Response> {
    const id = request.headers.get("Mcp-Session-Id");
    const body = await readJson(request);
    if (id !== null) {
      const session = this.#sessions.get(id);
      // 404 tells the client to start a new session.
      if (!session) return jsonRpcError(404, -32001, "Session not found.");
      const response = await session.transport.handleRequest(request, body === NOT_JSON ? undefined : { parsedBody: body });
      for (const cancelled of cancelledIds(body)) this.#endCancelled(session, cancelled);
      return this.#track(session, response, requestIds(body));
    }
    if (request.method.toUpperCase() !== "POST") return jsonRpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required.");
    if (body === NOT_JSON) return jsonRpcError(400, -32700, "Parse error: the body is not JSON.");
    if (!isInitializeRequest(body)) return jsonRpcError(400, -32000, "Bad Request: Mcp-Session-Id header is required.");
    if (this.#sessions.size + this.#starting >= MAX_SESSIONS && !this.#evictIdlest()) {
      return jsonRpcError(503, -32000, `Too many MCP sessions (${MAX_SESSIONS}) are in use.`);
    }

    this.#starting++;
    let started = false;
    const session: Session = {
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Take the place reserved for this session.
          this.#sessions.set(sessionId, session);
          this.#starting--;
          started = true;
        },
      }),
      open: 0,
      lastActive: Date.now(),
      calls: new Map(),
    };
    const { transport } = session;
    try {
      // Set before connecting, so the server chains its own close handling after this.
      transport.onclose = () => {
        if (transport.sessionId !== undefined && this.#sessions.get(transport.sessionId) === session) this.#sessions.delete(transport.sessionId);
      };
      transport.onerror = this.#onerror;
      await this.#build().connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      if (!started) void transport.close().catch(() => {});
      return this.#track(session, response, requestIds(body));
    } finally {
      if (!started) this.#starting--;
    }
  }

  /** Close every session, aborting their calls. */
  async close(): Promise<void> {
    clearInterval(this.#sweeper);
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(({ transport }) => transport.close()));
  }

  /**
   * The server sends nothing for a cancelled request, so its response stream
   * would stay open until the session ends. Close it once all its requests
   * are cancelled.
   */
  #endCancelled(session: Session, id: RequestId) {
    const call = session.calls.get(id);
    if (!call) return;
    call.cancelled.add(id);
    if (call.ids.every((each) => call.cancelled.has(each))) session.transport.closeSSEStream(id);
  }

  /**
   * Count the response as open until its body has been delivered or dropped.
   * When the client drops it first, cancel the requests it was carrying.
   */
  #track(session: Session, response: Response, ids: RequestId[]): Response {
    session.open++;
    session.lastActive = Date.now();
    const call: Call = { ids, cancelled: new Set() };
    for (const id of ids) session.calls.set(id, call);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      session.open--;
      session.lastActive = Date.now();
      for (const id of ids) if (session.calls.get(id) === call) session.calls.delete(id);
      return true;
    };
    if (response.body === null) {
      settle();
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            settle();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          settle();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (settle()) {
          for (const id of ids) {
            if (call.cancelled.has(id)) continue;
            session.transport.onmessage?.({
              jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "The client disconnected." },
            });
          }
        }
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  #idle(): [string, Session][] {
    return [...this.#sessions].filter(([, session]) => session.open === 0);
  }

  #evictIdlest(): boolean {
    const [oldest] = this.#idle().sort(([, a], [, b]) => a.lastActive - b.lastActive);
    if (!oldest) return false;
    this.#sessions.delete(oldest[0]);
    void oldest[1].transport.close().catch(() => {});
    return true;
  }

  #sweep() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of this.#idle()) {
      if (session.lastActive >= cutoff) continue;
      this.#sessions.delete(id);
      void session.transport.close().catch(() => {});
    }
  }
}
