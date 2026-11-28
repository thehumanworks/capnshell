import net from "node:net";
import type { RpcStub } from "capnweb";
import { AuthError } from "../auth.js";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { errorMessage, strictlyPrintable } from "../errors.js";
import { carry, CONNECT_MS, Flow, MAX_FORWARD_CONNECTIONS, portSchema, type PortForward, type Tunnel } from "../forward.js";
import { ensureIdentity } from "../identity.js";
import { allowHint, resolvePeer } from "../peers.js";
import { secureReady } from "../secure.js";
import { RETRY_MAX_MS, RETRY_MIN_MS } from "../shell-recovery.js";
import type { ShellApi } from "../shell.js";

/** Say `message` on stderr, as cns forward says everything: it can hold the device's words. */
export const say = (message: string) => { process.stderr.write(`cns: ${strictlyPrintable(message)}\n`); };

/** A failure that ends cns forward, with its exit status. */
export class Final extends Error {
  constructor(message: string, readonly code: number) { super(message); }
}

/** A port operand or option: a number from 1 to 65535. */
function portOf(value: string, what: string): number {
  const port = portSchema.safeParse(/^\d+$/.test(value) ? Number(value) : NaN);
  if (!port.success) throw new Error(`${what} is a port number from 1 to 65535, not ${value}.`);
  return port.data;
}

/**
 * What a failure to reach the forward means, or undefined when it is worth trying again:
 * `first` when nothing was forwarded yet. The device's own words go through strictlyPrintable.
 */
export function forwardFailure(error: unknown, device: string, port: number, first: boolean): Final | undefined {
  if (error instanceof Final) return error;
  const message = errorMessage(error);
  if (error instanceof AuthError && (error.code === "not-paired" || error.code === "identity-changed" || error.code === "invalid-proof")) {
    return new Final(`${device} ${first ? "does not accept" : "no longer accepts"} this device (${message}).`, 3);
  }
  if (/^Permission denied/.test(message)) {
    return new Final(`${device} ${first ? "does not let" : "no longer lets"} this device reach port ${port}. ${allowHint(message, device) ?? message}`, 4);
  }
  if (/^'forward' is not a function/.test(message)) return new Final(`${device} runs a cns from before cns forward; update it: cns upgrade ${device}`, 1);
  return undefined;
}

/** Ask the device for a forward to `port` over `remote`, its shell. */
export async function openForward(remote: RpcStub<ShellApi>, device: string, port: number, first: boolean): Promise<RpcStub<PortForward>> {
  try { return await remote.forward(port) as unknown as RpcStub<PortForward>; }
  catch (error) {
    throw forwardFailure(error, device, port, first) ?? new Error(`${device}: ${errorMessage(error)}`, { cause: error });
  }
}

/** The local port to suggest in place of one that cannot be used. */
const another = (port: number) => port + 10000 <= 65535 ? port + 10000 : port - 10000;

/** Listen on 127.0.0.1 only, at `local`. */
export function listen(local: number, device: string, port: number): Promise<net.Server> {
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      const instead = `Pick another: cns forward ${device} ${port} --local ${another(local)}`;
      if (error.code === "EADDRINUSE") reject(new Error(`Port ${local} is in use on this device. ${instead}`));
      else if (error.code === "EACCES" || error.code === "EPERM") reject(new Error(`This device does not let cns listen on port ${local}: ports below 1024 need administrator rights on Linux, and Windows reserves some ranges. ${instead}`));
      else reject(new Error(`Cannot listen on 127.0.0.1:${local}: ${errorMessage(error)}`));
    });
    server.listen({ host: "127.0.0.1", port: local }, () => resolve(server));
  });
}

/** One link to the device and the forward on it, with the connections it carries. */
interface Linked { link: DeviceLink; handle: RpcStub<PortForward>; flow: Flow; tunnels: Set<Tunnel>; via: string }

/**
 * `cns forward DEVICE PORT [--local LOCALPORT]`: listen on 127.0.0.1:LOCALPORT here, and carry
 * each TCP connection to localhost:PORT on the paired device, over the local daemon's link to
 * it, else one of this command's own (openDeviceLink). When the link is lost, its connections
 * close and the listener stays: it reconnects with cns shell's backoff, and a new connection
 * waits up to CONNECT_MS for it. Returns the exit status: 3 when the device no longer accepts
 * this one, 4 when it no longer lets it reach the port, 1 for another failure, and 130, 143 or
 * 129 after Ctrl-C or another signal stopped it.
 */
export async function forward(name: string, portText: string, options: { local?: string }): Promise<number> {
  const port = portOf(portText, "PORT");
  const local = options.local === undefined ? port : portOf(options.local, "--local");
  resolvePeer(name);
  const { identity } = ensureIdentity();
  await secureReady();
  const finished = Promise.withResolvers<undefined>();
  const stopping = new AbortController();
  let code: number | undefined;
  /** End the forward with `exit`, saying why when there is a message. */
  const finish = (exit: number, message?: string) => {
    if (code !== undefined) return;
    if (message) say(message);
    code = exit;
    stopping.abort();
    finished.resolve(undefined);
  };
  const signals = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  const handlers = Object.entries(signals).map(([signal, exit]) => {
    const handler = () => finish(exit);
    // A platform that lacks one of these signals never sends it.
    try { process.once(signal, handler); } catch {}
    return [signal, handler] as const;
  });
  let linked: Linked | undefined;
  /** New connections waiting for a link. */
  const waiting = new Set<() => void>();
  let open = 0;
  const server = await listen(local, name, port).catch((error: unknown) => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    throw error;
  });

  /** Wait for a link, up to CONNECT_MS, unless the connection closes first. */
  const linkFor = (socket: net.Socket) => new Promise<Linked | undefined>((resolve) => {
    if (linked || code !== undefined) return resolve(linked);
    const done = () => { clearTimeout(timer); waiting.delete(done); socket.off("close", done); resolve(code === undefined ? linked : undefined); };
    const timer = setTimeout(done, CONNECT_MS);
    waiting.add(done);
    socket.once("close", done);
  });

  /** Carry one local connection to the port on the device. */
  async function accepted(socket: net.Socket) {
    // A reset shows as the connection closing.
    socket.on("error", () => {});
    if (open >= MAX_FORWARD_CONNECTIONS) {
      socket.destroy();
      say(`refused a connection to 127.0.0.1:${local}: ${MAX_FORWARD_CONNECTIONS} connections are open through this forward already, as many as it carries.`);
      return;
    }
    open++;
    socket.once("close", () => { open--; });
    const at = await linkFor(socket);
    if (!at) {
      if (!socket.destroyed && code === undefined) say(`closed a new connection: the link to ${name} did not come back within ${CONNECT_MS / 1000} seconds.`);
      socket.destroy();
      return;
    }
    try { await carry(at.handle, socket, at.flow, at.tunnels); }
    catch (error) {
      // A connection that a lost link took is reported with the link.
      if (at !== linked || !at.link.open) return;
      const final = forwardFailure(error, name, port, false);
      if (final) finish(final.code, final.message);
      else say(`${name}: ${errorMessage(error)}`);
    }
  }
  server.on("connection", (socket: net.Socket) => { void accepted(socket); });

  const end = (at: Linked, why: string) => {
    for (const tunnel of at.tunnels) tunnel.close(why);
    at.handle[Symbol.dispose]();
    at.link.remote[Symbol.dispose]();
    at.link.close("Forward ended");
  };
  /** One link to the device and a forward on it. */
  async function reach(first: boolean): Promise<Linked> {
    // Read again each time: a device unpaired or removed here meanwhile is not reached.
    let device: ReturnType<typeof resolvePeer>;
    try { device = resolvePeer(name); } catch (error) { throw new Final(errorMessage(error), 3); }
    let link: DeviceLink;
    try { link = await openDeviceLink(device, identity, stopping.signal); }
    catch (error) { throw error instanceof AuthError ? error : new Error(`Cannot connect to ${name}: ${errorMessage(error)}`, { cause: error }); }
    try {
      const handle = await openForward(link.remote, name, port, first);
      const via = link.lent ? `this device's daemon (${link.via === "relay" ? "through the relay" : "directly"})` : link.via === "relay" ? "the relay" : "a direct link";
      return { link, handle, flow: new Flow(), tunnels: new Set(), via };
    } catch (error) { link.remote[Symbol.dispose](); link.close("Forward refused"); throw error; }
  }
  try {
    let first = true;
    let wait = RETRY_MIN_MS;
    for (;;) {
      if (code !== undefined) return code;
      let next: Linked | undefined;
      const reaching = reach(first);
      try { next = await Promise.race([reaching, finished.promise]); }
      catch (error) {
        if (code !== undefined) return code;
        const final = forwardFailure(error, name, port, first);
        if (final) { finish(final.code, final.message); return final.code; }
        // Nothing was forwarded yet: say what failed, in words that may be the device's, and stop.
        if (first) { finish(1, errorMessage(error)); return 1; }
        await Promise.race([new Promise((resolve) => setTimeout(resolve, wait)), finished.promise]);
        wait = Math.min(RETRY_MAX_MS, wait * 2);
        continue;
      }
      // Stopped while reaching the device: a link that comes later ends at once.
      if (!next) { void reaching.then((late) => end(late, "Forward ended"), () => {}); return code!; }
      linked = next;
      wait = RETRY_MIN_MS;
      say(first ? `forwarding 127.0.0.1:${local} to localhost:${port} on ${name}, via ${next.via} (Ctrl-C stops)` : `reconnected to ${name} via ${next.via}`);
      first = false;
      for (const wake of [...waiting]) wake();
      await Promise.race([next.link.done, finished.promise]);
      linked = undefined;
      const lost = next.tunnels.size;
      end(next, "The link to the device was lost.");
      if (code !== undefined) return code;
      say(`the link to ${name} was lost; ${lost} connection${lost === 1 ? "" : "s"} closed; reconnecting (Ctrl-C stops)`);
    }
  } finally {
    code ??= 1;
    if (linked) end(linked, "Forward ended");
    for (const wake of [...waiting]) wake();
    server.close();
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
