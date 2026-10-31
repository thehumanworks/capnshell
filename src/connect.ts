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

/** Close a socket politely, then forcibly if the peer does not answer. */
export function closeSocket(socket: WebSocket, reason = "Connection ended") {
  socket.close(1000, reason);
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
