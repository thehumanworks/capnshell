import assert from "node:assert/strict";
import test from "node:test";
import { describeCall } from "./audit.js";

const call = (tool: string, args: Record<string, unknown>) => describeCall({ tool: tool as never, args, ok: true, elapsedMs: 1 });

test("the audit log keeps commands and paths, but not file contents or typed keys", () => {
  assert.equal(call("run_command", { command: "make test", cwd: "/srv/app" }), "make test (in /srv/app)");
  assert.equal(call("write_file", { path: "/srv/.env", content: "SECRET=hunter2" }), "/srv/.env (14 bytes)");
  assert.equal(call("send_keys", { name: "shell", keys: ["my password", "Enter"] }), "shell: 2 keys");
  assert.equal(call("start_session", { name: "dev" }), "dev: login shell");
  assert.equal(call("glob", { pattern: "**/*.ts", path: "/src" }), "**/*.ts in /src");
  assert.equal(call("list_peers", {}), "");
  assert.equal(call("run_command", { command: "x".repeat(600) }).length, 503);
});
