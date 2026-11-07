import { errorMessage } from "../errors.js";
import { isLoopback } from "../options.js";
import { redactRelay } from "../relay-hub.js";
import { checkRelayUrl, configuredRelay, loadSettings, saveSettings, settingsPath, type RelaySource } from "../settings.js";
import { connectControl } from "./daemon.js";

export interface ConfigRelayOptions { unset?: boolean; json?: boolean; state?: string }

const sources: Record<RelaySource, string> = { flag: "--relay", env: "CNS_RELAY", config: "cns config" };

/** What the running daemon here uses as its relay; undefined when no paired daemon answers. */
async function daemonRelay(state?: string): Promise<{ relay: string | null } | undefined> {
  let control;
  try { control = await connectControl(state); } catch { return undefined; }
  try {
    const status = await control.remote.status();
    return status.paired ? { relay: status.relay ?? null } : undefined;
  } catch { return undefined; } finally { control.close(); }
}

/** Tell the person when the running daemon uses another relay than the one now in effect. */
async function noteDaemon(effective: string | undefined, state?: string): Promise<void> {
  const daemon = await daemonRelay(state);
  if (!daemon || (daemon.relay ?? undefined) === effective) return;
  console.error(`The running daemon ${daemon.relay ? `uses the relay ${redactRelay(daemon.relay)}` : "uses no relay"}; run cns stop, then cns up, to ${effective ? "use the new one" : "stop using it"}.`);
}

/** `cns config relay [URL]`: show, save or remove the relay this device uses. */
export async function configRelay(url: string | undefined, options: ConfigRelayOptions): Promise<void> {
  if (url !== undefined && options.unset) throw new Error("Use either a relay URL or --unset, not both.");
  if (url !== undefined) {
    try { checkRelayUrl(url); } catch (error) { throw new Error(`Not a relay URL: ${errorMessage(error)}`, { cause: error }); }
    const parsed = new URL(url);
    if ((parsed.protocol === "ws:" || parsed.protocol === "http:") && !isLoopback(parsed.hostname)) console.error("The relay URL is ws://, so the relay token and registration travel unencrypted; links themselves stay encrypted. Use wss:// for a relay beyond this machine.");
    saveSettings({ ...loadSettings(), relay: url });
    console.log(`Saved the relay ${redactRelay(url)} in ${settingsPath()}.`);
    if (process.env.CNS_RELAY && process.env.CNS_RELAY !== url) console.error(`CNS_RELAY is set and takes precedence: ${redactRelay(process.env.CNS_RELAY)}.`);
    await noteDaemon(configuredRelay()?.url, options.state);
    return;
  }
  if (options.unset) {
    const { relay: _relay, ...rest } = loadSettings();
    saveSettings(rest);
    console.log("Removed the saved relay.");
    if (process.env.CNS_RELAY) console.error(`CNS_RELAY is still set: ${redactRelay(process.env.CNS_RELAY)}.`);
    await noteDaemon(configuredRelay()?.url, options.state);
    return;
  }
  const relay = configuredRelay();
  if (options.json) {
    console.log(JSON.stringify({ relay: relay ? redactRelay(relay.url) : null, source: relay?.source ?? null, saved: loadSettings().relay ? redactRelay(loadSettings().relay!) : null }, null, 2));
    return;
  }
  if (!relay) { console.log("No relay set. Save one with cns config relay wss://RELAY/?token=TOKEN."); return; }
  console.log(`${redactRelay(relay.url)} (from ${sources[relay.source]})`);
}
