// A cns MCP server over a fake daemon, for evals of how an agent names peers.
// The tools, descriptions, instructions and peer resolution are the real ones; only the
// daemon is fake. Each tool call opens a new connection, and in scenarios that rotate,
// every paired device has reconnected since the last call, so its daemon ID has changed.
// Every call is appended as one JSON line to EVAL_LOG.
import { appendFileSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { PeerSummary } from "../../src/console.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { resolvePeer, type McpTarget } from "../../src/mcp/target.js";
import { SCENARIOS, type FakePeer } from "./scenarios.js";

const scenario = SCENARIOS[process.env.EVAL_SCENARIO ?? ""];
const log = process.env.EVAL_LOG;
if (!scenario || !log) throw new Error("Set EVAL_SCENARIO and EVAL_LOG.");
const record = (entry: Record<string, unknown>) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

let connections = 0;
/** The daemon's peers as one connection sees them. */
function summaries(): { list: PeerSummary[]; byId: Map<string, FakePeer> } {
  const byId = new Map<string, FakePeer>();
  const list = scenario.peers.map((fake, index) => {
    // A rotating paired device gets a fresh ID per connection, as a reconnect gives it.
    const id = fake.name && scenario.rotate ? `p${10 + connections * scenario.peers.length + index}` : fake.id;
    byId.set(id, fake);
    return {
      id,
      info: { platform: fake.platform, name: fake.os, shell: fake.shell, hostname: fake.hostname, cwd: fake.home, pid: 4000 + index },
      ...fake.name ? { peer: { name: fake.name, fingerprint: fake.fingerprint ?? "aaaa-bbbb-cccc-dddd", daemon: true, via: "direct" as const } } : {},
    } satisfies PeerSummary;
  });
  return { list, byId };
}

const target: McpTarget = {
  label: "the local daemon",
  async open() {
    connections++;
    const { list, byId } = summaries();
    const host = (id: string) => byId.get(id)!;
    return {
      lost: false,
      close() {},
      async peer(requested) {
        try { return resolvePeer(list, requested); }
        catch (error) {
          record({ event: "resolve-failed", requested, message: (error as Error).message });
          throw error;
        }
      },
      controller: {
        async peers() { return list; },
        async run(id, command) {
          const fake = host(id);
          record({ event: "run", peer: fake.key, command });
          return { stdout: fake.respond(command), stderr: "", exitCode: 0, signal: null, timedOut: false, elapsedMs: 40, truncated: false };
        },
        async ptySessions() { return []; },
        async startPtySession() { throw new Error("Sessions are not available in this eval."); },
        async ptySession() { throw new Error("Sessions are not available in this eval."); },
        async files(id) {
          const fake = host(id);
          record({ event: "files", peer: fake.key });
          throw new Error("Files are not available in this eval; use run_command.");
        },
      },
    };
  },
};

serveStdio(() => createMcpServer(target, {
  onCall: (call) => record({ event: "call", tool: call.tool, args: call.args, ok: call.ok }),
}), { onerror: (error) => console.error(error) });
