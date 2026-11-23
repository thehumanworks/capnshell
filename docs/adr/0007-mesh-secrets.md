# ADR 0007: Mesh secrets, sealed to each member that may read them

- Status: proposed
- Date: 2026-11-23

## Context

Members of a mesh are devices its admin accepted into one group. They often need the same
secrets, such as API keys and tokens, and so do bots and sandboxes that join and leave
quickly. Copying a value to each machine by hand puts it in shell history, chat logs and
files nobody tracks, and a machine that joins later has to be set up again.

The goal was `cns secret set MESH NAME` on any member, `cns secret get MESH NAME` on every
member that may read it, now and later, and `--device NAME` to set or get a secret for one
member only, without a server, without changing the relay, the gateway or the handshake,
and with nothing readable by a device that may not read it.

## Decision

- **A signed record per secret.** The member that sets a secret, its owner, signs a record:
  the mesh's name and admin, its own key, the name, the one member it is for (with
  `--device`) or none (every member), a version, and the value encrypted once with
  XChaCha20-Poly1305 under a fresh key for that version. The signature covers
  `cns-mesh-secret-1\0` and the record's exact JSON text. Removing a secret is a newer
  version with no value, so an old copy cannot bring it back.
- **Sealed to each reader's device key.** The version's key is sealed (libsodium sealed box)
  to each reader's Ed25519 identity, converted to X25519. There is no mesh key: a device
  that left cannot open a version made after it left.
- **Copies on every reader.** Each reader keeps the record with the key sealed to itself,
  as a private file in `secrets/` in the configuration directory, so `get` reads local disk
  and works offline, and no file holds a value in the clear.
- **Passing records along.** Beside the `meshes` call, a daemon offers each linked device the
  records that device may read, each with the key sealed to it, through a `secrets` call on
  the shell it already exports, which needs no grant. A device keeps an offered record when
  the device offering it is a member, its owner signed it, the owner (and the member it is
  for) are in the mesh's current list, this device may read it, the key opens the value,
  and its version is newer than the one held. Then it passes the change on. Any reader can
  pass a record on and seal it for a member that joins later; none can change, forge or
  roll it back.
- **One writer per secret.** Only the owner changes or removes its secret. `set` refuses a
  name another member already set for the same readers, so a member, a bot say, cannot
  quietly replace a value others use.
- **Leaving.** Records whose owner, or whose one reader, leaves the mesh, and every record
  of a mesh this device left, are deleted when the member list changes.
- **Reading.** `get` prints the value on stdout. On a device, a secret set for it alone comes
  before the mesh's. `list` shows names, owners and readers, never values. `set` reads the
  value from a hidden prompt or stdin, never from an argument.

## Consequences

- A secret reaches a member that joins later from any reader that is online, so neither
  its owner nor the admin has to be.
- The admin's identity becomes worth more: someone who steals it can add a device, which
  readers then seal every mesh-wide secret to. This is the trust the mesh already gives
  the admin over who reaches each device.
- A member that leaves keeps every value it read while it was one. For a lost or stolen
  device, change those secrets at their source, then set them again.
- Someone who can read a member's configuration directory can read its identity too, and
  so open its secrets; this is the same trust the identity has today.
- An agent with `shell` on a reader can run `cns secret get`. There are no MCP tools for
  secrets; use `--device` to keep a secret off devices agents use.
- A cns older than secrets does not answer `secrets`, so it receives nothing. The member
  list is unchanged, so older members stay in the mesh.

## Alternatives considered

- **Fetching from the owner when needed.** Simpler, but it fails whenever the owner sleeps,
  which is most of the time for a laptop.
- **One key for the whole mesh.** Simpler, but every device that was ever a member would keep
  it and could open any later record it got hold of.
- **Every member may change every secret.** Simpler to describe, but then any one member,
  such as a bot running untrusted code, could replace a value every other member uses.
- **The OS keychain.** Headless Linux, WSL, NixOS services and bots often have none. Moving
  `identity.json` into a keychain later would protect secrets with it.
