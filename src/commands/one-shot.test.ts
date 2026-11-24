import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { beforeSecrets } from "./one-shot.js";

test("a device from before --secret says so, in place of its schema error; other errors are left as they are", () => {
  // What cns 1.x answers: its options are a strict object without env.
  const old = z.strictObject({ timeoutMs: z.number().optional(), cwd: z.string().optional() });
  let refusal: unknown;
  try { old.parse({ cwd: "/srv", env: { API_KEY: "sk-value" } }); } catch (error) { refusal = error; }
  const told = beforeSecrets(refusal, "studio");
  assert.ok(told instanceof Error);
  assert.equal(told.message, "studio runs a cns from before --secret, so nothing was started there. Update cns on studio to 2.0.0 or later.");
  // Capnweb carries an error's message as text.
  assert.equal((beforeSecrets(new Error((refusal as Error).message), "studio") as Error).message, told.message);
  for (const other of [new Error("No PTY session named env."), new Error("cwd must be an absolute path."), new Error('Unrecognized key: "cols"'), "text"]) {
    assert.equal(beforeSecrets(other, "studio"), other);
  }
});
