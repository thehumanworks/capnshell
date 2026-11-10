# The cns gateway (Cloudflare Worker)

The gateway lets an agent in a remote environment, such as Claude on the web, Claude
Desktop or Claude Code, use your paired devices through MCP, without exposing any device to
the internet or a VPN. You add it to Claude as a custom connector; it reaches devices
through the relay built into cns, the same way your other devices do.
[ADR 0002](../docs/adr/0002-gateway.md) records the design.

```
Claude ──HTTPS + OAuth──▶ gateway (Worker + Durable Object) ──encrypted cns link via relay──▶ device
```

## What keeps devices safe

- **The gateway is a paired device.** It has its own Ed25519 identity, kept in its Durable
  Object, and each device pairs with it as with any other device (`cns pair`), granting it
  only what you choose. The device enforces those grants, so a compromised gateway can do
  no more than they allow. `cns peer revoke gateway` or `cns peer remove gateway` on the
  device ends it at once.
- **Links stay end to end.** The gateway opens a cns link to the device for each tool call.
  The relay still sees only ciphertext, and the device authenticates the gateway's key.
  The gateway never offers devices anything: a device that links to it gets no shell.
- **Connectors need your approval.** Claude signs in with OAuth 2.1 (dynamic registration
  or a client metadata document, PKCE). The sign-in page shows a code and waits; nothing is
  granted until you run `cns gateway approve CODE` on one of your devices, which shows the
  app, where its access goes, and the devices and tools it will get. That request is signed
  by your device's key, which the gateway accepts only when it is listed in `OWNER_KEYS`.
- **Each approval is scoped.** It names the devices (by key, so a re-paired device under the
  same name is not included) and the tools (`--tools read` for tools that change nothing).
  Access tokens last an hour, refresh tokens 30 days. `cns gateway revoke ID` stops a
  connector's tokens and in-flight sessions immediately.
- **Every call is logged.** `cns gateway log` shows when, which connector, which device,
  which tool and the command or path. File contents and keystrokes are not recorded, only
  their size.
- Browsers can't call `/mcp` (any `Origin` header is refused), and the consent page runs
  under a strict Content-Security-Policy with no framing.

## Deploy

From this directory, in your Cloudflare account (the zone for the hostname must be there):

1. Create the KV namespace for OAuth state, and put the id it prints in `wrangler.toml`
   (the one there is for gateway.cns.nothuman.work; replace it for your own deployment):

   ```sh
   npx wrangler kv namespace create OAUTH_KV
   ```

2. Change `routes` and `GATEWAY_ORIGIN` in `wrangler.toml` if you use another hostname.

3. Set the owner keys, the public keys of the devices that may administer the gateway
   (`cns identity` on each prints it; separate several with commas):

   ```sh
   npx wrangler secret put OWNER_KEYS
   ```

4. Deploy:

   ```sh
   npx wrangler deploy
   ```

5. On an owner device, check it: `cns gateway status` prints the gateway's fingerprint, and
   `curl https://gateway.cns.nothuman.work/` prints the cns version it was deployed from.
   Set `CNS_GATEWAY=https://your-host` first if you changed the hostname.

## Use

Pair a device with the gateway. On the device:

```sh
cns pair --grant shell,files,sessions:create
```

It shows a code, such as `42-orbit-canyon-velvet`, and waits. On an owner device:

```sh
cns gateway pair 42-orbit-canyon-velvet
```

The owner device swaps the code for the device's invite through the relay and sends it to the
gateway. `cns pair --long` prints a `cns1:` invite instead, which `cns gateway pair` also takes.

The device shows the gateway's fingerprint (compare it with `cns gateway status`) and asks
before saving. `--grant files`, for example, grants less; `--request` on `cns gateway pair`
asks for less. The device's daemon (`cns up`) must be running for the gateway to reach it.

Add the connector in Claude: Settings, Connectors, Add custom connector, with the URL
`https://gateway.cns.nothuman.work/mcp`. For Claude Code:
`claude mcp add -t http cns https://gateway.cns.nothuman.work/mcp`. Claude opens the
gateway's sign-in page, which shows a code. On an owner device:

```sh
cns gateway approve ABCD-EFGH                      # all paired devices, all tools
cns gateway approve ABCD-EFGH --devices studio --tools read
```

The page then returns to Claude, and its tools reach the approved devices by name
(`list_peers` lists them). Other commands:

| Command | Does |
| --- | --- |
| `cns gateway status` | Fingerprint, devices, approved connectors, approvals waiting |
| `cns gateway grants` | Approved connectors with their IDs |
| `cns gateway revoke ID` | Stop a connector now (an ID prefix of 4+ characters works) |
| `cns gateway deny CODE` | Decline a connector that is waiting |
| `cns gateway remove NAME` | Forget a device; run `cns peer remove gateway` there too |
| `cns gateway log [--limit N]` | The newest tool calls |

All take `--json`, and `--url` or `CNS_GATEWAY` to name another gateway.

## Notes

- cns's encryption uses libsodium.js, which compiles WebAssembly at run time, and Workers
  forbid that. `nacl.ts` implements the same algorithms (crypto_kx and secretstream
  XChaCha20-Poly1305) with the audited `@noble` libraries; `nacl.test.ts` checks them
  against libsodium. `wrangler.toml` aliases `libsodium-wrappers-sumo` to `sodium.ts`.
- Devices running a cns release from before the gateway try to dial it every 30 seconds,
  since it has no address; it does no harm but costs relay requests. Newer releases don't
  dial a paired device that has no address and nothing granted to it.
- To develop locally: put `GATEWAY_ORIGIN=http://localhost:8787`, a local `RELAY` and
  `OWNER_KEYS` in `.dev.vars`, run `npx wrangler dev --local-upstream localhost:8787`, and
  point cns at it with `CNS_GATEWAY=http://localhost:8787` and `CNS_RELAY`.
