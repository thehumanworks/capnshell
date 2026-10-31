// Build the Pi extension as an npm package that needs nothing else installed:
// the extension in one script that Pi loads on Node or Bun, cns in another that
// the daemon runs, and Bun for this platform as an optional dependency.
//
//   bun scripts/build-pi-package.ts [OUT_DIR]     (default dist/pi-package)
//   cd dist/pi-package && npm publish
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUN_PACKAGES, BUN_VERSION } from "../pi/program.js";

export const PACKAGE_NAME = "@nothumanwork/pi-cns";
/** Modules Pi gives extensions; bundling them would bypass Pi's own copies. */
const HOST_MODULES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "typebox"];
const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function bundle(entry: string, outdir: string, name: string, options: Partial<Bun.BuildConfig>) {
  const result = await Bun.build({ entrypoints: [path.join(ROOT, entry)], outdir, naming: name, format: "esm", ...options });
  if (!result.success) throw new AggregateError(result.logs, `Cannot bundle ${entry}`);
}

export async function buildPiPackage(out = path.join(ROOT, "dist/pi-package")): Promise<string> {
  const root = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { version: string };
  await rm(out, { force: true, recursive: true });
  await mkdir(out, { recursive: true });
  await bundle("pi/index.ts", out, "index.js", { target: "node", external: HOST_MODULES });
  await bundle("src/cli.ts", out, "cns.js", { target: "bun", define: { CNS_BUNDLED: "true" } });
  await copyFile(path.join(ROOT, "pi/daemon.bunfig.toml"), path.join(out, "daemon.bunfig.toml"));
  await copyFile(path.join(ROOT, "pi/README.md"), path.join(out, "README.md"));

  const imported = await readFile(path.join(out, "index.js"), "utf8");
  const peers = HOST_MODULES.filter((name) => imported.includes(`from "${name}"`));
  const manifest = {
    name: PACKAGE_NAME,
    version: root.version,
    description: "Run Pi's tools on other machines with Cap’n Shell (cns).",
    keywords: ["pi-package", "pi-extension", "remote", "shell"],
    repository: { type: "git", url: "git+https://github.com/thehumanworks/capnshell.git" },
    type: "module",
    files: ["index.js", "cns.js", "daemon.bunfig.toml", "README.md"],
    pi: { extensions: ["./index.js"] },
    peerDependencies: Object.fromEntries(peers.map((name) => [name, "*"])),
    // npm installs only the one for this machine's platform, CPU and libc.
    optionalDependencies: Object.fromEntries(Object.values(BUN_PACKAGES).flat().sort().map((name) => [name, BUN_VERSION])),
  };
  await writeFile(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return out;
}

if (import.meta.main) console.log(await buildPiPackage(process.argv[2] ? path.resolve(process.argv[2]) : undefined));
