# Agent skills for cns

Skills that teach coding agents to use cns well on your devices. Each folder is one skill in
the [Agent Skills](https://agentskills.io) format: a `SKILL.md` with a `name` and a
`description` that tells the agent when to load it.

| Skill | Teaches |
| --- | --- |
| [cns-remote](cns-remote/SKILL.md) | Run commands, copy files and drive terminal programs on another device |
| [cns-skills](cns-skills/SKILL.md) | Find, read and copy skills kept on any paired device |
| [cns-secrets](cns-secrets/SKILL.md) | Give commands mesh secrets without printing them |
| [cns-access](cns-access/SKILL.md) | Pairing, grants, denials, meshes, bots, gateway approvals and the audit log |
| [cns-troubleshoot](cns-troubleshoot/SKILL.md) | Offline devices, exit statuses, version drift and the relay |

The skills tell agents to leave access changes, pairing and secret values to you: they
give you the command to run instead.

## Install

Copy them into `~/.agents/skills` on one device:

```sh
git clone --depth 1 https://github.com/thehumanworks/capnshell
mkdir -p ~/.agents/skills
cp -R capnshell/skills/cns-* ~/.agents/skills/
```

Then spread them to your other devices with cns itself (this needs the `files` grant there):

```sh
cns skills sync --to studio: cns-remote cns-skills cns-secrets cns-access cns-troubleshoot
```

Devices that grant this one `skills` can also read them in place with `cns skills load
cns-remote`, without a copy. For an agent that reads skills from another folder, such as
Claude Code's `~/.claude/skills`, link or copy each skill folder there.

`src/repo-skills.test.ts` checks that every `cns` command and option these skills show
exists, so a renamed command fails the tests instead of misleading agents.
