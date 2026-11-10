/**
 * The cns gateway: an MCP server for Claude (web, desktop and Code custom connectors) that
 * reaches devices paired with the gateway, through the relay built into cns. It holds its
 * own device identity, so each device decides what the gateway may do there, and
 * `cns peer remove gateway` on a device cuts it off whatever happens here.
 *
 *   /mcp              Streamable HTTP MCP, for connectors holding an OAuth access token.
 *   /authorize        A connector's sign-in: shows a code an owner approves with cns gateway approve.
 *   /oauth/*          Token, registration and discovery, from @cloudflare/workers-oauth-provider.
 *   /admin/ACTION     Owner requests from cns gateway, signed with an owner device's key.
 *
 * Deploy from this directory with wrangler deploy; see README.md and docs/adr/0002-gateway.md.
 */
import OAuthProvider, { AuthorizationError, CimdFetchError, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { errorMessage } from "../src/errors.js";
import { CNS_VERSION } from "../src/version.js";
import { ownerKeys, OWNER_HEADER, verifyOwner } from "../src/owner-proof.js";
import type { Permission } from "../src/peers.js";
import type { ToolName } from "../src/mcp/server.js";
import { CONSENT_MS, GRANT_HEADER, type Env, type Gateway, type GrantProps } from "./object.js";
import { consentPage, consentPolicy, errorPage } from "./pages.js";

export { Gateway } from "./object.js";

/** The one user of a gateway: its owners, who approve every connector with a device key. */
const OWNER = "owner";
const SCOPE = "cns";

interface ProviderEnv extends Env { OAUTH_PROVIDER: OAuthHelpers; OAUTH_KV: KVNamespace }

const gateway = (env: Env): DurableObjectStub<Gateway> => env.GATEWAY.get(env.GATEWAY.idFromName("gateway"));

const json = (value: unknown, status = 200, headers?: Headers) => {
  const response = Response.json(value, { status, headers });
  response.headers.set("Cache-Control", "no-store");
  return response;
};
const html = (body: string, status: number, headers = new Headers()) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(body, { status, headers });
};

async function sha256(text: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url");
}

/** A connector's MCP request, with a valid token: pass its approval to the Durable Object. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // No MCP client of the gateway is a web page; refuse pages that might hold a token.
    if (request.headers.has("Origin")) return new Response("Browser origins are not allowed.", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set(GRANT_HEADER, JSON.stringify(ctx.props as GrantProps));
    return await gateway(env).fetch(new Request(request, { headers }));
  },
};

async function authorize(request: Request, env: ProviderEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    const authRequest = await oauth.parseAuthRequest(request);
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    const code = await gateway(env).startConsent({
      handle: await sha256(consent.handle), clientId: details.clientId, clientName: details.clientName,
      ...details.clientDomain ? { clientDomain: details.clientDomain } : {}, redirectHost: details.redirectHost, loopback: details.redirectIsLoopback,
    });
    const nonce = crypto.randomUUID().replaceAll("-", "");
    consent.headers.set("Content-Security-Policy", consentPolicy(nonce));
    return html(consentPage({
      code, handle: consent.handle, clientName: details.clientName, ...details.clientDomain ? { clientDomain: details.clientDomain } : {},
      redirectHost: details.redirectHost, loopback: details.redirectIsLoopback, nonce, minutes: CONSENT_MS / 60_000,
    }), 200, consent.headers);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return html(errorPage(error.description ?? "The sign-in request is not valid."), 400);
    if (error instanceof CimdFetchError) return html(errorPage("This app could not be verified: its metadata document could not be fetched."), 400);
    return html(errorPage(errorMessage(error)), 400);
  }
}

/** The consent page asking whether its code was approved; once it is, the approval becomes an OAuth grant. */
async function wait(request: Request, env: ProviderEnv, cancel: boolean): Promise<Response> {
  if (request.headers.get("Content-Type")?.split(";")[0] !== "application/json") return json({ error: "JSON only" }, 415);
  const { code, handle } = await request.json() as { code?: unknown; handle?: unknown };
  if (typeof code !== "string" || typeof handle !== "string" || code.length > 16 || handle.length > 256) return json({ status: "expired" });
  const oauth = env.OAUTH_PROVIDER;
  const handleHash = await sha256(handle);
  const stub = gateway(env);
  try {
    if (cancel) {
      const record = await stub.consent(code);
      if (record?.status === "pending") await stub.decide(code, { approve: false, owner: "the consent page" });
    }
    const answer = await stub.pollConsent(code, handleHash);
    if (answer.status !== "approved") {
      if (answer.status !== "denied") return json({ status: answer.status });
      const denied = await oauth.denyConsent(request, handle, { description: "Declined on the gateway." });
      denied.headers.delete("Location");
      return json({ status: "denied", redirectTo: denied.redirectTo }, 200, denied.headers);
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
    const status = await stub.status();
    const names = status.devices.filter((device) => answer.props.devices.includes(device.publicKey)).map((device) => device.name);
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, userId: OWNER, scope: [SCOPE], props: answer.props,
      metadata: { grant: answer.props.grant, client: answer.props.client, devices: names, tools: answer.props.tools },
    });
    return json({ status: "approved", redirectTo }, 200, approved.headers);
  } catch (error) {
    if (error instanceof AuthorizationError) return json({ status: "expired" });
    throw error;
  }
}

/** One signed owner request from cns gateway. */
async function admin(request: Request, env: ProviderEnv, action: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (request.headers.has("Origin")) return json({ error: "Browser origins are not allowed." }, 403);
  let owners: string[];
  try { owners = ownerKeys(env.OWNER_KEYS); } catch (error) { return json({ error: errorMessage(error) }, 503); }
  if (!owners.length) return json({ error: "This gateway has no owners yet. Set OWNER_KEYS to your devices' public keys (cns identity --json) and deploy again." }, 503);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > 64 * 1024) return json({ error: "Request too large." }, 413);
  const stub = gateway(env);
  const checked = await verifyOwner(request.headers.get(OWNER_HEADER), request, body, { owners, claimNonce: (nonce, until) => stub.claimNonce(nonce, until) });
  if ("refused" in checked) return json({ error: checked.refused }, 401);
  const input = body.length ? JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> : {};
  const text = (key: string) => typeof input[key] === "string" ? input[key] as string : undefined;
  const list = <T extends string>(key: string) => Array.isArray(input[key]) ? input[key] as T[] : undefined;
  try {
    switch (action) {
      case "status": return json({ ...await stub.status(), grants: await grants(env), owner: checked.fingerprint });
      case "pair": return json(await stub.pair(text("invite") ?? "", { name: text("name"), requests: list<Permission>("requests") }));
      case "remove": return json({ removed: await stub.removeDevice(text("name") ?? "") });
      case "consent": return json({ consent: await stub.consent(text("code") ?? "") });
      case "approve": return json({ consent: await stub.decide(text("code") ?? "", { approve: true, devices: input.devices === "all" ? "all" : list<string>("devices"), tools: list<ToolName>("tools"), owner: checked.fingerprint }) });
      case "deny": return json({ consent: await stub.decide(text("code") ?? "", { approve: false, owner: checked.fingerprint }) });
      case "grants": return json({ grants: await grants(env) });
      case "revoke": return json({ revoked: await revoke(env, text("id") ?? "") });
      case "log": return json({ entries: await stub.auditLog(typeof input.limit === "number" ? input.limit : 100) });
      default: return json({ error: `Unknown action ${action}.` }, 404);
    }
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
}

interface GrantMetadata { grant: string; client: string; devices: string[]; tools: string[] }

async function grants(env: ProviderEnv) {
  const found: { id: string; client: string; devices: string[]; tools: string[]; createdAt: number; expiresAt?: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(OWNER, { cursor, limit: 100 });
    for (const item of page.items) {
      const metadata = item.metadata as GrantMetadata | undefined;
      if (!metadata?.grant) continue;
      found.push({ id: metadata.grant, client: metadata.client, devices: metadata.devices, tools: metadata.tools, createdAt: item.createdAt, ...item.expiresAt ? { expiresAt: item.expiresAt } : {} });
    }
    cursor = page.cursor;
  } while (cursor);
  return found;
}

/** Revoke a connector by its ID or a unique prefix of it: its tokens stop working, and so do requests in flight. */
async function revoke(env: ProviderEnv, id: string) {
  if (id.length < 4) throw new Error("Give at least four characters of the connector's ID, from cns gateway grants.");
  const matches: { oauth: string; grant: string; client: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(OWNER, { cursor, limit: 100 });
    for (const item of page.items) {
      const metadata = item.metadata as GrantMetadata | undefined;
      if (metadata?.grant?.startsWith(id)) matches.push({ oauth: item.id, grant: metadata.grant, client: metadata.client });
    }
    cursor = page.cursor;
  } while (cursor);
  if (!matches.length) {
    // Still stop it at the gateway: a grant that already expired or was removed may have requests in flight.
    if (/^[0-9a-f-]{36}$/.test(id)) { await gateway(env).revoke(id); return { id, client: null }; }
    throw new Error(`No connector has an ID starting with ${id}; see cns gateway grants.`);
  }
  if (matches.length > 1) throw new Error(`Several connectors have IDs starting with ${id}; give more of it.`);
  const [match] = matches;
  await gateway(env).revoke(match!.grant);
  await env.OAUTH_PROVIDER.revokeGrant(match!.oauth, OWNER);
  return { id: match!.grant, client: match!.client };
}

const defaultHandler = {
  async fetch(request: Request, env: ProviderEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" && request.method === "GET") return await authorize(request, env);
    if (url.pathname === "/authorize/wait" && request.method === "POST") return await wait(request, env, false);
    if (url.pathname === "/authorize/cancel" && request.method === "POST") return await wait(request, env, true);
    if (url.pathname.startsWith("/admin/")) return await admin(request, env, url.pathname.slice("/admin/".length));
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(`cns gateway ${CNS_VERSION}\nAdd ${url.origin}/mcp as a custom connector in Claude; approve it with cns gateway approve CODE.\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
};

let provider: OAuthProvider<ProviderEnv> | undefined;

function oauthProvider(env: Env): OAuthProvider<ProviderEnv> {
  if (provider) return provider;
  const origin = env.GATEWAY_ORIGIN?.replace(/\/+$/, "");
  if (!origin) throw new Error("Set GATEWAY_ORIGIN in wrangler.toml to the gateway's https:// address.");
  provider = new OAuthProvider<ProviderEnv>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler as never,
    defaultHandler: defaultHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
    clientIdMetadataDocumentEnabled: true,
    // An hour of access per token; revoking a connector also stops it at once (Gateway.revoke).
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
  });
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await oauthProvider(env).fetch(request, env as ProviderEnv, ctx as never);
    } catch (error) {
      console.error(`gateway: ${errorMessage(error)}`);
      return new Response("The gateway failed to answer.", { status: 500 });
    }
  },
};
