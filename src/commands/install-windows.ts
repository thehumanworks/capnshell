import { cp, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { PROJECT_FILES, resolveProjectRoot } from "../project.js";

type BunRunner = (args: string[], cwd: string) => Promise<void>;

async function runBun(args: string[], cwd: string): Promise<void> {
  // Use the external package manager, never process.execPath (which may be this CLI).
  await execa("bun", args, { cwd, stdio: "inherit" });
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertSeparate(source: string, destination: string): void {
  if (contains(source, destination) || contains(destination, source)) {
    throw new Error("Installation destination must not overlap the source project.");
  }
}

// Testable without modifying a real installation or invoking the package manager.
export async function installWindowsCopy(destination: string, sourceRoot: string, bun: BunRunner = runBun): Promise<void> {
  if (!path.isAbsolute(destination)) throw new Error("Installation destination must be an absolute path.");
  const source = await resolveProjectRoot(sourceRoot);
  assertSeparate(source, path.resolve(destination));
  await mkdir(destination, { recursive: true });
  const target = await realpath(destination);
  assertSeparate(source, target);
  if ((await readdir(target)).length > 0) {
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    } catch {
      throw new Error(`Refusing to overwrite a nonempty directory without a valid capnweb-shell package: ${target}`);
    }
    if (!existing || typeof existing !== "object" || !("name" in existing) || existing.name !== "capnweb-shell") {
      throw new Error(`Refusing to overwrite another project at ${target}`);
    }
  }
  for (const file of PROJECT_FILES) {
    await cp(path.join(source, file), path.join(target, file), { recursive: true, force: true });
  }
  await bun(["install", "--frozen-lockfile", "--ignore-scripts"], target);
  await bun(["run", "build"], target);
}

export async function installWindows(options: { destination?: string; source?: string } = {}): Promise<void> {
  const source = await resolveProjectRoot(options.source);
  let destination: string;
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    const { stdout: localAppData } = await execa("bun.exe", ["-e", "console.log(process.env.LOCALAPPDATA)"]);
    if (!options.destination && (!localAppData.trim() || localAppData.trim() === "undefined")) {
      throw new Error("Windows LOCALAPPDATA is not set; supply --destination.");
    }
    destination = options.destination ?? path.win32.join(localAppData.trim(), "capnweb-shell");
    if (!path.win32.isAbsolute(destination)) throw new Error("Installation destination must be an absolute Windows path.");
    const { stdout: mountedPath } = await execa("wslpath", ["-u", destination]);
    // Copy via WSL's filesystem, then let Windows Bun install/build locally.
    // This works even when this CLI is a standalone binary or a Nix package.
    await installWindowsCopy(mountedPath.trim(), source, async (args) => {
      await execa("bun.exe", ["--cwd", destination, ...args], { stdio: "inherit" });
    });
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!options.destination && !localAppData) throw new Error("LOCALAPPDATA is not set; supply --destination.");
    destination = options.destination ?? path.join(localAppData!, "capnweb-shell");
    await installWindowsCopy(destination, source);
  } else {
    throw new Error("install-windows requires native Windows or WSL.");
  }
  console.log(`Installed the native Windows peer at ${destination}`);
  console.log(`Run in Windows PowerShell: & "${path.win32.join(destination, "dist", "capnweb-shell.exe")}" windows`);
}
