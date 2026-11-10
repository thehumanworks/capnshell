import type { RpcStub } from "capnweb";
import { connectControl, type ControlConnection } from "./commands/daemon.js";
import type { Identity } from "./identity.js";
import { RefusingShell } from "./refusing-shell.js";
import { builtInRelay } from "./relay-config.js";
import { dialAddresses, isRelayAddress } from "./relay-hub.js";
import { connectFirst, rpcSession } from "./secure.js";
import type { ShellApi } from "./shell.js";

/** How long a command waits for the local daemon to lend it a link before dialing the device itself. */
export const LEND_MS = 3000;

/**
 * One command's connection to a paired device: the local daemon's standing link to it,
 * lent for the command, or an encrypted connection the command dialed itself.
 */
export interface DeviceLink {
  /** The device's shell, which it lets this device use as far as it granted. */
  remote: RpcStub<ShellApi>;
  /** Whether the connection reaches the device directly or through the relay. */
  via: "direct" | "relay";
  /** Whether this is the local daemon's standing link, lent to the command. */
  lent: boolean;
  /** Where the connection goes, for messages. */
  address: string;
  /** Resolves with the reason once the connection has ended, however it ended. */
  done: Promise<string>;
  /** Whether the connection is still up. */
  readonly open: boolean;
  /** End the connection. The device then ends the commands and handles this connection started. */
  close(reason?: string): void;
}

type Device = { name: string; publicKey: string; addresses: readonly string[] };

/**
 * Reach a paired device for one command. When the local daemon has a standing link to it,
 * use that: nothing is dialed, which matters most for a device that cannot be dialed at
 * all, such as one in WSL, whose host drops inbound connections while its daemon's
 * outbound link works. Otherwise dial it at its saved addresses, then the relay.
 */
export async function openDeviceLink(device: Device, identity: Identity, signal: AbortSignal): Promise<DeviceLink> {
  const lent = await borrow(device, identity, signal);
  if (lent) return lent;
  signal.throwIfAborted();
  const { channel, url } = await connectFirst(dialAddresses(device, builtInRelay()), identity, { expect: device.publicKey, signal });
  // One command's own connection only uses the other device and offers it nothing.
  const remote = rpcSession<ShellApi>(channel, new RefusingShell());
  return {
    remote,
    via: isRelayAddress(url) ? "relay" : "direct",
    lent: false,
    address: new URL(url).host,
    done: channel.done,
    get open() { return channel.open; },
    close: (reason = "Command ended") => channel.close(reason),
  };
}

/**
 * Borrow the local daemon's standing link to `device`, or undefined when there is no daemon
 * at the default state path, it runs as another identity, it has no link to the device, it
 * is too old to lend one, or it does not answer within LEND_MS. The local control connection
 * stays open for the command: closing it is what ends the command's work on the device.
 */
async function borrow(device: Device, identity: Identity, signal: AbortSignal): Promise<DeviceLink | undefined> {
  signal.throwIfAborted();
  let connection: ControlConnection;
  try { connection = await connectControl(undefined, LEND_MS); }
  catch { return undefined; }
  let closed = false;
  let broken = false;
  // Registered first, so a daemon that hangs up at once is still noticed.
  const done = new Promise<string>((resolve) => {
    connection.remote.onRpcBroken(() => {
      broken = true;
      resolve(closed ? "Command ended" : `The local daemon's link to ${device.name} ended.`);
    });
  });
  let answer: Awaited<ReturnType<ControlConnection["remote"]["lend"]>>;
  const timer = setTimeout(() => connection.close(), LEND_MS);
  const cancel = () => connection.close();
  signal.addEventListener("abort", cancel, { once: true });
  try { answer = await connection.remote.lend(device.publicKey); }
  catch {
    // Most often a daemon older than this cns, which has no lend; or it gave up meanwhile.
    connection.close();
    signal.throwIfAborted();
    return undefined;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
  if (!answer || answer.identity !== identity.publicKey || broken) {
    answer?.shell[Symbol.dispose]();
    connection.close();
    return undefined;
  }
  const remote = answer.shell as unknown as RpcStub<ShellApi>;
  return {
    remote,
    via: answer.via,
    lent: true,
    address: "the local daemon",
    done,
    get open() { return !closed && !broken; },
    close() {
      if (closed) return;
      closed = true;
      connection.close();
    },
  };
}
