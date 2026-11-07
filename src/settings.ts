import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { checkConfigDirectory, configDirectory, isPrivateFile, requirePrivateStateSupport } from "./config.js";
import { relayEndpoint } from "./relay-hub.js";

/**
 * This device's settings, set with `cns config`: today only the relay. The file is
 * private, like the identity, because a relay URL may carry its token.
 */
const settingsSchema = z.strictObject({
  version: z.literal(1),
  relay: z.string().min(1).optional(),
});
export type Settings = Omit<z.infer<typeof settingsSchema>, "version">;

export function settingsPath(): string { return path.join(configDirectory(), "settings.json"); }

/** Refuse a relay URL that cns could not register or dial at. */
export function checkRelayUrl(url: string): void { relayEndpoint(url, "accept", "A".repeat(43)); }

/** The saved settings; empty when there is no file. The file must be private and valid. */
export function loadSettings(): Settings {
  requirePrivateStateSupport("Settings");
  const file = settingsPath();
  let fd: number;
  try { checkConfigDirectory(); fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    if (!isPrivateFile(fstatSync(fd))) throw new Error(`Settings must be a private file owned by your user: ${file}`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(fd, "utf8")); } catch { throw new Error(`Settings are not valid JSON: ${file}`); }
    const settings = settingsSchema.safeParse(parsed);
    if (!settings.success) throw new Error(`Settings are not valid: ${file}`);
    const { version: _version, ...rest } = settings.data;
    return rest;
  } finally { closeSync(fd); }
}

/** Replace the settings. They go to a private temporary file renamed over the old one, so a crash leaves either version whole. */
export function saveSettings(settings: Settings): void {
  requirePrivateStateSupport("Settings");
  if (settings.relay !== undefined) checkRelayUrl(settings.relay);
  const directory = checkConfigDirectory(true);
  const content = JSON.stringify(settingsSchema.parse({ version: 1, ...settings }), null, 2) + "\n";
  const temporary = path.join(directory, `.settings.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, settingsPath());
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Where this device's relay setting comes from. */
export type RelaySource = "flag" | "env" | "config";

/**
 * This device's relay: `--relay` when given, else CNS_RELAY, else `cns config relay`.
 * Undefined when none is set. Settings that cannot be read are an error, not "no relay".
 */
export function configuredRelay(flag?: string): { url: string; source: RelaySource } | undefined {
  if (flag) return { url: flag, source: "flag" };
  if (process.env.CNS_RELAY) return { url: process.env.CNS_RELAY, source: "env" };
  if (process.platform === "win32") return undefined;
  const relay = loadSettings().relay;
  return relay ? { url: relay, source: "config" } : undefined;
}
