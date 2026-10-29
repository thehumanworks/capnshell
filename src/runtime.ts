import { fileURLToPath } from "node:url";

declare const CAPNWEB_COMPILED: boolean;
export const IS_COMPILED = typeof CAPNWEB_COMPILED !== "undefined" && CAPNWEB_COMPILED;

/** Re-enter this CLI, not Bun's interpreter, when running a compiled executable. */
export function selfInvocation(args: string[]): { file: string; args: string[] } {
  return {
    file: process.execPath,
    args: IS_COMPILED ? args : [fileURLToPath(new URL("cli.ts", import.meta.url)), ...args],
  };
}
