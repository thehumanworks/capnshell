# ADR 0010: Removing a lost device without widening anything

- Status: accepted (Tomas confirmed the removed-keys design on 2026-11-28)
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
   Refusing its new lists is not enough either: a member may have taken such a list between the
   theft and the removal, so the last list it took can already name a device the thief added.
4. **A record cns cannot read hides the key.** A record file that is not private, or is a link,
   as after a backup was restored or under a dotfile manager, fails the private-file check. The
   removal then found no key: it deleted the file and kept nothing out, or did nothing at all, and
   once the file was made private again the lost device was back.
5. **Text from other places is passed on.** Another device's answer and the gateway's errors
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
  - The daemon lets no record of it in: `authorize`, `offerTo` and the dial loop refuse its key,
    so a record left behind, or restored, does not let it in. That is one look at the revoked
    directory per connection. A revoked directory that is not private fails closed: the daemon
    lets nothing in, and `cns peers` and `cns run` here name the directory and the `chmod` to run.
  - No command connects to such a record, as what it sends would go to whoever has the key,
    and what it takes, such as a skill, would come from them. `refuseRemoved` is checked where
    every command's connection is made (`openDeviceLink`, before the daemon is asked to lend its
    link), and by `cns doctor` and Pi, which dial on their own. A command named for the device
    says so, with the command that deletes the record; one that asks every device, such as
    `cns sessions`, `cns skills`, `cns ui` or `cns upgrade --all`, leaves it out
    (`reachablePeers`), and `--everywhere` reports it as `not used`, so it does not learn the
    fingerprint being removed.
    Pairing is not refused, as it is the way back. `cns peers` marks it `removed`, and
    `cns peers --json` and `cns peer list --json` give `revoked`. `secure.ts` does not check, as
    the gateway's Worker shares it and keeps no revoked list.
  - `newerLists` takes no list it signs. A mesh it runs stays at the last list this device took.
  - `secretsFor` seals nothing to it. A secret version it set, or one set for it, is not kept or
    read, even when another member passes it on (`meshOf`), and `pruneSecrets` deletes it.
  - A bot token for a mesh it runs is refused (`startAsBot`), with what to do instead: get a new
    token, or stop using that one. A token is no person's decision to trust that admin again.
  - `cns mesh list` marks it `(revoked)`, so a mistaken removal can be seen.
- **The key is read loosely, for this only.** To find the key of a record that fails the
  private-file check, `savedKey` reads it anyway, through a link too, from a regular file of at
  most 64 KiB. Putting a key on the revoked list only narrows, so a file anyone could have written
  is safe to read for it. Nothing else reads a record that way. Whoever may write that file, or
  where it links, chose the key, so the report gives its fingerprint and says the file was not
  private, and `--everywhere` refuses such a key unless `--fingerprint` names it. Every record
  that names the key goes, those read loosely first, so that a link goes before the record it
  points to; each is named.
- **Pairing directly is the way back.** Saving a direct pairing (`savePairedPeer` with no mesh)
  deletes the entry. That covers `cns pair` and a pairing the daemon accepts. A mesh record does
  not, and neither does a bot token, which is refused first. The entry is looked up before the
  pairing is written, so a revoked directory that cannot be read stops the pairing. The entry
  is deleted only after the pairing is saved, so a pairing that fails leaves the device revoked.
  `cns pair` says so on both sides, with `--yes` too, as one line of its summary: the other
  device was removed here before, and pairing again lets it back in. The side that types the
  code reads the revoked directory before it connects. There is no other command for it.
- **A mesh the lost device runs is narrowed.** On every removal, plain or not, each such mesh
  gets `allow` set to no grants here, so its members may use nothing here, whoever its last
  list names, and `secretsFor` and `takeSecrets` pass none of its secrets. It is reported as
  `narrowed` (`not permitted` when it allowed nothing already), with `cns mesh leave NAME` to
  finish, and the command exits 4 until it is left. `cns mesh allow NAME GRANTS` undoes the
  narrowing, which the report offers only once `cns mesh list NAME` shows no device the person
  does not know; `cns mesh allow` warns while the mesh's admin is on the revoked list, and a
  removal run again narrows it again. Secrets this device already took from that mesh stay
  readable here: a device the thief added may have set them, so the report says so when there
  are any, and that `cns mesh leave NAME` drops them. Leaving stays that device's person's call,
  because it drops the other members' records there. A device reached through `cns run` is given `cns run DEVICE -- cns mesh leave
  NAME`, built from the mesh name its answer gave, which must match a mesh name's pattern.
- **One path.** Plain `cns peer remove NAME` is `removeHere` without `--meshes`, printed in
  short: `Removed NAME.` (each record that named the key, when there were more), then a line for
  each mesh here that it runs (frozen at its last version and narrowed, with the commands
  above), each mesh here that lists it (it gets no record from that mesh until this device
  pairs with it directly), and each step that failed. A pairing step that fails says which
  records went before it, and the other lines follow all the same. It brings the
  records in line with the lists every time, after the entry is written, so a record a running
  daemon saved meanwhile goes too. `unpair` checks the key saved under the name before it
  changes anything. That is the one key check; when the name names another key, or none, it
  is left as it is, and the report says so.
- **The gateway.**
  - It is asked only when `CNS_GATEWAY` is set. Otherwise it is reported as `not used`, with
    `cns gateway status` and `cns gateway remove NAME` for an owner to run.
  - Every gateway line says how to take an owner's key out of `OWNER_KEYS`, because an owner
    that the gateway never paired can still approve connectors.
  - A paired device that is the gateway is not asked to run commands, and is reported as
    `not used`. It counts as the gateway when its mesh record says so, or when its fingerprint is
    the one the gateway answered with.
  - A device that gave no address and lets this device do nothing, as the gateway's pairing does
    (`worthDialing`), is not asked either. While no gateway answered, it may be the gateway or a
    device, so its line gives the command to run there, and it counts toward exit 4. Once a
    gateway answered with another fingerprint, it is a second gateway or a device that only
    dials this one. Neither could ever be asked, so its line says what to run for each and it
    does not count toward exit 4, which nothing could then clear.
- **Every word in the report is this cns's.**
  - Another device's answer must match a schema (`readAnswer`): at most 20 places, each one that
    `removeHere` reports, in outcomes this cns knows. Only its places and outcomes are kept.
  - In a dry run, an answer that claims a removal or a narrowing is not taken.
  - Every `next` command is built on this device from the fingerprint, and from each place and
    outcome (`answerPlaces`). The fingerprint's pattern is anchored. It and a mesh name that
    matches the place pattern are the only text placed on another device's command line.
  - Nothing a device says is quoted. When its answer cannot be read, or its command fails, the
    line says so and gives the command that shows it there.
  - Text from elsewhere that is kept, an error the gateway sent or a local error, is made
    `strictlyPrintable` where the place is made, and the gateway's words are quoted as its own
    (`The gateway answered 401 and said: "..."`): control, format and line or paragraph separator
    characters are replaced, so neither the report nor `--json` carries one. The shared
    `printable` keeps format characters for other output, such as right-to-left session titles.
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
  removed it still gives it no record. A plain removal names those meshes, `cns mesh list`
  marks it, and `cns pair` says so. That is the point of the list: a mesh admin cannot undo a
  member's removal. To let it back in through a mesh, pair with it directly, or delete
  `~/.cns/revoked/FINGERPRINT` by hand.
- A plain removal bans the key from every mesh here, which can break a setup that relies on one,
  such as a gateway that reaches a device only through a mesh (ADR 0009). The removal says which
  meshes list it, so this is never silent.
- A mesh whose admin was removed is frozen and narrowed here, not ended. Its members may use
  nothing here until this device's person allows them again or leaves it. A machine that runs
  as a bot of that mesh lets the lost device in until it is removed there too, and must stop
  using its token.
- Plain `cns peer remove` now removes a mesh member's record, which it used to refuse. The
  removal holds, because the list keeps the record from coming back.
- The list grows by one small file per removed device. Nothing prunes it.
- Devices removed with cns 2.8.0 or earlier are not on the list. Remove them again with
  `cns peer remove --fingerprint FINGERPRINT` (or with `--everywhere`).
- A device that lets the lost device run commands can be made to run `cns peer remove` there. It
  could already be made to run any other command, so this adds nothing that `cns run` did not
  allow.

## Known limits

- **Connectors a lost gateway owner approved stay approved.** The Worker records who approved
  each consent (`approvedBy`), but `status` does not return it, so cns cannot revoke those
  connectors automatically. That needs a Worker change. Until then each gateway line says to take
  the key out of `OWNER_KEYS` (`npx wrangler secret put OWNER_KEYS`), then review
  `cns gateway grants` and run `cns gateway revoke ID`.
- **Only devices that were reached freeze and narrow a lost admin's mesh.** A member on an older
  cns, or one not reached, still takes its lists and passes them on. The report names each such
  device.
- A record file that names no key is deleted without a revoked entry, because there is no key to
  keep out, and the removal says so.
- A device whose configuration directory is new, such as a CI runner that starts a bot from a
  token each time, has no revoked list, so it takes the token. Stop using the token.

## Alternatives considered

- **Keep the pairing with no grants.** Rejected for the reasons in Context.
- **A tombstone record in `peers/`.** Rejected: every reader of peer records would have to skip
  it, and it would keep the name taken.
- **Leave a lost admin's mesh as it is once its lists are refused.** An earlier draft chose this,
  reasoning that the mesh can no longer change here, so what its members may use stays as the
  person set it. Rejected: that ignored lists taken after the theft and before the removal,
  which can already name a device the thief added, and which keep what members may use.
- **Leave a lost admin's mesh automatically.** Rejected, because it drops the other members'
  records and secrets here without asking that device's person.
- **Strip format characters in the shared `printable`.** Rejected: it would turn right-to-left
  marks and joiners in session titles and terminal panes into `?`. Output that must show each
  character as itself, the audit table and this report, uses `strictlyPrintable`.
- **Ask the default gateway when `CNS_GATEWAY` is not set.** Rejected, because most devices use
  no gateway, or use one of their own.
