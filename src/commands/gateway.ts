import readline from "node:readline";
import { describeGrants, expandGrants } from "../peers.js";
import { loadIdentity } from "../identity.js";
import { INVITE_PREFIX } from "../pairing.js";
import { OWNER_HEADER, ownerProof } from "../owner-proof.js";
import { TOOL_NAMES, type ToolName } from "../mcp/server.js";

/**
 * `cns gateway`: administer the gateway (gateway/), the MCP server Claude's connectors use to
 * reach devices paired with it. Every request is signed with this device's identity, which
 * the gateway accepts when this device is one of its owners (its OWNER_KEYS).
 */

/** The gateway these commands talk to, unless CNS_GATEWAY or --url names another. */
export const DEFAULT_GATEWAY = "https://gateway.cns.nothuman.work";

/** What `--tools read` approves: tools that look, and change nothing. */
export const READ_TOOLS: readonly ToolName[] = ["list_peers", "read_file", "list_directory", "glob", "list_sessions", "read_screen"];

export interface GatewayOptions { url?: string; json?: boolean }

function gatewayUrl(options: GatewayOptions): string {
  const value = options.url ?? process.env.CNS_GATEWAY ?? DEFAULT_GATEWAY;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`The gateway address must be a URL such as ${DEFAULT_GATEWAY}.`); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The gateway address must use https:// (http:// only for localhost, in development).");
  return url.origin;
}

/** One signed owner request; returns the gateway's answer or throws its error. */
async function call<T>(options: GatewayOptions, action: string, input: Record<string, unknown> = {}): Promise<T> {
  const identity = loadIdentity();
  if (!identity) throw new Error("This device has no identity yet; run cns identity, then add its public key to the gateway's OWNER_KEYS.");
  const url = `${gatewayUrl(options)}/admin/${action}`;
  const body = new TextEncoder().encode(JSON.stringify(input));
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", [OWNER_HEADER]: ownerProof(identity, "POST", url, body) }, body });
  } catch (error) {
    throw new Error(`Cannot reach the gateway at ${gatewayUrl(options)}: ${(error as Error).message}`, { cause: error });
  }
  const text = await response.text();
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { throw new Error(`The gateway answered ${response.status}: ${text.slice(0, 200)}`); }
  if (!response.ok) {
    const message = (answer as { error?: string }).error ?? `The gateway answered ${response.status}.`;
    if (response.status === 401) throw new Error(`${message} This device's public key is ${identity.publicKey}.`);
    throw new Error(message);
  }
  return answer as T;
}

function print(options: GatewayOptions, value: unknown, text: () => string) {
  console.log(options.json ? JSON.stringify(value, null, 2) : text());
}

interface Device { name: string; fingerprint: string; granted: string[]; pairedAt: string }
interface Consent { code: string; clientName: string; clientDomain: string | null; redirectHost: string; loopback: boolean; expiresAt: number; status: string; devices: string[]; tools: string[] }
interface Grant { id: string; client: string; devices: string[]; tools: string[]; createdAt: number; expiresAt?: number }

const when = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const toolsText = (tools: readonly string[]) => tools.length === TOOL_NAMES.length ? "all tools" : tools.join(", ");

export async function status(options: GatewayOptions): Promise<void> {
  const answer = await call<{ fingerprint: string; name: string; relay: string; devices: Device[]; pending: Consent[]; grants: Grant[]; owner: string }>(options, "status");
  print(options, answer, () => [
    `Gateway:    ${gatewayUrl(options)} (${answer.name}, fingerprint ${answer.fingerprint})`,
    `Owner:      this device, ${answer.owner}`,
    `Relay:      ${answer.relay}`,
    `Devices:    ${answer.devices.length ? "" : "none; pair one with cns gateway pair"}`,
    ...answer.devices.map((device) => `  ${device.name}  ${device.fingerprint}  may use: ${describeGrants(expandGrants(device.granted))}`),
    `Connectors: ${answer.grants.length ? "" : "none"}`,
    ...answer.grants.map((grant) => `  ${grant.id.slice(0, 8)}  ${grant.client}  devices: ${grant.devices.join(", ")}  ${toolsText(grant.tools)}`),
    ...answer.pending.length ? ["Waiting for approval:", ...answer.pending.map((consent) => `  ${consent.code}  ${consent.clientName} (access goes to ${consent.redirectHost})`)] : [],
  ].join("\n"));
}

/** `cns gateway pair CODE` (or INVITE): resolve a pairing code here, then hand the gateway the invite behind it. */
export async function pair(typed: string | readonly string[], options: GatewayOptions & { name?: string; request?: string }): Promise<void> {
  const parts = typeof typed === "string" ? [typed] : [...typed];
  const requests = options.request === undefined ? undefined : expandGrants(options.request.split(","));
  // The gateway is dialed through the relay either way; the code exchange runs on this device, so the gateway changes nothing.
  let invite: string;
  if (parts.length === 1 && parts[0]!.startsWith(INVITE_PREFIX)) invite = parts[0]!;
  else {
    const { inviteFromCode } = await import("./pairing-cli.js");
    try { invite = await inviteFromCode(parts); }
    catch (error) { process.exitCode = 3; throw error; }
  }
  if (!options.json) console.error("The gateway is pairing; confirm on the device that showed the code, after checking the gateway's fingerprint (cns gateway status).");
  const answer = await call<{ paired: boolean; reason?: string; name?: string; fingerprint?: string; granted?: string[] }>(options, "pair", { invite, ...options.name ? { name: options.name } : {}, ...requests ? { requests } : {} });
  if (!answer.paired) { process.exitCode = 3; print(options, answer, () => `Not paired: ${answer.reason}`); return; }
  print(options, answer, () => `The gateway paired with ${answer.name} (${answer.fingerprint}). It may use there: ${describeGrants(expandGrants(answer.granted ?? []))}.`);
}

export async function remove(name: string, options: GatewayOptions): Promise<void> {
  const answer = await call<{ removed: boolean }>(options, "remove", { name });
  if (!answer.removed) throw new Error(`The gateway has no device named ${name}.`);
  print(options, answer, () => `The gateway forgot ${name}; no connector reaches it now. To end the pairing on ${name} too, run there: cns peer remove gateway`);
}

function parseTools(value: string | undefined): ToolName[] {
  if (value === undefined || value === "all") return [...TOOL_NAMES];
  if (value === "read") return [...READ_TOOLS];
  const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
  for (const tool of tools) if (!(TOOL_NAMES as readonly string[]).includes(tool)) throw new Error(`Unknown tool ${tool}. Tools: ${TOOL_NAMES.join(", ")}; or all, or read.`);
  return tools as ToolName[];
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("Confirm at a terminal, or pass --yes after checking the details above.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally { rl.close(); }
}

export async function approve(code: string, options: GatewayOptions & { devices?: string; tools?: string; yes?: boolean }): Promise<void> {
  const tools = parseTools(options.tools);
  const devices = options.devices === undefined || options.devices === "all" ? "all" : options.devices.split(",").map((name) => name.trim()).filter(Boolean);
  const { consent } = await call<{ consent: Consent | null }>(options, "consent", { code });
  if (!consent || consent.status !== "pending") throw new Error(`No connector is waiting with code ${code}. Codes last ten minutes; connect again from Claude.`);
  const { devices: paired } = await call<{ devices: Device[] }>(options, "status");
  const chosen = devices === "all" ? paired.map((device) => device.name) : devices;
  console.error([
    `${consent.clientName} wants to use devices through the gateway.`,
    consent.clientDomain ? `  Published by:    ${consent.clientDomain}` : "  Its name is not verified: it registered itself.",
    `  Access goes to:  ${consent.redirectHost}${consent.loopback ? "  (an app on that computer: approve only if you just connected from it)" : ""}`,
    `  Devices:         ${chosen.join(", ") || "none"}`,
    `  Tools:           ${toolsText(tools)}`,
    "Check that the code and the app match the page you opened; approve only connections you started.",
  ].join("\n"));
  if (!options.yes && !(await confirm("Approve it?"))) {
    await call(options, "deny", { code });
    console.log("Declined.");
    process.exitCode = 3;
    return;
  }
  const answer = await call<{ consent: Consent }>(options, "approve", { code, devices, tools });
  print(options, answer, () => `Approved ${consent.clientName} for ${chosen.join(", ")}. The page you opened returns to it now.`);
}

export async function deny(code: string, options: GatewayOptions): Promise<void> {
  const answer = await call<{ consent: Consent }>(options, "deny", { code });
  print(options, answer, () => `Declined ${answer.consent.clientName}.`);
}

export async function grants(options: GatewayOptions): Promise<void> {
  const answer = await call<{ grants: Grant[] }>(options, "grants");
  print(options, answer.grants, () => answer.grants.length
    ? answer.grants.map((grant) => `${grant.id.slice(0, 8)}  ${grant.client}  devices: ${grant.devices.join(", ")}  ${toolsText(grant.tools)}  since ${when(grant.createdAt)}${grant.expiresAt ? `  until ${when(grant.expiresAt)}` : ""}`).join("\n")
    : "No connectors are approved.");
}

export async function revoke(id: string, options: GatewayOptions): Promise<void> {
  const answer = await call<{ revoked: { id: string; client: string | null } }>(options, "revoke", { id });
  print(options, answer, () => `Revoked ${answer.revoked.client ?? answer.revoked.id}: its tokens and requests stop working now.`);
}

export async function log(options: GatewayOptions & { limit?: string }): Promise<void> {
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit takes 1 to 1000.");
  const { entries } = await call<{ entries: { at: string; grant: string; client: string; tool: string; peer: string | null; detail: string; ok: boolean; elapsedMs: number }[] }>(options, "log", { limit });
  print(options, entries, () => entries.length
    ? entries.map((entry) => `${entry.at.slice(0, 19).replace("T", " ")}  ${entry.client}  ${entry.peer ?? "-"}  ${entry.tool}${entry.ok ? "" : " (failed)"}  ${entry.detail}`).join("\n")
    : "Nothing yet.");
}
