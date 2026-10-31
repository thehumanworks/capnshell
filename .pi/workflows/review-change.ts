import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

const FINDINGS = Type.Object({
  findings: Type.Array(Type.Object({
    title: Type.String(),
    severity: Type.Union([Type.Literal("bug"), Type.Literal("reliability"), Type.Literal("polish")]),
    location: Type.String({ description: "file:line" }),
    evidence: Type.String({ description: "What in the code, or which experiment, shows the problem" }),
    fix: Type.String(),
  })),
});

const rules = `Review the change on this branch: \`git diff --cached BASE\` plus untracked files from \`git status\` (BASE is given below).
Read the surrounding code too; the change has to work with it.
- Do not modify, stage or commit anything in the repository. Put scratch files in /tmp/cns-review/LABEL.
- You may run focused experiments: \`bun test --timeout 60000 <file> -t <name>\`, small scripts under /tmp, real \`bun src/cli.ts ...\` processes.
  Do not run \`bun run build\` or \`bun run test:compiled\`; other reviewers share dist/.
- Report only problems you can point to in the code or reproduce. No style preferences, no speculative rewrites,
  nothing the code already handles. A short list of real findings beats a long one. Say "none" honestly.`;

export default defineWorkflow({
  name: "review-change",
  description: "One review pass over a branch's staged change: three focused reviewers, then a judge who verifies each finding against the code and keeps only the real ones. Read-only.",
  args: Type.Object({
    base: Type.String({ description: "Git ref the change is compared against" }),
    context: Type.String({ description: "What the change does, its constraints and known limitations" }),
  }),
  budget: { maxAgents: 4 },
  async run(ctx) {
    const { base, context } = ctx.args;
    const focuses = {
      reliability: `Reliability: cancellation, aborts and their races, connection loss, cleanup of processes, sockets, timers,
listeners and waiters, resource bounds and leaks, shutdown on stdin EOF and signals, concurrency limits, error paths that leave state behind.`,
      security: `Security and protocol correctness of the HTTP and stdio MCP servers: authentication, Host/Origin checks, token handling,
body/concurrency limits, legacy session handling, what a connected listener can do to the MCP server's machine, stdout purity on stdio,
MCP spec conformance of tool results, schemas and annotations.`,
      edges: `Edges and bugs: CLI option parsing and validation, env vars, error messages an agent or user will see, output clipping,
tool input/output schemas versus what the code returns, README accuracy against the code, tests that would pass even if the code
were broken, platform differences (Windows paths and PowerShell are untested but must not be broken by construction).`,
    };
    ctx.phase("Review");
    const reviews = await ctx.parallel(Object.entries(focuses).map(([label, focus]) => () =>
      ctx.agent(`${rules.replaceAll("LABEL", label)}\n\nBASE: ${base}\n\nAbout the change:\n${context}\n\nYour focus. ${focus}`,
        { label, tools: ["read", "bash"], schema: FINDINGS, timeoutMs: 40 * 60_000 })));
    ctx.phase("Judge");
    return ctx.agent(`${rules.replaceAll("LABEL", "judge")}\n\nBASE: ${base}\n\nAbout the change:\n${context}

Three reviewers reported these findings. For each, check the code (and reproduce where practical). Keep only findings that are real
and worth fixing in this change; merge duplicates; correct the location, evidence or fix where a reviewer got it wrong.
Order by severity: bug, then reliability, then polish.

${JSON.stringify(reviews, null, 1)}`, { label: "judge", tools: ["read", "bash"], schema: FINDINGS, timeoutMs: 40 * 60_000 });
  },
});
