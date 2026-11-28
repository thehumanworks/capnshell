import readline from "node:readline";
import { describeGrants, expandGrants } from "../peers.js";
import { loadIdentity } from "../identity.js";
import { INVITE_PREFIX } from "../pairing.js";
import { OWNER_HEADER, ownerProof } from "../owner-proof.js";
import { TOOL_NAMES, type ToolName } from "../mcp/server.js";
import { CNS_VERSION, describeVersion, reportedVersion, versionOrder } from "../version.js";

/**
 * `cns gateway`: administer the gateway (gateway/), the MCP server Claude's connectors use to
 * reach devices paired with it. Every request is signed with this device's identity, which
 * the gateway accepts when this device is one of its owners (its OWNER_KEYS).
 */

/** The gateway these commands talk to, unless CNS_GATEWAY or --url names another. */
export const DEFAULT_GATEWAY = "https://gateway.cns.nothuman.work";

/** What `--tools read` approves: tools that look, and change nothing. */
export const READ_TOOLS: readonly ToolName[] = ["list_peers", "read_file", "list_directory", "glob", "list_sessions", "read_screen", "list_skills", "read_skill", "search_skills"];

export interface GatewayOptions { url?: string; json?: boolean }

export function gatewayUrl(options: GatewayOptions): string {
  const value = options.url ?? process.env.CNS_GATEWAY ?? DEFAULT_GATEWAY;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`The gateway address must be a URL such as ${DEFAULT_GATEWAY}.`); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The gateway address must use https:// (http:// only for localhost, in development).");
  return url.origin;
}

/**
 * A request the gateway refused, with its HTTP status (401 when this device is not one of its
 * owners) and the error it gave, `said`; or no answer at all, with neither.
 */
export class GatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly said?: string, options?: ErrorOptions) { super(message, options); }
}

/** One signed owner request; returns the gateway's answer or throws its error. */
export async function call<T>(options: GatewayOptions, action: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const identity = loadIdentity();
  if (!identity) throw new Error("This device has no identity yet; run cns identity, then add its public key to the gateway's OWNER_KEYS.");
  const url = `${gatewayUrl(options)}/admin/${action}`;
  const body = new TextEncoder().encode(JSON.stringify(input));
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", [OWNER_HEADER]: ownerProof(identity, "POST", url, body) }, body, signal });
    text = await response.text();
  } catch (error) {
    throw new GatewayError(`Cannot reach the gateway at ${gatewayUrl(options)}: ${(error as Error).message}`, undefined, undefined, { cause: error });
  }
  let answer: unknown;
  try { answer = JSON.parse(text); } catch { throw new Error(`The gateway answered ${response.status} and said: ${JSON.stringify(text.slice(0, 200))}`); }
  if (!response.ok) {
    const said = (answer as { error?: unknown } | null)?.error;
    const message = typeof said === "string" ? said : `The gateway answered ${response.status}.`;
    throw new GatewayError(response.status === 401 ? `${message} This device's public key is ${identity.publicKey}.` : message, response.status, typeof said === "string" ? said.slice(0, 200) : undefined);
  }
  return answer as T;
}

function print(options: GatewayOptions, value: unknown, text: () => string) {
  console.log(options.json ? JSON.stringify(value, null, 2) : text());
}

interface Device { name: string; fingerprint: string; granted: string[]; pairedAt: string }
interface Consent { code: string; clientName: string; clientDomain: string | null; redirectHost: string; loopback: boolean; expiresAt: number; status: string; devices: string[] | "all"; tools: string[] }
interface Grant { id: string; client: string; devices: string[]; tools: string[]; createdAt: number; expiresAt?: number }

interface GatewayMesh { name: string; admin: string; version: number; members: string[] }
/** `meshes` is absent from a gateway deployed before 2.6.0. */
export interface GatewayStatus { fingerprint: string; name: string; relay: string; devices: Device[]; meshes?: GatewayMesh[]; pending: Consent[]; grants: Grant[]; owner: string; version?: unknown; tools?: unknown }

/**
 * What the gateway was deployed from: its cns version and the tools it can grant. A gateway
 * deployed from before cns 2.3.1 gives neither in its status; from 1.4.0 on, its root page
 * shows the version.
 */
export interface GatewayBuild { version?: string; tools?: readonly string[] }

async function gatewayBuild(options: GatewayOptions, status: GatewayStatus): Promise<GatewayBuild> {
  const tools = Array.isArray(status.tools) && status.tools.every((tool) => typeof tool === "string") ? status.tools as string[] : undefined;
  let version = reportedVersion(status.version);
  if (version === undefined) {
    try {
      const root = await fetch(`${gatewayUrl(options)}/`, { signal: AbortSignal.timeout(5000) });
      version = reportedVersion(/^cns gateway (\S+)/.exec(await root.text())?.[1]);
    } catch { /* Unknown, as for a gateway too old to say. */ }
  }
  return { ...version === undefined ? {} : { version }, ...tools ? { tools } : {} };
}

/** The tools of this cns that the gateway lacks; none known for a gateway that does not list its tools. */
const lacking = (build: GatewayBuild) => build.tools ? TOOL_NAMES.filter((tool) => !build.tools!.includes(tool)) : [];

/** What to tell an owner when the gateway runs another cns than this one, or nothing when it runs this one. */
export function gatewayDrift(build: GatewayBuild): string | undefined {
  const order = versionOrder(build.version);
  if (order === "same" && !lacking(build).length) return undefined;
  if (order === "newer") return `The gateway runs cns ${build.version}, newer than this cns (${CNS_VERSION}); upgrade cns here to approve its newer tools by name.`;
  const missing = lacking(build);
  const runs = order === "same" ? `The gateway runs cns ${CNS_VERSION}` : `The gateway runs ${describeVersion(build.version)}, not this cns's ${CNS_VERSION}`;
  const what = missing.length ? `, so it cannot grant ${missing.join(", ")}` : ", so it may lack tools this cns has";
  return `${runs}${what}. Redeploy it from this release: cd gateway && npx wrangler deploy (gateway/README.md).`;
}

const when = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
const toolsText = (tools: readonly string[]) => tools.length === TOOL_NAMES.length ? "all tools" : tools.join(", ");

export async function status(options: GatewayOptions): Promise<void> {
  const answer = await call<GatewayStatus>(options, "status");
  const build = await gatewayBuild(options, answer);
  const drift = gatewayDrift(build);
  print(options, { ...answer, ...build }, () => [
    `Gateway:    ${gatewayUrl(options)} (${answer.name}, fingerprint ${answer.fingerprint})`,
    `Version:    ${describeVersion(build.version)}${drift ? `\n  ${drift}` : ""}`,
    `Owner:      this device, ${answer.owner}`,
    `Relay:      ${answer.relay}`,
    `Devices:    ${answer.devices.length ? "" : "none; pair one with cns gateway pair"}`,
    ...answer.devices.map((device) => `  ${device.name}  ${device.fingerprint}  may use: ${describeGrants(expandGrants(device.granted))}`),
    ...answer.meshes?.length ? ["Meshes:     reached by connectors approved for all devices", ...answer.meshes.map((mesh) => `  ${mesh.name}  run by ${mesh.admin}, version ${mesh.version}: ${mesh.members.join(", ") || "no other members"}`)] : [],
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
  const answer = await call<{ paired: boolean; reason?: string; name?: string; fingerprint?: string; granted?: string[]; reachedBy?: string[] }>(options, "pair", { invite, ...options.name ? { name: options.name } : {}, ...requests ? { requests } : {} });
  if (!answer.paired) { process.exitCode = 3; print(options, answer, () => `Not paired: ${answer.reason}`); return; }
  // A gateway from before 2.4.0 sends no reachedBy: its connectors reach only the devices they were approved for.
  const reached = answer.reachedBy?.length ? `\nConnectors approved for all devices reach it now: ${answer.reachedBy.join(", ")}. Revoke one with cns gateway revoke ID.` : "";
  print(options, answer, () => `The gateway paired with ${answer.name} (${answer.fingerprint}). It may use there: ${describeGrants(expandGrants(answer.granted ?? []))}.${reached}`);
}

export async function remove(name: string, options: GatewayOptions): Promise<void> {
  const answer = await call<{ removed: boolean }>(options, "remove", { name });
  if (!answer.removed) throw new Error(`The gateway has no device named ${name}.`);
  print(options, answer, () => `The gateway forgot ${name}; no connector reaches it now. To end the pairing on ${name} too, run there: cns peer remove gateway`);
}

/**
 * The tools an approval asks for, from --tools: undefined for all of them, which the gateway
 * expands to every tool it has, so a cns on another version than the gateway still approves.
 * Named tools must be ones the gateway has, when it lists them; `read` keeps those it has.
 */
export function chooseTools(value: string | undefined, build: GatewayBuild): { tools?: ToolName[]; dropped: string[] } {
  if (value === undefined || value === "all") return { dropped: [] };
  const offered = build.tools ?? TOOL_NAMES;
  if (value === "read") return { tools: READ_TOOLS.filter((tool) => offered.includes(tool)), dropped: READ_TOOLS.filter((tool) => !offered.includes(tool)) };
  const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
  for (const tool of tools) {
    if (offered.includes(tool)) continue;
    if ((TOOL_NAMES as readonly string[]).includes(tool)) throw new Error(`The gateway has no tool ${tool}. ${gatewayDrift(build) ?? ""}`.trim());
    throw new Error(`Unknown tool ${tool}. Tools: ${offered.join(", ")}; or all, or read.`);
  }
  return { tools: tools as ToolName[], dropped: [] };
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
  const devices = options.devices === undefined || options.devices === "all" ? "all" : options.devices.split(",").map((name) => name.trim()).filter(Boolean);
  const { consent } = await call<{ consent: Consent | null }>(options, "consent", { code });
  if (!consent || consent.status !== "pending") throw new Error(`No connector is waiting with code ${code}. Codes last ten minutes; connect again from Claude.`);
  const status = await call<GatewayStatus>(options, "status");
  const build = await gatewayBuild(options, status);
  const { tools, dropped } = chooseTools(options.tools, build);
  const drift = gatewayDrift(build);
  const chosen = devices === "all" ? status.devices.map((device) => device.name) : devices;
  console.error([
    `${consent.clientName} wants to use devices through the gateway.`,
    consent.clientDomain ? `  Published by:    ${consent.clientDomain}` : "  Its name is not verified: it registered itself.",
    `  Access goes to:  ${consent.redirectHost}${consent.loopback ? "  (an app on that computer: approve only if you just connected from it)" : ""}`,
    `  Devices:         ${devices === "all" ? `all, including devices paired with the gateway later (now: ${chosen.join(", ") || "none"})` : chosen.join(", ")}`,
    `  Tools:           ${tools ? toolsText(tools) : build.tools ? `all ${build.tools.length} the gateway has` : "all the gateway has"}${dropped.length ? ` (not ${dropped.join(", ")}: the gateway lacks them)` : ""}`,
    ...drift ? [`  ${drift}`] : [],
    "Check that the code and the app match the page you opened; approve only connections you started.",
  ].join("\n"));
  if (!options.yes && !(await confirm("Approve it?"))) {
    await call(options, "deny", { code });
    console.log("Declined.");
    process.exitCode = 3;
    return;
  }
  let answer: { consent: Consent };
  try { answer = await call<{ consent: Consent }>(options, "approve", { code, devices, ...tools ? { tools } : {} }); }
  catch (error) {
    // A gateway that does not list its tools refuses one it lacks only here.
    const unknown = /^Unknown tool (\S+?)\.?$/.exec((error as Error).message);
    if (unknown) throw new Error(`The gateway has no tool ${unknown[1]}. ${gatewayDrift(build) ?? ""} Or approve with --tools naming tools it has.`.replace(/ +/g, " "), { cause: error });
    throw error;
  }
  // A gateway from before 2.4.0 approves the devices paired now, whatever it was asked.
  const reach = answer.consent.devices === "all" ? `every device paired with the gateway (now ${chosen.join(", ")}) and any paired later` : chosen.join(", ");
  print(options, answer, () => `Approved ${consent.clientName} for ${reach}. The page you opened returns to it now.`);
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
