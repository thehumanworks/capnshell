# ADR 0006: Mesh bot tokens, one token per bot

- Status: proposed
- Date: 2026-11-15

## Context

A machine nobody sits at, such as a CI runner, a server or an agent's container, cannot
confirm a pairing or type a code, and is often rebuilt from scratch for every job. It
should still be able to join a mesh (ADR 0005), so that the members reach it and it
reaches them, from one secret set in its environment and reused.

The choice was between one token per bot and one token that any number of machines use.
One token per bot was chosen: the token is the bot's identity, so each bot is a member
of its own, every device sees which bot did what, and removing one bot leaves the others.

## Decision

- **Minting.** `cns mesh token NAME BOT --allow GRANTS` runs on the mesh's admin. It makes a
  new key pair, adds the public key to the member list as BOT and signs the new version.
  The admin saves BOT as a paired device with no grants, as for a device that joined, and
  keeps no copy of the private key. `--allow` is required, because the bot has no person
  to choose what members may use on it.
- **The token.** `cnsbot1:` followed by base64url JSON: the bot's private key, the signed
  member list with the bot in it, the admin's advertised addresses, and the bot's allow.
  The list in it is checked like any other, and a token whose list does not hold the bot,
  or holds it as the admin, is refused. A token longer than 30,000 characters is never
  printed, so it fits in an environment variable on every platform.
- **Using it.** When `CNS_TOKEN` is set, every cns command first saves what the machine is
  missing to be the bot: its identity, its pairing with the admin and the mesh, as
  `cns mesh join` would have left them. The rest of cns then works unchanged: `cns up`
  runs the bot's daemon, which links to the members, and commands reach them. The admin
  need not be online when the bot starts, since the token carries a list; the bot catches
  up on newer lists from any member.
- **Never over another device.** A machine that already has an identity of its own
  refuses the token, so a token set by mistake cannot replace a person's device.
- **Revoking.** `cns mesh remove NAME BOT` drops the bot from every member, and
  `cns peer remove BOT` unpairs it from the admin. A copy of the token used later makes a
  bot that no member accepts.

## Consequences

- The token is the bot's private key. Anyone who has it can act as the bot, with what
  members allow members and within the bot's `--limit`, until it is removed.
- Reusing the token on a new machine brings back the same bot, which suits runners that
  are replaced. Two machines with the same token at once are one bot with two daemons,
  whose links would keep replacing each other; the docs say to use one at a time.
- There is no expiry: a token lasts until it is removed from the mesh.
- No handshake, relay or gateway change.

## Alternatives considered

- **A token that only reaches out** (closed PR #72): a program could reach one device, but
  nothing could reach the program's machine, and it was not a mesh member.
- **One token for many bots**, each machine making its own key and the admin approving it:
  shorter to hand out to a fleet, but each machine is then a member nobody named, and
  revoking one means telling it apart from the others first.
