import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("cns skills lists, loads, searches and syncs the newest copy of each skill across paired devices", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-skills-")));
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir, skills: path.join(dir, ".agents", "skills") };
  };
  const cli = async (dev: { env: Record<string, string> }, args: string[]) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end();
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  /** A skill at `modified` seconds since the epoch, with a SKILL.md and a script. */
  const skill = async (dev: { skills: string }, name: string, modified: number, text: string) => {
    const dir = path.join(dev.skills, name);
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${text}\n---\n# ${name}\n${text}\n`);
    await writeFile(path.join(dir, "scripts", "run.sh"), `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
    await writeFile(path.join(dir, ".env"), "API_KEY=never-shared\n");
    for (const file of ["SKILL.md", "scripts/run.sh"]) await utimes(path.join(dir, file), modified, modified);
  };
  const alpha = await device("alpha");
  const beta = await device("beta");
  const client = await device("client");
  // Alpha lets the client read its skills alone; beta lets it use its files, which covers skills.
  for (const [name, dev, grant] of [["alpha", alpha, "skills"], ["beta", beta, "files"]] as const) {
    const up = await cli(dev, ["up", "--bind", "127.0.0.1", "--port", await unusedPort("127.0.0.1"), "--state", dev.state]);
    assert.equal(up.code, 0, up.stderr);
    cleanups.push(() => cli(dev, ["stop", "--state", dev.state]));
    const inviting = launchCli(t, ["pair", "--yes", "--name", "client", "--grant", grant, "--state", dev.state], { env: dev.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    const accepted = await cli(client, ["pair", invite, "--yes", "--name", name, "--request", grant, "--grant", "none"]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(await inviting.exited, 0, inviting.stderr);
  }
  await skill(alpha, "pdf", 3_000_000, "alpha-pdf");
  await skill(beta, "pdf", 2_000_000, "beta-pdf");
  await skill(client, "pdf", 1_000_000, "client-pdf");
  await skill(beta, "docx", 2_000_000, "beta-docx");

  // One row per skill, from the device with the newest copy, naming the others.
  const listed = await cli(client, ["skills", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /^docx +beta +1970-01-24 03:33 +- +beta-docx$/m);
  assert.match(listed.stdout, /^pdf +alpha +1970-02-04 17:20 +beta, this device +alpha-pdf$/m);
  const json = JSON.parse((await cli(client, ["skills", "list", "--json"])).stdout);
  assert.deepEqual(json.skills.map((entry: { name: string; device: string | null }) => [entry.name, entry.device]), [["docx", "beta"], ["pdf", "alpha"]]);
  assert.deepEqual(json.skills[1].copies.map((copy: { device: string | null }) => copy.device), ["alpha", "beta", null]);
  assert.deepEqual(json.devices, []);

  // load prints the newest SKILL.md, or a named device's; stderr says where it came from.
  const loaded = await cli(client, ["skills", "load", "pdf"]);
  assert.equal(loaded.code, 0, loaded.stderr);
  assert.match(loaded.stdout, /^---\nname: pdf\ndescription: alpha-pdf\n/);
  assert.match(loaded.stderr, /pdf is from alpha \(modified 1970-02-04 17:20 UTC\), with 1 other file: scripts\/run\.sh\. Read one with cns skills cat alpha:pdf FILE/);
  assert.match((await cli(client, ["skills", "load", "beta:pdf"])).stdout, /beta-pdf/);
  const ls = await cli(client, ["skills", "ls", "pdf"]);
  assert.match(ls.stdout, /^SKILL\.md +\d+ +1970-02-04 17:20\nscripts\/run\.sh +\d+ +1970-02-04 17:20\n$/m);
  assert.equal((await cli(client, ["skills", "cat", "pdf", "scripts/run.sh"])).stdout, "#!/bin/sh\necho alpha-pdf\n");
  // Hidden files are no part of a skill, and alpha's skills grant reads nothing else.
  const hidden = await cli(client, ["skills", "cat", "alpha:pdf", ".env"]);
  assert.equal(hidden.code, 1);
  assert.match(hidden.stderr, /no hidden parts/);
  const outside = await cli(client, ["cp", "alpha:.env", "."]);
  assert.equal(outside.code, 4);
  assert.match(outside.stderr, /files not granted to client.*cns peer grant client files/);
  const missing = await cli(client, ["skills", "load", "beta:nope"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /beta has no skill nope; it has docx, pdf\./);

  // rg searches the newest copy of every skill.
  const found = await cli(client, ["skills", "rg", "-i", "ALPHA|docx"]);
  assert.equal(found.code, 0, found.stderr);
  assert.deepEqual(found.stdout.trim().split("\n").sort(), [
    "docx/SKILL.md:2:name: docx", "docx/SKILL.md:3:description: beta-docx", "docx/SKILL.md:5:# docx", "docx/SKILL.md:6:beta-docx",
    "docx/scripts/run.sh:2:echo beta-docx", "pdf/SKILL.md:3:description: alpha-pdf", "pdf/SKILL.md:6:alpha-pdf", "pdf/scripts/run.sh:2:echo alpha-pdf",
  ]);
  assert.equal((await cli(client, ["skills", "rg", "nothing-matches"])).code, 1);

  // sync copies the newest copy here, over the older one, keeping its times and modes; again, it is already here.
  const synced = await cli(client, ["skills", "sync", "pdf"]);
  assert.equal(synced.code, 0, synced.stderr);
  assert.match(synced.stdout, /pdf: copied 2 files from alpha .* to \/.*\/client\/\.agents\/skills\/pdf\./);
  const local = path.join(client.skills, "pdf");
  assert.match(await readFile(path.join(local, "SKILL.md"), "utf8"), /alpha-pdf/);
  assert.equal(Math.floor((await stat(path.join(local, "scripts", "run.sh"))).mtimeMs / 1000), 3_000_000);
  assert.equal((await stat(path.join(local, "scripts", "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readFile(path.join(local, ".env"), "utf8"), "API_KEY=never-shared\n", "files sync does not have are kept");
  assert.match((await cli(client, ["skills", "list"])).stdout, /^pdf +this device +1970-02-04 17:20 +alpha, beta +alpha-pdf$/m);
  assert.match((await cli(client, ["skills", "sync", "pdf"])).stdout, /pdf: the copy on this device is already in /);

  // To a paired device it needs the files grant there, and keeps the times too.
  const toBeta = await cli(client, ["skills", "sync", "--to", "beta:", "alpha:pdf"]);
  assert.equal(toBeta.code, 0, toBeta.stderr);
  assert.match(await readFile(path.join(beta.skills, "pdf", "SKILL.md"), "utf8"), /alpha-pdf/);
  assert.equal(Math.floor((await stat(path.join(beta.skills, "pdf", "SKILL.md"))).mtimeMs / 1000), 3_000_000);
  const toAlpha = await cli(client, ["skills", "sync", "--to", "alpha:", "docx"]);
  assert.equal(toAlpha.code, 4);
  assert.match(toAlpha.stderr, /files not granted to client/);
  // Nothing that is not a skill is copied over.
  await mkdir(path.join(client.dir, "work", "docx"), { recursive: true });
  const notSkill = await cli(client, ["skills", "sync", "--to", path.join(client.dir, "work"), "docx"]);
  assert.equal(notSkill.code, 1);
  assert.match(notSkill.stderr, /work\/docx exists and is not a skill/);
});
