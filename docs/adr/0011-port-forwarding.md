# ADR 0011: Port forwarding over the link

- Status: accepted (the owner chose option C of the design note: `shell`, or a `port:N` grant)
- Date: 2026-11-28

## Context

A database, dev server or web UI that listens only on localhost on another device is reached
today with an SSH tunnel, or by exposing its port. Paired devices already hold an authenticated,
encrypted link to each other, direct or through the relay, so cns can carry TCP connections over
it without dialing or exposing anything new.

What the code had to work with:

- Bytes cross the link as awaited Cap'n Web calls: `cns run` and terminals send 64 KiB per call,
  `cp` 1 MiB. The link itself has no flow control: `SecureChannel.send` hands each record to the
  WebSocket at once, so whatever a forward sends ahead waits in front of keystrokes.
- An older peer answers a method it lacks with `'forward' is not a function.`
- An older cns refuses an unknown grant word wherever it parses grants: a pairing proposal, a
  mesh member list's limit, a bot token. cns 2.5.0 and later refuse a record whose `needs` names
  a feature they lack; 2.4.0 and earlier refuse any unknown field.
- `shell` already reaches every local port: `cns run DEVICE -- nc localhost 5432` with stdin
  piped is a tunnel.

## Decision

- **The command.** `cns forward DEVICE PORT [--local LOCALPORT]` listens on 127.0.0.1 here, with
  no option to listen anywhere else, and carries each TCP connection to localhost:PORT on the
  device. The device tries 127.0.0.1, then ::1, as Node dev servers often listen on ::1 only.
  The RPC takes no host, so a device is never a way into another machine. As with `ssh -L`, any
  program on this device can use the forwarded port.
- **Grants.** A device may forward to a port with `shell`, which reaches every port anyway, or
  with that port's word, such as `port:5432`. There is no bare `ports`: on a dev machine,
  localhost holds Docker's API, a browser's debug port, Node's inspector or Postgres with `trust`
  auth, which add up to as much as `shell`.
  - A port word names one port, `port:N` with N from 1 to 65535 written without leading zeros.
    Grant lists split on commas, so several are `port:5432,port:8080`. A device holds at most 64.
  - It is never part of `all`, and lives only in a direct pairing's record, given on the
    device that has the port with `cns peer grant NAME port:N`. It is never sent where an older
    cns would refuse the whole proposal or list: `cns pair --grant` and `--request`, bot tokens
    and `cns gateway pair --request` refuse it, and so does everything of a mesh, `cns mesh
    allow`, `cns mesh join --allow` and `cns mesh add --limit`, saying to grant the port on a
    direct pairing or to allow members `shell`. `expandGrants` refuses port words unless the
    caller asks for them (`{ ports: true }`), so a new place that takes grants cannot take one by
    mistake. The wire schema `grantsSchema` holds no port word; `heldGrantsSchema` (records and
    `granted()`) does.
  - A record that holds one, in either direction, gets `needs: ["ports"]`, so a downgraded cns
    2.5.0 or later leaves that device out and says to update, rather than reading it without
    the word. cns 2.4.0 and earlier refuse the field, which fails closed too.
  - `cns peer revoke NAME port:N` removes one; a bare `cns peer revoke NAME` removes them all,
    with every permission. `describeGrants` shows them as `ports 5432, 8080` after the
    permissions, and `explainDenial` gives the command for a missing one:
    `To allow it, run on studio: cns peer grant laptop port:5432`.
  - A mesh's members forward with `shell`, as allowed there. A denied member is told to allow
    `shell` with `cns mesh allow`, or to pair the two devices directly and grant the port.
- **The RPC.** `shell.forward(port)` checks the grant, counts toward the limits, writes the audit
  start line and returns a handle. `handle.connect(sink)` checks the grant again, so a revoked
  grant stops new connections even on a link that lives on. It dials the port and returns a
  connection with `write(bytes)`, `end()` and release; the sink here gets `data(bytes)`, `end()`
  and `closed(reason?)`. Releasing the handle, or the link closing, closes every connection.
- **Bounded bytes in flight.** At most 64 KiB per call. A call is answered once its bytes are
  written to the socket at the other end (the write callback), so an answer means the bytes have
  left cns. At most 4 calls (256 KiB) may be unanswered per connection in each direction, and 8
  (512 KiB) per forward. When a window is full, the sender pauses its TCP socket, so TCP slows
  the program at either end. Each end counts what it receives as well, and closes a connection
  whose other end sends more than the windows allow, or a chunk over 64 KiB. Calls on one stub
  arrive in order, so `end()` follows the data without waiting for its answers.
- **Half-close and close.** A socket's end is sent as `end()`, which half-closes the socket at the
  other end once what was sent is written. A connection that closes cleanly finishes sending
  what it read first; the other end says when its socket closed (`closed()`), and only then is
  the connection released. One that fails is dropped at both ends at once, with the reason.
- **Limits.** At most 32 connections per forward, counting those still being dialed; one past
  that is closed at once and reported on stderr. At most 8 forwards per paired device at once,
  counted on the device by the forwarding device's key, over all its links. A connect fails
  after 10 seconds. There is no idle timeout, as database pools idle for hours; the link's
  heartbeat (45 seconds) catches dead paths. There is no byte quota: bounded bytes in flight
  keep the link responsive without capping a 10 GB `pg_dump`.
- **The link, and losing it.** `cns forward` uses `openDeviceLink`: the local daemon's link when
  it has one, else a direct dial, then the relay. It prints which. When the link is lost, its
  connections close at both ends and the listener stays: it reconnects with `cns shell`'s
  backoff (0.5 s, doubling to 15 s), and a new connection waits up to 10 seconds for a link.
  Each attempt reads the peer record again, so a device unpaired here meanwhile ends it.
- **Exit status.** A failure on the first attempt ends the command with 1, with what to fix.
  After that it retries until it is told to stop, except that a device that no longer accepts
  this one (an `AuthError`: not paired, identity changed, invalid proof), or a device removed
  here, exits 3, and one that no longer lets it reach the port exits 4. Ctrl-C exits 130,
  SIGTERM 143 and SIGHUP 129. The library returns the status; only the CLI sets
  `process.exitCode`.
- **Errors say what to run next.** A device from before this feature: `studio runs a cns from
  before cns forward; update it: cns upgrade studio`. A port in use here: `Port 5432 is in use on
  this device. Pick another: cns forward studio 5432 --local 15432` (10000 up, or down near the
  top). A port below 1024 or a reserved range says so, with the same suggestion. Nothing on the
  port there: `studio: nothing listens on port 5432 there. Start the service, then connect again.`
  Every line goes through `strictlyPrintable`, as it can hold the device's words.
- **Audit.** One `port.forward localhost:PORT` entry per forward: a start line and an end line
  with `connections`, `bytesIn` (what reached the port) and `bytesOut` (what it sent back).
  There is no line per connection, which would flood the log. A refusal is one line with the
  error, as for other actions.

## Consequences

- Devices paired with `all` forward with no setup, because `all` holds `shell`. Nothing widens:
  `shell` reached every port already, and `port:N` is strictly less than `shell`.
- A device that should reach one service, and run nothing, gets one word given on the device
  that has the service. It cannot be asked for while pairing, which costs a step after pairing.
- A mesh cannot give one port. A port word in a mesh file's `allow` would make a cns from before
  this feature fail to read its meshes at all, which stops lists and secrets for every mesh
  there, so meshes take none.
- With 512 KiB in flight per forward, a keystroke on the same link waits at most about 0.4 s at
  10 Mbit/s, and a forward still moves about 10 MB/s with 50 ms between the devices. On loopback
  in a Linux container, 50 MiB each way took about 1.5 s, and a call on the same link took a
  7 ms median during the transfer.
- Each 64 KiB chunk is its own encrypted record and its own call, with an answer.

## Platforms

- **Linux** is tested end to end with real daemons: a lent link, the command's own direct link
  and the relay, 50 MiB each way by hash, 32 connections and a refused one, a grant revoked
  mid-forward, unpairing and a peer daemon restart.
- **Bun's `node:net`.** `pause()` stopping reads, `pauseOnConnect`, `allowHalfOpen` half-close and
  write callbacks are proven by `src/forward.test.ts` with real sockets, which runs on every
  platform the tests run on, including the weekly Windows workflow. The end-to-end tests skip
  Windows, as every daemon end-to-end test here does.
- **macOS and Windows** use the same `node:net` calls; their kernels' loopback and half-close
  behave as Linux's for TCP. Windows reserves some port ranges (`netsh int ipv4 show
  excludedportrange protocol=tcp`), which fail as `EACCES`; the error suggests `--local`. On
  Linux, ports below 1024 need root.
- **WSL** reaches WSL's own localhost, not the Windows host's.
- **::1.** A device with no IPv6 loopback, as some containers, fails the ::1 attempt at once and
  reports the 127.0.0.1 error.

## Known limits

- Any program on this device can use the forwarded port, as with `ssh -L`. There is no option
  to listen elsewhere, so other machines cannot.
- A forward ends only on a refusal or a signal: a device that stays unreachable is retried
  forever, at most every 15 seconds.
- UDP is not carried.

## Alternatives considered

- **A bare `ports` grant.** Rejected for the reason under Grants: it only looks narrow.
- **`shell` alone.** Rejected: a device could not reach one service without running commands,
  which is the one case a port grant protects.
- **A port grant that `shell` does not cover.** Rejected: devices paired with `all` would need a
  second grant for no gain, as `shell` reaches every port.
- **Reusing `cns run` with `nc`.** Rejected: it needs `nc` or bash on the device, a process per
  connection and one chunk per round trip.
- **capnweb streams.** Rejected: their window grows to 1 GiB, all of it queued in front of
  keystrokes.
- **An audit line per connection.** Rejected: a browser or a pool opens many, which would flood
  the log.
- **An idle timeout.** Rejected: database pools idle for hours, and the heartbeat catches dead
  links.
