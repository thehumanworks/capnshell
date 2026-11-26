# ADR 0008: Skills shared from each device's ~/.agents/skills, with a read-only grant

- Status: proposed
- Date: 2026-11-26

## Context

Agents load skills from `~/.agents/skills`: directories that each hold a `SKILL.md`, and
often scripts and references beside it. A person with several machines ends up with
different skills, and different versions of the same skill, on each. The goal was one set
across the paired devices: `cns skills list`, `cns skills load [DEVICE:]NAME`, and
`cns skills sync` for a device that wants its own copy, with no server and no change to the
relay, the gateway or the handshake.

Reading another device's skills had two existing routes, and neither fit. The `files` grant
reads and writes every file the user can, which is far more than sharing skills needs. A
shell command (`cns run DEVICE -- cat ...`) needs `shell`, which is more again.

## Decision

- **Each device answers for its own skills.** Three new methods on the device's shell:
  `skills()` lists the skills with their description and modification time, `skillFiles(name)`
  lists one skill's files, and `readSkillFile(name, file, { offset })` reads one in parts of up
  to 1 MiB. The device resolves `~` itself (`os.homedir()`: the profile directory on Windows,
  the Linux home in WSL), so callers never send it a path.
- **A new `skills` grant, read-only and confined.** Those three methods need `skills`, or
  `files`, which can read the same files anyway, so nothing is widened. A name is one path part
  with no separator, colon or leading dot. A file is a relative path with `/` between parts,
  none of them empty, `..` or hidden. The real path of every file read must lie inside the real
  path of its skill; a skill directory may itself be a link, as installers make them, but a link
  inside it is followed only to a file inside it. Hidden files and directories (`.git`, `.env`)
  are not part of a skill, so a key kept beside one is not shared.
- **`all` leaves `skills` out.** `all` already holds `files`, which covers skills. Keeping it
  as it was also keeps `cns pair`'s default request, `all`, readable by a cns from before
  skills, whose grant schema rejects names it does not know.
- **Newest copy wins.** A skill's modification time is that of its newest file: editing any
  file of a skill changes it, while a directory's own time changes only when entries are added
  or removed. Copies of a name are compared in UTC to the second; a tie goes to this device,
  then to the device whose name sorts first. `DEVICE:NAME` picks a device's own copy.
- **Sync is a copy that keeps times.** `cns skills sync` reuses `cns cp -r`'s copy, reading the
  source through the skills methods, so `skills` is enough on the source; writing needs `files`
  on a paired destination, as `cp` does. Each file keeps its source's modification time (a new
  `files` method, `setModified`, on a paired device), so a copy ties with its source and wins
  there only by being local, rather than looking newer everywhere and being copied back and
  forth. Sync never deletes: it replaces files of the same name and refuses a destination
  directory that is not a skill. A copy within one paired device is refused, since links there
  cannot be compared from here and copying a skill onto itself would empty it.
- **Asked like `cns sessions`.** Every paired device whose saved grants allow it is asked at
  once, within 10 seconds each, through the daemon's link when there is one.

## Consequences

- Every device that shares skills runs cns 2.2.0 or later. An older one answers with capnweb's
  "is not a function", which cns reports as "runs a cns from before skills" with what to
  install. A sync onto an older device works, but its copies carry the time of the sync.
- `skills` in a pairing (`--grant skills`, `--request skills`) or in a mesh bot token is
  unreadable by a cns from before 2.2.0, which then refuses it. So is a mesh member's
  `--limit` that names `skills`: older members cannot read that member list and leave the mesh
  (fail-closed, as with any list change), so upgrade every member before using it there.
- Listing walks every skill's files on each device on every call. Skills are small, and a
  skill of more than 1,000 files is listed but cannot be listed file by file or copied.
- `rg` reads the files it searches over the link; a search on the device would be faster for
  large sets of skills, at the cost of another method.
- Not built: an MCP tool for skills, which would also need a gateway release, and a sync that
  deletes files the source no longer has.
