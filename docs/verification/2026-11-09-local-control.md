# Local daemon timeout fix: verification, 2026-11-09

> This records the initial local-control fix. The subsequent
> [relay trust report](2026-11-09-relay-trust.md) documents a separate failure of
> external reachability and supersedes the package path and local-pin removal
> instructions below. Local control passing did not establish relay registration.

## Result

Verified on the originally affected WSL2 mirrored-networking machine with Bun
1.4.4. The existing IPv4 localhost failure remains reproducible, but the updated
CLI and daemon communicate successfully over IPv6 loopback. No host routes,
firewall settings or global environment variables were changed.

Implementation and rationale: [ADR 0003](../adr/0003-local-control-loopback.md).

## Checks completed

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `git diff --check` | Passed |
| Focused control tests on the affected WSL network, source CLI | 8 passed, 0 failed |
| Same focused tests using `CAPNWEB_TEST_BINARY=1` | 8 passed, 0 failed |
| Full `bun run test`, isolated network namespace | 223 passed, 9 skipped, 0 failed |
| Full `bun run test:compiled`, isolated network namespace | 224 passed, 8 skipped, 0 failed |
| Daemon and service tests with IPv6 disabled in an isolated namespace, source CLI | 24 passed, 0 failed |
| Same IPv4-only checks, compiled CLI | 24 passed, 0 failed |
| `nix build .#cns`, including its package checks | Passed |
| CLI lifecycle test using the Nix-built executable on the affected WSL network | Passed |

The source suite skips the compiled-only smoke test plus eight Windows-only tests.
The compiled suite skips only those eight Windows tests. Windows and macOS were
not run locally. Both full suites include the Pi package tests on Node and the
installed Pi runtime, exercising the shared control client outside Bun.

The focused native command was:

```sh
bun test --timeout 30000 src/commands/daemon.test.ts \
  -t 'state accepts|unsafe and malformed|same opened|symlink substituted|unrelated bind|local control authenticates|cleanup never|independently of the peer bind'
```

For compiled verification, first finish `bun run build`, then run the same command
with `CAPNWEB_TEST_BINARY=1`. Do not rebuild `dist/cns` concurrently with a test
launching it: replacing a running executable can make Linux report its self-path
as `dist/cns (deleted)`, preventing the daemon subprocess from starting. An initial
parallel verification hit this race; the sequential rerun passed. The ADR gives
commands for the separate network namespace and genuine IPv4-only verification.

## Verification against the installed service

The fixed executable was installed in the user's Nix profile, and the existing
`cns.service` was restarted using that same immutable package. The final checks
used plain `cns`, not a checkout-only command or a specially adjusted PATH:

| Command/check | Result |
| --- | --- |
| `cns stop` | Exit 0, 0.093 s; state file removed |
| `cns up` | Exit 0, 0.295 s; new service PID |
| Repeated `cns up` | Exit 0, 0.088 s; same PID retained |
| `cns status --json` | Exit 0, 0.090 s; matching service PID |
| `cns attach` with `:peers` and `:quit` | Exit 0 |
| `systemctl --user is-active cns` | Active |
| Private state | Version 2, host `::1`, mode `0600` |
| TCP to the recorded IPv6 control port | Connected |
| TCP to the IPv4 peer listener at `127.0.0.1:47381` | Still timed out |
| Device identity | Unchanged |
| Paired-device listener | Still `ws://0.0.0.0:47381` |

The daemon was left running. This confirms the application avoids the broken
localhost route; it does not claim to repair WSL's IPv4 networking.

## Local deployment and removal of the temporary pin

This is a local, reversible deployment of the uncommitted checkout, not a published
release or a change to the Home Manager/NixOS configuration:

- Nix profile entry: `capnweb-shell`.
- Package: `/nix/store/6v8qbndpjr6n1spfw1pw0na31piz8194-capnweb-shell-1.1.0`.
- CLI: `~/.nix-profile/bin/cns`, which precedes the existing Home Manager package.
- Service override: `~/.config/systemd/user/cns.service.d/90-local-loopback-fix.conf`.
  It replaces only `ExecStart` and the cns package prefix of the service's existing
  PATH; bind, port, state path and other service settings are preserved.
- The original service file was not overwritten. `cns up --install` was not used to
  take ownership away from Home Manager.

Once the declarative Home Manager capnshell input has been updated to include this
fix and activated, remove the local pin and restart using that updated package:

```sh
nix profile remove capnweb-shell
rm ~/.config/systemd/user/cns.service.d/90-local-loopback-fix.conf
systemctl --user daemon-reload
systemctl --user restart cns
cns up
```

Confirm `command -v cns` and `systemctl --user show cns -p ExecStart` both name the
intended updated package. Removing the local pin before updating the declarative
package restores the old IPv4-only implementation and can restore the timeout.
The same commands can deliberately roll back, with that limitation. A service
restart ends its sessions. Local Pi clients must also include the new state reader.
