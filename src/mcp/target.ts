import { connectControl } from "../commands/daemon.js";
import type { PeerController } from "../console.js";
import { openDeviceLink } from "../device-link.js";
import { fingerprint, loadIdentity } from "../identity.js";
import type { ShellApi } from "../shell.js";
import { plain, type RemoteNamedPty } from "../terminal.js";

/** The file calls the file tools make, which the `files` grant covers on a paired device. */
export type PeerFiles = Pick<ShellApi, "stat" | "readdir" | "mkdir" | "glob" | "readFile" | "writeFile">;

/** The controller calls the tools make; terminals need a local TTY and are left out. */
export type ToolController = Pick<PeerController, "peers" | "run" | "ptySessions" | "startPtySession" | "ptySession"> & {
  /** The peer's files, for the length of one call: closing the link releases them. */
  files(id: string): Promise<PeerFiles>;
};

/** One connection, opened for one tool call. Closing it ends the call's remote work. */
export interface Link {
  controller: ToolController;
  /** The ID of the peer to use: `requested`, else the only one connected. */
  peer(requested: string | undefined): Promise<string>;
  /** Set once the connection has broken, unless close() broke it. */
  readonly lost: boolean;
  close(): void;
}

/** Where the tools' peers are: one paired device, or the devices linked to the local daemon. */
export interface McpTarget {
  /** For messages, such as the paired device's name. */
  readonly label: string;
  /** This device's name for the paired device the tools reach, when there is one. */
  readonly device?: string;
  /** The working directory for commands and sessions that do not name one. */
  readonly cwd?: string;
  open(signal: AbortSignal): Promise<Link>;
}

/** The ID the one paired device of a `cns mcp DEVICE` server has. */
export const DEVICE_PEER = "p1";
/** Tool calls in progress at once; each holds a connection. */
export const MAX_CALLS = 16;

/** Refuse calls beyond MAX_CALLS, so a busy client cannot exhaust a device's connection slots. */
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
 * Reach one paired device for each call as `cns run` does: over the local daemon's standing
 * link to it when there is one, else a new encrypted connection. Closing a call's connection
 * makes the device kill its commands and end its waits.
 */
export function pairedTarget(expect: { name: string; publicKey: string; addresses: string[] }, cwd?: string): McpTarget {
  return {
    label: expect.name,
    device: expect.name,
    cwd,
    open: limitCalls(async (signal) => {
      // Prove this device's identity and require the saved one on the other end.
      const identity = loadIdentity();
      if (!identity) throw new Error("This device has no identity yet; run cns identity or cns up first.");
      // The local daemon's standing link to the device, lent for this call, or else an encrypted
      // channel to it at the first saved address, or the relay, that answers as it.
      const link = await openDeviceLink(expect, identity, signal);
      const { remote, via } = link;
      let closed = false;
      let lost = false;
      remote.onRpcBroken(() => { if (!closed) lost = true; });
      const controller: ToolController = {
        async peers() {
          return [{ id: DEVICE_PEER, info: await plain(remote.info()), peer: { name: expect.name, fingerprint: fingerprint(expect.publicKey), daemon: false, via } }];
        },
        async run(_id, command, options) { return await plain(remote.run(command, options)); },
        async ptySessions() { return await plain(remote.ptySessions()); },
        async startPtySession(_id, name, options) {
          using session = await remote.startPtySession(name, options);
          return await plain(session.info());
        },
        async ptySession(_id, name) { return await remote.ptySession(name) as unknown as RemoteNamedPty; },
        async files() { return remote as unknown as PeerFiles; },
      };
      return {
        controller,
        get lost() { return lost; },
        async peer(requested) {
          if (requested !== undefined && requested !== DEVICE_PEER && requested !== expect.name) {
            throw new Error(`Unknown peer ${requested}. This server reaches one paired device, ${expect.name}, as peer ${DEVICE_PEER}.`);
          }
          return DEVICE_PEER;
        },
        close() {
          if (closed) return;
          closed = true;
          remote[Symbol.dispose]();
          link.close("MCP call ended");
        },
      };
    }),
  };
}

/**
 * Explain a call the local daemon does not offer: it was started by an older cns, which
 * keeps running after cns is upgraded until the daemon restarts.
 */
function olderDaemon(error: unknown, statePath: string | undefined): unknown {
  if (!(error instanceof TypeError) || !/^'\w+' is not a function\.$/.test(error.message)) return error;
  const state = statePath === undefined ? "" : ` --state ${statePath}`;
  return new Error(
    `The local daemon runs an older cns than this one and does not offer file access. Restart it with cns stop${state}, then cns up${state}; ` +
    "if it runs as a service and cns has moved, as an upgrade can do, run cns up --install instead.",
    { cause: error },
  );
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
          throw new Error(`No local daemon is running. Start it with cns up${state}.`, { cause: error });
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
      const forks: { [Symbol.dispose](): void }[] = [];
      return {
        controller: {
          ...connection.controller,
          async files(id) {
            // The peer's own file calls, which a paired device allows with the files grant alone.
            const files = await remote.files(id).catch((error: unknown) => { throw olderDaemon(error, statePath); });
            forks.push(files);
            return files as unknown as PeerFiles;
          },
          // Closing the connection, as cancelling the call does, kills the command.
          async run(id, command, options) {
            return await plain(remote.runWhileConnected(id, command, options));
          },
        },
        get lost() { return lost; },
        async peer(requested) {
          const connected = await connection.controller.peers();
          const ids = connected.map((peer) => peer.id);
          if (requested !== undefined) {
            if (ids.includes(requested)) return requested;
            // A paired device's name selects its standing link to the daemon; a command's one-off connection offers nothing.
            const named = connected.find((peer) => peer.peer?.name === requested && peer.peer.daemon);
            if (named) return named.id;
            throw new Error(`Unknown peer ${requested}. ${ids.length ? `Connected peers: ${ids.join(", ")}.` : "No peers are connected to the daemon."}`);
          }
          if (ids.length === 1) return ids[0]!;
          throw new Error(ids.length ? `Several peers are connected (${ids.join(", ")}); pass peer to choose one.` : "No peers are connected to the daemon.");
        },
        close() {
          if (closed) return;
          closed = true;
          for (const fork of forks.splice(0)) fork[Symbol.dispose]();
          connection.close();
        },
      };
    }),
  };
}
