import { mkdir } from "node:fs/promises";
import path from "node:path";
import { create } from "tar";
import { PROJECT_FILES, resolveProjectRoot } from "../project.js";

export async function createMacBundle(options: { output?: string; source?: string } = {}): Promise<string> {
  const projectRoot = await resolveProjectRoot(options.source);
  const output = options.output
    ? path.resolve(options.output)
    : path.resolve("dist", "capnweb-shell-mac.tar.gz");
  await mkdir(path.dirname(output), { recursive: true });
  // tar handles archive headers, portable paths and gzip without a system tar
  // dependency. Ship source/lockfile, never host-specific node_modules.
  await create({
    file: output, cwd: projectRoot, gzip: true, portable: true, prefix: "capnweb-shell",
  }, [...PROJECT_FILES]);
  return output;
}
