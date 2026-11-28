# ADR 0010: Removing a lost device without widening anything

- Status: proposed (the revoked list below waits for Tomas to confirm it over the zero-grant
  record of commit 5832a5f)
- Date: 2026-11-28

## Context

When a device is lost or stolen, its key must leave every device, mesh and gateway that trusts
it. `cns peer remove NAME --everywhere` does that from one trusted device, using only the
authority that device already has: its own records, the meshes it runs (ADR 0005), the gateway
when it is an owner (ADR 0002), and the devices that let it run commands, where it runs their own
`cns peer remove --fingerprint FP --meshes` through `cns run`. That keeps their grant checks and
audit log in the path.

Reviews found these ways that removing something could still give the lost device more access.

1. **A deleted pairing makes way for a member record.** A direct pairing wins over a mesh's
   record for the same key (`planMesh`). If a member deletes its pairing with a device that a
   mesh it is in also lists, the next settle saves a member record with what that member allows
   members. A pairing that granted nothing became `shell`. The list saved here can also be older
   than the admin's, so a device the list does not name yet can be named by the next list.
2. **Keeping that pairing with no grants is not enough.** The first fix kept the pairing with no
   grants. That record is still a live peer: the daemon dials it, and learns addresses and grants
   from it. It also kept a bot's name taken after `cns mesh remove --unpair`, it did nothing for a
   device that was only a mesh member, and a finished run still exited 4.
3. **A mesh the lost device runs stays open.** Whoever has the admin's key can sign new lists,
   add a device of their own, and get what each member allows members. The lists reach members
   through any member that is still linked to them.
4. **The gateway was asked even when none is used,** and a device paired with the gateway was
   asked to run commands, which it never does, so the run could not finish.

## Decision

- **A revoked list.** Every `cns peer remove` (plain, `--fingerprint`, `--everywhere`) and
  `cns mesh remove --unpair` first writes `~/.cns/revoked/FINGERPRINT`. That is a private file,
  like the other state, holding the key when it is known and the time. Then it deletes the
  pairing, direct or a mesh member's, and the running daemon ends its links. While a fingerprint
  is on the list:
  - `planMesh` gives it no record from any mesh, and removes one it has.
  - `secretsFor` seals nothing to it.

  The list uses fingerprints, so `--fingerprint` can keep out a device this one never saw. The
  entry is written before the pairing goes, so a list that arrives in between gives no record.
- **Pairing directly is the way back.** Saving a direct pairing (`savePairedPeer` with no mesh)
  deletes the entry. That covers `cns pair`, a pairing the daemon accepts, and a bot's pairing
  with its admin. There is no command for it.
- **One path.** Plain `cns peer remove NAME` is the pairing step of `--everywhere`, printed in
  short: `Removed NAME.` It also says which meshes the device can still change: one it runs
  (`cns mesh leave NAME`), or one this device runs that lists it (`cns mesh remove NAME DEVICE`).
  Both also name `--everywhere`. `unpair` checks the key saved under the name before it deletes
  anything. That is the one key check.
- **Narrow the meshes a lost admin runs.** With `--meshes` (which `--everywhere` runs on each
  device), every mesh whose admin is the lost key gets `allow` set to none on each device reached.
  The report gives `cns mesh allow NAME GRANTS` to undo it. It does not leave the mesh, because
  leaving drops the other members' records here. Narrowing is not enough on its own: mesh-wide
  secrets are still sealed to every member the lists name. So the report says to leave with
  `cns mesh leave NAME`, and the command exits 4 until the mesh is left.
- **The gateway.**
  - It is asked only when `CNS_GATEWAY` is set. Otherwise it is reported as `not used`, with
    `cns gateway status` and `cns gateway remove NAME` for an owner to run.
  - A paired device that is the gateway is not asked to run commands. It is reported as
    `not used`, pointing at the gateway line. A device counts as the gateway when its mesh record
    says so, when its fingerprint is the one the gateway answered with, or when it gave no
    address and lets this device do nothing. That last sign is the one `worthDialing` uses.
  - The `OWNER_KEYS` advice is given only when the gateway removed the device.
- **Remote answers are data** (`readAnswer`).
  - Each answer must match a schema: at most 20 places, short strings, and outcomes this cns
    knows.
  - `printable` replaces C0 and C1 controls and characters that reorder text.
  - In a dry run, an answer that claims a change is not taken.
  - Every `next` command is built on this device from the fingerprint. The fingerprint's pattern
    is anchored, and it is the only text placed on another device's command line.
  - `--json` output writes C1 controls, those characters and line separators as `\uXXXX`.
- **Exit status.**
  - 0 when every place is done.
  - 4 while any place still needs something run there: not permitted, or a lost admin's mesh.
  - 1 while any place was unreachable or failed.

  Each place is attempted on its own, so one failure does not stop the others. A dry run makes no
  identity, and no revoked entry.

## Consequences

- **The trade-off.** A removed device comes back only by a direct pairing, on each device that
  removed it. A mesh alone cannot bring it back. If its admin lists it again, every member that
  removed it still gives it no record, and nothing tells that member's person. That is the point
  of the list: a mesh admin cannot undo a member's removal. To let it back in through a mesh,
  pair with it directly, or delete `~/.cns/revoked/FINGERPRINT` by hand.
- Plain `cns peer remove` now removes a mesh member's record, which it used to refuse. The
  removal holds, because the list keeps the record from coming back.
- The list grows by one small file per removed device. Nothing prunes it.
- A device that lets the lost device run commands can be made to run `cns peer remove` there. It
  could already be made to run any other command, so this adds nothing that `cns run` did not
  allow.
- Members of a lost admin's mesh lose access to each other on every device that was reached,
  until someone leaves the mesh or runs `cns mesh allow` again.

## Known limits

- **Connectors a lost gateway owner approved stay approved.** The Worker records who approved
  each consent (`approvedBy`), but `status` does not return it, so cns cannot revoke those
  connectors automatically. That needs a Worker change. Until then the report says to take the
  key out of `OWNER_KEYS` (`npx wrangler secret put OWNER_KEYS`), then review `cns gateway grants`
  and run `cns gateway revoke ID`.
- **A list signed by a lost admin is still taken.** Narrowing and leaving answer it. Refusing new
  lists whose admin is on the revoked list would be a follow-up.
- A record file that names no key is deleted without a revoked entry, because there is no key to
  keep out.
- The gateway sign can match a real device that was paired with no address and lets this device
  do nothing. The report then gives the command to run there, and the exit status does not count
  that device.

## Alternatives considered

- **Keep the pairing with no grants** (commit 5832a5f). Rejected for the reasons in Context. To go
  back to it, restore `coveringMeshes` and the old `unpair` from that commit, and drop
  `revokedFiles`, the `revoked` argument to `planMesh` and the `secretsFor` check.
- **A tombstone record in `peers/`.** Rejected: every reader of peer records would have to skip
  it, and it would keep the name taken.
- **Leave a lost admin's mesh automatically.** Rejected, because it drops the other members'
  records and secrets here without asking that device's person.
- **Ask the default gateway when `CNS_GATEWAY` is not set.** Rejected, because most devices use
  no gateway, or use one of their own.
