# Relay pairing timeout: diagnosis and verification, 2026-11-09

## Cause

The earlier IPv6 control fix made `cns up` work locally, but did not establish that
this WSL daemon could be reached from another network. Its status advertised a relay
address while `relayRegistered` remained false. The registration code swallowed
connection errors, so its journal contained no explanation.

The shell had `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` pointing to the system's
configured CA bundle; the running service had neither. Using a newly generated,
in-memory identity against the public relay reproduced the difference:

| Environment | Result |
| --- | --- |
| Shell CA configuration | WebSocket opened; relay challenge, proof and ready completed |
| Same Bun runtime without shell CA variables | TLS failed: `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `unable to get local issuer certificate` |

The relay selection algorithm was already present: direct sockets get a 300 ms head
start, then relay sockets are also tried. It cannot reach a daemon that never
registered. Increasing connection timeouts or forcing relay-only invites does not
fix a missing CA trust configuration.

## Changes

- `src/service.ts`: keep the allowlisted CA paths `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, and `SSL_CERT_DIR` in `cns up --install` service environments.
  Do not inherit arbitrary shell variables, secrets, TLS key-log settings or
  `NODE_TLS_REJECT_UNAUTHORIZED`.
- `nix/modules/nixos.nix`: default the service's extra CA and CA-file settings to
  `config.security.pki.caBundle`; explicit service environment values override them.
- `nix/modules/home-manager.nix`: inherit those three CA paths from declared
  `home.sessionVariables`, with `services.cns.environment` taking precedence.
  Do not copy the entire session environment.
- `src/connect.ts`: retain bounded, terminal-safe underlying WebSocket error text
  and its cause instead of replacing TLS failures with a generic reachability error.
- `src/commands/peer.ts`: log initial/changed relay registration failures, including
  connections closed before registration. Keep retrying with existing backoff;
  suppress repeated identical errors and reset suppression after success.
- Tests cover actual TLS rejection and subsequent verified registration using a
  test-only certificate, service environment filtering/serialization, Nix module
  merging, and pairing through a relay with an unreachable direct address retained
  in the invite. The external-relay test also now handles a relay URL path prefix.

No TLS verification was disabled, no new system-wide CA was installed, and no WSL
routing/firewall settings were changed.

## Verification

| Check | Result |
| --- | --- |
| `bun run typecheck` and `git diff --check` | Passed |
| Full source suite in isolated network namespace | 225 passed, 9 skipped, 0 failed |
| Full compiled suite in isolated network namespace | 226 passed, 8 skipped, 0 failed |
| TLS regression on the affected WSL network | Passed: untrusted certificate rejected/logged, configured CA accepted, pre-registration refusal logged, retry recovered |
| End-to-end test against `wss://cns.nothuman.work/relay`, source CLI | Passed, 29.65 s |
| Same public-relay test, compiled CLI | Passed, 30.72 s |
| Nix package build and its checks | Passed |
| NixOS unit and Home Manager activation-package builds | Passed; build-only, no activation of the test configuration |
| Real NixOS/Home Manager module assertions | Passed: CA defaults/inheritance, override precedence, no unrelated session secrets/TLS bypass, disabled user service inert |
| Updated installed WSL daemon | `relayRegistered: true`; `cns doctor`: Ready for paired devices |
| Pairing proposal/decision through the public relay to the actual installed WSL daemon | Passed with ephemeral guest identity and a deliberately unreachable direct address; declined after the round-trip, so no pairing or grants were saved |

The public-relay test uses disposable homes and identities. It pairs two devices,
runs shell commands and MCP calls, and confirms their standing link uses the relay.
It runs from WSL but goes through the actual public relay rather than a local mock;
it is not a claim that the user's particular external device was tested.

The full-suite skipped tests are the eight Windows-only tests, plus the compiled-only
smoke test in the source run. Windows and macOS were not tested natively. The TLS
regression uses a public test-only key, documented in `src/test-fixtures/README.md`.

### Repeat the relevant checks

```sh
bun test --timeout 30000 src/relay-client.test.ts -t 'relay TLS'
CNS_TEST_RELAY_URL=wss://cns.nothuman.work/relay bun test --timeout 150000 src/relay-e2e.test.ts
bun run build
CNS_TEST_RELAY_URL=wss://cns.nothuman.work/relay CAPNWEB_TEST_BINARY=1 \
  bun test --timeout 150000 src/relay-e2e.test.ts
```

The public-relay test creates temporary registrations/pairings and requires network
access. The full suites use the isolated-network commands in
[ADR 0003](../adr/0003-local-control-loopback.md) when WSL IPv4 loopback is broken.
Finish a compiled build before starting tests that launch that executable.

`nix/tests/trust.nix` takes the project flake as `cns` and a pinned Home Manager
flake as `homeManager`; it returns `checks`, `nixosUnit` and `homeActivation`.
For this verification the actual invocation used the existing machine's pinned
Home Manager input, without changing its configuration or lockfile:

```sh
nix eval --impure --raw --file nix/tests/trust.nix \
  --arg cns '(builtins.getFlake "/home/nixos/capnshell")' \
  --arg homeManager '(builtins.getFlake "/etc/nixos").inputs.home-manager' checks
```

The same arguments with `nix build`, targets `nixosUnit homeActivation`, and
`--no-link` build the generated artifacts without activating them. A different
consumer should supply its own checkout and pinned Home Manager input.

## Installed local fix and retry

The local Nix profile entry `capnweb-shell` now points to:

`/nix/store/j1q6apx785gjmgag3zm5y07fizw0rh49-capnweb-shell-1.1.0`

The existing `~/.config/systemd/user/cns.service.d/90-local-loopback-fix.conf`
was updated to that package. A separate `91-system-ca.conf` passes only
`NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` and
`SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` to the service. That file resolves
to the same bundle that already worked in the user's shell. The base service and
Home Manager configuration were not overwritten.

After restart, both `cns up` and `cns doctor` report the relay as **registered**.
The local control endpoint remains IPv6 loopback. The daemon is left running with
its original identity and no diagnostic pairings saved.

**Generate a fresh invite with `cns pair` and use it on the external device.** The
service restart invalidated outstanding invites; the relay fix does not revive
old ones. There is no need to expose the local control socket, forward a port or
edit the invite to remove private addresses.

Once the declarative capnshell input includes both fixes and is activated, remove
the local profile pin and both drop-ins, then reload/restart the service:

```sh
nix profile remove capnweb-shell
rm ~/.config/systemd/user/cns.service.d/90-local-loopback-fix.conf \
   ~/.config/systemd/user/cns.service.d/91-system-ca.conf
systemctl --user daemon-reload
systemctl --user restart cns
cns up
cns doctor
```

Do not remove the CA override before the declarative service inherits the correct
trust settings. Check the service's actual `ExecStart` and environment, not just the
interactive shell. In general, a working local control channel, a listening peer
port, an advertised relay URL and a completed relay registration are four separate
claims that require separate checks.
