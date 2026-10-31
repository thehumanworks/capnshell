import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter, once } from "node:events";
import net from "node:net";
import path from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { selfInvocation } from "./runtime.js";

export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function cliInvocation(args: string[]): { file: string; args: string[] } {
  const binary = process.env.CAPNWEB_TEST_BINARY;
  if (!binary) return selfInvocation(args);
  return {
    file: binary === "1" ? path.join(PROJECT_ROOT, "dist", process.platform === "win32" ? "cns.exe" : "cns") : path.resolve(binary),
    args,
  };
}

/** A port that is free on `host`, which should be the address the test then binds. */
export async function unusedPort(host = "::1"): Promise<string> {
  const probe = net.createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Missing probe address");
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return String(address.port);
}

/** Keep user CLI defaults out of tests unless explicitly supplied. */
export function cliEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, CNS_BIND: undefined, CNS_PORT: undefined, CNS_CWD: undefined, ...overrides };
}

/** Exercise actual CLI processes, keeping exact streams available for run assertions. */
export function launchCli(t: TestContext, args: string[], options: SpawnOptionsWithoutStdio = {}) {
  const invocation = cliInvocation(args);
  const child = spawn(invocation.file, invocation.args, {
    ...options, env: cliEnvironment(options.env), stdio: ["pipe", "pipe", "pipe"],
  });
  const events = new EventEmitter();
  let output = "";
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; output += chunk; events.emit("change"); });
  child.stderr.on("data", (chunk) => { stderr += chunk; output += chunk; events.emit("change"); });
  child.on("error", (error) => { output += error.message; events.emit("change"); });
  const exited = new Promise<number | null>((resolve) => child.once("close", (code) => {
    closed = true;
    events.emit("change");
    resolve(code);
  }));
  t.after(async () => {
    if (closed) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    await exited;
    clearTimeout(timer);
  });
  const waitFor = (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      events.off("change", check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (output.includes(needle, from)) finish();
      else if (closed) finish(new Error(`CLI exited before ${needle}:\n${output}`));
    };
    const timer = setTimeout(() => finish(new Error(`Waiting for ${needle}:\n${output}`)), 15000);
    events.on("change", check);
    check();
  });
  return {
    child, exited, waitFor,
    get output() { return output; },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    get closed() { return closed; },
    async send(command: string, expected: string) {
      const from = output.length;
      child.stdin.write(command + "\n");
      await waitFor(expected, from);
      return output.slice(from);
    },
  };
}
