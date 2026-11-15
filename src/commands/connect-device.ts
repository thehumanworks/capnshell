import type { RpcStub } from "capnweb";
import { z } from "zod";
import { AuthError } from "../auth.js";
import { errorMessage } from "../errors.js";
import { ensureIdentity } from "../identity.js";
import type { ExpectedPeer } from "../options.js";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import type { ShellApi, ShellInfo } from "../shell.js";
import { reportedVersion } from "../version.js";

/** What a peer's handshake must report about it. */
export const infoSchema = z.object({
  platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
  name: z.string().max(128), shell: z.enum(["PowerShell", "Bash"]),
  hostname: z.string().max(256), cwd: z.string().max(32768), pid: z.int().positive(),
  // Older releases send none. A value that is not a version is dropped rather than refused, so it cannot break a link.
  version: z.unknown().optional().transform((value) => reportedVersion(value)),
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
  let link: DeviceLink;
  try {
    // The local daemon's standing link when it has one; else, like any one command's connection,
    // one that only uses the other device and offers nothing back.
    link = await openDeviceLink(expect, identity, signal);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new Error(`Cannot connect to ${expect.name}: ${errorMessage(error)}`, { cause: error });
  }
  const { remote } = link;
  const close = () => {
    remote[Symbol.dispose]();
    link.close("Command ended");
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
