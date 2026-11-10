# State machines in cns, and how to test them

Status: survey of 10 November 2026. The first two candidates are explicit in
`src/link-rules.ts` and `src/invites.ts`, the third, already explicit, now has tests
in `gateway/consent.test.ts`, and the fourth's decisions are in `src/tty-recovery.ts`.

Several of cns's lifecycles live in flags, timers, map membership and the order of
callbacks rather than in a named state with named transitions. Their expected behaviour
is then only checked end to end, by tests that start real daemons and wait, which are slow
and depend on timing. This document lists those lifecycles, ranks where making them
explicit pays most, and says how each would be tested once it is: as a table of state and
event to outcome, and where two devices must agree, by running both sides through every
order of events.

The pattern to follow is already in the code: the handshake (`Initiator` and `Responder`
in `src/auth.ts`, with a `#state`), the encrypted channel (`SecureChannel` in
`src/secure.ts`, with a `#phase`), and the relay's rooms (`RelayRoom` and `PairingRooms` in
`src/relay-hub.ts`), all tested without processes in `auth.test.ts`, `secure.test.ts` and
`relay-hub.test.ts`. No framework is needed: plain functions or a small class whose
transitions take the clock as an argument.

## Ranking

| # | Lifecycle | Where | Why it matters | Status |
| --- | --- | --- | --- | --- |
| 1 | One standing link between two daemons | `src/commands/peer.ts` (`dial`, `accept`) | Races on every pairing, restart and outage; both sides must agree with no message between them. Behind a flaky test and the 2 s "stays single" sleeps. | Explicit in `src/link-rules.ts`, tested by tables and a two-daemon model |
| 2 | A pairing invite on the inviting daemon | `src/commands/peer.ts` (`PendingInvite`, `pairingFor`, `pairing.*`), `ControlApi` | Security: the invite secret must work once, and neither side may keep half a pairing. Was only tested end to end. | Explicit in `src/invites.ts`, tested by a state × event table |
| 3 | A connector's consent on the gateway | `gateway/object.ts` (`consents` table) | Security: gates OAuth access to devices. Already a status column, but had no tests. | Tested in `gateway/consent.test.ts` |
| 4 | A `cns tty` client through outages | `src/commands/paired-tty.ts`, console footer words | The recovery words in docs/paired-peers.md section 7 are states. Revoked access and giving up had no test. | Decisions explicit in `src/tty-recovery.ts`, tested by a failure × situation table |
| 5 | A daemon's relay registration | `src/commands/peer.ts` (`registerAtRelay`) | What `cns doctor` reports, and backoff against a relay that keeps dropping it. | Later |
| 6 | The pairing code's host | `src/pairing-code.ts` (`hostCode`) | Security: three wrong codes end it. | Low: already checked in process |
| 7 | The daemon process and its state file | `src/commands/daemon.ts`, `daemon-server.ts` | Start arbitration and stale state. Already well tested. | Low |
| 8 | A named PTY session | `src/pty.ts` (`Pty`, `PtyControls`, `HandleScope`) | Partly explicit; its tests need real terminals anyway. | Low |

## 1. One standing link between two daemons

**States**, for one daemon and one paired device: no link; dialing; linked, direct or
through the relay (and, until the device answers `info()`, not yet lent to commands);
upgrading, while a relayed link is held and a direct dial is out; and the dial loop
stopped, for a device that answers as another or no longer knows this one.

**Events**: the dial loop's turn, a dial that opened, a dial that failed, a link the other
daemon dialed that authenticated, a link closing or timing out, grants narrowed by
`cns peer revoke` (the links are dropped and redialed), unpairing, and the daemon stopping.

**What was implicit.** The decisions were spread over the dial loop and `accept`, compared
links by object identity (`other === existing`), and applied the key rule in two places
with nothing checking that both daemons reach the same answer. Its bugs and costs so far:
a daemon kept a link its restarted peer had lost (`peer-links.test.ts`); a link dialed by a
device in WSL stayed relayed (PR #54); `the daemon target chooses among linked devices` in
`mcp.test.ts` failed about one run in six because it used a link ID before the race after
pairing had settled (7 of 40 compiled runs; 2 of 25 from source here, once with the second
device missing from the peers while one of its links replaced the other); and tests poll
`settledLink` until an ID holds still for a second. That test now waits for `settledLink`
before it uses an ID.

**Now.** `src/link-rules.ts` holds the four decisions as pure functions (`dialTurn`,
`afterDialFailure`, `onDialed`, `onInbound`) and `peer.ts` calls them; behaviour is
unchanged. `src/link-rules.test.ts` checks each as a table, and runs the rules on two
simulated daemons through every order in which their dials can open and close, for twelve
situations (both dialing after pairing, only one able to dial directly, a restart while
the other holds the dead link, a relayed link giving way to a direct one from either side,
or both) and both key orders. It asserts that every order ends with both daemons holding
the same single link, that each knows which of them dialed it, and that it is direct
whenever a direct dial can work. It runs in about 50 ms, and a rule changed on one side
only (the dialer keeping its link when the responder also keeps its own, or the key rule
flipped) fails it.

The model's assumptions, which the real timings respect: a daemon redials at least a second
after its last attempt, so what is already on its way to it arrives first; both loops may
still take their turns at once; time only matters for the dial race and the relay upgrade.

## 2. A pairing invite on the inviting daemon

**States**: open (its secret proves a pairing until it expires); proposed (a device has
proved the secret and proposed; the secret no longer works; waiting up to ten minutes for
`cns pair` to decide); and the endings: accepted (saved, dialing starts), declined, failed
to save (the other device is told no), expired unused, not decided in time, cancelled
(the `cns pair` that asked for it went away), abandoned (the device left before the
decision), and ended by the daemon stopping.

**What was implicit**: membership in the `invites` map, whether `proposal` was set, the
`waiters` array, a timer swapped from the invite's lifetime to the decision's, a deferred
`decision`, and `secretFor` checking `expiresAt > now && !proposal`.

**Now.** `InviteBook` in `src/invites.ts` holds the invites with a named phase (`open`,
`proposed`; gone once ended) and takes the clock and timers as an argument; `peer.ts`
keeps the saving, announcing and dialing, and behaves as before. `src/invites.test.ts`
takes each phase through each event (the secret asked for, a device proposes, `cns pair`
waits, accepts, accepts under another name, declines, saving fails, the proposing or
another device leaves, `cns pair` goes away, the daemon stops, the invite's lifetime or
the decision time passes) and checks what the event returns, the next phase, what the
waiting `cns pair` and the proposing device are told, and what was saved; then that an
invite ended any of six ways takes nothing more. Reusing the secret after a proposal,
taking a second proposal, granting beyond the request, telling the device yes when saving
failed, ending on another device's leaving, letting the lifetime end a proposed invite,
or ignoring expiry each fails it. `pairing-e2e.test.ts` and `code-pairing-e2e.test.ts`
stay as the wiring checks.

## 3. A connector's consent on the gateway

**States**: pending, approved, denied, done (the approval was handed out once), and
expired after ten minutes (pruned). The page's handle must match to read it.

**Tested** in `gateway/consent.test.ts`: the Durable Object's own consent methods run
against `bun:sqlite` through a small stand-in for `ctx.storage.sql.exec`. A table takes
each of the five states through each event (the page polls, another page polls, an owner
approves, an owner denies) to the outcome and the next state; further tests cover approval
for named or unknown devices and tools, a gateway with no device, codes in any case, and
the cap of 20 waiting approvals. Removing any one of the handle check, the single handout,
the pending check, expiry or the cap fails them. No gateway code changed, so no redeploy.

## 4. A `cns tty` client through outages

**States**: connecting (the first try); attached; reconnecting, after the connection
dropped, waiting 0.5 s between tries and doubling up to 15 s until ten minutes have
passed; and the endings: stopped (Ctrl-C, a signal, or Ctrl-] while reconnecting), a plain
terminal instead (the first try of `cns tty DEVICE` on a device that does not let this one
start sessions), refused (not accepted, exit 3; access revoked, exit 4; the session missing,
ended, replaced or over the cap, exit 1), given up (exit 1), and the program's exit or a
detach. The words in docs/paired-peers.md section 7 (`interrupted`, `reconnecting`,
`reattached`, `access-revoked`, `session-expired`, `host-lost`) name some of them.

**What was implicit**: a `first` flag, a deadline and a doubling wait in the attach loop,
and an ordered chain of checks in its `catch` that chose between these, with each error
classified by its message.

**Now.** `src/tty-recovery.ts` holds those decisions as pure functions: `afterOpenFailure`
(stop, fall back to a plain terminal, end with a reason and exit status, report the error,
give up, or retry after a wait), `classify`, and `sessionReplaced`, which keeps a reattach
from joining another session that took the name. `paired-tty.ts` keeps the connecting, the
terminal and its messages, and behaves as before. `src/tty-recovery.test.ts` takes twelve
failures (each refusal, each missing session grant, the session missing, ended, replaced or
over the cap, and an outage) through four situations (a terminal's own session or
`--attach`, on the first try or reconnecting) and checks the outcome, exit status and
message; then that stopping wins over any failure, the backoff and deadline, and the
replaced-session check. It runs in about 50 ms, and each of 13 rules broken by hand (falling
back to a plain terminal while reconnecting, giving up at the deadline rather than after it,
an uncapped wait, a control character passed to the terminal, and so on) fails it.
`tty-paired.test.ts` and `reconnect-e2e.test.ts` (17 s together) stay as the wiring checks:
they show that the device's real error texts reach these rules, which a table of copied
messages cannot.

## 5. A daemon's relay registration

**States**: connecting, challenged, registered, lost, waiting to retry. Today they are the
flags `relayRegistered` and `readyAt`, the `lastHeard` time, the backoff `attempt`, which
resets only after a registration stayed up for 30 s, and `lastFailure`, which keeps the
same outage from being logged on every retry. A reducer with the clock passed in would let
`relay-client.test.ts` check backoff, reset and logging without a socket.

## 6. The pairing code's host

`hostCode` waits for a guest, sends it a hello, then delivers the invite to a correct
reply, counts a wrong one and waits again, or forgets the guest that left; the third
wrong code or a lost relay ends it. `pairing-code.test.ts` already runs it against an
in-process relay in under 200 ms: delivery once, three wrong codes ending it, a mistyped
word costing one try, and one guest at a time. A reducer over the relay's messages would
add only a stray message and a guest leaving mid-exchange, so it ranks low.

## 7. The daemon process and its state file

Absent, starting (spawned, waiting for its ready message), running (state written with its
token), stopping, and stale (the state file is there, the control endpoint does not answer
and, unless it runs as a service, its process is gone). `removeStaleState` is a decision
table already, and `daemon.test.ts` covers it well; extracting it would only name it.

## 8. A named PTY session

`Pty` keeps `#ended`, `#hungUp`, `#disposed` and `#exit`; `PtyControls` and `HandleScope`
keep their revocation reasons. Its tests need real terminals in any case, so naming the
states would add little now.

## Tests to focus

- Rules that both devices must agree on belong in models like `link-rules.test.ts`, which
  check every order of events in milliseconds. Keep one end-to-end test per behaviour for
  the wiring, and drop fixed sleeps that only check that a link stays single.
- Tests that need a link ID wait for `settledLink` (`src/test-support.ts`), or pass the
  device's name, which follows its link when the ID changes.
- The slowest files are `lent-link.test.ts` (25 s), `mcp/mcp.test.ts` (24 s),
  `transport.test.ts` (15 s), `pairing-e2e.test.ts` (12 s), `peer-limits.test.ts` (11 s)
  and `peer-links.test.ts` (8 s) of a 150 s suite.
