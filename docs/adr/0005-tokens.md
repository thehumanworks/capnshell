# ADR 0005: Tokens let programs reach a device without pairing

- Status: proposed
- Date: 2026-11-15

## Context

Every connection needs a paired device, and pairing needs a person at both ends within a
few minutes: one runs `cns pair` and confirms, the other types the code. A CI job, a
server, a script or an agent's container has nobody to do that, and a throwaway machine
would have to pair again on every run, leaving a new paired device behind each time.

The goal was a credential that such a program can be given once and present on every
connection, without widening what anyone else can do: no device reachable without the
owner's consent, grants as narrow as the owner chooses, and nothing the relay can use.

## Decision

A token is a device identity that the device to be reached makes and pairs in advance.

- `cns token create NAME --grant G [--expires 30d|12h|never]` makes a new Ed25519 key pair
  and saves its public key as a paired device named `NAME` whose record has
  `token: { expiresAt? }`, granted `G` and nothing in the other direction. The token text,
  `cnst1:` plus base64url JSON `{ v: 1, sk, as, key, name, addr, exp? }`, holds the private
  key (`sk`), the name the device saved it under (`as`), the device's key, the name it
  suggests for itself and its addresses, and the expiry. It goes to stdout once; the device
  keeps no copy of the private key. Tokens expire after 30 days unless `--expires` says
  otherwise.
- A program sets `CNS_TOKEN` to one or more tokens. Commands that name a device then reach
  it with the token's identity, through the unchanged handshake (`src/auth.ts`), and read
  or write nothing under `~/.cns`. They never borrow a local daemon's link, since that
  daemon runs as another identity.
- The device refuses a token at the handshake once it has expired (`not-paired`, with the
  reason `This token has expired.`), and ends a connection open when it expires with a
  timer, as revocation would. `cns token revoke NAME` removes the record and drops its
  connections, as `cns peer remove` does. `cns peer grant` and `revoke` change a token's
  grants. The daemon never dials a token.
- `cns peers`, `cns up` and `cns ui` list devices only; `cns token list` lists tokens.

The token's life is its record: valid until `expiresAt`, gone once removed. That needs no
state machine beyond `tokenExpired(record, now)` in `src/tokens.ts`.

## Consequences

- Nothing changes on the wire, in the relay or in the gateway. The token is a private key
  used to sign the handshake, never sent, so the relay and anyone on the path see an
  ordinary paired device and cannot replay or use it.
- The device stores only a public key, so a copy of `~/.cns/peers` does not leak tokens.
- Anyone who has the token text is `NAME` until it expires or is revoked; the text is the
  secret, like a deploy key. Its grants, expiry and instant revocation bound that. One
  token per program keeps revocation narrow.
- A token reaches one device. A program that needs several gets a token from each.
- Token holders are one-way: devices cannot dial them, and they run no daemon. A machine
  that should be a full peer pairs with `cns pair` as before.
- `pairedPeerSchema` stays strict, so a cns older than 1.7.0 skips a token's record and
  refuses the token: an older daemon fails closed rather than ignoring an expiry. The
  program is told that the device may run an older cns.
- Many machines can sign in with one token at once; each connection is separate, as two
  commands from one device are.

## Alternatives considered

- **A reusable invite that enrolls the machine** (the program pairs itself with no prompt
  and keeps its own identity). It makes the machine a full peer, but it writes state on the
  machine, adds a paired device on the owner's side for every new or wiped machine, needs a
  new handshake field that older devices refuse as a protocol error, and the device must
  store the secret to check the HMAC proof. Rejected for this release.
- **A bearer secret sent on each connection.** Simpler to explain, but the secret would
  travel through the relay, and the device would have to store it or a hash of it.
  Rejected: the signed handshake already gives the same result without sending a secret.
