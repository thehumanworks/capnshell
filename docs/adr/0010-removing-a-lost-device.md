# ADR 0010: Removing a lost device without widening anything

- Status: proposed (Tomas to confirm the revoked list)
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
2. **Keeping that pairing with no grants is not enough.** A record with no grants is still a live
   peer: the daemon dials it, and learns addresses and grants from it. It also does nothing for a
   device that is only a mesh member.
3. **A mesh the lost device runs stays open.** Whoever has the admin's key can sign new lists,
   add a device of their own, and get what each member allows members. They can also set new
   versions of the mesh's secrets, which other members pass on, and mint bot tokens for it.
4. **Text from other places is passed on.** Another device's answer and the gateway's errors
   ended up in the report, which agents are told to pass on to the user.

## Decision

- **A revoked list.** `unpair`, which every `cns peer remove` and `cns mesh remove --unpair`
  uses, first writes `~/.cns/revoked/FINGERPRINT`. That is a private file, like the other state,
  holding the key and the time. Then it deletes the pairing, direct or a mesh member's, and the
  running daemon ends its links. `--fingerprint` writes the entry even when no record is saved,
  so it also keeps out a device this one never saw. While a fingerprint is on the list:
  - `planMesh` gives it no record from any mesh, and removes one it has. `applyMeshes` reads the
    list after the records in each pass. A device revoked and then removed meanwhile is either
    still in the records, so gets no new one, or already on the list.
  - `newerLists` takes no list it signs. A mesh it runs stays at the last list this device took.
  - `secretsFor` seals nothing to it. A secret version it set, or one set for it, is not kept or
    read, even when another member passes it on (`meshOf`), and `pruneSecrets` deletes it.
  - A bot token for a mesh it runs is refused (`startAsBot`), with what to do instead: get a new
    token, or stop using that one. A token is no person's decision to trust that admin again.
  - `cns mesh list` marks it `(revoked)`, so a mistaken removal can be seen.
- **Pairing directly is the way back.** Saving a direct pairing (`savePairedPeer` with no mesh)
  deletes the entry. That covers `cns pair` and a pairing the daemon accepts. A mesh record does
  not, and neither does a bot token, which is refused first. The entry is looked up before the
  pairing is written, so a revoked directory that cannot be read stops the pairing. The entry
  is deleted only after the pairing is saved, so a pairing that fails leaves the device revoked.
  There is no command for it.
- **One path.** Plain `cns peer remove NAME` is the pairing step of `--everywhere`, printed in
  short: `Removed NAME.` It also says which meshes the device can still change: one it runs
  (`cns mesh leave NAME`), or one this device runs that lists it (`cns mesh remove NAME DEVICE`).
  Both also name `--everywhere`. `unpair` checks the key saved under the name before it changes
  anything. That is the one key check.
- **A mesh the lost device runs is left to leave.** With `--meshes` (which `--everywhere` runs on
  each device), each such mesh is reported as `not permitted`, with `cns mesh leave NAME` to run,
  and the command exits 4 until it is left. Its members keep what they may use here, and its
  secrets, under its last list. Leaving is that device's person's call, because it drops the
  other members' records there.
- **The gateway.**
  - It is asked only when `CNS_GATEWAY` is set. Otherwise it is reported as `not used`, with
    `cns gateway status` and `cns gateway remove NAME` for an owner to run.
  - Every gateway line says how to take an owner's key out of `OWNER_KEYS`, because an owner
    that the gateway never paired can still approve connectors.
  - A paired device that is the gateway is not asked to run commands, and is reported as
    `not used`. It counts as the gateway when its mesh record says so, or when its fingerprint is
    the one the gateway answered with.
  - When no gateway answered, a device that gave no address and lets this device do nothing, as
    the gateway's pairing does (`worthDialing`), is not asked either. It may be a device, so its
    line gives the command to run there, and it counts toward exit 4.
- **Every word in the report is this cns's.**
  - Another device's answer must match a schema (`readAnswer`): at most 20 places, each one that
    `removeHere` reports, in outcomes this cns knows. Only its places and outcomes are kept, and
    whether it said something is left to do.
  - In a dry run, an answer that claims a removal is not taken.
  - Every `next` command is built on this device from the fingerprint. The fingerprint's pattern
    is anchored, and it is the only text placed on another device's command line.
  - Text from elsewhere that is kept is made printable where the place is made: C0 and C1
    controls and characters that reorder text are replaced. Such text is an error the gateway
    sent, or a device's output when its answer cannot be read, which is quoted as `NAME said: "…"`.
  - A paired record this cns cannot read is reported as `failed`, with what to run on it, and is
    never silently skipped.
- **Exit status.**
  - 0 when every place is done.
  - 4 while any place still needs something run there.
  - 1 while any place was unreachable or failed.

  Each place is attempted on its own, so one failure does not stop the others. A dry run makes no
  identity, and no revoked entry.

## Consequences

- **The trade-off.** A removed device comes back only by a direct pairing, on each device that
  removed it. A mesh alone cannot bring it back. If its admin lists it again, every member that
  removed it still gives it no record, and nothing tells that member's person except
  `cns mesh list`. That is the point of the list: a mesh admin cannot undo a member's removal. To
  let it back in through a mesh, pair with it directly, or delete `~/.cns/revoked/FINGERPRINT` by
  hand.
- A mesh whose admin was removed is frozen here, not ended. Its members keep what they may use
  here until this device leaves it. A machine that runs as a bot of that mesh must stop using its
  token.
- Plain `cns peer remove` now removes a mesh member's record, which it used to refuse. The
  removal holds, because the list keeps the record from coming back.
- The list grows by one small file per removed device. Nothing prunes it.
- A device that lets the lost device run commands can be made to run `cns peer remove` there. It
  could already be made to run any other command, so this adds nothing that `cns run` did not
  allow.

## Known limits

- **Connectors a lost gateway owner approved stay approved.** The Worker records who approved
  each consent (`approvedBy`), but `status` does not return it, so cns cannot revoke those
  connectors automatically. That needs a Worker change. Until then each gateway line says to take
  the key out of `OWNER_KEYS` (`npx wrangler secret put OWNER_KEYS`), then review
  `cns gateway grants` and run `cns gateway revoke ID`.
- **Only devices that were reached freeze a lost admin's mesh.** A member on an older cns, or one
  not reached, still takes its lists and passes them on. The report names each such device.
- A record file that names no key is deleted without a revoked entry, because there is no key to
  keep out.

## Alternatives considered

- **Keep the pairing with no grants.** Rejected for the reasons in Context.
- **A tombstone record in `peers/`.** Rejected: every reader of peer records would have to skip
  it, and it would keep the name taken.
- **Narrow a lost admin's mesh to no grants.** Rejected once its lists are refused: the mesh can
  no longer change here, so what its members may use stays as the person set it.
- **Leave a lost admin's mesh automatically.** Rejected, because it drops the other members'
  records and secrets here without asking that device's person.
- **Ask the default gateway when `CNS_GATEWAY` is not set.** Rejected, because most devices use
  no gateway, or use one of their own.
