---
name: cns-troubleshoot
description: Diagnose cns failures between the user's devices - a device offline or unreachable, commands that time out or are slow, exit statuses 3 and 5, a daemon still running an old version after an upgrade, relay registration errors. Use when a cns command fails or hangs, cns peers shows a device offline, or cns behaves like an older release.
---

# Troubleshooting cns

Diagnose before changing anything. These commands only read, so run them freely:

```sh
cns --version           # this cns
cns status              # this device: its daemon's version, relay, live links
cns peers               # each device: online/offline, CONNECTION (direct/relay), VERSION
cns doctor studio       # every saved address of studio: ok, unreachable or a refusal
cns doctor              # this device: identity, daemon, relay registration, addresses
```

Follow what they print: when something is wrong they name the command that fixes it.

## Symptoms

| Symptom | Cause and next step |
| --- | --- |
| `cns peers` says `offline` | That device's daemon is not running, or no path reaches it. `cns doctor NAME`. If every address is `unreachable`, the user must start cns there (`cns up`, or its service). A desktop or NAS that sleeps: `cns wake NAME` has a device on its network wake it, and says what to do when cns cannot. |
| `unreachable` for direct addresses only | Normal for a device in WSL or behind NAT: its own daemon links out, and commands use that link. Fine while `cns peers` shows it `online`. |
| Each command takes a second or two | It goes through the relay: `CONNECTION` says `relay`. Keep both daemons running so a standing link exists. |
| Exit 3, `identity-changed` | Another key answers at that address. The device was reinstalled, or it is not that device. Stop and tell the user; they must check the fingerprint and pair again. |
| Exit 3, `not-paired` | The other device removed this one. It must pair again. |
| Exit 4, `Permission denied` | Not a fault: a grant is missing. See cns-access. |
| Exit 5 from `cns doctor NAME` | No address answered, or none is saved. |
| Exit 124 | `--timeout` passed. Raise it, or use a named session and `cns screen --until`. |
| `is not a function`, or a new feature missing after an upgrade | The daemon, here or there, still runs the old cns. See below. |
| `Relay: ... (registering)` that never turns `registered` | The service cannot reach or verify the relay: read its log (`journalctl --user -u cns` on Linux, `~/.cns/service.log` on macOS and Windows). Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. |
| `Local daemon connection timed out` | Local loopback trouble, as with WSL mirrored networking. Do not delete `~/.cns`; see docs/adr/0003-local-control-loopback.md. |

## Version drift

A running daemon keeps the executable it started with. After installing a new cns,
`cns status`, `cns up` and `cns doctor` say when the daemon runs another version, and print
the restart command that fits how it was started: usually `cns daemon restart`, or
`cns up --install` again for a service that points at another executable. Use the command
they print.

- Named sessions keep running when the daemon restarts if `cns status --json` shows
  `daemon.keepsSessions: true`. Otherwise restarting ends them: check `cns sessions` first and
  ask the user.
- `cns --version` older than `cns status`'s daemon: an older cns comes first on `PATH`
  (`command -v cns`, or `Get-Command cns` in PowerShell).
- A daemon that stays old after a restart on Linux: `systemctl --user cat cns` shows a
  drop-in or another `ExecStart` that overrides the service.
- `cns peers` and `cns doctor NAME` show which other devices run an older cns.
  `cns upgrade NAME --dry-run` shows how cns would upgrade one from here; with the user's
  go-ahead, `cns upgrade NAME` (or `--all`) does it. A daemon whose named sessions outlive
  a restart (`daemon.keepsSessions` in `cns status --json`) is upgraded with them running.
  It skips one whose sessions would end, or too old to say; add `--end-sessions` only when
  the user agrees to end them.

## Never

- Delete `~/.cns/identity.json`: the device becomes a new one that every peer must pair again.
- Remove and re-pair a device, or widen grants, to make an error go away without the user.
- Disable TLS checks to get past a relay error.
