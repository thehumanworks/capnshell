import { isPrivateAddress } from "./addresses.js";
import { isRelayAddress, redactRelay } from "./relay-hub.js";

/** What `cns doctor` with no argument found out about this device, gathered before judging it. */
export interface SelfFacts {
  /** This device's identity file: its fingerprint, absent, or why it cannot be read. */
  identity: { fingerprint: string; publicKey: string } | { missing: true } | { error: string };
  identityPath: string;
  /** The running daemon, or why there is none. */
  daemon:
    | { running: false; error?: string }
    | { running: true; pid: number; url: string; paired: boolean; identity?: { publicKey: string; fingerprint: string }; addresses: string[]; relay?: string; relayRegistered?: boolean };
  /** The relay a new daemon would use here (CNS_RELAY, else cns config relay), if any. */
  configuredRelay?: { url: string; source: "flag" | "env" | "config" };
  /** Why the saved settings could not be read, if they could not. */
  settingsError?: string;
  /** How many paired devices are saved. */
  paired: number;
}

export interface AddressCheck { address: string; relay: boolean; private: boolean; host: string }

export interface SelfReport {
  identity: { fingerprint: string; publicKey: string; path: string } | null;
  daemon: { pid: number; url: string; paired: boolean; matchesIdentity: boolean | null } | null;
  relay: { url: string; registered: boolean } | null;
  addresses: AddressCheck[];
  /** Whether a device on another network has an address here it could reach: a public direct address or a registered relay that is not private. */
  reachableBeyondNetwork: boolean;
  paired: number;
  /** Problems that stop paired devices from reaching this one. */
  problems: string[];
  /** Things that work, but maybe not the way the person expects. */
  warnings: string[];
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

/** Judge the facts: a report, the lines `cns doctor` prints, and its exit status. */
export function selfCheck(facts: SelfFacts): { report: SelfReport; lines: string[]; exitCode: number } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  let exitCode = 0;

  const found = facts.identity;
  const identity = "fingerprint" in found ? { ...found, path: facts.identityPath } : null;
  if (identity) lines.push(`Identity:  ${identity.fingerprint} (${identity.path})`);
  else if ("missing" in found) {
    lines.push(`Identity:  none at ${facts.identityPath}`);
    problems.push("This device has no identity yet, so nothing can pair with it. cns up creates one and starts the daemon.");
    exitCode = 5;
  } else {
    const reason = "error" in found ? found.error : "unknown";
    lines.push(`Identity:  unreadable (${reason})`);
    problems.push(`The identity file cannot be used: ${reason}`);
    exitCode = 5;
  }

  const daemon = facts.daemon;
  let reportDaemon: SelfReport["daemon"] = null;
  let relay: SelfReport["relay"] = null;
  let addresses: AddressCheck[] = [];
  if (!daemon.running) {
    lines.push(`Daemon:    not running${daemon.error ? ` (${daemon.error})` : ""}`);
    problems.push("No daemon runs here, so paired devices cannot reach this one and it keeps no standing links. Start it with cns up.");
    exitCode = 5;
  } else if (!daemon.paired) {
    reportDaemon = { pid: daemon.pid, url: daemon.url, paired: false, matchesIdentity: null };
    lines.push(`Daemon:    pid ${daemon.pid} at ${daemon.url}, legacy listener (not for paired devices)`);
    problems.push("The running daemon is a legacy listener that paired devices cannot use. Stop it with cns stop, then run cns up.");
    exitCode = 5;
  } else {
    const matches = identity && daemon.identity ? daemon.identity.publicKey === identity.publicKey : null;
    reportDaemon = { pid: daemon.pid, url: daemon.url, paired: true, matchesIdentity: matches };
    lines.push(`Daemon:    pid ${daemon.pid} at ${daemon.url}`);
    if (matches === false) {
      lines.push(`           runs as ${daemon.identity!.fingerprint}, not this device's identity`);
      problems.push("The daemon runs with a different identity than the file on disk, so paired devices see another device. Restart it with cns stop, then cns up.");
      exitCode = 3;
    }

    if (daemon.relay) {
      relay = { url: redactRelay(daemon.relay), registered: !!daemon.relayRegistered };
      lines.push(`Relay:     ${relay.url} (${relay.registered ? "registered" : "not registered"})`);
      if (!relay.registered) warnings.push("The daemon is not registered at its relay right now, so devices that need the relay cannot reach this one. It retries on its own; the daemon log says why it failed.");
    } else lines.push("Relay:     none");
    if (facts.configuredRelay && facts.configuredRelay.url !== daemon.relay) {
      const from = facts.configuredRelay.source === "env" ? "CNS_RELAY names" : facts.configuredRelay.source === "config" ? "cns config relay saved" : "--relay names";
      warnings.push(`${from} ${redactRelay(facts.configuredRelay.url)}, but the running daemon ${daemon.relay ? `uses ${redactRelay(daemon.relay)}` : "uses no relay"}. Run cns stop, then cns up, to use it.`);
    }

    addresses = daemon.addresses.map((address) => {
      const host = hostOf(address);
      return { address, relay: isRelayAddress(address), private: isPrivateAddress(host), host };
    });
    if (!addresses.length) {
      lines.push("Addresses: none");
      problems.push("The daemon advertises no address, so invites from this device name nothing to dial. Bind it to an interface with cns up --bind, or add a relay with --relay.");
      exitCode = exitCode || 5;
    } else {
      lines.push("Addresses:");
      for (const entry of addresses) lines.push(`  ${entry.address}${entry.relay ? " [relay]" : ""}: ${entry.private ? "private, this network only" : "reachable from other networks"}`);
    }
  }

  const reachableBeyondNetwork = addresses.some((entry) => !entry.private && (!entry.relay || relay?.registered));
  if (daemon.running && daemon.paired && addresses.length && !reachableBeyondNetwork) {
    warnings.push(relay
      ? "Every address here is private and the relay is not usable from other networks right now, so only devices on this network can reach this one."
      : "Every address here is private, so only devices on this network can reach this one. For devices elsewhere, save a relay with cns config relay URL and restart with cns stop, then cns up, or join both to an overlay network such as Tailscale.");
  }
  if (facts.settingsError) warnings.push(`The settings cannot be read, so cns up and other commands fail until they are fixed: ${facts.settingsError}`);
  lines.push(`Paired:    ${facts.paired} device${facts.paired === 1 ? "" : "s"}`);

  if (problems.length || warnings.length) lines.push("");
  for (const problem of problems) lines.push(`Problem: ${problem}`);
  for (const warning of warnings) lines.push(`Warning: ${warning}`);
  if (!problems.length) lines.push(warnings.length ? "Ready for paired devices, with the warnings above." : "Ready for paired devices.");

  return {
    report: { identity, daemon: reportDaemon, relay, addresses, reachableBeyondNetwork, paired: facts.paired, problems, warnings },
    lines,
    exitCode,
  };
}
