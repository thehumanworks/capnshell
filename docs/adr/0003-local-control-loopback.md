# ADR 0003: Prefer IPv6 loopback for local daemon control

- Status: accepted
- Date: 2026-11-09

## Context and observed failure

`cns up` reported `Local daemon connection timed out.` on WSL2 in mirrored
networking mode even though the systemd user service was running. The PID and
control port in its private state matched the listening process. Both the control
server and client hard-coded `127.0.0.1`.

Independent TCP probes on that machine established:

| Destination | Result |
| --- | --- |
| Daemon control on `127.0.0.1` | Timeout |
| Daemon peer listener on `127.0.0.1` | Timeout |
| Same peer listener on local address `10.255.255.254` | Connected |
| Unrelated server and client in the same process on `127.0.0.1` | Timeout |
| Unrelated server and client on `::1` | Connected |

`wslinfo --networking-mode` reported `mirrored`. `ip route get 127.0.0.1
ipproto tcp` selected a table-127 route through a link-local gateway on
`loopback0`, whereas `::1` used the local loopback route. The shell running the
probes shared the init process's network namespace: this was not evidence of a
Pi-only network sandbox. The exact Windows/WSL component losing the IPv4 traffic
was not determined. Do not generalize this observation to every WSL installation.

The CLI first tries the control connection, then tries it again during stale-state
recovery. Each connection has a five-second timeout. A still-running daemon's state
is deliberately kept, so this failure took about ten seconds and did not mean the
daemon needed a longer startup deadline.

## Decision

1. Bind private control to the numeric IPv6 loopback address `::1`, on an ephemeral
   port. If the bind fails with `EAFNOSUPPORT`, `EPROTONOSUPPORT` or `EADDRNOTAVAIL`,
   try `127.0.0.1`. Other errors, and failures of the IPv4 fallback, propagate.
   In particular, do not hide resource exhaustion as an IPv6 compatibility issue.
2. Record the selected literal address in version-2 state:
   `{ version: 2, pid, host, port, token }`. Only `::1` and `127.0.0.1` are accepted
   as `host`. Clients bracket IPv6 addresses in WebSocket URLs and connect to the
   recorded address, not a guessed host or a DNS-resolved `localhost`.
3. Continue reading strict version-1 state `{ version: 1, pid, port, token }` as
   IPv4. Never reinterpret an old daemon's endpoint as IPv6. Version-2 state must
   include its host; unknown versions and additional fields are refused.
4. Keep the security properties unchanged: loopback-only binding, private state
   ownership/mode checks, no-follow file opening, a random bearer token, constant-time
   comparison before WebSocket upgrade, and refusal of every browser Origin header.
   Never permit an arbitrary state-file hostname to receive the control token.
5. Leave the paired-device listener and its `--bind`/`--port` settings alone.
   `up`, `status`, `attach`, `stop`, pairing, MCP and Pi use the same control client.

## Compatibility and operations

- New clients can control old IPv4 daemons wherever IPv4 localhost works. On the
  affected WSL machine, an old daemon must be restarted with the new executable;
  a new client cannot make the old IPv4 listener reachable.
- Old clients reject version-2 state. Upgrade the CLI, daemon and local Pi extension
  together. This is a local control-state change, not a peer protocol or pairing change.
- Use the service manager to replace an unreachable running daemon. Do not delete
  live state, signal an unverified PID from a stale file, or expose private control on
  `0.0.0.0`/`::` as a workaround. A restart ends the daemon's sessions.
- For a daemon installed using `cns up --install`, reinstall from the updated binary.
  For a Nix-managed service, update the package used by the service and the CLI;
  check the service's actual `ExecStart`, not just `command -v cns`.
- A Unix socket could avoid IP routing entirely, but would need a separate transport
  path for Bun/Node and Windows. IPv6 loopback keeps the existing authenticated
  WebSocket RPC transport across all supported platforms.

## Verification and reusable debugging lessons

`src/commands/daemon.test.ts` covers the new state schema, preferred loopback,
actual authenticated RPC on the IPv4 fallback, legacy-state connections, each
fallback errno, propagation of unrelated bind failures, and a CLI lifecycle with an
IPv4 peer listener independent of the control address. Existing tests exercise
private-file checks, authentication/Origin rejection, exclusive state creation,
stale-state recovery, simultaneous starts, proxying, sessions and shutdown.

Run the focused regression on the affected WSL network, without changing routes:

```sh
bun test src/commands/daemon.test.ts \
  -t 'local control authenticates|independently of the peer bind'
bun run build
CAPNWEB_TEST_BINARY=1 bun test src/commands/daemon.test.ts \
  -t 'local control authenticates|independently of the peer bind'
```

The broader suite intentionally includes IPv4 peer listeners and legacy IPv4
control. On a machine with broken IPv4 loopback, run that suite in a **separate
network namespace**, not by changing the host's routes. For example, on Linux with
`sudo`, `unshare`, `ip`, `runuser` and Bun already installed, from the checkout:

```sh
sudo unshare --net sh -c 'ip link set lo up; exec runuser -u "$1" -- env PATH="$2" bun run test' sh "$USER" "$PATH"
sudo unshare --net sh -c 'ip link set lo up; exec runuser -u "$1" -- env PATH="$2" bun run test:compiled' sh "$USER" "$PATH"
```

Also test a real IPv4-only environment, not just mocked bind errors:

```sh
sudo unshare --net sh -c '
  ip link set lo up
  sysctl -qw net.ipv6.conf.all.disable_ipv6=1
  exec runuser -u "$1" -- env PATH="$2" bun test --timeout 30000 src/commands/daemon.test.ts src/service.test.ts
' sh "$USER" "$PATH"
```

The sysctl above affects only the new namespace. Avoid a rootless user namespace
for this suite: unmapped filesystem owners cause the intentional configuration-path
ownership checks to fail before networking is exercised. Do not weaken those checks
just to accommodate the test runner.

For diagnosis, distinguish an active process, a listening socket, a completed TCP
connection, a successful WebSocket upgrade and authenticated RPC. One does not prove
the next. Test another minimal server/client to separate network behavior from cns,
compare IPv4 and IPv6, and never print the daemon state's bearer token in logs.
