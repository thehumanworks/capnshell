# Peer-naming evals

Do agents name cns peers so that their calls survive a reconnect? A paired device keeps its name, but the
daemon gives it a new ID (`p4`, then `p14`) each time it reconnects, so an agent that copies the ID from
`list_peers` into later calls gets `Unknown peer p4`.

`server.ts` serves the real MCP tools, descriptions, instructions and `resolvePeer()` over a fake daemon in
which paired devices reconnect between calls. `run.ts` runs real `claude -p` sessions against it and scores
each call's `peer` argument. Each run is one Claude session.

    bun evals/peer-naming/run.ts --label mine --models sonnet,haiku,opus --reps 3 [--scenarios single,several,stale,unnamed]

Scenarios (`scenarios.ts`): `single` (one paired device, name differs from hostname), `several` (two paired
devices and an unpaired one), `stale` (the user names the device by an old ID), `unnamed` (no paired
devices, so IDs are correct; a guard against overcorrecting).

## Results, 2026-11-09

A run is clean when it completes the task with no refused call.

| Variant | single | several | stale | unnamed |
|---|---|---|---|---|
| Before (IDs first everywhere) | 1/11 | 3/11 | 0/9 | 8/8 |
| Shipped: argument, instructions, errors and `list_peers` | 11/11 | 11/11 | 9/9 | 8/8 |
| Ablation: `list_peers` changes only | 5/6 | 6/6 | 6/6 | — |
| Ablation: argument, instructions and errors only | 6/6 | 6/6 | 6/6 | — |

Models: sonnet and haiku in every cell, plus opus for all but the ablations and the unnamed guard. Before the change, every
run still finished the task, but only after 1 to 6 refused calls; opus avoided IDs only when several peers were
connected. The `peer` argument's description does most of the work; the `list_peers` changes help on their own
but less reliably, and both are kept.
