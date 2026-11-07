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

/**
 * Whether an IP address is only reachable on its own network: loopback, link-local,
 * RFC 1918 IPv4 or IPv6 unique-local. Hostnames and the CGNAT range (overlay networks
 * such as Tailscale use it across networks) count as reachable.
 */
export function isPrivateAddress(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const version = isIP(unwrapped);
  if (version === 4) {
    const [a = 0, b = 0] = unwrapped.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (version === 6) {
    const lower = unwrapped.toLowerCase();
    return lower === "::1" || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  return false;
}

/** Whether every one of these ws:// or wss:// URLs names a private address, so a device on another network can reach none of them. */
export function allPrivate(urls: readonly string[]): boolean {
  if (!urls.length) return true;
  return urls.every((url) => { try { return isPrivateAddress(new URL(url).hostname); } catch { return false; } });
}
