# ADR 0009: The gateway as a mesh member that dials, never answers, and holds no secrets

- Status: proposed
- Date: 2026-11-27

## Context

The gateway (ADR 0002) reaches only the devices that paired with it. A device that joins one of
the owner's meshes (ADR 0005) later was out of reach for Claude's connectors until it also
paired with the gateway. The owner wanted connectors to pick up such devices on their own.

A device reaches only peers that accepted it. So the gateway cannot use a device's own peers
through that device: those peers never agreed to the gateway, and the device's grants are
its own, not something to lend. A mesh is different. Each member already lets the admin choose
who else may reach it, within what the member allows members. The gateway can join a mesh
under the same rule.

As a plain member, though, the gateway would get two things it must not have. Members would
dial it every 30 seconds through the relay, where it is never registered. And mesh secrets for
every member would be sealed to its key, so anyone who changed the gateway's code in Cloudflare
could read secrets on devices that grant it nothing.

## Decision

- **The admin lists the gateway as the gateway.** `cns mesh add NAME GATEWAY --gateway`, on the
  admin, lists a device that is paired with it and marks it `gateway: true` in the member list.
  Unless `--limit` says otherwise, its limit is what the admin lets the gateway use. Each member
  then lets it use what that member allows members, within that limit.
- **A list that names a gateway is `v: 2`.** A list without a gateway stays `v: 1`. A cns from
  before 2.6.0 cannot read a `v: 2` list, so that member leaves the mesh (`droppedBy`). It does
  not let the gateway in as a plain member. After an upgrade, `cns mesh join` brings it back.
- **Members save it as a gateway.** Its record is marked `gateway: true`. Members do not dial
  it (`worthDialing`), and it is no member for secrets: no secret is sealed to it, set by it,
  or set for it (`isMember` in secrets.ts). `cns secret set --device` refuses it. The record's
  `gateway` field is informational (`PEER_FIELDS` in peers.ts): it decides only whether a
  member dials the gateway, so a cns that ignores it only dials it for nothing.
- **The gateway asks for lists while listing devices.** `list_peers` already opens a link to
  each paired device. On that link it calls `meshes([])`. A device answers with the lists of
  the meshes that list the caller. The gateway keeps a list only when it was signed by the
  device that offered it and names the gateway as its gateway. It keeps the newest version, and
  it forgets a mesh that this device no longer offers. It then reaches the members in the same
  call. Removing a device from the gateway removes the meshes that device runs.
- **Only approvals for all devices reach mesh members.** An approval for named devices still
  reaches only the paired devices named, by key.

## Consequences

- One command on the admin brings a mesh to Claude, and members added later are reached
  without any step at the gateway, a reconnect, or a pairing with the gateway.
- Every member must run 2.6.0 or newer before the gateway is added, or it leaves the mesh.
- The gateway learns of a new member only at its next `list_peers`. Until then a call that
  names the member fails with `Unknown peer`, and the error says so.
- The gateway can reach members of a mesh that a non-owner device runs, if that device is paired
  with the gateway. Owners approve connectors, and the admin decides on each mesh.
- Someone with the admin's identity could add the gateway to a mesh. That device can already
  add any device. Each member's `--allow` bounds both.
- `cns gateway status` lists the meshes and the members reached through them.

## Alternatives considered

- **Use a device's peers through that device**: rejected. Those peers never accepted the
  gateway, and they could not tell its calls apart from the device's own.
- **The gateway as a plain member**: rejected because of the dialing and secrets described
  above.
- **A separate signed record that admits the gateway, outside the member list**: members from
  before the change would ignore it, which is safe. But it needs its own versioning, a way to
  spread, and a way to be revoked, which is a second copy of the member list's rules.
