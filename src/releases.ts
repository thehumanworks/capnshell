import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configDirectory } from "./config.js";
import { errorMessage, printable } from "./errors.js";

/**
 * The latest cns release: what GitHub names it, and what this device last learned of it, which
 * cns peers trusts for a day. Kept out of version.ts, which the gateway Worker bundles.
 */

const LATEST_RELEASE = "https://api.github.com/repos/thehumanworks/capnshell/releases/latest";
/** How long cns peers goes by what it last learned, or failed to learn, before asking again. */
const KEEP_MS = 24 * 60 * 60_000;
const cacheFile = () => path.join(configDirectory(), "latest-release.json");

/**
 * A release's version as cns puts it on other devices' command lines: three numbers and two dots,
 * nothing that Bash, PowerShell or cmd reads as anything else. Prereleases are not taken.
 */
export function releaseVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : undefined;
}

/**
 * The latest release's version, from GitHub, which this device then remembers; throws with the
 * reason when there is none to be had, as offline, and remembers that it asked. CNS_RELEASES
 * replaces the URL for development and tests, or, set to off, turns the check off.
 */
export async function latestRelease(timeoutMs = 10_000): Promise<string> {
  const url = process.env.CNS_RELEASES || LATEST_RELEASE;
  if (url === "off") throw new Error("CNS_RELEASES is off");
  let version: string | undefined;
  try {
    let tag: unknown;
    try {
      const response = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "cns" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      tag = ((await response.json()) as { tag_name?: unknown } | null)?.tag_name;
    } catch (error) { throw new Error(`cannot ask GitHub: ${errorMessage(error)}`, { cause: error }); }
    version = releaseVersion(typeof tag === "string" ? tag.replace(/^v/, "") : undefined);
    if (!version) throw new Error(`the latest release is not named vX.Y.Z: ${printable(String(tag)).slice(0, 40)}`);
    return version;
  } finally { remember(version); }
}

/** Keep what GitHub said, or that it did not answer, privately; a device that cannot write it asks again next time. */
function remember(version: string | undefined): void {
  const file = cacheFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...version ? { version } : {}, checkedAt: Date.now() })}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch { /* The configuration directory is missing or read-only. */ }
}

/**
 * The latest release for cns peers: what this device learned within the last day, else what
 * GitHub says within `timeoutMs`. Undefined when that is not known, so cns peers never waits on
 * an unreachable GitHub more than once a day.
 */
export async function knownLatestRelease(timeoutMs = 2000): Promise<string | undefined> {
  if (process.env.CNS_RELEASES === "off") return undefined;
  try {
    const saved = JSON.parse(readFileSync(cacheFile(), "utf8")) as { version?: unknown; checkedAt?: unknown };
    const age = Date.now() - Number(saved.checkedAt);
    if (age >= 0 && age < KEEP_MS) return releaseVersion(saved.version);
  } catch { /* Never asked, or not readable: ask now. */ }
  try { return await latestRelease(timeoutMs); } catch { return undefined; }
}
