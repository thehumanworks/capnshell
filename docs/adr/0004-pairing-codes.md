# ADR 0004: Pair by typing a short code, checked with a PAKE through the relay

- Status: accepted
- Date: 2026-11-10

## Context

`cns pair` printed an invite, `cns1:` plus 350 to 600 characters of base64url, for the
other device to paste. Between two machines with no shared clipboard (a laptop and a
server console, a Windows host and a WSL guest, a phone screen and a terminal) that meant
retyping it or sending it through some other channel, such as chat or email, which then
holds a live pairing secret. The invite is long because it carries the inviter's public
key, every address it listens at, and a 128-bit secret.

The goal was a code a person can read off one screen and type on another, without making
pairing materially easier to attack.

## Decision

`cns pair` shows a code such as `42-orbit-canyon-velvet`, and the other device types
`cns pair 42-orbit-canyon-velvet`. The code only carries the existing invite from one
device to the other; everything after it (the handshake, the proof of the invite's secret,
both fingerprint prompts, grants) is unchanged.

- **The code.** The number names a room on the built-in relay, assigned by the relay: the
  lowest free one, never reused within 2 minutes. The three words are drawn uniformly from
  the 2048-word BIP-39 English list (`src/words.ts`), so they are 33 bits of password.
  Every word on that list is unique in its first four letters, so four letters are enough;
  dashes or spaces and any case are accepted, and a word not on the list is refused before
  anything is sent, so a typo costs no try.
- **The exchange.** The device showing the code (the host) opens a room with `/v1/room`;
  the device typing it (the guest) joins with `/v1/room/N`. They run CPace
  (draft-irtf-cfrg-cpace-21) over ristretto255 with SHA-512, in its initiator-responder
  form, with:
  - password: the three words joined by `-`;
  - channel identifier: `lv_cat("cns-pairing-code-1", relay host, room number)`, so a
    message from one room or relay is useless in another;
  - session id: 16 random bytes the host picks for each guest;
  - no associated data.

  The host sends `{t: "hello", v: 1, sid, y}`, the guest answers `{t: "reply", y, tag}`, and
  the host answers `{t: "wrong", left}` or `{t: "invite", tag, nonce, box}`. Both tags are
  the key-confirmation MACs of the draft's section 10.4. The guest proves it knows the
  words first; the host checks that before it sends anything that depends on them. The
  invite is sealed with libsodium `crypto_secretbox` under
  `HKDF-SHA256(ISK, salt: sid, info: "cns-pairing-code-1 invite")`.
- **Tries.** A wrong code is reported on both devices (`A device typed a wrong code (1 of 3
  tries).`). After 3 wrong codes the host closes the room and `cns pair` exits 3, saying
  the code no longer works. A delivered invite also closes the room, so a code works once.
  It expires with its invite (5 minutes by default) or when that `cns pair` exits.
- **The relay** only pipes messages between one guest at a time and the host. It holds the
  rooms in memory in one Durable Object (`RelayRooms`) and in `src/relay-server.ts` for
  tests; the shared logic is `PairingRooms` in `src/relay-hub.ts`. Room requests need the
  `Cns-Client` header like every other relay request. A guest gets 15 seconds, one address
  may hold 4 guests at once, rooms last at most 60 minutes, and the relay holds at most
  10,000.
- **Without a code.** `cns pair --long` prints the `cns1:` invite as before, for pairing
  without the relay (`CNS_RELAY=off`, offline networks) and for scripts. `cns pair` also
  prints it when the relay cannot give a code, or loses the room while waiting, and keeps
  waiting for it. Typing a code with the relay off says to use `--long`.
- **The gateway.** `cns gateway pair CODE` on an owner device swaps the code for the invite
  locally, then sends the invite to the gateway as before. The gateway Worker is unchanged.
- **Cryptography.** CPace needs ristretto255, which the standard `libsodium-wrappers` build
  lacks, so cns now uses `libsodium-wrappers-sumo` at the same pinned version (about 0.4 MB
  more). The CPace pieces are tested against the draft's appendix B.3 vectors.

## Threat model

What the code protects is the invite. Whoever has the invite can propose a pairing; the
people at both devices still see each other's fingerprints and must confirm, unless they
passed `--yes`. That part is unchanged from the long invite.

| Attacker | Long invite | Code |
| --- | --- | --- |
| Watches the network, or runs the relay honestly but reads everything | Sees nothing if the invite was carried out of band; whatever channel carried it may keep it | Sees the room number and CPace messages, which reveal nothing about the words, and the sealed invite. No offline guessing. |
| Runs or impersonates the relay, or joins rooms | Cannot read invites it never carried | One guess per attempt: 3 against a host, then the code is dead (3 in 2^33, about 1 in 2.9 billion); one per run against a guest, which then sees a failed proof. |
| Sees the screen while the code is valid | Can use the invite | Can use the code, once. Same as before; fingerprints still show. |
| Wants to stop pairing | Can drop relay traffic | Can also burn a code's 3 tries, or keep its room busy. The host says the code was tried and to run `cns pair` again. |

The security of the code rests on CPace: an attacker without the words learns nothing
from the transcript and gets exactly one verifiable guess per exchange it takes part in.
The host counts every exchange that fails, and stops at three. 33 bits is therefore an
online-guessing bound, not a brute-force one, which is how short-code tools such as
Magic Wormhole are designed.

Two limits are new and worth stating. First, a relay that misbehaves can now deny pairing
by code more cheaply, by burning tries; it could already deny service by dropping links,
and `--long` does not depend on it. Second, room numbers are small and guessable by
design, so anyone with cns can find open rooms and try a code. That costs the real user a
try and has the odds above. Rate limits per address bound it; nothing better is needed for
a code that lives five minutes and dies after three tries.

## Alternatives considered

- **A sealed mailbox.** Upload the invite to the relay encrypted under a key stretched
  from a 4-word code (Argon2id), and fetch it by the code's hash. Simpler, no live
  exchange, but anyone who fetches the box can guess offline at whatever speed they can
  afford; Argon2id only slows that. Rejected because it weakens the relay threat model.
- **QR codes.** No good path from a terminal on one machine to a terminal on another
  without a camera on both.
- **A shorter invite.** Dropping addresses and shortening the key and secret still leaves
  over 100 characters to type, and a shorter secret without a PAKE is open to offline
  guessing from anything that sees it.
- **Numeric-only codes.** Easier on some keyboards but longer for the same bits and easier
  to mistype; words from a list let a typo be caught before it costs a try.

## Compatibility and rollout

- The relay must be redeployed (`cd relay && npx wrangler@4.151.3 deploy`) before a cns with
  codes is released. The deploy adds the `RelayRooms` Durable Object with a `v2` migration.
- A new cns against an old relay gets 404 from `/v1/room` and prints the long invite, so
  pairing still works. Typing a code against an old relay fails with a relay error.
- An old cns can pair with a new one by invite in both directions: run `cns pair --long`
  on the new one, or paste the old one's invite into the new one.
- Paired devices, identities and the handshake are unchanged; nothing needs pairing again.
