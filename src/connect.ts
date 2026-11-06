import type { RpcStub } from "capnweb";
import type { ShellApi } from "./shell.js";

/** Wait this long for a listener to accept the socket. */
export const CONNECT_MS = 10_000;

/** Wait for a socket to open, giving up on abort or after CONNECT_MS. */
export function openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => fail(new Error(`Timed out connecting to ${url}.`)), CONNECT_MS);
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = () => fail(new Error(`Cannot connect to ${url}. Check that the listener is running and reachable.`));
    const onAbort = () => fail(signal.reason);
    function cleanup() {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(error: unknown) {
      cleanup();
      terminateSocket(socket);
      reject(error);
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

/** Drop a socket at once. Node's WebSocket, which Pi may run on, has no terminate(). */
export function terminateSocket(socket: WebSocket) {
  if (typeof socket.terminate === "function") socket.terminate();
  else socket.close();
}

/**
 * A close reason that fits a WebSocket close frame: at most 123 bytes of UTF-8, cut
 * at a whole character. Only a bounded prefix is examined, so a huge reason costs
 * no more than a short one.
 */
export function closeReason(reason: string): string {
  const characters = Array.from(String(reason).slice(0, 123));
  while (Buffer.byteLength(characters.join("")) > 123) characters.pop();
  return characters.join("");
}

/**
 * Close a socket politely, then forcibly if the peer does not answer. Clients may only
 * send 1000 or 4000-4999, so another code is sent as 4000 plus its last three digits.
 */
export function closeSocket(socket: WebSocket, reason = "Connection ended", code = 1000) {
  if (socket.readyState === WebSocket.CLOSED) return;
  try { socket.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000 + (code % 1000), closeReason(reason)); }
  catch { terminateSocket(socket); return; }
  const timer = setTimeout(() => terminateSocket(socket), 750);
  timer.unref();
  socket.addEventListener("close", () => clearTimeout(timer), { once: true });
}

/** A fork of a peer's shell, or undefined when the peer's cns predates ShellApi.fork. */
export async function forkShell(remote: RpcStub<ShellApi>): Promise<RpcStub<ShellApi> | undefined> {
  try {
    return await remote.fork() as RpcStub<ShellApi>;
  } catch (error) {
    if (error instanceof TypeError && error.message === "'fork' is not a function.") return undefined;
    throw error;
  }
}
