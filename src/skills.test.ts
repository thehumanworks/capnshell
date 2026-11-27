import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import { explained } from "./commands/skills-cli.js";
import { byNewest, listSkillFiles, listSkills, readSkillFile, skillDescription } from "./skills.js";

const posix = process.platform !== "win32";

async function skillsRoot(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-skills-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("skills are the directories with a SKILL.md, described by their front matter and dated by their newest file", async (t) => {
  const root = await skillsRoot(t);
  const pdf = path.join(root, "pdf");
  await mkdir(path.join(pdf, "scripts"), { recursive: true });
  await writeFile(path.join(pdf, "SKILL.md"), "---\nname: pdf\ndescription: >\n  Fill and merge\n  PDF forms.\n---\n# PDF\n");
  await writeFile(path.join(pdf, "scripts", "fill.py"), "print('fill')\n");
  await utimes(path.join(pdf, "SKILL.md"), new Date(1_000_000), new Date(1_000_000));
  await utimes(path.join(pdf, "scripts", "fill.py"), new Date(2_000_000), new Date(2_000_000));
  // Lower-case skill.md counts; a directory without one, a hidden one and a file are not skills.
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(root, "notes", "skill.md"), "no front matter\n");
  await mkdir(path.join(root, "library"));
  await writeFile(path.join(root, "library", "README.md"), "");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "SKILL.md"), "");
  await writeFile(path.join(root, "loose.md"), "");
  assert.deepEqual(await listSkills(root), [
    { name: "notes", description: "", modifiedMs: (await listSkillFiles("notes", root))[0]!.modifiedMs },
    { name: "pdf", description: "Fill and merge PDF forms.", modifiedMs: 2_000_000 },
  ]);
  assert.deepEqual(await listSkills(path.join(root, "missing")), [], "no skills directory is no skills");
  assert.deepEqual((await listSkillFiles("pdf", root)).map((file) => file.path), ["SKILL.md", "scripts/fill.py"]);
  assert.equal(new TextDecoder().decode((await readSkillFile("pdf", "scripts/fill.py", {}, root)).data), "print('fill')\n");
  await assert.rejects(readSkillFile("nope", "SKILL.md", {}, root), /There is no skill nope in/);
  await assert.rejects(readSkillFile("pdf", "nope.md", {}, root), /The skill pdf has no file nope\.md/);
});

test("a skill's front matter gives its description on one line", () => {
  assert.equal(skillDescription("---\nname: a\ndescription: \"Quoted: with colon\"\n---\nbody"), "Quoted: with colon");
  assert.equal(skillDescription("﻿---\r\ndescription: |\r\n  two\r\n  lines\r\n---\r\n"), "two lines");
  assert.equal(skillDescription("# No front matter\ndescription: not this"), "");
  assert.equal(skillDescription("---\ndescription: [not, text]\n---\n"), "");
  assert.equal(skillDescription("---\n: : bad yaml [\n---\n"), "");
});

test("only a skill's own files are listed and read: no hidden files, no way out, links only inside it", { skip: !posix }, async (t) => {
  const root = await skillsRoot(t);
  const outside = path.join(root, "..", `${path.basename(root)}-outside`);
  await mkdir(outside);
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret"), "secret");
  const skill = path.join(root, "tool");
  await mkdir(path.join(skill, "docs"), { recursive: true });
  await mkdir(path.join(skill, ".venv"));
  await writeFile(path.join(skill, "SKILL.md"), "---\ndescription: t\n---\n");
  await writeFile(path.join(skill, ".env"), "API_KEY=secret");
  await writeFile(path.join(skill, ".venv", "x"), "");
  await writeFile(path.join(skill, "docs", "a.md"), "a");
  await writeFile(path.join(skill, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("docs/a.md", path.join(skill, "inside.md"));
  await symlink(path.join(outside, "secret"), path.join(skill, "outside"));
  await symlink("docs", path.join(skill, "docs-link"));
  await symlink("missing", path.join(skill, "broken"));
  // A skill may itself be a link to a directory elsewhere, as installers make them.
  const elsewhere = path.join(outside, "linked");
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, "SKILL.md"), "");
  await symlink(elsewhere, path.join(root, "linked"));

  const files = await listSkillFiles("tool", root);
  assert.deepEqual(files.map((file) => file.path), ["SKILL.md", "docs/a.md", "inside.md", "run.sh"]);
  assert.equal(files.find((file) => file.path === "run.sh")!.mode & 0o111, 0o111, "modes are kept, so scripts stay executable");
  assert.deepEqual((await listSkills(root)).map((entry) => entry.name), ["linked", "tool"]);
  assert.deepEqual((await listSkillFiles("linked", root)).map((file) => file.path), ["SKILL.md"]);
  assert.equal(new TextDecoder().decode((await readSkillFile("tool", "inside.md", {}, root)).data), "a");
  for (const [file, refusal] of [
    ["outside", /leads out of the skill tool/],
    [".env", /no \.\. and no hidden parts/],
    [".venv/x", /hidden parts/],
    ["../tool/SKILL.md", /no \.\./],
    ["docs/../../tool/SKILL.md", /no \.\./],
    ["/etc/passwd", /a path inside it/],
    ["docs\\a.md", /a path inside it/],
    ["docs//a.md", /a path inside it/],
  ] as const) await assert.rejects(readSkillFile("tool", file, {}, root), refusal, file);
  for (const name of ["..", ".", "../tool", "a/b", ".git", "c:d"]) {
    await assert.rejects(listSkillFiles(name, root), /A skill's name is its directory's name/, name);
    await assert.rejects(readSkillFile(name, "SKILL.md", {}, root), /A skill's name/, name);
  }
});

test("the newest copy of a skill wins, compared to the second, with this device first on a tie", () => {
  const copies = [
    { name: "pdf", modifiedMs: 5_000, device: "studio" },
    { name: "pdf", modifiedMs: 9_400, device: "beelink" },
    { name: "pdf", modifiedMs: 9_900, device: undefined },
    { name: "pdf", modifiedMs: 9_100, device: "alpha" },
    { name: "docx", modifiedMs: 1_000, device: "studio" },
  ];
  const groups = byNewest(copies);
  assert.deepEqual([...groups.keys()], ["docx", "pdf"]);
  assert.deepEqual(groups.get("pdf")!.map((copy) => copy.device), [undefined, "alpha", "beelink", "studio"]);
  assert.deepEqual(byNewest([{ name: "pdf", modifiedMs: 10_000, device: "studio" }, { name: "pdf", modifiedMs: 9_999 }]).get("pdf")!.map((copy) => copy.device), ["studio", undefined]);
});

test("a device whose cns has no skills is told apart from a refusal, with what to install", async (t) => {
  // A cns from before skills answers its other methods, and these with capnweb's own error.
  class Older extends RpcTarget { info() { return {}; } }
  const { port1, port2 } = new MessageChannel();
  t.after(() => { port1.close(); port2.close(); });
  newMessagePortRpcSession(port1, new Older());
  using remote = newMessagePortRpcSession<{ skills(): Promise<unknown>; setModified(file: string, ms: number): Promise<unknown> }>(port2);
  for (const call of [() => remote.skills(), () => remote.setModified("/x", 0)]) {
    const error = await call().then(() => undefined, (failure: unknown) => failure);
    assert.match(explained(error, "studio").message, /^studio runs a cns from before skills\. Update cns on studio to 2\.2\.0 or later\.$/);
  }
  assert.match(explained(new Error("Permission denied: skills not granted to laptop."), "studio").message, /To allow it, run on studio: cns peer grant laptop skills$/);
  assert.equal(explained(new Error("There is no skill pdf in /home/t/.agents/skills."), "studio").message, "studio: There is no skill pdf in /home/t/.agents/skills.");
});
