import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Invocation = (args: string[]) => { file: string; args: string[] };

/** The Bun the published package depends on to run its bundled cns. */
export const BUN_VERSION = "1.4.4";
/** Oldest Bun that runs cns correctly; Pi's own Bun 1.3 misreports signals, for one. */
const MINIMUM_BUN = [1, 4, 2] as const;

/**
 * Bun's per-platform npm packages, as the `bun` package lists them, by Node's
 * platform and architecture. The package depends on all of them optionally, so
 * npm installs only this machine's.
 */
export const BUN_PACKAGES: Record<string, string[]> = {
  "darwin-arm64": ["@oven/bun-darwin-aarch64"],
  "darwin-x64": ["@oven/bun-darwin-x64"],
  "linux-arm64": ["@oven/bun-linux-aarch64", "@oven/bun-linux-aarch64-musl"],
  "linux-x64": ["@oven/bun-linux-x64", "@oven/bun-linux-x64-musl"],
  "win32-arm64": ["@oven/bun-windows-aarch64"],
  "win32-x64": ["@oven/bun-windows-x64"],
};

/** An executable named `name` on PATH, with Windows' extensions. Bun.which, which Node lacks. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = process.platform === "win32";
  const extensions = windows ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const file = path.join(directory, name + extension);
      try {
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        return file;
      } catch {}
    }
  }
  return undefined;
}

/** This machine's Bun from the package's platform dependency, if npm installed it. */
export function bundledBun(from = import.meta.url): string | undefined {
  const candidates = [...BUN_PACKAGES[`${process.platform}-${process.arch}`] ?? []];
  // npm installs the package for this libc; prefer it if an older npm installed both.
  const musl = process.platform === "linux" && existsSync(`/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`);
  if (musl) candidates.reverse();
  const require = createRequire(from);
  for (const name of candidates) {
    let manifest: string;
    try { manifest = require.resolve(`${name}/package.json`); }
    catch { continue; }
    const file = path.join(path.dirname(manifest), "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(file)) return file;
  }
  return undefined;
}

function bunVersion(file: string): string | undefined {
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function recentEnough(version: string): boolean {
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < MINIMUM_BUN.length; index++) {
    if ((parts[index] ?? 0) !== MINIMUM_BUN[index]) return (parts[index] ?? 0) > MINIMUM_BUN[index]!;
  }
  return true;
}

/**
 * Run a cns script with Bun, isolated from the directory it starts in: without
 * the flags, Bun loads that directory's .env and its bunfig.toml, whose preloads
 * would run in the daemon.
 */
function withBun(bun: string, script: string, from: string): Invocation {
  const config = fileURLToPath(new URL("./daemon.bunfig.toml", from));
  return (args) => ({ file: bun, args: ["--no-env-file", `--config=${config}`, script, ...args] });
}

/**
 * How to run cns for the daemon, which outlives Pi, in this order: --cns-bin or
 * CNS_BIN; the published package's bundled cns.js with its Bun; `cns` on PATH;
 * a source checkout with Bun from PATH. Never Pi's own executable.
 */
export function cnsInvocation(explicit?: string, env: NodeJS.ProcessEnv = process.env, from = import.meta.url): Invocation {
  const configured = explicit?.trim() || env.CNS_BIN?.trim();
  if (configured) return (args) => ({ file: configured, args });

  const bundled = fileURLToPath(new URL("./cns.js", from));
  if (existsSync(bundled)) {
    const bun = bundledBun(from) ?? findOnPath("bun", env);
    const version = bun && bunVersion(bun);
    if (bun && version && recentEnough(version)) return withBun(bun, bundled, from);
    if (!bun) {
      throw new Error(`This package's Bun for ${process.platform}-${process.arch} is not installed. Reinstall the package with optional dependencies, put Bun ${MINIMUM_BUN.join(".")} or newer on PATH, or set CNS_BIN to a cns executable.`);
    }
    // Bun's x64 builds need AVX2; its npm package would pick a baseline build, but this one is fixed.
    if (!version) throw new Error(`${bun} does not run on this machine${process.arch === "x64" ? ", perhaps for want of AVX2" : ""}. Set CNS_BIN to a cns executable that does.`);
    throw new Error(`${bun} is Bun ${version}; cns needs Bun ${MINIMUM_BUN.join(".")} or newer. Reinstall the package so npm installs its Bun, or set CNS_BIN to a cns executable.`);
  }

  const installed = findOnPath("cns", env);
  if (installed) return (args) => ({ file: installed, args });
  const source = fileURLToPath(new URL("../src/cli.ts", from));
  const bun = findOnPath("bun", env);
  if (bun && existsSync(source)) return withBun(bun, source, from);
  throw new Error("Cannot find cns to start its daemon. Put cns on PATH, set CNS_BIN, or start Pi with --cns-bin PATH.");
}
