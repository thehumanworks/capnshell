import manifest from "../package.json" with { type: "json" };

/** This cns's version, from package.json. */
export const CNS_VERSION: string = manifest.version;

/** What a version another device or process reports must look like to be shown: 1.4.0, or 1.4.0-rc.1. */
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.+-]{1,40})?$/;

/** A version another device or process reported, if it is one. Anything else is dropped rather than shown. */
export function reportedVersion(value: unknown): string | undefined {
  return typeof value === "string" && VERSION_PATTERN.test(value) ? value : undefined;
}

/** Order two versions by major, minor and patch: negative when `a` is older than `b`. Suffixes such as -rc.1 are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[-+]/, 1)[0]!.split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * How another cns compares with this one: `same`, `older`, `newer`, or `unknown` for a cns too old
 * to report its version, which is older than any that does.
 */
export type VersionOrder = "same" | "older" | "newer" | "unknown";

export function versionOrder(other: string | undefined, own = CNS_VERSION): VersionOrder {
  if (other === undefined) return "unknown";
  const order = compareVersions(other, own);
  return order < 0 ? "older" : order > 0 ? "newer" : "same";
}

/** A version for people: `cns 1.4.0`, or what is known about one that was not reported. */
export function describeVersion(version: string | undefined): string {
  return version === undefined ? "a cns too old to report its version" : `cns ${version}`;
}

/** What the running daemon says about itself, for comparing it with this cns. */
export interface DaemonBuild {
  /** Absent for a daemon too old to report it. */
  version?: string;
  /** The executable it runs, or the script for one run from source. */
  executable?: string;
}

/** How to get the daemon onto this cns's version, from restartAdvice. */
export interface DriftFacts {
  daemon: DaemonBuild;
  /** This cns: its version and executable. */
  self: { version: string; executable: string };
  /** What to run so the daemon runs this cns; see restartAdvice. */
  advice: string;
  /** For a newer daemon: the command that shows which cns a shell runs. */
  which: string;
}

/**
 * A warning when the running daemon is not this cns's version, saying what that means and what to
 * run; undefined when it is the same version. A daemon keeps the executable it started with, so an
 * upgrade only reaches paired devices and commands that go through the daemon once it restarts.
 */
export function daemonDrift(facts: DriftFacts): string | undefined {
  const version = reportedVersion(facts.daemon.version);
  const order = versionOrder(version, facts.self.version);
  if (order === "same") return undefined;
  const running = `${describeVersion(version)}${facts.daemon.executable ? ` (${facts.daemon.executable})` : ""}`;
  if (order === "newer") {
    return `The daemon runs ${running}, newer than this cns ${facts.self.version} (${facts.self.executable}). ` +
      `An older cns may come first on PATH: ${facts.which} shows which one a shell runs.`;
  }
  return `The daemon runs ${running}, but this cns is ${facts.self.version} (${facts.self.executable}), ` +
    `so paired devices and commands that use the daemon get the older one. ${facts.advice}`;
}

/** What is known about how the daemon is run, for restartAdvice. */
export interface RestartFacts {
  /** The daemon runs under a service manager (`cns daemon --service`); undefined for a daemon too old to say. */
  service?: boolean;
  /** The service `cns up --install` or Home Manager installed for this daemon's state file, if there is one. */
  installed?: {
    kind: "launchd" | "systemd";
    /** Its file is a link into the Nix store: Home Manager owns it, so cns must not rewrite it. */
    managedByNix: boolean;
    /** It runs this cns's executable. */
    runsThis: boolean;
  };
  platform: NodeJS.Platform;
}

/** Restarting a daemon ends the named sessions it holds, which nothing brings back. */
const SESSIONS_END = "Restarting ends the named sessions it holds.";

/** What to run so that the daemon runs this cns: restart it, reinstall its service, or update the configuration that owns it. */
export function restartAdvice(facts: RestartFacts): string {
  const { installed } = facts;
  if (installed?.managedByNix) {
    const check = installed.kind === "systemd" ? " If it still runs the old one afterwards, systemctl --user cat cns shows what overrides it." : "";
    return installed.runsThis
      ? `Home Manager's service already names this cns; restart it: cns stop, then cns up. ${SESSIONS_END}${check}`
      : `Home Manager owns its service: switch to a configuration with this cns (home-manager switch), which restarts it. ${SESSIONS_END}${check}`;
  }
  if (installed) {
    return installed.runsThis
      ? `Restart it: cns stop, then cns up. ${SESSIONS_END}`
      : `Its service runs another executable: run cns up --install with this cns, which points the service here and restarts it. ${SESSIONS_END}`;
  }
  if (facts.service) {
    const example = facts.platform === "linux" ? ", such as sudo systemctl restart cns for the NixOS module" : "";
    return `A service manager cns did not install runs it: update cns there and restart it${example}. ${SESSIONS_END}`;
  }
  if (facts.service === undefined) return `Restart it: cns stop, then cns up, or restart the service that runs it. ${SESSIONS_END}`;
  return `Restart it: cns stop, then cns up. ${SESSIONS_END}`;
}
