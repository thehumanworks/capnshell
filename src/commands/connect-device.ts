import type { RpcStub } from "capnweb";
import { z } from "zod";
import { AuthError } from "../auth.js";
import { errorMessage } from "../errors.js";
import { ensureIdentity } from "../identity.js";
import type { ExpectedPeer } from "../options.js";
import { RefusingShell } from "../refusing-shell.js";
import { builtInRelay } from "../relay-config.js";
import { dialAddresses } from "../relay-hub.js";
import { connectFirst, rpcSession } from "../secure.js";
import type { ShellApi, ShellInfo } from "../shell.js";

/** What a peer's handshake must report about it. */
export const infoSchema = z.object({
  platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
  name: z.string().max(128), shell: z.enum(["PowerShell", "Bash"]),
  hostname: z.string().max(256), cwd: z.string().max(32768), pid: z.int().positive(),
});

/** One more encrypted connection, to a paired device, for a command that uses two: cns cp DEVICE:PATH OTHER:PATH. */
export interface DeviceConnection {
  remote: RpcStub<ShellApi>;
  info: ShellInfo;
  close(): void;
}

/** Connect to `expect` at the first of its addresses, or the relay, that answers as it, and read its handshake. */
export async function connectDevice(expect: ExpectedPeer, signal: AbortSignal): Promise<DeviceConnection> {
  const { identity } = ensureIdentity();
  let connected: Awaited<ReturnType<typeof connectFirst>>;
  try {
    connected = await connectFirst(dialAddresses(expect, builtInRelay()), identity, { expect: expect.publicKey, signal });
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new Error(`Cannot connect to ${expect.name}: ${errorMessage(error)}`, { cause: error });
  }
  const { channel } = connected;
  // Like any one command's connection, it only uses the other device and offers nothing back.
  const remote = rpcSession<ShellApi>(channel, new RefusingShell());
  const close = () => {
    remote[Symbol.dispose]();
    channel.close("Command ended");
  };
  try {
    const reported = await remote.info();
    let info: ShellInfo;
    try { info = infoSchema.parse(reported); } finally { reported[Symbol.dispose]?.(); }
    return { remote, info, close };
  } catch (error) {
    close();
    throw error;
  }
}
