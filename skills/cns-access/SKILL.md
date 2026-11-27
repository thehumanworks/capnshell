---
name: cns-access
description: Explain and, when the user asks, change what the user's devices may do on each other with cns - pairing, grants, revokes, meshes, bot tokens and gateway approvals. Use when cns says Permission denied (exit 4), a device is missing from cns peers, or the user wants to pair a device, grant or revoke access, set up a mesh or add a CI bot.
---

# Access between devices with cns

Every grant is set and enforced by the device that grants it. Nothing reaches a device
until a person on it paired with the other device, or joined a mesh, and chose what to allow.

## Rules for agents

- Changing access is the user's decision. Run `cns pair`, `cns peer grant`, `cns peer revoke`,
  `cns peer remove`, `cns mesh join|allow|add|remove|delete|token` or `cns gateway approve`
  only when the user asks for that change. Otherwise give them the exact command to run.
- Ask for the narrowest grant that does the job.
- Pairing needs a person on both devices to compare fingerprints. Use `--yes` only after they
  have, and say so.
- A bot token (`cns mesh token`) is a credential. Never print it into a transcript.

## Grants

| Grant | Allows |
| --- | --- |
| `shell` | Run commands and open terminals. This is everything the user can do there. |
| `files` | Read, write and list files (`cns cp`, the MCP file tools). Also reads skills. |
| `skills` | Read `~/.agents/skills` only, without hidden files. Not part of `all`. |
| `sessions` | All of `sessions:list`, `sessions:create`, `sessions:view`, `sessions:control`, `sessions:kill` |
| `all` | `shell`, `files` and `sessions` |

A device may always view, type into and kill the sessions it started.

## Reading what is allowed

```sh
cns peers               # ACCESS: what this device may use on each one
cns peers --json        # access (there) and grants (what it may use here), mesh
cns doctor studio       # asks studio what it grants now, and saves it
cns mesh list           # meshes, members and limits
```

## Permission denied

A denied call exits 4, does nothing, and names the fix:

```text
Permission denied: shell not granted to laptop. To allow it, run on studio: cns peer grant laptop shell
```

Pass that command to the user to run on that device, if they want it. Do not work around a
denial by other means without their OK.

## Changing access (when the user asks)

```sh
cns peer grant laptop files            # on the granting device: allow more, at once
cns peer revoke laptop shell           # allow less; work that used it ends now
cns peer revoke laptop                 # nothing at all
cns peer remove laptop                 # unpair
```

A device that is in a mesh gets its grants from the mesh: `cns peer grant` refuses it, and
`cns mesh allow MESH GRANTS` on the granting device sets what every member may use there.

## Pairing two devices (a person on each)

```sh
studio $ cns pair                          # shows a code such as 42-orbit-canyon-velvet, waits
laptop $ cns pair 42-orbit-canyon-velvet   # both show fingerprints and ask what to allow
```

`cns pair --long` prints a `cns1:` invite for pairing without the relay. Both daemons must
run (`cns up`).

## Meshes: every member reaches every other

```sh
hub    $ cns mesh create home
hub    $ cns mesh add home laptop studio          # devices already paired with hub
laptop $ cns mesh join home --via hub --allow shell
studio $ cns mesh join home --via hub --allow files
```

`--allow` (default none) is what members may use on the joining device; the admin's
`cns mesh add home laptop --limit GRANTS` narrows one member further. A CI runner joins with
a token, written to a new private file on the admin:
`(umask 077; set -C; cns mesh token home ci --allow none >ci.token)`. Move it securely, then
run `cns up --token-file ci.token` on the runner. `cns mesh remove home ci --unpair` revokes it.

## Claude connectors through the gateway

A connector gets nothing until the user approves its sign-in code on one of their devices:
`cns gateway approve CODE --devices studio --tools read`. `cns gateway grants`,
`cns gateway revoke ID` and `cns gateway log` list, stop and audit connectors.
