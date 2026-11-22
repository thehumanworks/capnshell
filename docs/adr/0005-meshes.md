# ADR 0005: Meshes, from a member list one device signs

- Status: proposed
- Date: 2026-11-15

## Context

Two devices reach each other only after pairing, and each grants the other what its
person chose. For a handful of machines that should all reach each other, such as a
person's laptop, desktop and servers, that means pairing every two of them: 10 pairings
for 5 devices, each confirmed on both ends, and repeated for every device added later.

The goal was a group, a mesh, in which every member reaches every other one, set up
with one step per device, without weakening the rule that a device enforces its own
grants, and without changing the handshake, the relay or the gateway.

## Decision

- **An admin and a signed list.** `cns mesh create NAME` makes this device the mesh's
  admin; its existing identity signs the member list, so there is no new key to keep.
  The list holds the mesh's name, the admin's key, a version, and for each member its
  key, the admin's name for it, the addresses the admin has for it and an optional
  limit. The signature covers `cns-mesh-list-1\0` followed by the list's exact JSON text.
- **Joining through a pairing.** A member must be paired with the admin, and joins with
  `cns mesh join NAME --via ADMIN`, which fetches the list from the admin over that
  pairing. The admin's key is therefore one this device's person already confirmed,
  and joining needs no new code or secret. The device keeps the admin's key with the
  mesh and never takes a list signed by another key.
- **Records, not a new kind of peer.** A member saves every other member as a paired
  device record marked `mesh: NAME`. Handshakes, links, grants, commands and the
  daemon's dial loops then work as for any paired device. A device paired directly, or
  known through another mesh, keeps its record. The admin keeps no member records, and
  members none for the admin: they are paired already.
- **Each device sets its own grants.** A member's records for the others get what it
  allows members (`--allow`, `cns mesh allow`), within each member's limit from the list.
  The admin can narrow what a member gets anywhere; it can never widen what a device
  allows. `cns peer grant` and `revoke` refuse mesh records.
- **Passing lists along.** A daemon offers each device on a standing link the lists of
  the meshes that device is in, through a `meshes` call on the shell it already exports,
  which needs no grant. A device takes a list only when the mesh's admin signed it and
  its version is newer than its own, then brings its records in line and offers the
  change to every device it is linked to. Any member can carry a list; none can change,
  forge or roll one back.
- **Leaving.** When a device is removed, the other members drop its record and so end
  their links to it. The admin offers each device every list it is in, so a mesh the
  admin no longer offers a member is one that member was removed from, or that ended:
  the member then forgets the mesh. Only the admin's own link can tell a device that.
  A mesh that cannot be read here fails the whole exchange rather than seeming to have
  been dropped.
- **Dialing.** Mesh records are dialed like any other. A member that refuses this one
  as unknown may not have the newest list yet, so a member's dial loop keeps retrying
  with backoff instead of stopping.

## Consequences

- One `add` on the admin and one `join` on the device bring a device into the mesh.
- The admin's identity becomes more valuable: someone who steals it can add a device to
  every member's list, and that device gets what each member allows members. Each
  device's `--allow` bounds that, and `cns mesh allow NAME none` or `cns mesh leave NAME`
  on a member shuts it out there.
- Members learn each other's keys, names and the admin's addresses for them.
- A change spreads only while daemons run and are linked; a device that is offline
  catches up from any member when it returns. A removed device that never reaches the
  admin again keeps its records, but the other members refuse it.
- A cns older than meshes cannot read a mesh record and skips it, so it never lets a
  mesh member in, and it does not answer `meshes`, which then changes nothing.

## Alternatives considered

- **A separate mesh key.** Kept apart from any device, it would survive losing the
  admin device, but it is one more secret to store and back up. The admin's identity
  is already protected and confirmed by every member.
- **Every member may add others.** Simpler to grow, but then any one stolen device
  could add devices everywhere. One admin keeps that power in one place.
- **A shared secret or token per mesh.** Anyone who sees it could join, and taking one
  device out means replacing it everywhere. Per-device keys and a signed list avoid both.
