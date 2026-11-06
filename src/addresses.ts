import { isIP } from "node:net";
import os from "node:os";
import { endpointUrl } from "./options.js";

/** Whether a bind address means every interface. */
export function isUnspecified(bind: string): boolean { return bind === "0.0.0.0" || bind === "::" || bind === "[::]"; }

/**
 * The URLs other machines can use for a listener bound to `bind`: the bind address
 * itself, or for an unspecified one every non-internal address of this machine,
 * IPv4 first, without link-local IPv6.
 */
export function listeningAddresses(bind: string, port: number): string[] {
  if (!isUnspecified(bind)) return [endpointUrl(bind, port)];
  const entries = Object.values(os.networkInterfaces()).flat().filter((entry): entry is os.NetworkInterfaceInfo => !!entry && !entry.internal);
  const v4 = entries.filter((entry) => entry.family === "IPv4" || (entry.family as unknown) === 4).map((entry) => entry.address);
  const v6 = bind === "0.0.0.0" ? [] : entries.filter((entry) => (entry.family === "IPv6" || (entry.family as unknown) === 6) && !entry.address.startsWith("fe80")).map((entry) => entry.address.replace(/%.*$/, ""));
  return [...v4, ...v6].filter((address) => isIP(address)).map((address) => endpointUrl(address, port));
}
