import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { BUN_PACKAGES, cnsInvocation } from "./program.js";

const posix = process.platform !== "win32";
const bunPackage = BUN_PACKAGES[`${process.platform}-${process.arch}`]?.[0];

/** An installed package whose Bun is a script that prints `version`, or fails without one. */
async function installed(t: TestContext, version: string | undefined) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-program-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const extension = path.join(root, "node_modules", "@nothumanwork", "pi-cns");
  await mkdir(extension, { recursive: true });
  await writeFile(path.join(extension, "cns.js"), "");
  const bun = path.join(root, "node_modules", ...bunPackage!.split("/"));
  await mkdir(path.join(bun, "bin"), { recursive: true });
  await writeFile(path.join(bun, "package.json"), "{}");
  await writeFile(path.join(bun, "bin", "bun"), version ? `#!/bin/sh\necho ${version}\n` : "#!/bin/sh\nexit 132\n");
  await chmod(path.join(bun, "bin", "bun"), 0o755);
  return { from: pathToFileURL(path.join(extension, "index.js")).href, extension, bun: path.join(bun, "bin", "bun") };
}

test("the package runs its cns with its own Bun, isolated from the directory it starts in", { skip: !posix || !bunPackage }, async (t) => {
  const { from, extension, bun } = await installed(t, "1.4.4");
  assert.deepEqual(cnsInvocation(undefined, { PATH: "" }, from)(["listen"]), {
    file: bun, args: ["--no-env-file", `--config=${path.join(extension, "daemon.bunfig.toml")}`, path.join(extension, "cns.js"), "listen"],
  });
  // --cns-bin, then CNS_BIN, take precedence.
  assert.deepEqual(cnsInvocation(" /opt/cns ", { CNS_BIN: "/usr/local/bin/cns" }, from)(["stop"]), { file: "/opt/cns", args: ["stop"] });
  assert.deepEqual(cnsInvocation(undefined, { CNS_BIN: "/usr/local/bin/cns" }, from)(["stop"]), { file: "/usr/local/bin/cns", args: ["stop"] });
});

test("the package refuses a Bun older than cns needs, such as Pi's own, or one missing or broken", { skip: !posix || !bunPackage }, async (t) => {
  const old = await installed(t, "1.3.14");
  assert.throws(() => cnsInvocation(undefined, { PATH: "" }, old.from), /is Bun 1\.3\.14; cns needs Bun 1\.4\.2 or newer/);
  const broken = await installed(t, undefined);
  assert.throws(() => cnsInvocation(undefined, { PATH: "" }, broken.from), /does not run on this machine.*CNS_BIN/);
  // Installed without optional dependencies, and no Bun on PATH.
  await rm(path.dirname(path.dirname(broken.bun)), { recursive: true });
  assert.throws(() => cnsInvocation(undefined, { PATH: "" }, broken.from), /Bun for .* is not installed/);
});
