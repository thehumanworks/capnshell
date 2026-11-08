# ADR 0002: A hosted gateway, itself a paired device, serves MCP to remote agents

- Status: accepted
- Date: 2026-11-08

## Context

`cns mcp --http` serves MCP with one static bearer token over plain HTTP on the machine
that runs it. An agent in a remote environment (Claude on the web, Claude Desktop's
connectors, Claude Code in the cloud) can only use it if that machine is reachable from
the internet or a VPN, and Claude's custom connectors expect OAuth, not a fixed token.

We want remote agents to use paired devices without exposing any device, and without
weakening what pairing guarantees: a device decides what each paired device may do, links
are end to end, and access can be withdrawn at once.

## Decision

1. **The gateway is a Cloudflare Worker with one Durable Object** (`gateway/`), deployed
   by the owner, at `gateway.cns.nothuman.work` by default. The object holds the
   gateway's own device identity, its paired devices, pending approvals, revocations,
   owner-request nonces and the audit log, in SQLite.
2. **The gateway is a paired device, not a privileged service.** Devices pair with it with
   `cns pair`, granting it what they choose (by default it asks for
   `shell,files,sessions:create`). It reaches them per tool call through the built-in
   relay, over the normal SecureChannel link, so the relay sees ciphertext and the device
   enforces its grants. It offers devices nothing.
3. **Connectors sign in with OAuth 2.1**, using `@cloudflare/workers-oauth-provider`:
   dynamic client registration and client ID metadata documents, PKCE, the `cns` scope,
   1-hour access tokens and 30-day refresh tokens.
4. **The owner approves on a device, not in the browser.** The sign-in page shows a code
   and polls. `cns gateway approve CODE` fetches what is waiting, shows the client, its
   verified domain if any, where its access goes, and the devices and tools, and asks.
   There is no password or account at the gateway that could be phished.
5. **Owner requests are signed by the device key.** `cns gateway` sends
   `Cns-Owner: cns-owner-1 PUBLICKEY TIME NONCE SIGNATURE`, an Ed25519 signature over the
   host, method, path, time, nonce and body hash (`src/owner-proof.ts`). The gateway
   accepts keys in its `OWNER_KEYS` secret, within five minutes of its clock, each nonce
   once.
6. **Approvals are scoped and revocable.** Each grant carries device keys and tool names
   in its token props; the MCP server registers only those tools and resolves only those
   devices. Revoking a grant removes it from the OAuth store and marks it revoked in the
   Durable Object, which refuses its requests immediately.
7. **libsodium is replaced in the Worker** by a pure-JavaScript implementation of the same
   primitives on `@noble` (`gateway/nacl.ts`), since Workers forbid compiling WebAssembly
   at run time. Its output is tested against libsodium.

## Consequences

- Anyone with Cloudflare access to the owner's account can change the gateway's code and so
  act as the gateway, within what devices granted it. Grants on devices and revocation
  there (`cns peer revoke gateway`) are the backstop.
- A device's daemon must be running and registered at the relay for the gateway to reach it.
- Devices on cns releases from before this change dial the gateway every 30 seconds, as it
  has no address; newer releases skip paired devices with no address and no grants.
- Tool calls cost one relay link each. That keeps the gateway stateless between calls, at
  some latency.
- The audit log records commands and paths, not file contents or keystrokes.

## Alternatives considered

- **`cns mcp --http` behind a tunnel or Tailscale**: exposes a device and keeps the static
  token; rejected as the default, kept for local use.
- **Approving in the browser with a gateway password or passkey**: another credential to
  manage and phish; the device key is already there.
- **Gateway with standing links to devices**: lower latency, but a Durable Object would stay
  awake for every device, and the per-call link is simpler to reason about.
