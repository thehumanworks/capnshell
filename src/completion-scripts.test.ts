import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { completionScript, type Shell } from "./completion.js";
import { cliInvocation } from "./test-support.js";

/**
 * Each shell's script, loaded in that shell, with a cns on PATH that logs what the script asks
 * cns __complete and answers with the lines in `reply`. Shells that are not installed are skipped.
 */
const posix = process.platform !== "win32";
const installed = (name: string) => Bun.which(name) ?? undefined;

function stub(t: TestContext) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "cns-completion-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "stub.js");
  writeFileSync(script, `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "__complete") {
  appendFileSync(${JSON.stringify(path.join(dir, "complete.log"))}, JSON.stringify(args) + "\\n");
  process.stdout.write(readFileSync(${JSON.stringify(path.join(dir, "reply"))}, "utf8"));
} else appendFileSync(${JSON.stringify(path.join(dir, "ran.log"))}, JSON.stringify(args) + "\\n");
`);
  if (posix) {
    writeFileSync(path.join(dir, "cns"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    chmodSync(path.join(dir, "cns"), 0o755);
  } else {
    writeFileSync(path.join(dir, "cns.cmd"), `@"${process.execPath}" "${script}" %*\r\n`);
  }
  const log = (name: string) => existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
  return {
    dir,
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    reply: (lines: string[]) => writeFileSync(path.join(dir, "reply"), lines.map((line) => `${line}\n`).join("")),
    asked: () => log("complete.log"),
    ran: () => log("ran.log"),
    file: (shell: Shell) => { const file = path.join(dir, `cns.${shell === "pwsh" ? "ps1" : shell}`); writeFileSync(file, completionScript(shell)); return file; },
  };
}

test("cns completion prints each shell's script, and refuses another shell", () => {
  const cns = (args: string[]) => { const { file, args: all } = cliInvocation(args); return spawnSync(file, all, { encoding: "utf8" }); };
  for (const shell of ["bash", "zsh", "fish", "pwsh"] as const) {
    const run = cns(["completion", shell]);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, completionScript(shell));
    assert.match(run.stdout, /cns __complete/);
  }
  const wrong = cns(["completion", "tcsh"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /bash, fish, pwsh, zsh|Allowed choices/);
});

test("the bash script joins DEVICE:PATH again, replaces what follows the colon, and leaves no space after a directory", { skip: !posix || !installed("bash") }, (t) => {
  const cns = stub(t);
  const file = cns.file("bash");
  assert.equal(spawnSync("bash", ["-n", file]).status, 0);
  // What readline gives the function for `cns cp studio:My\ D`: COMP_WORDBREAKS splits at the colon.
  const complete = (words: string[], line: string, space = false) => {
    const run = spawnSync("bash", ["-c", [
      `source ${JSON.stringify(file)}`,
      space ? "_cns_space=' '" : "compopt() { :; }",
      `COMP_WORDBREAKS=$' \\t\\n"\\'><=;|&(:'`,
      `COMP_LINE=${JSON.stringify(line).replaceAll("$", "\\$")} COMP_POINT=${Buffer.byteLength(line)}`,
      `COMP_WORDS=(${words.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ")}) COMP_CWORD=${words.length - 1}`,
      "_cns",
      "for c in \"${COMPREPLY[@]}\"; do printf '[%s]\\n' \"$c\"; done",
    ].join("\n")], { encoding: "utf8", env: cns.env });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.split("\n").filter(Boolean);
  };
  // Bash 3.2 has no compopt, so there a space goes on each candidate that takes one.
  const old = spawnSync("bash", ["-c", "type compopt"]).status !== 0;
  cns.reply(["studio:My\\ Docs/", "studio:My\\ Dx.txt"]);
  assert.deepEqual(complete(["cns", "cp", "studio", ":", "My\\ D"], "cns cp studio:My\\ D"), ["[My\\ Docs/]", `[My\\ Dx.txt${old ? " " : ""}]`]);
  assert.deepEqual(cns.asked().at(-1), ["__complete", "bash", "cp", "studio:My\\ D"]);
  assert.deepEqual(complete(["cns", "cp", "studio", ":", "My\\ D"], "cns cp studio:My\\ D", true), ["[My\\ Docs/]", "[My\\ Dx.txt ]"]);
  // Right after the colon, and with a space before the word being typed.
  complete(["cns", "cp", "studio", ":"], "cns cp studio:");
  assert.deepEqual(cns.asked().at(-1), ["__complete", "bash", "cp", "studio:"]);
  cns.reply(["studio:", "stash:"]);
  assert.deepEqual(complete(["cns", "cp", "'./a b'", ""], "cns cp './a b' "), ["[studio:]", "[stash:]"]);
  assert.deepEqual(cns.asked().at(-1), ["__complete", "bash", "cp", "'./a b'", ""]);
  cns.reply([]);
  assert.deepEqual(complete(["cns", ""], "cns "), []);
  assert.deepEqual(cns.asked().at(-1), ["__complete", "bash", ""]);
});

test("the zsh script completes in an interactive zsh: the path is quoted, and a directory gets no space", { skip: !posix || !installed("zsh"), timeout: 60000 }, async (t) => {
  const cns = stub(t);
  const file = cns.file("zsh");
  assert.equal(spawnSync("zsh", ["-n", file]).status, 0);
  const shell = interactive(t, ["zsh", "-f", "-i"], { ...cns.env, PS1: "READY> ", HOME: cns.dir });
  await shell.waitFor("READY> ");
  shell.write(`autoload -Uz compinit && compinit -u -D && source ${file} && print LOADED\r`);
  await shell.waitFor("LOADED");
  cns.reply(["studio:~/My Docs/"]);
  shell.write("cns cp studio:~/My\t");
  await until(() => cns.asked().length > 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  shell.write("x .\r");
  await until(() => cns.ran().length > 0);
  assert.deepEqual(cns.asked()[0], ["__complete", "zsh", "cp", "studio:~/My"]);
  assert.deepEqual(cns.ran()[0], ["cp", "studio:~/My Docs/x", "."]);
});

test("the fish script completes the current token, unescaped, after the words before it", { skip: !posix || !installed("fish"), timeout: 30000 }, (t) => {
  const cns = stub(t);
  const file = cns.file("fish");
  assert.equal(spawnSync("fish", ["--no-execute", file]).status, 0);
  cns.reply(["studio:~/My Docs/", "studio:~/My Dx.txt"]);
  const run = spawnSync("fish", ["--no-config", "-c", `source ${file}; complete -C 'cns cp -r studio:~/My\\ D'; complete -C 'cns '`], { encoding: "utf8", env: cns.env });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.split("\n").filter(Boolean).slice(0, 2), ["studio:~/My Docs/", "studio:~/My Dx.txt"]);
  assert.deepEqual(cns.asked().slice(0, 2), [["__complete", "fish", "cp", "-r", "studio:~/My D"], ["__complete", "fish", ""]]);
});

test("the PowerShell script hands the words before the cursor to cns and offers each line", { skip: !installed("pwsh"), timeout: 60000 }, (t) => {
  const cns = stub(t);
  const file = cns.file("pwsh");
  cns.reply(["'studio:My Docs/'", "studio:Mx.txt"]);
  const lines = ["cns cp studio:M", "cns ", "cns.exe cp 'studio:My D'", "cns run studio -- l"];
  const runner = path.join(cns.dir, "run.ps1");
  writeFileSync(runner, [
    `. ${JSON.stringify(file)}`,
    `foreach ($line in @(${lines.map((line) => `'${line.replaceAll("'", "''")}'`).join(", ")})) {`,
    "  $r = TabExpansion2 -inputScript $line -cursorColumn $line.Length",
    "  [pscustomobject]@{ start = $r.ReplacementIndex; length = $r.ReplacementLength; matches = @($r.CompletionMatches | ForEach-Object CompletionText) } | ConvertTo-Json -Compress",
    "}",
  ].join("\n"));
  const run = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner], { encoding: "utf8", env: cns.env });
  assert.equal(run.status, 0, run.stderr);
  const results = run.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { start: number; length: number; matches: string[] });
  assert.deepEqual(results[0], { start: 7, length: 8, matches: ["'studio:My Docs/'", "studio:Mx.txt"] });
  assert.deepEqual(results[2], { start: 11, length: 13, matches: ["'studio:My Docs/'", "studio:Mx.txt"] });
  assert.deepEqual(cns.asked(), [
    ["__complete", "pwsh", "cp", "studio:M"],
    ["__complete", "pwsh", ""],
    ["__complete", "pwsh", "cp", "'studio:My D'"],
    ["__complete", "pwsh", "run", "studio", "--", "l"],
  ]);
});

/** A shell at a terminal, whose output collects in `screen`. */
function interactive(t: TestContext, argv: string[], env: NodeJS.ProcessEnv) {
  let screen = "";
  const proc = Bun.spawn(argv, { env: env as Record<string, string>, terminal: { cols: 160, rows: 40, name: "xterm", data: (_terminal, data) => { screen += new TextDecoder().decode(data); } } });
  t.after(() => { if (proc.exitCode === null) proc.kill(); });
  return {
    write: (text: string) => proc.terminal!.write(text),
    waitFor: (needle: string) => until(() => screen.includes(needle), () => `Waiting for ${needle} in ${JSON.stringify(screen.slice(-400))}`),
  };
}

async function until(check: () => boolean, message = () => "Timed out", ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
