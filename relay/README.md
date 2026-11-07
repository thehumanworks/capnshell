# The cns relay (Cloudflare Worker)

Paired devices that cannot reach each other directly (behind NAT, on different
networks) meet at a relay. This Worker is the relay built into cns: every `cns up`
registers there and every device dials paired devices there after their direct
addresses, with no URL or token to set up. Its address is `DEFAULT_RELAY` in
`src/relay-config.ts`. [ADR 0001](../docs/adr/0001-built-in-relay.md) records the decision.

The relay forwards encrypted links without being able to read them; the devices still
authenticate each other end to end, so a relay can deny service but cannot impersonate a
device or see what it does. See [docs/paired-peers.md](../docs/paired-peers.md) section 8
and `src/relay-hub.ts` for the protocol.

One Durable Object per device key, using the WebSocket hibernation API, so a registered
device that is idle costs nothing.

## Who may use it

Only cns. Every request must carry a `Cns-Client` header: an HMAC-SHA256, under the client
key built into cns (`CLIENT_KEY` in `src/relay-hub.ts`), of the relay's host, the path, the
time and a nonce. Requests without a valid header, or made more than an hour from the
relay's clock, are refused with `401` before they reach a Durable Object. Browsers (any
`Origin` header) are refused too. Registering also needs proof of the device key, as before.

The client key ships in every copy of cns, so this keeps out other programs, not someone
who extracts the key. The ADR lists what would be stronger. Links stay end-to-end
authenticated whatever the relay lets through.

To rotate the key, add the new one to `ACCEPTED_CLIENT_KEYS` beside the old, deploy, release
cns with the new `CLIENT_KEY`, and drop the old key once those releases are no longer in use.

## Deploy

```sh
cd relay
npx wrangler@4.151.3 deploy
```

It needs no secrets. Deploy before releasing a cns that depends on a change here. If the
Worker's address changes, update `DEFAULT_RELAY` and release cns.

## Test locally

```sh
cd relay && npx wrangler@4.151.3 dev --local --port 8787 &
cd .. && CNS_TEST_RELAY_URL=ws://127.0.0.1:8787 bun test src/relay-hub.test.ts src/relay-e2e.test.ts
```

The tests then run the relay protocol, the client check, and a full pairing, commands and a
daemon link through the Worker in workerd, Cloudflare's runtime. Without
`CNS_TEST_RELAY_URL` they run the same code in Bun (`src/relay-server.ts`). To point a
development cns at a local relay, set `CNS_RELAY=ws://127.0.0.1:8787`; `CNS_RELAY=off` turns
the relay off. Neither is a user setting.

## Limits

- 32 connections through the relay per device key at once, 8 of them from one address.
- 1 MiB per WebSocket message (links send 64 KiB records).
- A dialer waits up to 10 seconds for the device to answer.
- The Worker keeps no data: a Durable Object holds only the sockets of one key.
