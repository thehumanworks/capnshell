import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { commandExitCode } from "./commands/peer.js";
import { PROJECT_ROOT, unusedPort } from "./test-support.js";

test("shutdown during daemon startup cleans up subsequently acquired control resources", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-startup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, "state.json");
  const port = await unusedPort();
  // Isolate process-level signals/environment from the test runner. A leaked server
  // keeps this child alive, so checking only the returned promise would miss the bug.
  const script = `
    import { startPeer } from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, "src/commands/peer.ts")).href)};
    import { parseOptions } from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, "src/options.ts")).href)};
    process.env.CNS_DAEMON_CHILD = '1';
    const task = startPeer(parseOptions(${JSON.stringify(["listen", "--no-repl", "--bind", "::1", "--port", port, "--state", state])}));
    process.emit('SIGTERM');
    await task;
  `;
  const result = await execa(process.execPath, ["--eval", script], { timeout: 5000 });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.stdout, /listening at/);
  await assert.rejects(() => stat(state), { code: "ENOENT" });
});

test("run translates signals using the executor's number across operating systems", () => {
  const result = { stdout: "", stderr: "", exitCode: null, signal: "SIGBUS" as const,
    signalNumber: 7, timedOut: false, truncated: false, elapsedMs: 1 };
  assert.equal(commandExitCode(result), 135); // Linux SIGBUS, even when the client is macOS.
  assert.equal(commandExitCode({ ...result, signalNumber: 10 }), 138); // macOS SIGBUS.
  assert.equal(commandExitCode({ ...result, timedOut: true }), 124);
});
