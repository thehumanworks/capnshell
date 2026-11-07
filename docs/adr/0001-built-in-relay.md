# ADR 0001: The relay is built into cns, and only cns may use it

- Status: accepted
- Date: 2026-11-07
- Replaces: the relay setup of PR 26 and later (`cns up --relay URL`, `CNS_RELAY`, `cns config relay`, `?token=TOKEN`, `CNS_RELAY_TOKEN`, `cns relay`)

## Context

Paired devices reach each other directly when they can, and through a relay when they
cannot (different networks, NAT). Until now the relay was something each person set up:
deploy the Worker in `relay/` or run `cns relay`, pick a token, then give every device the
URL and token with `cns config relay wss://RELAY/?token=TOKEN`, `cns up --relay` or
`CNS_RELAY`. The token was the only thing that stopped strangers from registering at a
relay and using it at the owner's expense.

That is a lot to type and remember for the part of cns that makes it work across
networks, and a device without the setting silently only works on its own network.

## Decision

1. **The relay is part of cns.** `src/relay-config.ts` names one relay, the Cloudflare
   Worker in `relay/`. Every `cns up` registers there, every invite lists it after the
   direct addresses, and commands, `doctor`, MCP, Pi and the daemons' standing links try a
   paired device there after its direct addresses. There is nothing to configure.
2. **No relay URL or token for users.** `cns config relay`, `cns up --relay`, the
   `?token=` parameter, `CNS_RELAY_TOKEN`, `CNS_DAEMON_RELAY`, the settings file and
   `cns relay` are removed, with no compatibility path. Relay URLs with a query are refused.
   `CNS_RELAY` remains only as a development and test switch: a relay URL (such as a local
   `wrangler dev`) or `off`. It is not documented as a user setting.
3. **Only the cns binary is an accepted client.** Every request to the relay carries a
   `Cns-Client` header:

   ```
   Cns-Client: cns-client-1 TIME NONCE MAC
   MAC = HMAC-SHA256(client key, "cns-client-1" 0 host 0 path 0 TIME 0 NONCE)
   ```

   The client key is built into cns (`CLIENT_KEY` in `src/relay-hub.ts`). The relay
   recomputes the MAC for the host and path of the request it received, accepts a `TIME`
   within an hour of its own clock, and answers anything else with `401` before a Durable
   Object or room is touched, so refused requests cost almost nothing. Browsers are refused
   as before (any `Origin` header). `ACCEPTED_CLIENT_KEYS` lets the relay accept an old and
   a new key while releases roll over.
4. **Device keys still gate registration.** Unchanged from PR 26: a daemon registers only
   by signing the relay's challenge, bound to the relay's host, with its Ed25519 identity
   key. Nobody can register as, or take over, another device's key.
5. **Peer traffic stays end-to-end authenticated, whatever the relay does.** Links through
   the relay are the same encrypted, mutually authenticated links as direct ones
   (`src/secure.ts`): both devices prove their identities, a changed identity is refused,
   and records are `secretstream` encrypted. The relay sees public keys, sizes and timing,
   and can drop or delay traffic, but cannot read, change or impersonate anything. The
   client check protects the relay operator, not the links.

## What the client check does and does not do

It is honest to call this a program identifier, not authentication.

- **It keeps out casual clients:** browsers, scanners, generic WebSocket tools, other
  programs that find the URL, and anyone replaying a header seen in a log, since a header
  is bound to one host and path and stops working within the hour.
- **It does not stop a determined person.** The key ships inside every copy of cns, and
  the source is the same code. Anyone can take it out of the binary or the repository and
  write a client that sends valid headers. Rotating the key only means a new release that
  can be taken apart the same way. No secret embedded in software that runs on other
  people's machines can prove which program is talking.
- **Device keys do not close this gap either.** We looked for a stronger check that is just
  as invisible to users, using the device keys cns already has. They prove *which key* is
  talking, which is why they already gate registration, but anyone can generate a key, so
  they cannot prove that a key belongs to someone allowed to use the relay. Telling allowed
  keys from others needs some list of allowed keys, and filling that list is a step a person
  has to take, which this decision rules out for now.

The damage someone with the key can do is limited to using the relay: registering their
own keys and piping their own encrypted traffic, within the limits that already apply
(32 connections per device key, 8 per address, 1 MiB messages, 10 s to answer, and
Cloudflare's own limits). They cannot reach a cns user's device without being paired with
it, because every link is authenticated end to end by device identity.

## Stronger options for later

In rough order of effort, if abuse or cost calls for it:

1. **Registered device identities.** The relay keeps a list of device keys allowed to
   register (in KV or a Durable Object), added when a device first pairs, or by an
   account. Registration already proves the key, so the check is one lookup. Cost: a
   one-time sign-up or approval step, and storage on the relay.
2. **Per-device signed challenges for every request.** Extend the registration challenge to
   dialing and answering, so every relay connection is tied to a device key, and rate-limit
   or bill per key rather than per address. On its own it raises the bar a little; combined
   with option 1 it limits the relay to known devices end to end.
3. **Pairing-scoped relay access.** When two devices pair, both sign a statement that they
   may meet at the relay; the relay only pipes a dialer to a key that has a statement
   naming the dialer's key. Invisible to users (pairing already happens), and it stops
   strangers from even reaching a device's relay slots, but needs the dial-side proof from
   option 2. It protects devices, not the relay: someone with the client key can still pair
   two keys of their own and use the relay between them.
4. **Platform attestation** (App Attest, Play Integrity, TPM-based) proves the binary on
   platforms that support it, but not on Linux and not for a command-line tool built from
   source, so it does not fit cns.
5. **Per-person relays again,** as an opt-in for people who want their own, with a token
   held by the operator. This is what was removed; it could return as an advanced setting
   if someone needs it.

## Consequences

- Pairing across networks works out of the box; invites carry the relay address without
  anyone choosing a relay.
- The project now operates a relay for everyone who uses cns: its availability and cost
  are the project's. The Worker must be deployed (`cd relay && npx wrangler deploy`) before
  a release that uses it, and before devices running this version can use the relay.
- Self-hosting a relay is no longer a user feature. `src/relay-server.ts` runs the same
  relay code in Bun for tests and development; point cns at it with `CNS_RELAY`.
- Changing the relay URL or client key needs a release. Devices learn each other's relay
  address over their standing link, so a new URL spreads to paired devices as they update.
