// Run the peer-naming evals: real `claude -p` sessions against the real cns MCP tools over
// a fake daemon (server.ts), then score how each session named the peers.
//
//   bun evals/peer-naming/run.ts --label baseline --models sonnet,haiku --reps 4 [--scenarios single,several] [--jobs 6]
//
// Results go to evals/peer-naming/results/<label>.json. Each run costs one Claude session.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { SCENARIOS, type RunEvent } from "./scenarios.js";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    models: { type: "string", default: "sonnet" },
    reps: { type: "string", default: "3" },
    scenarios: { type: "string", default: Object.keys(SCENARIOS).join(",") },
    jobs: { type: "string", default: "6" },
  },
});
const here = import.meta.dir;
const models = values.models!.split(",");
const scenarioNames = values.scenarios!.split(",");
const reps = Number(values.reps);

interface Score {
  scenario: string; model: string; rep: number;
  /** Every task requirement met. */
  success: boolean;
  /** Calls refused because the peer they named was not connected. */
  unknownPeer: number;
  /** Calls that named a paired device by its daemon ID rather than its name. */
  idForNamed: number;
  /** Calls that named a peer by a hostname that is not a name it is known by. */
  hostname: number;
  /** Calls that omitted peer although several peers were connected, so were refused. */
  ambiguous: number;
  calls: number;
  failedChecks: string[];
  peerArgs: (string | null)[];
  error?: string;
}

async function runOne(scenario: string, model: string, rep: number): Promise<Score> {
  const work = mkdtempSync(path.join(tmpdir(), `cns-eval-${scenario}-`));
  const log = path.join(work, "calls.jsonl");
  const config = { mcpServers: { cns: { type: "stdio", command: "bun", args: [path.join(here, "server.ts")], env: { EVAL_SCENARIO: scenario, EVAL_LOG: log } } } };
  writeFileSync(path.join(work, "mcp.json"), JSON.stringify(config));
  // A child of this session would otherwise think it was nested in it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CLAUDE(CODE$|_CODE_(SESSION|CHILD|ENTRYPOINT|MESSAGING|EXECPATH)|_PID$|_EFFORT$)/.test(key)));
  const child = Bun.spawn([
    "claude", "-p", SCENARIOS[scenario]!.task,
    "--model", model,
    "--mcp-config", path.join(work, "mcp.json"), "--strict-mcp-config",
    "--setting-sources", "",
    "--allowedTools", "mcp__cns",
    "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch", "NotebookEdit",
    "--no-session-persistence",
    "--output-format", "json",
  ], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(timer);
  writeFileSync(path.join(work, "claude.json"), out);

  const events = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const spec = SCENARIOS[scenario]!;
  const runs: RunEvent[] = events.filter((e) => e.event === "run");
  const calls = events.filter((e) => e.event === "call" && e.tool !== "list_peers");
  const peerArgs = calls.map((c) => (c.args.peer as string | undefined) ?? null);
  const named = spec.peers.filter((p) => p.name);
  const hostnames = new Set(spec.peers.filter((p) => p.hostname !== p.name).flatMap((p) => [p.hostname.toLowerCase(), p.hostname.toLowerCase().replace(/\.local$/, "")]));
  const failures = events.filter((e) => e.event === "resolve-failed");
  const failedChecks = spec.checks.filter((check) => !check.ok(runs)).map((check) => check.label);
  return {
    scenario, model, rep,
    success: failedChecks.length === 0,
    unknownPeer: failures.filter((f) => f.requested !== undefined).length,
    ambiguous: failures.filter((f) => f.requested === undefined).length,
    idForNamed: named.length && spec.rotate ? peerArgs.filter((p) => p !== null && /^p\d+$/.test(p)).length : 0,
    hostname: peerArgs.filter((p) => p !== null && hostnames.has(p.toLowerCase())).length,
    calls: calls.length,
    failedChecks,
    peerArgs,
    ...child.exitCode === 0 ? {} : { error: `claude exited ${child.exitCode}: ${err.slice(0, 500)}` },
  };
}

const jobs: (() => Promise<Score>)[] = [];
for (const scenario of scenarioNames) for (const model of models) for (let rep = 0; rep < reps; rep++) jobs.push(() => runOne(scenario, model, rep));
const scores: Score[] = [];
let next = 0;
await Promise.all(Array.from({ length: Number(values.jobs) }, async () => {
  while (next < jobs.length) {
    const score = await jobs[next++]!();
    scores.push(score);
    console.error(`${score.scenario}/${score.model}#${score.rep}: ${score.success ? "ok" : `FAIL ${score.failedChecks.join("; ")}`} unknown=${score.unknownPeer} id=${score.idForNamed} host=${score.hostname} peers=${JSON.stringify(score.peerArgs)}${score.error ? ` ${score.error}` : ""}`);
  }
}));

// A clean run met every requirement without a single refused call.
const summary: Record<string, Record<string, unknown>> = {};
for (const scenario of scenarioNames) for (const model of models) {
  const group = scores.filter((s) => s.scenario === scenario && s.model === model);
  const sum = (key: "unknownPeer" | "idForNamed" | "hostname" | "ambiguous" | "calls") => group.reduce((total, s) => total + s[key], 0);
  summary[`${scenario}/${model}`] = {
    n: group.length,
    success: group.filter((s) => s.success).length,
    clean: group.filter((s) => s.success && s.unknownPeer === 0 && s.ambiguous === 0).length,
    unknownPeer: sum("unknownPeer"), idForNamed: sum("idForNamed"), hostname: sum("hostname"), ambiguous: sum("ambiguous"), calls: sum("calls"),
  };
}
console.table(summary);
mkdirSync(path.join(here, "results"), { recursive: true });
writeFileSync(path.join(here, "results", `${values.label}.json`), JSON.stringify({ label: values.label, summary, scores }, null, 2));
