import { isIP } from "node:net";
import { peerFileExists } from "../src/aliases.js";
import { getPeer } from "../src/peers.js";

/** The port `cns listen` uses unless told otherwise. */
export const DEFAULT_PORT = 47381;

/**
 * Where the tools run: this machine, a peer connected to this machine's daemon
 * (by its ID, as `cns attach` shows it), or a cns listener reached directly.
 */
export type Target =
  | { kind: "local" }
  | { kind: "peer"; id: string }
  | { kind: "url"; url: string }
  /** A device paired with this one (`cns pair`), reached by its saved addresses over an encrypted link. */
  | { kind: "paired"; name: string; publicKey: string; addresses: string[] };

/**
 * The saved peer under `name`, if there is one: a paired device, or an address alias's
 * URL. A name that is saved but cannot be read is an error, never a hostname: Pi would
 * otherwise send its commands to whatever answers to that name, unauthenticated.
 */
function savedPeer(name: string): Target | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) return undefined;
  let saved: boolean;
  try { saved = peerFileExists(name); } catch { saved = false; } // Saved peers are unavailable here, as on Windows.
  if (!saved) return undefined;
  let entry: ReturnType<typeof getPeer>;
  try { entry = getPeer(name); }
  catch (error) { throw new Error(`The saved peer ${name} cannot be read (${error instanceof Error ? error.message : String(error)}); fix or remove it with cns peer remove ${name}.`); }
  if (!entry) return undefined;
  if (entry.kind === "address") return { kind: "url", url: entry.url };
  return { kind: "paired", name, publicKey: entry.publicKey, addresses: entry.addresses };
}

/** The port for `host` without one: CNS_PORT, as `cns run` uses, else the default. */
function defaultPort(env: NodeJS.ProcessEnv): number {
  const port = Number(env.CNS_PORT);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
}

/**
 * Parse `local`, a daemon peer such as `p1`, a `ws://` or `wss://` URL, or a
 * listener's `host[:port]` (IPv6 in brackets, or bare without a port).
 */
export function parseTarget(text: string, env: NodeJS.ProcessEnv = process.env): Target {
  const value = text.trim();
  if (!value) throw new Error("Name a host: local, a peer such as p1, host[:port] or a ws:// URL.");
  if (value === "local") return { kind: "local" };
  if (/^p[1-9]\d*$/.test(value)) return { kind: "peer", id: value };
  // A saved peer's name comes before reading the word as a hostname.
  const saved = savedPeer(value);
  if (saved) {
    if (saved.kind === "paired" && !saved.addresses.length) throw new Error(`Paired device ${value} has no saved address. Add one with cns peer address ${value} ws://HOST:PORT.`);
    return saved;
  }
  if (/^wss?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || url.hash) {
      throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
    }
    return { kind: "url", url: url.href };
  }
  if (/[/\s@]/.test(value)) throw new Error(`Not a host: ${value}. Use host[:port] or a ws:// URL.`);
  // A bare IPv6 address has several colons and no port.
  const authority = isIP(value) === 6 ? `[${value}]` : value;
  const url = new URL(`ws://${authority}`);
  if (!url.hostname) throw new Error(`Not a host: ${value}.`);
  if (!url.port) url.port = String(defaultPort(env));
  return { kind: "url", url: url.href };
}

/** How a target is named in messages: a peer ID, or the listener's host and port. */
export function targetLabel(target: Target): string {
  if (target.kind === "local") return "local";
  if (target.kind === "peer") return target.id;
  if (target.kind === "paired") return target.name;
  const url = new URL(target.url);
  return url.protocol === "ws:" ? url.host : url.href.replace(/\/$/, "");
}
