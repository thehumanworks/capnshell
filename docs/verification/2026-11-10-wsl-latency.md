# Slow commands to a device in WSL: diagnosis and verification, 2026-11-10

## Symptom

`cns run lf` and `cns tty lf` were slow from the Mac (`thestudio`) to `lf`, a NixOS
device in WSL2 with mirrored networking, while the same commands to `beelink`, a NixOS
machine on the same network, were quick. Measured on those devices with the installed
cns 1.1.x:

| From thestudio | To lf (WSL) | To beelink |
| --- | --- | --- |
| `cns run DEVICE -- true`, wall time | 2.59-2.66 s | 0.12-0.18 s |
| `cns tty DEVICE --attach NAME` until attached | 2.36-2.38 s | 0.10 s |
| `cns tty`, one key's echo (median of 20) | 326-328 ms | 4-5 ms |

## Cause

Nothing can dial lf. Its daemon advertises `ws://192.168.1.69:47381` and
`ws://169.254.83.107:47381`; from thestudio both time out (`nc -z`: 5.1 s each, ping
lost), as WSL's mirrored mode lets the Hyper-V firewall drop inbound connections by
default. lf's own dials out work: `cns status` on both showed the daemons' standing
link as **direct**, dialed by lf.

Commands did not use that link. Each `cns run`, `cns tty`, `cns cp` and `cns mcp DEVICE`
call dialed the device itself, so for lf every one went through the relay: the direct
dials' 300 ms head start, TCP and TLS to Cloudflare from both ends (lf answers every
relayed dial with a new WebSocket), the four handshake messages and every RPC crossing
thestudio→Cloudflare→lf. Typing in `cns tty` crossed the relay too.

A second effect made the standing link itself relayed at times. When both daemons dial
at once, the one with the smaller public key keeps its outbound link, whichever path it
took; the Mac's outbound link to lf can only go through the relay, so after a
simultaneous redial, or right after pairing (where the invitee's first direct dial can
be refused as `not-paired` because the other side has not saved the pairing yet), the
devices kept a relayed link, and a daemon never dials while it has a link.

## Changes

1. **Commands use the daemon's link** (`src/device-link.ts`, `ControlApi.lend`). A
   command asks the local daemon at the default state path for its standing link to the
   device; the daemon lends a fork of the device's shell over it. Releasing the fork,
   which closing the command's control connection does, makes the device end that
   command's commands, terminals and handles, as closing a connection of its own did.
   When the link ends, the daemon closes the control connection, so the command sees a
   lost connection, and `cns tty` reconnects as before. No daemon, a daemon running as
   another identity, no link, or an older daemon without `lend`: the command dials.
2. **A relayed standing link gives way to a direct one** (`dial` in
   `src/commands/peer.ts`). From 10 s after a relayed link was made (twice the dial
   race), the dial loop keeps trying the device's direct addresses alone with its usual
   backoff; a direct link that opens replaces the relayed one on both sides. The other
   daemon needs no change: it already takes a daemon link dialed after the race as
   replacing the one it holds.

Neither touches identity, pairing, grants, the handshake or the relay. Lending happens
only over the daemon's private control endpoint, which already offered forks of a
linked device's shell (`ControlApi.shell`) to the same local user; the device enforces
its grants to this device on the link as on any connection from it.

## Approaches measured

`scripts/bench-unreachable-peer.ts` reproduces the setup on one Linux machine with real
daemons: iptables drops SYNs to the "wsl" device's port, as the Hyper-V firewall does,
and a local relay sits behind a proxy that adds each device's measured distance to
Cloudflare (studio 140 ms round trip, wsl 66 ms plus a 70 ms DNS lookup per connection)
and a TCP and TLS handshake to each new connection. Compiled binaries, medians:

| Build | Standing link | `cns run wsl -- true` | `cns tty wsl` to prompt | Key echo |
| --- | --- | --- | --- | --- |
| main | relay | 1924 ms | 2058-2486 ms | 211 ms |
| main, relay dialed at once (no 300 ms head start) | relay | 1641 ms | 1746-2220 ms | 211 ms |
| commands use the daemon's link | relay | 773-801 ms | 989-1488 ms | 212 ms |
| commands use the daemon's link, relayed link replaced (this change) | direct | 161 ms | 146-169 ms | 4 ms |

Dropping the head start saves 300 ms and nothing else. Lending alone saves the dial and
handshake but still crosses the relay for each call and keystroke whenever the daemons'
link is relayed, which main's dial race made it in every run. Both together make the WSL
device as quick as a directly reachable one.

## Verification on the real devices

On thestudio, a script run from a checkout of main compared, in one process, dialing lf
as `cns run` did with going through the running daemon's direct link to lf by
`ControlApi.shell`, the fork that `lend` hands out (median of five connect-and-run
`true`, and of 20 key echoes through an unnamed terminal running `cat`):

| Device | Dialing | Through the daemon's link |
| --- | --- | --- |
| lf (WSL) | 1977 ms, echo 322 ms (via relay) | 18 ms, echo 7 ms |
| beelink | 22 ms, echo 4 ms (direct) | 10 ms, echo 3 ms |

Process startup adds about 0.1 s to a CLI command. The new build itself was not
installed on those devices: lending needs the calling device's CLI and daemon updated
and its daemon restarted (which ends its sessions), and replacing a relayed link needs
the WSL device's daemon updated.

## Tests

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `src/lent-link.test.ts`, on main | Both tests fail: the command cannot connect; the link stays relayed |
| `src/lent-link.test.ts`, with the change | 2 passed, from source and compiled |
| Full `bun run test` | 225 passed, 11 skipped, 0 failed |
| Full `bun run test:compiled` | 225 passed, 10 skipped, 1 failed: the MCP daemon-target test, which fails as often on main (see below) |

The failing compiled test, `the daemon target chooses among linked devices and kills
cancelled commands` in `src/mcp/mcp.test.ts`, is flaky before this change: it uses each
link as soon as it appears, while the two daemons' links right after pairing are still
settling. Run alone with the compiled binary it failed 7 times in 40 on main and 4 times
in 36 with this change, with the same messages (`Unknown peer second`, a link disposed
mid-call). CI runs on Windows, where that test and `src/lent-link.test.ts` are skipped.

`src/lent-link.test.ts` covers a device whose saved addresses are all dead and that is
reachable only over the link it dialed: `run` with output, piped input and exit status,
`sessions`, `tty` at a terminal, a cancelled command killed on the device while the link
stays, a link that ends during a command ending the command, and dialing again once the
link is gone. The second test starts two daemons on a local relay with dead direct
addresses and checks that their link becomes, and stays, a single direct one once one of
them can dial the other.

Repeat the measurement (Linux, root, util-linux `script`):

```sh
bun run build
sudo bun scripts/bench-unreachable-peer.ts --binary dist/cns
sudo bun scripts/bench-unreachable-peer.ts --binary dist/cns --block-studio   # no direct path either way
```

After updating the devices, `cns run lf -- true` from the Mac should take about as long
as to beelink, and `cns tty lf` should say `connected to lf via this device's daemon
(directly)`. `cns status` on either device shows whether their link is direct.
