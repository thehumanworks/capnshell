import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_COMPILED } from "./runtime.js";

declare const CAPNWEB_DEFAULT_SOURCE: string;
export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PROJECT_FILES = [
  "package.json", "bun.lock", "tsconfig.json", "src", "nix", "flake.nix", "flake.lock", "README.md", "README-MAC.md",
] as const;

/** Source-based setup is optional: normal peers need only the compiled binary. */
export async function resolveProjectRoot(explicit?: string): Promise<string> {
  const packaged = typeof CAPNWEB_DEFAULT_SOURCE === "string" ? CAPNWEB_DEFAULT_SOURCE : undefined;
  const candidate = explicit ?? process.env.CAPNWEB_SOURCE_DIR ?? packaged ?? (IS_COMPILED ? process.cwd() : PROJECT_ROOT);
  try {
    const root = await realpath(candidate);
    const manifest: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== "capnweb-shell") {
      throw new Error("Not a capnweb-shell source tree");
    }
    await Promise.all(PROJECT_FILES.map((file) => access(path.join(root, file))));
    return root;
  } catch (error) {
    throw new Error(`A complete source checkout is required for this setup command. Use --source PATH or CAPNWEB_SOURCE_DIR. Checked: ${candidate}`, { cause: error });
  }
}
