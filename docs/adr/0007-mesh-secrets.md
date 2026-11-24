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

## Addendum, 2026-11-24: using a secret without printing it (cns 2.0.0)

- **Naming.** A secret is written `NAME` or `MESH:NAME`. `get` and `rm` look in every mesh
  the device is in and need the mesh only when two hold the name; then they refuse and
  show both. `set` takes a bare name on a device in one mesh and asks which in several:
  it never chooses where a value goes.
- **`cns secret run [--only NAMES | --exclude NAMES] -- COMMAND`** runs a command on this
  device with the secrets it reads as environment variables, so a value need not pass
  through `$(cns secret get ...)` and a shell's history. Two meshes holding one name among
  the chosen stop the command: one variable holds one value, and picking silently would
  hand a program the wrong key. The command follows the rules of `cns run`: its words are
  joined with spaces and a shell runs them, so a word with spaces must be quoted for that
  shell. Running the words as an argument list, as `env` does, was the alternative; it
  keeps argument boundaries but makes `cns secret run -- 'a | b'` and `cns run DEVICE --
  'a | b'` behave differently.
- **Variables another member chose.** Any member may set a secret of any name, and before
  `secret run` a name was only a label. Now a member could set `PATH` or `BASH_ENV` and so
  run code in every command another member starts with all its secrets. Without `--only`,
  `secret run` therefore refuses a variable that tells programs what to run or where to
  connect when a device other than this one set it, and says who did; `--only` names what
  the command gets and is not checked. The list of such names cannot be complete, since
  any program may read a variable of its own, so a mesh with members that are not trusted
  to run commands on the others needs `--only`.
- **`--secret NAMES` on `cns run` and `cns shell`** opens the secrets on the calling device
  and sends them as an `env` option of the call that starts the program, over the encrypted
  link. cns never puts them in the command string or in the arguments of what it starts,
  and a session's listing does not include them; a command that expands one into another
  program's arguments puts it there itself. The target need not be a member of the mesh,
  nor the device a `--device` secret was set for: a reader can already print the value and
  send it any other way, so the option is no new power, but it is a new and easy path by
  which a value reaches a device outside the mesh, where the program, its children and
  that device's user can read it. A device that starts a session receives the variables
  before it can refuse the call for another reason. A device from before this refuses the
  unknown option before starting anything, and the caller says to update it.
- The first consequence above about agents holds here too: an agent with `shell` on a
  reader can run `cns secret run`. There are still no MCP or pi tools for secrets.

## Alternatives considered

- **Fetching from the owner when needed.** Simpler, but it fails whenever the owner sleeps,
  which is most of the time for a laptop.
- **One key for the whole mesh.** Simpler, but every device that was ever a member would keep
  it and could open any later record it got hold of.
- **Every member may change every secret.** Simpler to describe, but then any one member,
  such as a bot running untrusted code, could replace a value every other member uses.
- **The OS keychain.** Headless Linux, WSL, NixOS services and bots often have none. Moving
  `identity.json` into a keychain later would protect secrets with it.
