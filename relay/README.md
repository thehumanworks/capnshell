# cns relay on Cloudflare

Paired devices that cannot reach each other directly (behind NAT, on different
networks) meet at a relay. The relay forwards their encrypted links without being able
to read them; the devices still authenticate each other end to end, so a relay can
deny service but cannot impersonate a device or see what it does. See
[docs/paired-peers.md](../docs/paired-peers.md) section 8 and `src/relay-hub.ts` for the protocol.

This directory is the relay as a Cloudflare Worker: one Durable Object per device key,
using the WebSocket hibernation API so a registered device that is idle costs nothing.
`cns relay` runs the same relay on any machine instead: `cns relay --bind 0.0.0.0 --public-host relay.example.com`
behind a TLS proxy, with `CNS_RELAY_TOKEN` to require the token. It needs the public host that
devices use, because registration proofs name it; it also limits each address to 64 sockets.

## Deploy

```sh
cd relay
npx wrangler@4.151.3 deploy
openssl rand -hex 24 > relay-token     # keep this private
npx wrangler@4.151.3 secret put RELAY_TOKEN < relay-token
```

Without `RELAY_TOKEN` anyone who learns the URL can register their own devices and use the
relay at your account's expense. With it, registering needs `?token=TOKEN`, so only devices
you give the token to can be reached through the relay. Dialing needs no token: a dialer only
reaches a registered device, which authenticates it end to end, so dial addresses, invites
and saved peers never contain the token. Anyone who knows a device's public key can still
dial it and be refused, and fill its 32 relay connections at most 8 at a time per address.

Then, on each device that should be reachable through it:

```sh
cns up --relay 'wss://cns-relay.YOUR-SUBDOMAIN.workers.dev/?token=TOKEN'
```

The daemon gets the URL through its environment, not its command line, and `cns` prints it
with the token hidden.

New invites include the relay address after the device's direct addresses, so devices you
pair from then on try direct first and the relay last. For a device paired before, add it
with `cns peer address NAME ADDRESS`, using the relay address `cns status` prints.

## Test locally

```sh
cd relay && npx wrangler@4.151.3 dev --local --port 8787 &
cd .. && CNS_TEST_RELAY_URL=ws://127.0.0.1:8787 bun test src/relay-hub.test.ts src/relay-e2e.test.ts
```

The tests then run the relay protocol and a full pairing, commands and a daemon link through
the Worker in workerd, Cloudflare's runtime.

## Limits

- 32 connections through the relay per device key at once, 8 of them from one address.
- 1 MiB per WebSocket message (links send 64 KiB records).
- A dialer waits up to 10 seconds for the device to answer.
- The Worker keeps no data: a Durable Object holds only the sockets of one key.
