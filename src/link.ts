import type { ServerWebSocket } from "bun";
import { AuthError, Initiator, Responder, refusalFor, type InitiatorOptions, type ResponderOptions, type Step } from "./auth.js";
import type { Identity, PublicKey } from "./identity.js";

/** How long a peer may take to finish authenticating. */
export const HANDSHAKE_MS = 10_000;

/**
 * Authenticate an open client WebSocket as the dialer. Resolves with the peer's
 * identity once both sides are authenticated; the socket then carries Cap'n Web.
 * Rejects with an AuthError, closing the socket, otherwise.
 */
export function authenticateClient(socket: WebSocket, identity: Identity, options: InitiatorOptions = {}): Promise<PublicKey> {
  const initiator = new Initiator(identity, options);
  return new Promise<PublicKey>((resolve, reject) => {
    const timer = setTimeout(() => fail(new AuthError("protocol", "The peer did not finish authenticating in time.")), HANDSHAKE_MS);
    const onMessage = (event: MessageEvent) => {
      let step: Step;
      try { step = initiator.receive(typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8")); }
      catch (error) { return fail(error); }
      if (step.send) socket.send(step.send);
      if (step.peer) { cleanup(); resolve(step.peer); }
    };
    const onClose = (event: CloseEvent) => fail(new AuthError("closed", event.reason ? `The peer closed the connection: ${event.reason}` : "The peer closed the connection before authenticating."));
    const onError = () => fail(new AuthError("closed", "The connection failed before authenticating."));
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    }
    function fail(error: unknown) {
      cleanup();
      try { socket.close(1008, error instanceof Error ? error.message.slice(0, 120) : "Authentication failed"); } catch { /* Already closed. */ }
      reject(error);
    }
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    socket.send(initiator.start());
  });
}

/**
 * Authenticate an accepted Bun WebSocket as the responder. Feed it every message
 * until `done` settles; messages that arrive while a step is in progress wait their
 * turn. The caller then hands the socket to Cap'n Web.
 */
export class ServerHandshake<T> {
  #responder: Responder;
  #queue: string[] = [];
  #busy = false;
  #settled = false;
  #resolve!: (result: { peer: PublicKey; invite?: { id: string } }) => void;
  #reject!: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout>;
  readonly done: Promise<{ peer: PublicKey; invite?: { id: string } }>;
  constructor(private readonly ws: ServerWebSocket<T>, identity: Identity, options: ResponderOptions) {
    this.#responder = new Responder(identity, options);
    this.done = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.#timer = setTimeout(() => this.#fail(new AuthError("protocol", "The peer did not finish authenticating in time.")), HANDSHAKE_MS);
  }
  get settled() { return this.#settled; }
  message(data: string | Buffer): void {
    if (this.#settled) return;
    this.#queue.push(typeof data === "string" ? data : data.toString("utf8"));
    void this.#pump();
  }
  closed(): void { this.#fail(new AuthError("closed", "The peer closed the connection before authenticating.")); }
  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length && !this.#settled) {
        const text = this.#queue.shift()!;
        let step: Step;
        try { step = await this.#responder.receive(text); }
        catch (error) {
          const refusal = refusalFor(error);
          if (refusal) { try { this.ws.send(refusal); } catch { /* Gone. */ } }
          this.#fail(error);
          return;
        }
        if (step.send) this.ws.send(step.send);
        if (step.peer) {
          this.#settled = true;
          clearTimeout(this.#timer);
          this.#resolve({ peer: step.peer, invite: step.invite });
        }
      }
    } finally { this.#busy = false; }
  }
  #fail(error: unknown) {
    if (this.#settled) return;
    this.#settled = true;
    clearTimeout(this.#timer);
    try { this.ws.close(1008, error instanceof Error ? error.message.slice(0, 120) : "Authentication failed"); } catch { /* Already closed. */ }
    this.#reject(error);
  }
}
