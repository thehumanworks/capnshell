---
name: cns-skills
description: Find, read and copy agent skills kept on any of the user's paired devices with cns skills (list, load, ls, cat, rg, sync). Use when a task calls for a skill that is not installed here, when the user mentions a skill on another machine, or before writing a skill that may already exist on one.
---

# Skills from every device with cns skills

Each device keeps its own skills in `~/.agents/skills` (`%USERPROFILE%\.agents\skills` on
Windows). `cns skills` shows this device's and every paired device's as one set.

```sh
cns skills list                       # NAME, DEVICE, MODIFIED (UTC), ALSO ON, DESCRIPTION
cns skills load pdf                   # the newest pdf skill's SKILL.md on stdout
cns skills load studio:pdf            # studio's own copy
cns skills ls pdf                     # its files, with sizes and times
cns skills cat pdf references/api.md  # one or more of its files
cns skills rg -i 'invoice' pdf        # NAME/FILE:LINE:TEXT; no name searches every skill
```

## Using a skill from another device

1. `cns skills list`, or `cns skills rg -i 'TOPIC'`, to find a skill for the task.
2. `cns skills load NAME` and follow its instructions. stderr names the device it came
   from and the skill's other files.
3. Read the files it refers to with `cns skills cat NAME PATH`, not by guessing paths.
4. Its scripts are on the device that holds it. To run one, either run it there
   (`cns run DEVICE -n -- 'python3 ~/.agents/skills/NAME/scripts/x.py'`, which needs `shell`)
   or copy the skill here first with `cns skills sync NAME`.

With cns MCP tools, `list_skills`, `read_skill` (a skill's `SKILL.md`, or `file`, and its
file list) and `search_skills` do steps 1 to 3. They need `skills` or `files` on the device.

When two devices hold a skill of the same name, `NAME` is the copy whose newest file is
newest; a tie goes to this device. Use `DEVICE:NAME` for a specific copy.

## Copying skills: cns skills sync

```sh
cns skills sync pdf                   # into this device's ~/.agents/skills
cns skills sync --to studio: pdf      # into studio's ~/.agents/skills (needs files there)
cns skills sync studio:pdf            # a specific copy
```

Sync replaces files of the same name and keeps other files, and it keeps modification
times, so a synced copy ties with its source. It never writes over a directory that is not
a skill. It changes what agents on the destination load, so sync only when the user wants
the skill there, or to run its scripts locally.

## When a device is missing

`list` names on stderr each device it could not read:

- `not listed: ... does not let this device read its skills`: that device grants neither
  `skills` nor `files`. Tell the user they can run, on that device,
  `cns peer grant NAME skills`, where NAME is that device's name for this one. It is
  read-only and reaches only skills.
- `runs a cns from before skills`: that device needs cns 2.2.0 or later.
- `unreachable`, or no answer within 10 seconds: `list` exits 1; see cns-troubleshoot.

Hidden files (`.git`, `.env`, `.python-version`) are never listed, read or copied, so a skill
that needs one must be set up on each device by hand.
