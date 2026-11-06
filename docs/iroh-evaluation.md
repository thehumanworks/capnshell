# iroh/QUIC evaluation

Status: evaluated 6 November 2026, decision 8 of [paired-peers.md](paired-peers.md).
Package: `@number0/iroh` 1.2.0 (N-API bindings, published 22 October 2026). Container:
Linux x86_64, Bun 1.4.4, Node 22.23.4, outbound internet only through an HTTPS proxy.

## What was measured

| Question | Result |
| --- | --- |
| Loads under Bun | Yes. Two endpoints in one process, relays disabled, connected directly and echoed over a bidirectional QUIC stream; each saw the other's id. |
| Loads under Node (Pi) | Yes, same probe. |
| Inside `bun build --compile` | Yes for the host platform: the 20 MB addon is embedded, and the binary runs from a directory without `node_modules`. |
| Cross-compiling | Not as is. `--target=bun-linux-arm64` builds, but npm installs only the host's addon, so the arm64 binary would lack its native module. Each target needs its own platform package installed and only that one embedded. |
| Size | +20 MB per binary (the addon for one platform). The compiled `cns` is about 111 MB today. |
| Nix | The fixed-output derivation installs every platform's optional dependencies (`--cpu="*" --os="*"`), so it would fetch all eleven addons (about 220 MB); the build would need to choose one per system. |
| Same identity | Yes. An endpoint built from a `cns` identity's Ed25519 seed has exactly the device's public key as its id, so iroh could reuse identities and pairings unchanged. |
| Public relays (n0) | Unreachable here: no home relay after 20 s. iroh neither uses the HTTPS proxy nor gets UDP through it. The cns WebSocket relay works through the same proxy, because it is ordinary `wss://`. |
| Hole punching | Not testable in a container; it is iroh's main advantage over a relay. |
| Windows | Addons exist for x64 and arm64; untested, as is all of cns on Windows. |

## Decision

Keep the WebSocket transport and its relay, and do not ship iroh in this release.

- The relay already gives every pair of devices a path, through HTTPS proxies too, with the same identity and grants. iroh would add direct paths through NATs, which saves relay traffic and latency but is not needed for reachability.
- Its cost lands on packaging: a native addon per platform, per-target bundling, and a Nix build that fetches every platform's addon. The rest of cns is JavaScript plus Bun.
- Its public relays did not work behind the proxy that this environment, and many corporate networks, use.

Revisit when hole punching matters, for example heavy traffic between two devices behind home NATs. The integration would be small:

- an iroh endpoint per daemon, keyed by the device identity
- the same `secure.ts` channel running over a QUIC bidirectional stream instead of a WebSocket
- `iroh:` addresses tried before the relay

Pairing, grants, sessions and the relay would stay as they are.
