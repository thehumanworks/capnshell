import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Command } from "commander";
import { createCli } from "./cli-program.js";
import { skillDescription } from "./skills.js";

// The agent skills in skills/ teach agents to use cns, so they must keep naming commands and
// options that exist: a rename such as tty to shell would otherwise mislead every agent quietly.
const root = path.join(import.meta.dir, "..", "skills");
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const skills = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
const markdown = [path.join(root, "README.md"), ...skills.map((name) => path.join(root, name, "SKILL.md"))];

test("each skill has the front matter agents load it by, with cns skills list's description", () => {
  assert.ok(skills.length);
  for (const name of skills) {
    const text = read(path.join(root, name, "SKILL.md"));
    const front = Bun.YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as { name?: unknown; description?: unknown } | null;
    assert.equal(front?.name, name, `${name}: name must be its directory's`);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64, `${name}: name over 64 characters`);
    assert.ok(typeof front?.description === "string" && front.description.length > 0 && front.description.length <= 1024, `${name}: description of 1 to 1024 characters`);
    assert.equal(skillDescription(text), front.description.replace(/\s+/g, " ").trim());
  }
});

/**
 * The words after each `cns` that starts a command in fenced or inline code: at the start, after a
 * prompt's `$`, or after `|`, `;`, `&&` or `(`, up to the next shell operator. Comments are left out.
 */
function commandLines(text: string): string[] {
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((match) => match[1]!.split("\n").map((line) => line.replace(/(^|\s)#.*$/, "")));
  const inline = [...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...fenced, ...inline].flatMap((line) => [...line.matchAll(/(?:^|[|;&($])[ \t]*cns((?:[ \t]+[^\s|;&()<>]+)*)/g)].map((match) => match[1]!.trim()));
}

const commandPath = (command: Command): string => command.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();

/** Why `cns WORDS` names a command or option cns does not have, or undefined. */
function unknown(program: Command, words: string[]): string | undefined {
  let command = program;
  let at = 0;
  for (; at < words.length; at++) {
    const sub = command.commands.find((candidate) => candidate.name() === words[at] || candidate.aliases().includes(words[at]!));
    if (!sub) break;
    command = sub;
  }
  const next = words[at];
  if (command.commands.some((sub) => sub.name() !== "help") && next !== undefined && !next.startsWith("-")) return `${commandPath(command)} has no command ${next}`;
  for (const word of words.slice(at)) {
    if (word === "--") break;
    if (!/^--?[A-Za-z]/.test(word)) continue;
    const flag = word.split("=")[0]!;
    if (flag === "-h" || flag === "--help") continue;
    if (![...command.options, ...program.options].some((option) => option.long === flag || option.short === flag)) return `${commandPath(command)} has no option ${flag}`;
  }
  return undefined;
}

test("every cns command the skills show exists, with its options", () => {
  const program = createCli();
  const problems = markdown.flatMap((file) => commandLines(read(file)).map((line) => {
    const problem = unknown(program, line.split(/\s+/).filter(Boolean));
    return problem && `${path.relative(root, file)}: cns ${line}: ${problem}`;
  })).filter(Boolean);
  assert.deepEqual(problems, []);
});

test("the command check catches a renamed command or option", () => {
  const program = createCli();
  assert.match(unknown(program, ["tty", "studio"]) ?? "", /cns has no command tty/);
  assert.match(unknown(program, ["skills", "show", "pdf"]) ?? "", /cns skills has no command show/);
  assert.match(unknown(program, ["run", "studio", "--cwdir", "/tmp", "--", "ls", "--cwdir"]) ?? "", /cns run has no option --cwdir/);
  assert.equal(unknown(program, ["run", "studio", "-n", "--", "ls", "--bogus"]), undefined);
  assert.deepEqual(commandLines("Run `cns peer grant laptop shell`, not `runs a cns from before`.\n```sh\nop read x | cns secret set home:KEY  # cns set it\nstudio $ cns up\njournalctl --user -u cns\n```\n"), ["secret set home:KEY", "up", "peer grant laptop shell"]);
});
