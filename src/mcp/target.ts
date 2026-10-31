import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { connectControl } from "../commands/daemon.js";
import type { PeerController } from "../console.js";
import { localShellInfo, type ShellApi, type ShellInfo } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";

/** The controller calls the tools make; terminals need a local TTY and are left out. */
export type ToolController = Pick<PeerController, "peers" | "run" | "ptySessions" | "startPtySession" | "ptySession">;

/** One connection, opened for one tool call. Closing it ends the call's remote work. */
export interface Link {
  controller: ToolController;
  /** The ID of the peer to use: `requested`, else the only one connected. */
  peer(requested: string | undefined): Promise<string>;
  /** Set once the connection has broken, unless close() broke it. */
  readonly lost: boolean;
  close(): void;
}

/** Where the tools' peers are: one listener, or the local daemon's connected peers. */
export interface McpTarget {
  /** For messages, such as the listener's URL. */
  readonly label: string;
  /** The working directory for commands and sessions that do not name one. */
  readonly cwd?: string;
  open(signal: AbortSignal): Promise<Link>;
}

/** The ID a listener has in this server, as in the console of `cns connect`. */
export const LISTENER_PEER = "p1";
/** Tool calls in progress at once; each holds a connection. */
export const MAX_CALLS = 16;
const CONNECT_MS = 10_000;

/** Wait for a socket to open, giving up on abort or after CONNECT_MS. */
function openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
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
      socket.terminate();
      reject(error);
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

/** Close a socket politely, then forcibly if the peer does not answer. */
function closeSocket(socket: WebSocket) {
  socket.close(1000, "MCP call ended");
  const timer = setTimeout(() => socket.terminate(), 750);
  timer.unref();
  socket.addEventListener("close", () => clearTimeout(timer), { once: true });
}

const refusal = "This peer is a cns MCP server; it does not run commands for other peers.";

/**
 * What this server offers a listener in return. The listener's handshake reads
 * info(), but agents' calls must not give the listener a shell on this machine.
 */
class RefusingShell extends RpcTarget {
  info(): ShellInfo { return localShellInfo(); }
  run(): never { throw new Error(refusal); }
  openPty(): never { throw new Error(refusal); }
  startPtySession(): never { throw new Error(refusal); }
  ptySession(): never { throw new Error(refusal); }
  ptySessions(): never { throw new Error(refusal); }
  fork(): never { throw new Error(refusal); }
}

/** Refuse calls beyond MAX_CALLS, so a busy client cannot exhaust a listener's peer slots. */
function limitCalls(open: (signal: AbortSignal) => Promise<Link>): (signal: AbortSignal) => Promise<Link> {
  let active = 0;
  return async (signal) => {
    if (active >= MAX_CALLS) throw new Error(`Too many tool calls in progress (${MAX_CALLS}); wait for some to finish.`);
    active++;
    let link: Link;
    try { link = await open(signal); }
    catch (error) {
      active--;
      throw error;
    }
    let counted = true;
    return {
      controller: link.controller,
      peer: (requested) => link.peer(requested),
      get lost() { return link.lost; },
      close() {
        if (counted) {
          counted = false;
          active--;
        }
        link.close();
      },
    };
  };
}

/**
 * Reach the listener at `url`, on a new connection for each call as `cns run`
 * does. Closing a call's connection makes the listener kill its commands and
 * end its waits.
 */
export function listenerTarget(url: string, cwd?: string): McpTarget {
  return {
    label: url,
    cwd,
    open: limitCalls(async (signal) => {
      const socket = await openSocket(url, signal);
      const remote = newWebSocketRpcSession<ShellApi>(socket, new RefusingShell());
      let closed = false;
      let lost = false;
      remote.onRpcBroken(() => { if (!closed) lost = true; });
      const controller: ToolController = {
        async peers() { return [{ id: LISTENER_PEER, info: await plain(remote.info()) }]; },
        async run(_id, command, options) { return await plain(remote.run(command, options)); },
        async ptySessions() { return await plain(remote.ptySessions()); },
        async startPtySession(_id, name, options) {
          using session = await remote.startPtySession(name, options);
          return await plain(session.info());
        },
        async ptySession(_id, name) { return await remote.ptySession(name) as unknown as RemoteNamedPty; },
      };
      return {
        controller,
        get lost() { return lost; },
        async peer(requested) {
          if (requested !== undefined && requested !== LISTENER_PEER) {
            throw new Error(`Unknown peer ${requested}. This server reaches one listener, ${url}, as peer ${LISTENER_PEER}.`);
          }
          return LISTENER_PEER;
        },
        close() {
          if (closed) return;
          closed = true;
          remote[Symbol.dispose]();
          closeSocket(socket);
        },
      };
    }),
  };
}

/**
 * Reach the peers connected to the local daemon. Each call reads the daemon's
 * state afresh, so a restarted daemon is found again. Closing a call's control
 * connection makes the daemon kill its commands and end its waits.
 */
export function daemonTarget(statePath?: string, cwd?: string): McpTarget {
  return {
    label: "the local daemon",
    cwd,
    open: limitCalls(async (signal) => {
      signal.throwIfAborted();
      const connection = await connectControl(statePath).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          const state = statePath === undefined ? "" : ` --state ${statePath}`;
          throw new Error(`No local daemon is running. Start one with cns listen --daemon${state}.`, { cause: error });
        }
        throw error;
      });
      if (signal.aborted) {
        connection.close();
        throw signal.reason;
      }
      let closed = false;
      let lost = false;
      connection.remote.onRpcBroken(() => { if (!closed) lost = true; });
      const { remote } = connection;
      return {
        controller: {
          ...connection.controller,
          // Closing the connection, as cancelling the call does, kills the command.
          async run(id, command, options) {
            try {
              return await plain(remote.runWhileConnected(id, command, options));
            } catch (error) {
              // A daemon started by an older cns can only run commands until they end.
              if (!(error instanceof TypeError && error.message === "'runWhileConnected' is not a function.")) throw error;
              return await plain(remote.run(id, command, options));
            }
          },
        },
        get lost() { return lost; },
        async peer(requested) {
          const ids = (await connection.controller.peers()).map((peer) => peer.id);
          if (requested !== undefined) {
            if (ids.includes(requested)) return requested;
            throw new Error(`Unknown peer ${requested}. ${ids.length ? `Connected peers: ${ids.join(", ")}.` : "No peers are connected to the daemon."}`);
          }
          if (ids.length === 1) return ids[0]!;
          throw new Error(ids.length ? `Several peers are connected (${ids.join(", ")}); pass peer to choose one.` : "No peers are connected to the daemon.");
        },
        close() {
          if (closed) return;
          closed = true;
          connection.close();
        },
      };
    }),
  };
}
