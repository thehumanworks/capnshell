import assert from "node:assert/strict";
import test from "node:test";
import { testDevices } from "./test-support.js";

// The paired path on Windows: identities, saved peers and the daemon state under ~/.cns,
// whose ACL cns checks there instead of Unix mode bits.
test("on Windows, cns up starts the daemon, two devices pair, and one runs a command on the other", { skip: process.platform !== "win32", timeout: 90000 }, async (t) => {
  const devices = await testDevices(t, "cns-windows-");
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.up(laptop);
  await devices.pair(studio, laptop);
  const run = await devices.cli(laptop, ["run", "studio", "--", "Write-Output ok"]);
  assert.equal(run.code, 0, run.output);
  assert.equal(run.stdout.trim(), "ok");
});
