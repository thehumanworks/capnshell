import { isIP } from "node:net";

/** The port `cns listen` uses unless told otherwise. */
export const DEFAULT_PORT = 47381;

/**
 * Where the tools run: this machine, a peer connected to this machine's daemon
 * (by its ID, as `cns attach` shows it), or a cns listener reached directly.
 */
export type Target =
  | { kind: "local" }
  | { kind: "peer"; id: string }
  | { kind: "url"; url: string };

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
  const url = new URL(target.url);
  return url.protocol === "ws:" ? url.host : url.href.replace(/\/$/, "");
}
