import path from "node:path";
import { PROJECT_ROOT } from "./project.js";
import { selfInvocation } from "./runtime.js";

export function cliInvocation(args: string[]): { file: string; args: string[] } {
  const binary = process.env.CAPNWEB_TEST_BINARY;
  if (!binary) return selfInvocation(args);
  return {
    file: binary === "1" ? path.join(PROJECT_ROOT, "dist", process.platform === "win32" ? "capnweb-shell.exe" : "capnweb-shell") : path.resolve(binary),
    args,
  };
}
