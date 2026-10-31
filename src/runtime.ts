import { fileURLToPath } from "node:url";

declare const CAPNWEB_COMPILED: boolean;
declare const CNS_BUNDLED: boolean;
export const IS_COMPILED = typeof CAPNWEB_COMPILED !== "undefined" && CAPNWEB_COMPILED;
/** Built into one script, as the Pi package's cns.js, rather than run from source. */
const IS_BUNDLED = typeof CNS_BUNDLED !== "undefined" && CNS_BUNDLED;

/** Re-enter this CLI, not Bun's interpreter, when running a compiled executable. */
export function selfInvocation(args: string[]): { file: string; args: string[] } {
  if (IS_COMPILED) return { file: process.execPath, args };
  const script = IS_BUNDLED ? fileURLToPath(import.meta.url) : fileURLToPath(new URL("cli.ts", import.meta.url));
  return { file: process.execPath, args: [script, ...args] };
}
