import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("cns cp copies directories both ways and between two paired devices", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-copy-")));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir };
  };
  const cli = async (dev: { env: Record<string, string> }, args: string[], options: { cwd?: string } = {}) => {
    const child = launchCli(t, args, { env: dev.env, cwd: options.cwd });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const alpha = await device("alpha");
  const beta = await device("beta");
  const client = await device("client");
  // Alpha and beta run daemons and grant the client only their files.
  for (const [name, dev] of [["alpha", alpha], ["beta", beta]] as const) {
    const up = await cli(dev, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", dev.state]);
    assert.equal(up.code, 0, up.stderr);
    cleanups.push(() => cli(dev, ["stop", "--state", dev.state]));
    const inviting = launchCli(t, ["pair", "--yes", "--name", "client", "--grant", "files", "--state", dev.state], { env: dev.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    const accepted = await cli(client, ["pair", invite, "--yes", "--name", name, "--request", "files", "--grant", "none"]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(await inviting.exited, 0, inviting.stderr);
  }

  // A tree on the client: nested directories, an empty file, an executable, a link to a file and one to a directory.
  const tree = path.join(client.dir, "tree");
  await mkdir(path.join(tree, "sub", "deeper"), { recursive: true });
  await writeFile(path.join(tree, "a.txt"), "alpha text");
  await writeFile(path.join(tree, "empty"), "");
  await writeFile(path.join(tree, "sub", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const big = Buffer.alloc(5 * 1024 * 1024 + 17, 7);
  await writeFile(path.join(tree, "sub", "deeper", "big.bin"), big);
  await symlink("a.txt", path.join(tree, "link.txt"));
  await symlink("sub", path.join(tree, "linkdir"));
  /** Each regular file under `dir` by relative path, with its hash; links are followed to files only. */
  const contents = async (dir: string, prefix = ""): Promise<Record<string, string>> => {
    const found: Record<string, string> = {};
    for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) Object.assign(found, await contents(dir, relative));
      else if (entry.isFile()) found[relative] = new Bun.CryptoHasher("sha256").update(await readFile(path.join(dir, relative))).digest("hex");
    }
    return found;
  };
  // The link to a file arrives as the file.
  const expected = { ...await contents(tree), "link.txt": new Bun.CryptoHasher("sha256").update("alpha text").digest("hex") };

  // A directory needs -r.
  const refused = await cli(client, ["cp", tree, "alpha:"]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /is a directory; copy it with cns cp -r/);

  // Into an existing remote directory, under its own name; the link to a directory is skipped and the status says so.
  const uploaded = await cli(client, ["cp", "-r", tree, "alpha:"]);
  assert.equal(uploaded.code, 1, uploaded.stderr);
  assert.match(uploaded.stderr, /^cns: skipped \/.*\/client\/tree\/linkdir: a link to a directory, which is not followed$/m);
  assert.deepEqual(await contents(path.join(alpha.dir, "tree")), expected);
  assert.equal((await stat(path.join(alpha.dir, "tree", "sub", "run.sh"))).mode & 0o777, 0o755);

  // From one paired device to another, through this one, to a new name.
  const across = await cli(client, ["cp", "-r", "alpha:tree", "beta:~/copied"]);
  assert.equal(across.code, 0, across.stderr);
  assert.deepEqual(await contents(path.join(beta.dir, "copied")), expected);
  const file = await cli(client, ["cp", "alpha:tree/a.txt", "beta:"]);
  assert.equal(file.code, 0, file.stderr);
  assert.equal(await readFile(path.join(beta.dir, "a.txt"), "utf8"), "alpha text");

  // Back to the client into a directory that ends with /, and within one device.
  await mkdir(path.join(client.dir, "back"));
  const downloaded = await cli(client, ["cp", "-r", "beta:copied", "back/"], { cwd: client.dir });
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.deepEqual(await contents(path.join(client.dir, "back", "copied")), expected);
  const within = await cli(client, ["cp", "-r", "beta:copied", "beta:again"]);
  assert.equal(within.code, 0, within.stderr);
  assert.deepEqual(await contents(path.join(beta.dir, "again")), expected);

  // Copies that would destroy their source are refused.
  const self = await cli(client, ["cp", "beta:a.txt", "beta:~/a.txt"]);
  assert.match(self.stderr, /are the same file/);
  const into = await cli(client, ["cp", "-r", "beta:copied", "beta:copied/sub"]);
  assert.match(into.stderr, /into itself/);
  const notDirectory = await cli(client, ["cp", "-r", "alpha:tree", "beta:a.txt"]);
  assert.match(notDirectory.stderr, /exists and is not a directory/);
  for (const result of [self, into, notDirectory]) assert.equal(result.code, 1);
  const missing = await cli(client, ["cp", "alpha:nothing", "beta:"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /alpha:.*\/nothing: No such file or directory/);
});
