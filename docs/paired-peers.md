# Paired peers

Status: in progress, 6 November 2026. Base: `main` at `1986d6a` with the address book
(PR 12), `peer list --json` (PR 18) and scoped handle lifetimes (PR 19). Decisions taken so
far: `cns up` listens on all interfaces for paired devices; both sides confirm a pairing;
the relay is a Cloudflare Worker; slices 1 and 2 are merged as PRs 21 and 22; encryption is PR 25, the relay PR 26, and session permissions with reconnecting terminals PR 27; slice 3 (pairing, peers file v2, `cns up`, `cns pair`, `cns peers`, named targets and grant enforcement at the method level) is PR 23; `status`, `doctor`, grant and address changes with live refresh, link deduplication, paired MCP targets and the fixes from PR 23's review are PR 24. The legacy mode (`cns listen`, `cns connect`, `ws://` targets, address aliases and `--one-way`) was removed after the built-in relay: every command now targets a paired device by name (section 9).

The requirement is **two devices I know of that have paired**. Today `cns` connects a
listener and a connector, identifies peers by connection IDs such as `p1`, grants
every connection unauthenticated shell access in both directions unless it is
one-way, and loses attachments when a connection drops. This document specifies the
remaining product work from the handover as independently verifiable slices, with
the design choices that are still open marked **Decision** so they can be settled
before the slice that needs them.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Device | One installation of `cns` for one OS user, with its own identity. |
| Identity | A device's long-lived Ed25519 key pair. Its public key is the device's name on the wire; its fingerprint is what people compare. |
| Alias | The local, human-readable name a device gives another device: `studio`, `laptop`. Aliases never travel on the wire; during pairing each device sends only the name it suggests for itself. |
| Pairing | The one-time exchange in which two devices learn and confirm each other's identity. |
| Grant | What one device permits a paired device to do on it. Grants are directional and enforced by the device that grants them. |
| Peer daemon | The one `cns` process per device that listens, dials, hosts sessions and serves local clients. |
| Session host | The peer daemon whose OS user runs a command or terminal. |
| Link | One authenticated connection between two peer daemons, whichever dialed. |

## 1. Identity

- `cns up` creates `~/.cns/identity.json` (`0600`) on first use: `{ "version": 1, "publicKey", "privateKey", "createdAt" }`, keys as base64url Ed25519. The file lives under the same trusted configuration path as the address book and gets the same ownership and mode checks (PR 12, PR 13).
- The **fingerprint** is `SHA-256(publicKey)`, shown as groups of base32, e.g. `k7qm-3h2x-...`. It is what `cns pair` asks people to compare and what `cns peers` shows.
- A paired device is recorded in `~/.cns/peers/<alias>` as JSON: `{ "version": 2, "publicKey", "addresses": [...], "pairedAt", "grants": { "incoming": [...], "outgoing": [...] } }`; the fingerprint is derived from the key, not stored. Changes replace the file whole (write a private temporary file, then rename). A file in the directory that is not a valid record is reported and skipped, so it never stops the other devices from authenticating. The plain-URL files PR 12 writes stay valid as **unpaired address-book entries**; `cns peer list` shows both kinds and marks which is which.
- Trust is keyed by the public key, so renaming an alias (`cns peer rename old new`) changes nothing about trust. Two aliases for the same key are refused; a key seen under a new alias is reported as the existing alias.
- **Identity change**: a device that presents a different key under a known address is treated as an unknown device, never silently re-trusted. `cns peers` shows `identity changed`; the user must pair again. Rotation is therefore "pair again", and there is no automatic migration of grants to a new key.
- **Lost local state** (identity or peers directory gone) means the device is new to everyone and must pair again. Documented, not recovered.
- **Decision 1 (key storage):** plain file under `~/.cns` with mode checks (as the daemon token today), or the OS keychain where available. Recommendation: file first, keychain later, because the daemon token already sets the precedent and Nix/compiled builds have no keychain dependency.

## 2. Pairing

The flow follows the handover's walkthrough:

```text
studio $ cns pair
Code: 42-orbit-canyon-velvet
On the other device, run: cns pair 42-orbit-canyon-velvet
Waiting for it (the code works once and expires in 5 minutes)...

laptop $ cns pair 42-orbit-canyon-velvet --name studio
Pair with studio? Fingerprint: k7qm-3h2x-...
Request permission to use studio's shell? [Y/n] y

studio: Allow laptop (fingerprint j4ra-...) to use this machine's shell? [y/N] y
Paired. Reverse shell access has not been granted.
```

- A **pairing code** carries the invite between the devices so that nobody has to copy it. The number names a room on the relay; the three words (33 bits, from the BIP-39 English list) are a password the two devices check with CPace, a PAKE, before the inviting device sends the invite sealed under the key they agreed. The relay sees neither the words nor the invite and cannot test guesses offline; a wrong code costs one of three tries. [ADR 0004](adr/0004-pairing-codes.md) has the protocol and threat model. `cns pair --long` prints the invite itself instead, for pairing without the relay.
- An **invite** is `cns1:` plus base64url JSON: `{ "v": 1, "id", "key": <inviter public key>, "addr": [<URLs the inviter is reachable at>], "secret": <128-bit random>, "exp": <unix time>, "name": <the inviter's suggested name> }`. It is single-use and expires after five minutes by default (`--expires`), or as soon as the `cns pair` that printed it exits. The inviter's daemon keeps the pending invite in memory only.
- The invitee dials each address in turn and runs the **handshake** (section 3). The handshake proves possession of both keys. The invitee additionally proves knowledge of the invite secret by including an HMAC of the transcript, so a device that intercepted the invite's public part but not the secret cannot pair.
- Each side **confirms interactively**, showing the other's fingerprint and the grants being requested. Both sides ask what the other may use (the accepting side: `What may studio use on this device? none, shell, files, sessions, all, or a comma-separated list [none]`). Non-interactive pairing (`--yes`, with `--grant shell,files` for what to allow) exists for scripted setups; `--yes` alone grants nothing. The inviting side grants at most what the other device requested.
- Pairing and granting are **separate states**: a pairing with no grants in a direction is valid and useful (the device is recognized but may do nothing). The example above pairs both ways and grants shell access in one direction only.
- Everything that can fail locally is checked before the other device saves anything: an alias already in use, or a device already paired, is refused before connecting (exit 1). If the inviting device cannot save the pairing, it declines, so neither side keeps half of one. A declined or refused pairing, an expired or unknown invite, an unpaired device and an identity change each have a distinct error text and exit status 3.

## 3. Authenticated links

Today the RPC capability is exported the moment the WebSocket opens, and the peer's `info()` is exchanged afterwards. In the paired model **nothing is exported until the handshake has succeeded**: `src/auth.ts` runs a four-message mutual authentication on the connection first, and only then does Cap'n Web start.

- Each side proves possession of its Ed25519 identity by signing a challenge made of both devices' nonces and public keys, so a signature from one connection is useless on another. The dialer states which identity it expects; a different one is reported as `identity-changed` and never accepted. The responder decides whether the authenticated device may connect at all; unknown devices are refused with `not-paired` before any capability exists.
- During pairing, the dialer also proves knowledge of the invite secret with an HMAC over the same transcript, so a device that saw the invite's public part but not the secret cannot pair.
- Refusals carry a stable code (`protocol`, `identity-changed`, `refused`, `not-paired`, `invalid-proof`) and a reason, which `cns doctor` and the CLI exit statuses use. An older `cns`, which speaks Cap'n Web first, is recognized and refused with a message saying so.
- **Encryption** (`src/secure.ts`). Each hello also carries a fresh libsodium `crypto_kx` public key, and the transcript both signatures cover includes both of them (auth version 2). `crypto_kx` then derives one session key per direction. Each side sends a `secretstream` header, and every later message is a libsodium `secretstream` record (XChaCha20-Poly1305): encrypted, authenticated, in order and never accepted twice. No cipher is implemented here; the code composes libsodium's constructions. The signatures also cover the initiator's link mode and invite id. Each side sends a heartbeat record right after its header, and a side counts the channel open only once the other's first record opens, which confirms that both derived the same keys. A record that fails to open, a replayed one, or a plaintext message after the handshake closes the link. Close frames are not encrypted, so they carry fixed phrases only. This device's copies of the session keys and the stream states are zeroed and freed when the link closes; libsodium.js may keep copies in its heap until that memory is reused.
- **What observers see.** The handshake is plaintext: both identity keys (linkable across networks), the link mode, an invite id, refusal reasons, and the size and timing of records. A relay sees the same, plus which keys are registered.
- **Records** carry 64 KiB fragments of Cap'n Web messages (so a relay that limits message size still works) and heartbeats. Each side sends a heartbeat every 15 s when idle; a link that delivers nothing for 45 s is closed as lost, and the daemon redials.
- **Decision 2 (link encryption):** settled: libsodium (`libsodium-wrappers-sumo`, pinned; the sumo build adds the ristretto255 operations pairing codes use) for key exchange and the stream, Ed25519 identities from section 1 for authentication.

## 4. Directional grants

A grant lists the operations one device may perform on another. The granting device stores it in its peers file under `grants.incoming` and enforces it locally; it also stores what it was granted (`grants.outgoing`) for display only, because the other device enforces that.

| Permission | ShellApi operations it allows |
| --- | --- |
| `shell` | `run`, `exec`, `openPty`, `fork` (a fork inherits the grant) |
| `files` | `stat`, `access`, `readdir`, `mkdir`, `glob`, `readFile`, `writeFile`, `writeFileAt` (`cns cp` uses `stat`, `readdir`, `mkdir`, `readFile` and `writeFileAt`) |
| `sessions:list` | `ptySessions` (names, commands, sizes and owners' fingerprints) |
| `sessions:create` | `startPtySession`; the device owns what it starts and may view, control and kill it, so this alone amounts to running commands |
| `sessions:view` | `info`, `capture` (with up to 1000 lines of scrollback), `wait`, `attach` as a viewer that cannot type |
| `sessions:control` | `write`, `keys`, `resize` on a handle or attachment |
| `sessions:kill` | `NamedPty.kill` |

- Presets: `shell` and `files` as above; `sessions` means all five session permissions; `all` means everything.
- Enforcement is a `GrantedShell` in the manner of `RefusingShell` (`src/granted-shell.ts`, merged with slice 3 at the method level; derived handles below are slice 4): every `ShellApi` method is present, permitted ones delegate, others throw `Permission denied: <permission> not granted to <alias>`. The device that receives the refusal adds what to do about it: `To allow it, run on <its name for the other device>: cns peer grant <alias> <permissions>`, built from the refusal, so it also explains refusals from an older cns. Session handles returned through a grant are **derived capabilities**: a handle issued without `sessions:control` has `write`, `keys` and `resize` refuse. Denied operations have no side effects, as PR 16's tests already require for one-way refusal.
- **Revocation**: `cns peers revoke studio [permission...]` rewrites the file and tells the running daemon, which closes the `HandleScope` of every shell exported to that device under the revoked permission (PR 19's mechanism), so live handles and attachments fail with "access revoked" and viewers are detached with that reason. Commands and unnamed PTYs started under a revoked `shell` grant are killed, as releasing a fork does today.
- **Expiry**: a grant may carry `expiresAt`; the daemon applies expiry like revocation.
- Legacy connections (`cns listen` and `cns connect` without identities) were kept at first and have since been removed (section 9); a daemon refuses any connection that does not authenticate.
- **Decision 3 (grant granularity):** the table above (seven permissions, three presets) versus the three coarse grants `shell`, `files`, `sessions`. Recommendation: implement the seven internally and expose the presets in prompts, so the CLI stays simple while scripts can be precise.
- **Decision 4 (revocation and running work):** kill commands started under a revoked grant immediately (recommended, matches fork release) or let them finish while refusing new ones.

## 5. Symmetric peer daemon and CLI

- `cns up [--name NAME] [--bind ADDRESS] [--port PORT]` starts the peer daemon, or reports the running one. It creates the identity if needed, listens for paired peers, and dials the saved addresses of paired peers to bring links up. There is one daemon per device (the existing `~/.cns/daemon.json` arbitration), and `attach` and `stop` work on it.
- A link between two devices is one connection whichever side dialed. If both dial at once, the daemon with the lexically smaller public key keeps its outbound link and drops the inbound duplicate; the other does the opposite. Named sessions, grants and reconnection are properties of the pair, not of who dialed.
- Every peer command takes a **target**: `cns tty studio`, `cns run studio -- 'git status'`, `cns sessions studio`, `cns screen studio main`. The target is a paired device's name; an unknown name fails with `No paired device is saved as studio. Pair with it first: cns pair.`, and nothing falls back to another peer or to a hostname. (Address-book aliases, `ws://` URLs and `--peer NAME` were accepted until the legacy mode was removed.)
- A command whose target the local daemon has a standing link to uses that link rather than dialing (`ControlApi.lend`): the daemon hands the command a fork of the device's shell over the link (the shell itself when the device grants no `shell`), which the device releases, ending the command's commands, terminals and handles, when the command's control connection closes, and the daemon closes that control connection when the link ends, so the command sees a lost connection as it would on its own. Only the daemon at the default state path, running as the command's identity, is asked; without a link, or with an older daemon, the command dials. This is what makes a device that can only dial out, such as one in WSL, quick to reach: its link to this daemon is direct even though nothing can dial it.
- `cns tty studio` with no `--name` creates or attaches to the session named `main` on that peer (**Decision 5**: default session name and whether `tty` without a name should attach to `main` or open an unnamed PTY as today; recommended: `main`, because the walkthrough and recovery both depend on a named session). Superseded on 10 November 2026: two terminals on one device ended up in the same `main`, so each `cns tty studio` now starts a named session of its own, `tty-1`, `tty-2` and so on, which keeps recovery after disconnects; `cns tty studio --attach NAME` joins a shared one.
- `cns peers [--json]` lists paired and address-book peers:

  ```text
  NAME      STATUS      CONNECTION   ACCESS
  studio    online      direct       shell, files
  modal     offline     —            shell
  build     unpaired    —            —
  ```

  `ACCESS` shows only what this device has been granted on the peer. `--json` emits `[{ name, fingerprint, status, connection, access: [...], addresses: [...], lastSeen }]` with stable field names; `cns peer list --json` (PR 18) stays as the address-book view.
- `cns status [--json]`: this device's alias, fingerprint, daemon PID, listening addresses, link count, and the sessions it hosts. `cns doctor NAME`: for one peer, each address tried and its result, the handshake result (not paired, identity changed, refused, ok), grants in both directions, clock skew, and the peer's `cns` version. `cns doctor` without a name: this device's identity, its daemon and whether it runs as that identity, relay registration, and each advertised address marked private or reachable from other networks.
- Exit statuses are stable for scripts: 0 ok, 1 command or runtime failure, 2 usage or unknown target, 3 not paired or identity changed, 4 permission denied, 5 peer offline, 124 timeout (unchanged).
- MCP (`cns mcp`) and the Pi extension accept the same targets and show the same `status` fields; MCP's `list_peers` returns alias, fingerprint, status and access, and Pi's `/cns attach studio` resolves aliases before daemon IDs.

## 6. Session ownership and continuity

- Named sessions are hosted by the peer daemon, in both roles: a session exists in the host's `PtyRegistry` and ends only when killed, when its `--timeout` passes, or when the daemon stops. Once its program has ended, the host removes it an hour later, or sooner when a new session needs its place. That is today's behavior, made symmetric because both devices run the same daemon.
- Each session records its **owner**: the device (public key) that created it, or `local` for sessions created from the host's own console. `sessions:list` shows every session on the host; `sessions:kill` is needed to kill another device's session, while an owner may always kill its own.
- Viewers remain many; writers are not coordinated beyond today's "last keystroke wins" (**Decision 6**: whether to add an exclusive-control lease, recommended no for the first release).
- Handles follow PR 19: they belong to the issuing shell, which now means to one device's link. When the link drops, the device's handles are revoked and its viewers detached; the session keeps running. Reconnection (section 7) obtains new handles.
- Host-process restart does not recover sessions, and nothing about them is written to disk. **Decision 7**: keep it that way for this plan (recommended) or add a `tmux`-style resurrect later.

## 7. Reconnect and output recovery

Client-visible states, shown in the console footer, in `cns peers`, and as stable `cns doctor` words: `connected`, `interrupted`, `reconnecting`, `reattached`, `access-revoked`, `session-expired`, `host-lost`.

- The daemon keeps a link to each online paired peer and re-dials with exponential backoff (1 s doubling to 30 s) while any local client wants that peer. The walkthrough's `Reconnecting… Reattached to studio/main via relay.` is the console rendering of `interrupted → reconnecting → reattached`.
- **Address exchange.** When a standing link is up, each daemon calls the other's `addresses()` (on `GrantedShell`, needing no grant) and rewrites its record with `learnAddresses` (`src/peers.ts`): advertised addresses replace IP-literal and relay addresses saved earlier, while hostnames, which only a person adds, and the address this side dialed the link at are kept; direct first, relays last, at most 16. An empty list, or a `cns` without the method, leaves the record as it is. The same exchange calls `granted()`, which returns the other device's current incoming grants for this one, and saves them as `grants.outgoing`, so the display follows later `cns peer grant` and `revoke` on that device. The record is only rewritten when it changed.
- An attachment that loses its link is re-established automatically after the link is back: the host redraws the current screen, as a manual reattach does today, and then streams. Every chunk a session emits carries a sequence number; the client remembers the last one it rendered, and the redraw reports how many bytes it skipped, shown as `[cns: N bytes of output missed]`. Retained scrollback stays bounded at 1000 lines and is available with `--history`; nothing beyond it is replayed.
- Input in flight: the host acknowledges each `write`/`keys` by sequence. Input not acknowledged when the link dropped is reported as uncertain (`[cns: 1 keystroke may not have arrived]`) and is **never resent automatically**.
- Repeated recovery never creates a second session or a second viewer for the same client; the client re-attaches by session name and owner.
- `access-revoked` and `session-expired` end recovery with that reason and a non-zero exit; `host-lost` (the host daemon is gone, so its sessions are gone) does too.

## 8. Transport: direct, relayed, and iroh/QUIC

The link design in section 3 is transport-independent: identity and grants hold over any byte stream, and session continuity belongs to the host, not the connection. That lets the transport be decided on evidence.

| Option | Direct | Relay | Bun fit | Compiled binary | Cost and ownership |
| --- | --- | --- | --- | --- | --- |
| WebSocket as today | LAN, VPN, port forward | none | native | yes | none |
| WebSocket plus a `cns` relay | as above | a Cloudflare Worker, built into cns, that forwards ciphertext between two device IDs | native | yes | one hosted Worker, run by the project |
| iroh (QUIC, hole punching, public relays) | direct across NATs | iroh's relays or self-hosted | N-API addon (`@number0/iroh`) per platform; Bun's N-API support must be verified for the binary | native addon must be bundled per target | relay traffic goes through n0's or your own servers |

**Built (PR 26, made built-in by [ADR 0001](adr/0001-built-in-relay.md)):** the relay protocol in `src/relay-hub.ts` and the Cloudflare Worker in `relay/` (Durable Objects with WebSocket hibernation), which is the relay built into cns: every daemon registers there and every device dials paired devices there, with no URL or token to set up. The relay accepts only requests carrying the `Cns-Client` header, an HMAC under a client key built into cns; that keeps other programs off it, not a determined person, as the ADR explains. `src/relay-server.ts` runs the same relay in Bun for tests and development (`CNS_RELAY=URL` or `off`). A daemon registers by signing a challenge bound to the relay's host; dialers reach a registered key, and the daemon answers each over a fresh connection that the relay pipes to the dialer. Saved addresses are tried direct first and relay last: `connectFirst` dials every direct address at once and relays 300 ms later (`RELAY_HEAD_START_MS`), or at once when every direct address has failed, so a dead address costs the head start rather than a timeout. Only opening is raced: opened sockets authenticate one at a time and the rest are dropped unauthenticated, so the device sees one link and one use of an invite. A standing link through the relay does not stay there: from `UPGRADE_AFTER_MS` (twice the dial race) after it was made, each daemon's dial loop tries the device's direct addresses alone, with its usual backoff, and a direct link that opens replaces the relayed one on both sides (the other daemon takes a daemon link dialed after the race as replacing the one it holds). Two daemons that dialed each other at once often keep the relayed link, because the smaller key's outbound link wins even when the other side's is direct, and a device behind a firewall that drops inbound connections can only be reached directly over the link it dials.

Evaluation evidence to collect before **Decision 8 (transport)**: Bun N-API loading of the iroh addon inside `bun build --compile` for each target in the flake; binary size and startup time; direct-connection success rate between two home NATs with and without a relay; latency added by a Cloudflare Worker relay versus an iroh relay; metadata each relay sees (device IDs and traffic volume only, with section 3's encryption); operating cost. Recommendation: ship end-to-end encryption over WebSocket first (it is needed regardless), add the small self-hosted relay as the second transport with the fallback order direct then relay, and adopt iroh only if the N-API packaging proves clean, because it then adds hole punching without changing identity or grants.

## 9. Compatibility and migration

The plan first kept the unauthenticated mode beside paired devices. Once the relay was built in, so that paired devices reach each other on any network with nothing to set up, the legacy mode was removed without a compatibility path:

| Existing | Now |
| --- | --- |
| `cns listen` / `cns connect URL` | Removed. `cns up` runs the daemon, which accepts only paired devices; a device that can only dial out links to the other's daemon, directly or through the relay. |
| `--one-way` | Removed. Commands you run always offer the other device nothing back; a daemon link offers what was granted, and an empty grant is the one-way case. |
| `cns peer add` and address aliases | Removed. `cns peer remove/list [--json]` work on paired devices; `cns peer address` changes where one is dialed. |
| `--peer NAME`, URL arguments, `--bind`/`--port` on commands | Removed. Every command takes a paired device's name as its first argument. |
| `cns mcp --daemon`, `cns mcp URL` | `cns mcp DEVICE` for one paired device; `cns mcp` alone for the devices linked to the daemon. |
| Pi's `/cns listen`, `CNS_LISTEN`, `/cns attach host[:port]` | `/cns up`, `CNS_UP`; `/cns attach` takes a paired device's name or a linked device's ID. |
| Named sessions, `keys`, `screen`, `kill`, `tty --attach` | Unchanged semantics, on a paired device; handles follow PR 19. |
| Daemon control (`attach`, `stop`, `~/.cns/daemon.json`) | Same daemon; `up` is its only front door. |
| Older `cns` on one side | Refused at the handshake, with a message saying so. |
| Windows | Identities and paired devices are kept in `~/.cns`, whose ACL must allow only the user, SYSTEM and Administrators (checked with `icacls /save` by SID). |

## 10. Slices

Each slice is a PR with its own tests, merged after review, in this order unless a decision above changes it:

1. **Identity file and fingerprints** (`cns identity` to show them; section 1). Tests: creation, mode checks, stable fingerprint, refusal of unsafe files.
2. **Authenticated link** (section 3), with the legacy path untouched. Tests: success, wrong identity, refusal codes, tampered and replayed messages, invite proofs.
3. **Pairing** (section 2): invite format, `cns pair` both roles, confirmation prompts, peers file v2 with address-book compatibility, error texts and exit statuses.
4. **Grants** (section 4): `GrantedShell`, derived handles, `cns peers grant/revoke`, live revocation through `HandleScope`, expiry.
5. **Peer daemon and CLI** (section 5): `up`, link dedup, positional targets, `peers`, `status`, `doctor`, `--json` outputs, exit statuses; MCP and Pi target resolution.
6. **Session ownership** (section 6): owner on `PtySessionInfo`, `main` default, kill rules.
7. **Reconnect and recovery** (section 7): link backoff, re-attach with gap and uncertain-input markers, state words everywhere.
8. **Relay** (section 8): the relay, built into cns (ADR 0001), fallback order, `doctor` showing the path.
9. **iroh evaluation** (section 8): a spike that records the evidence table; adoption is a separate decision.
10. **Release matrix**: macOS, Linux, Windows where applicable, compiled binary, Pi package, Nix check, with runtime versions recorded per result as the handover asks.

## Decisions to settle

1. Key storage: settled as a file under `~/.cns` (`src/identity.ts`); the OS keychain can come later.
2. Link encryption: settled. libsodium `crypto_kx` and `secretstream`, bound to the authenticated handshake (`src/secure.ts`).
3. Grant granularity: seven permissions with three presets (recommended) or three coarse grants.
4. Revocation kills running commands at once (recommended) or lets them finish.
5. `cns tty studio` without a name uses the `main` named session (recommended) or an unnamed PTY.
6. Exclusive-control lease for sessions: not in the first release (recommended).
7. Session persistence across host restart: not in this plan (recommended).
8. Transport order: settled. Encrypted WebSocket, direct first and the built-in relay (the Cloudflare Worker in `relay/`, [ADR 0001](adr/0001-built-in-relay.md)) last; iroh evaluated and deferred, see [iroh-evaluation.md](iroh-evaluation.md).
