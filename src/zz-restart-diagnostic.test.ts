// TEMPORARY diagnostic for the Windows restart path; not to be merged.
import { spawn } from "node:child_process";
import test from "node:test";
import { powershell, powershellArgs } from "./platform.js";
import { cliEnvironment, cliInvocation, testDevices } from "./test-support.js";

function timed(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const started = Date.now();
  const child = spawn(file, args, { env: cliEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  let exit = -1;
  child.once("exit", (code) => { exit = Date.now() - started; console.log(`[diag] exit ${code} after ${exit} ms`); });
  return new Promise<string>((resolve) => child.once("close", (code) => resolve(`exit at ${exit} ms, close (${code}) at ${Date.now() - started} ms: ${out.trim()}`)));
}

test("DIAGNOSTIC: how long a restart's command takes to exit and close on Windows", { skip: process.platform !== "win32", timeout: 120000 }, async (t) => {
  const devices = await testDevices(t, "cns-diag-");
  const studio = await devices.device("studio");
  await devices.up(studio);
  const { file, args } = cliInvocation(["daemon", "restart", "--state", studio.state]);
  console.log(`[diag] direct: ${await timed(file, args, studio.env)}`);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const command = `& ${[file, ...args].map((word) => `'${word}'`).join(" ")}`;
  console.log(`[diag] powershell: ${await timed(powershell(), powershellArgs(command, false), studio.env)}`);
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const short = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => short.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  let alive: string;
  try { process.kill(short.pid!, 0); alive = "kill(pid, 0) succeeds for an exited process"; } catch (error) { alive = `kill(pid, 0) throws ${(error as NodeJS.ErrnoException).code}`; }
  console.log(`[diag] ${alive}`);
});
