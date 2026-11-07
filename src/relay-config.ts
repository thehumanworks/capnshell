import { relayEndpoint } from "./relay-hub.js";

/**
 * The relay built into cns. Every paired daemon registers there and every device dials
 * paired devices there after their direct addresses, so devices on different networks
 * reach each other with nothing to set up. See docs/adr/0001-built-in-relay.md.
 */
export const DEFAULT_RELAY = "wss://cns.nothuman.work/relay";

/**
 * The relay this device uses. CNS_RELAY replaces it for development and tests only: a
 * relay URL, such as a local `wrangler dev`, or `off` for none. It is not a setting for
 * users, and a relay it names must still accept the cns client key.
 */
export function builtInRelay(): string | undefined {
  const override = process.env.CNS_RELAY;
  if (override === "off") return undefined;
  if (!override) return DEFAULT_RELAY;
  try { relayEndpoint(override, "accept", "A".repeat(43)); }
  catch (error) { throw new Error(`CNS_RELAY must be a relay URL or off: ${(error as Error).message}`, { cause: error }); }
  return override;
}
