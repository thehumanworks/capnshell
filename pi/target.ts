import { peerFileExists } from "../src/peer-files.js";
import { getPeer } from "../src/peers.js";

/** The port the cns daemon listens on unless told otherwise. */
export const DEFAULT_PORT = 47381;

/**
 * Where the tools run: this machine, a device linked to this machine's daemon (by its ID,
 * as `cns attach` shows it), or a device paired with this one, reached directly.
 */
export type Target =
  | { kind: "local" }
  | { kind: "peer"; id: string }
  /** A device paired with this one (`cns pair`), reached by its saved addresses or the relay over an encrypted link. */
  | { kind: "paired"; name: string; publicKey: string; addresses: string[] };

/**
 * The paired device saved under `name`, if there is one. A name that is saved but cannot
 * be read is an error, so a broken record is fixed rather than silently skipped.
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
  return { kind: "paired", name, publicKey: entry.publicKey, addresses: entry.addresses };
}

/** Parse `local`, a daemon peer such as `p1`, or a paired device's name. */
export function parseTarget(text: string): Target {
  const value = text.trim();
  if (!value) throw new Error("Name a host: local, a paired device's name, or a peer such as p1.");
  if (value === "local") return { kind: "local" };
  if (/^p[1-9]\d*$/.test(value)) return { kind: "peer", id: value };
  const saved = savedPeer(value);
  if (saved) return saved;
  throw new Error(`No paired device is saved as ${value}. Pair with it first (cns pair); cns peers lists the paired devices.`);
}

/** How a target is named in messages: a peer ID or the paired device's name. */
export function targetLabel(target: Target): string {
  if (target.kind === "local") return "local";
  if (target.kind === "peer") return target.id;
  return target.name;
}
