import net from "node:net";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { errorMessage } from "./errors.js";

/*
 * cns forward (docs/adr/0011-port-forwarding.md): each TCP connection to the forwarding device's
 * port is carried to a port on localhost on the paired device, over the link both already hold.
 * Bytes cross as awaited calls of at most FORWARD_CHUNK_BYTES, each way. A call is answered once
 * its bytes are written to the socket at the other end; with at most CONNECTION_WINDOW calls
 * unanswered per connection, and FORWARD_WINDOW per forward, a full window pauses the socket
 * that is read, so TCP slows the program at either end, and a forward never queues more than
 * 512 KiB in front of keystrokes on the link.
 */

/** Bytes in one call at most, as for exec. */
export const FORWARD_CHUNK_BYTES = 64 * 1024;
/** Calls one connection may have unanswered in each direction: 256 KiB. */
export const CONNECTION_WINDOW = 4;
/** Calls one forward may have unanswered in each direction, over all its connections: 512 KiB. */
export const FORWARD_WINDOW = 8;
/** TCP connections one forward carries at once. */
export const MAX_FORWARD_CONNECTIONS = 32;
/** Forwards one paired device holds on a device at once, over all its links. */
export const MAX_FORWARDS = 8;
/** How long a device tries to reach the port, on 127.0.0.1 and then ::1. */
export const CONNECT_MS = 10_000;

export const portSchema = z.int().min(1).max(65535);

/** What one end of a connection calls on the other: write or data, and end. */
interface Far { send(data: Uint8Array): PromiseLike<unknown>; end(): unknown }

/** One forward's calls that are unanswered, in each direction, over all its connections. */
export class Flow {
  sending = 0;
  receiving = 0;
  #waiting = new Set<() => void>();
  wait(wake: () => void) { this.#waiting.add(wake); }
  forget(wake: () => void) { this.#waiting.delete(wake); }
  answered() {
    this.sending--;
    for (const wake of [...this.#waiting]) { this.#waiting.delete(wake); wake(); }
  }
}

/** Settle a call nobody waits for, so that a failure is not reported as unhandled. */
const settle = (call: unknown) => { void Promise.resolve(call).then(() => {}, () => {}); };

/**
 * One forwarded TCP connection at one end: its socket here, and the other end over the link,
 * which it sends to once started. What the socket reads goes out in order, then its end; while
 * the window is full the socket is paused. What comes in is answered once the socket took it,
 * and more than the window allows closes the connection.
 */
export class Tunnel {
  readonly socket: net.Socket;
  #flow: Flow;
  #far?: Far;
  /** What the socket read and has not been sent, then null for its end. */
  #queue: Array<Uint8Array | null> = [];
  #sending = 0;
  #receiving = 0;
  #error?: string;
  #gone = false;
  #closed = Promise.withResolvers<string | undefined>();
  /** Bytes the socket read, and bytes written to it. */
  read = 0;
  written = 0;
  /**
   * Resolves once the socket has closed: with why, or, when it closed cleanly, with undefined
   * once all it read has been sent too, so that what follows comes after it on the link.
   */
  readonly closed = this.#closed.promise;

  constructor(socket: net.Socket, flow: Flow) {
    this.socket = socket;
    this.#flow = flow;
    // Nothing is read before start: until then there is nobody to send it to.
    socket.pause();
    socket.on("data", (data: Buffer) => {
      this.read += data.length;
      for (let at = 0; at < data.length; at += FORWARD_CHUNK_BYTES) {
        this.#queue.push(new Uint8Array(data.buffer, data.byteOffset + at, Math.min(FORWARD_CHUNK_BYTES, data.length - at)));
      }
      this.#pump();
    });
    socket.on("end", () => { this.#queue.push(null); this.#pump(); });
    socket.on("error", (error) => { this.#error ??= errorMessage(error); });
    socket.once("close", (hadError) => {
      this.#gone = true;
      if (hadError) this.#error ??= "The connection failed.";
      this.#finish();
    });
  }

  /** Send what the socket reads to `far`. */
  start(far: Far) {
    this.#far = far;
    this.#pump();
  }

  /** Once the socket has closed: at once after a failure, else once the queue is sent. */
  #finish() {
    if (!this.#gone) return;
    if (this.#error !== undefined) { this.#queue = []; this.#flow.forget(this.#pump); }
    if (!this.#queue.length) this.#closed.resolve(this.#error);
  }

  #pump = () => {
    const far = this.#far;
    if (!far || this.#error !== undefined) return;
    while (this.#queue.length) {
      const next = this.#queue[0]!;
      if (next !== null && (this.#sending >= CONNECTION_WINDOW || this.#flow.sending >= FORWARD_WINDOW)) break;
      this.#queue.shift();
      // The end follows the data on the link, in order, without waiting for its answers.
      if (next === null) { settle(far.end()); continue; }
      this.#sending++;
      this.#flow.sending++;
      far.send(next).then(() => { this.#sending--; this.#flow.answered(); this.#pump(); },
        (error: unknown) => { this.#sending--; this.#flow.answered(); this.close(errorMessage(error)); });
    }
    if (!this.#queue.length) { this.socket.resume(); this.#finish(); return; }
    this.socket.pause();
    // An answer to one of its own calls pumps again; one to another connection's does when the forward was full.
    if (this.#sending < CONNECTION_WINDOW) this.#flow.wait(this.#pump);
  };

  /** Write what the other end sent: answered once the socket has taken it. */
  receive(data: unknown): Promise<void> {
    if (!(data instanceof Uint8Array) || data.byteLength > FORWARD_CHUNK_BYTES) return this.#refuse(`A forwarded chunk is a Uint8Array of at most ${FORWARD_CHUNK_BYTES} bytes.`);
    if (this.socket.destroyed) return Promise.resolve();
    if (!this.socket.writable) return this.#refuse("The other end sent bytes after its end.");
    if (this.#receiving >= CONNECTION_WINDOW || this.#flow.receiving >= FORWARD_WINDOW) {
      return this.#refuse(`The other end sent more than ${CONNECTION_WINDOW} chunks unanswered on one connection, or ${FORWARD_WINDOW} on one forward.`);
    }
    this.#receiving++;
    this.#flow.receiving++;
    this.written += data.byteLength;
    return new Promise<void>((resolve) => { this.socket.write(data, () => resolve()); }).finally(() => { this.#receiving--; this.#flow.receiving--; });
  }

  #refuse(reason: string): Promise<never> {
    this.close(reason);
    return Promise.reject(new Error(reason));
  }

  /** The other end sends nothing more: half-close the socket, once what it sent is written. */
  ended() { this.socket.end(); }

  /** Close the socket at once, and stop sending, for `reason` when there is one. */
  close(reason?: string) {
    if (reason) this.#error ??= reason;
    this.socket.destroy();
    // A socket that had closed already has nothing to send now.
    this.#finish();
  }
}

/** What a device calls on the forwarding device's end of a connection. */
export interface ForwardSink {
  /** Bytes from the port, at most FORWARD_CHUNK_BYTES. */
  data(data: Uint8Array): void | Promise<void>;
  /** The port sends nothing more. */
  end(): void | Promise<void>;
  /** The device's socket closed: with why, or undefined when it closed cleanly. */
  closed(reason?: string): void | Promise<void>;
}
type SinkStub = ForwardSink & { dup?(): SinkStub; [Symbol.dispose]?(): void };

/** One connection to the port, as the forwarding device holds it. Releasing it closes the connection. */
export class PortConnection extends RpcTarget {
  #tunnel: Tunnel;
  constructor(tunnel: Tunnel) { super(); this.#tunnel = tunnel; }
  /** Bytes for the port, at most FORWARD_CHUNK_BYTES; answered once they are written. */
  write(data: Uint8Array) { return this.#tunnel.receive(data); }
  /** Nothing more comes for the port: half-close the connection. */
  end() { this.#tunnel.ended(); }
  [Symbol.dispose]() { this.#tunnel.close("The forwarding device closed the connection."); }
}

export interface ForwardStats { connections: number; bytesIn: number; bytesOut: number }

/** Forwards each paired device holds here, by its fingerprint, over all its links. */
const held = new Map<string | null, number>();

/**
 * A forward to `port` on localhost on this device, which a paired device holds: connect opens a
 * connection. Releasing it closes its connections, and `ended` then gives what it carried. It
 * counts toward the MAX_FORWARDS of `owner`, the device's fingerprint, until then.
 */
export class PortForward extends RpcTarget {
  #port: number;
  #owner: string | null;
  #flow = new Flow();
  #tunnels = new Set<Tunnel>();
  #connecting = 0;
  #closed = false;
  #onClose: (forward: PortForward) => void;
  #stats: ForwardStats = { connections: 0, bytesIn: 0, bytesOut: 0 };
  #ended = Promise.withResolvers<ForwardStats>();
  /** What the forward carried, once it has ended and its connections have closed. */
  readonly ended = this.#ended.promise;

  constructor(port: number, owner: string | null, onClose: (forward: PortForward) => void = () => {}) {
    super();
    const count = held.get(owner) ?? 0;
    if (count >= MAX_FORWARDS) throw new Error(`A device holds at most ${MAX_FORWARDS} forwards here at once; stop one of the others first.`);
    held.set(owner, count + 1);
    this.#port = port;
    this.#owner = owner;
    this.#onClose = onClose;
  }

  /** Open a connection to the port: 127.0.0.1, else ::1. What the port sends goes to `sink`. */
  async connect(sink: ForwardSink): Promise<PortConnection> {
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A forward sink is required.");
    if (this.#closed) throw new Error("This forward has ended.");
    if (this.#tunnels.size + this.#connecting >= MAX_FORWARD_CONNECTIONS) throw new Error(`A forward carries at most ${MAX_FORWARD_CONNECTIONS} connections at once.`);
    // Parameters are released after the call returns; keep our own reference.
    const far = (sink as SinkStub).dup?.() ?? sink as SinkStub;
    this.#connecting++;
    let socket: net.Socket;
    try { socket = await dialLocal(this.#port); }
    catch (error) { far[Symbol.dispose]?.(); throw error; }
    finally { this.#connecting--; }
    if (this.#closed) { socket.destroy(); far[Symbol.dispose]?.(); throw new Error("This forward has ended."); }
    const tunnel = new Tunnel(socket, this.#flow);
    this.#tunnels.add(tunnel);
    this.#stats.connections++;
    tunnel.start({ send: (data) => Promise.resolve(far.data(data)), end: () => far.end() });
    void tunnel.closed.then((reason) => {
      this.#tunnels.delete(tunnel);
      this.#stats.bytesIn += tunnel.written;
      this.#stats.bytesOut += tunnel.read;
      void Promise.resolve(far.closed(reason)).catch(() => {}).finally(() => far[Symbol.dispose]?.());
    });
    return new PortConnection(tunnel);
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    const count = held.get(this.#owner) ?? 1;
    if (count > 1) held.set(this.#owner, count - 1); else held.delete(this.#owner);
    const closing = [...this.#tunnels].map((tunnel) => { tunnel.close("The forward ended."); return tunnel.closed; });
    this.#onClose(this);
    void Promise.all(closing).then(() => this.#ended.resolve({ ...this.#stats }));
  }
}

/** A connection to `port` on localhost here, on 127.0.0.1 or else ::1, as many services listen on only one of them. */
async function dialLocal(port: number): Promise<net.Socket> {
  const deadline = Date.now() + CONNECT_MS;
  const codes: unknown[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const socket = net.connect({ host, port, allowHalfOpen: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), Math.max(0, deadline - Date.now()));
        socket.once("connect", () => { clearTimeout(timer); resolve(); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      return socket;
    } catch (error) {
      socket.destroy();
      if (Date.now() >= deadline) throw new Error(`port ${port} there did not answer within ${CONNECT_MS / 1000} seconds.`);
      codes.push((error as NodeJS.ErrnoException).code ?? errorMessage(error));
    }
  }
  if (codes[0] === "ECONNREFUSED") throw new Error(`nothing listens on port ${port} there. Start the service, then connect again.`);
  throw new Error(`port ${port} there cannot be reached (${codes.join(", ")}).`);
}

/**
 * The forwarding device's end of one connection: the device calls it with what the port sends,
 * and `closed` tells the forwarding device the device's socket closed.
 */
class ForwardEnd extends RpcTarget implements ForwardSink {
  #tunnel: Tunnel;
  #closed: (reason: string | undefined) => void;
  constructor(tunnel: Tunnel, closed: (reason: string | undefined) => void) {
    super();
    this.#tunnel = tunnel;
    this.#closed = closed;
  }
  data(data: Uint8Array) { return this.#tunnel.receive(data); }
  end() { this.#tunnel.ended(); }
  closed(reason?: string) { this.#closed(typeof reason === "string" ? reason : undefined); }
}

/** A connection to the port as the forwarding device holds it: a stub of the device's PortConnection. */
interface HeldConnection { write(data: Uint8Array): PromiseLike<unknown>; end(): unknown; [Symbol.dispose](): void }

/**
 * Carry `socket`, a connection to the forwarding device's port, through `forward`, the device's
 * forward: in `tunnels` until it closes. A connection that closed cleanly here waits for the
 * device to say its socket closed too; one that failed is dropped there at once. Rejects when
 * the device does not open the connection, which is then closed here.
 */
export async function carry(forward: { connect(sink: ForwardSink): PromiseLike<unknown> }, socket: net.Socket, flow: Flow, tunnels: Set<Tunnel>): Promise<void> {
  const tunnel = new Tunnel(socket, flow);
  let held: HeldConnection | undefined;
  let done = false;
  const release = () => { done = true; held?.[Symbol.dispose](); held = undefined; };
  const sink = new ForwardEnd(tunnel, (reason) => { if (reason !== undefined) tunnel.close(reason); release(); });
  tunnels.add(tunnel);
  void tunnel.closed.then((reason) => { tunnels.delete(tunnel); if (reason !== undefined) release(); });
  let opened: HeldConnection;
  try { opened = await forward.connect(sink) as HeldConnection; }
  catch (error) { tunnel.close("The device did not open the connection."); throw error; }
  if (done) { opened[Symbol.dispose](); return; }
  held = opened;
  tunnel.start({ send: (data) => opened.write(data), end: () => opened.end() });
}
