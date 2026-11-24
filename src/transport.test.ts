import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { remotePath } from "./commands/copy.js";
import { connectControl } from "./commands/daemon.js";
import { MAX_WRITE_BYTES } from "./shell.js";
import { launchCli, testDevices, type TestDevice } from "./test-support.js";

// Commands reach a paired device's daemon over an encrypted link. Saved peers, and so pairing,
// are not available on Windows yet.
const posix = process.platform !== "win32";
const print = (marker: string) => `printf '${marker}'`;

async function eventually(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${label}`);
}

/** Studio runs its daemon and grants laptop everything; laptop runs commands on it by name. */
async function studioAndLaptop(t: TestContext, studioEnv: Record<string, string> = {}) {
  const devices = await testDevices(t, "cns-transport-");
  const studio = await devices.device("studio", studioEnv);
  const laptop = await devices.device("laptop");
  await devices.up(studio);
  await devices.pair(studio, laptop, { hostGrants: "all" });
  /** Run cns on laptop and collect its result. */
  const cli = async (args: string[], options: { env?: Record<string, string>; cwd?: string; input?: string } = {}) => {
    const child = launchCli(t, args, { env: { ...laptop.env, ...options.env }, cwd: options.cwd });
    child.child.stdin.end(options.input ?? "");
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };
  const launch = (args: string[], env: Record<string, string> = {}) => launchCli(t, args, { env: { ...laptop.env, ...env } });
  return { devices, studio, laptop, cli, launch };
}

test("run preserves exact output, quoting and remote exit status, and the daemon refuses browsers", { skip: !posix, timeout: 30000 }, async (t) => {
  const { studio, cli } = await studioAndLaptop(t);
  const rejected = await fetch(`http://127.0.0.1:${studio.port}`, { headers: { Origin: "https://example.invalid", Upgrade: "websocket" } });
  assert.equal(rejected.status, 401);
  const command = `printf '%s' "héllo 'quoted' " '$HOME'; printf 'exact error' >&2; exit 7`;
  const run = await cli(["run", "studio", "--", command]);
  assert.equal(run.code, 7);
  assert.equal(run.stdout, "héllo 'quoted' $HOME");
  assert.equal(run.stderr, "exact error");
  const next = await cli(["run", "studio", "--", print("LATER_RUN")]);
  assert.deepEqual([next.code, next.stdout, next.stderr], [0, "LATER_RUN", ""]);
});

test("run forwards piped stdin, streams output past 1 MiB and stops when its reader does", { timeout: 30000, skip: !posix }, async (t) => {
  const { cli, launch } = await studioAndLaptop(t);
  const input = Buffer.alloc(3 * 1024 * 1024 + 7, "z");
  const piped = launch(["run", "studio", "--", "wc -c | tr -d ' '; printf done >&2"]);
  piped.child.stdin.end(input);
  assert.equal(await piped.exited, 0, piped.output);
  assert.equal(piped.stdout.trim(), String(input.length));
  assert.equal(piped.stderr, "done");
  // An open stdin that never ends does not hold a command that does not read it.
  const unread = launch(["run", "studio", "--", "printf ok"]);
  assert.equal(await unread.exited, 0);
  assert.equal(unread.stdout, "ok");
  const closed = await cli(["run", "studio", "--no-stdin", "--", "cat; printf closed"]);
  assert.deepEqual([closed.code, closed.stdout], [0, "closed"]);
  const large = await cli(["run", "studio", "--no-stdin", "--", "head -c 2000000 /dev/zero | tr '\\0' x"]);
  assert.equal(large.code, 0);
  assert.equal(large.stdout.length, 2000000);
  // A local reader that goes away ends the remote command, as SIGPIPE would.
  const endless = launch(["run", "studio", "--no-stdin", "--", "yes"]);
  endless.child.stdout.destroy();
  assert.equal(await endless.exited, 141);
});

test("cp copies files both ways in parts, into directories, keeping permission bits", { timeout: 30000, skip: !posix }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns cp ")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { cli: run } = await studioAndLaptop(t);
  const cp = async (...args: string[]) => {
    const result = await run(["cp", ...args], { cwd: directory });
    return { code: result.code, stderr: result.stderr };
  };
  // Larger than one write, and not a multiple of the read or write size.
  const big = Buffer.alloc(MAX_WRITE_BYTES * 2 + 12345);
  for (let index = 0; index < big.length; index++) big[index] = (index * 7919) % 251;
  await writeFile(path.join(directory, "big.bin"), big);
  await mkdir(path.join(directory, "remote"));
  assert.deepEqual(await cp("big.bin", `studio:${directory}/remote/`), { code: 0, stderr: "" });
  assert.ok(big.equals(await readFile(path.join(directory, "remote", "big.bin"))));
  await mkdir(path.join(directory, "back"));
  assert.deepEqual(await cp(`studio:${directory}/remote/big.bin`, "back"), { code: 0, stderr: "" });
  assert.ok(big.equals(await readFile(path.join(directory, "back", "big.bin"))));
  // A shorter copy replaces a longer file entirely.
  await writeFile(path.join(directory, "small.sh"), "#!/bin/sh\necho hi\n");
  await chmod(path.join(directory, "small.sh"), 0o750);
  assert.equal((await cp("small.sh", `studio:${directory}/remote/big.bin`)).code, 0);
  assert.equal(await readFile(path.join(directory, "remote", "big.bin"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal((await cp("small.sh", `studio:${directory}/remote/run.sh`)).code, 0);
  assert.equal((await stat(path.join(directory, "remote", "run.sh"))).mode & 0o777, 0o750 & ~process.umask());
  await writeFile(path.join(directory, "empty"), "");
  assert.equal((await cp(`${directory}/empty`, `studio:${directory}/remote/empty`)).code, 0);
  assert.equal(await readFile(path.join(directory, "remote", "empty"), "utf8"), "");
  const missing = await cp(`studio:${directory}/nope`, ".");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /nope: No such file or directory/);
  assert.match((await cp(`studio:${directory}/remote`, ".")).stderr, /is a directory/);
});

test("cp resolves remote paths against the peer's home in its own path style", () => {
  const posix = { platform: "linux" as const, cwd: "/home/me" };
  assert.equal(remotePath(posix, "/srv/x"), "/srv/x");
  assert.equal(remotePath(posix, "notes.txt"), "/home/me/notes.txt");
  assert.equal(remotePath(posix, "~/a/b"), "/home/me/a/b");
  assert.equal(remotePath(posix, "~"), "/home/me");
  assert.equal(remotePath(posix, ""), "/home/me");
  const windows = { platform: "win32" as const, cwd: "C:\\Users\\me" };
  assert.equal(remotePath(windows, "D:\\x"), "D:\\x");
  assert.equal(remotePath(windows, "~\\a.txt"), "C:\\Users\\me\\a.txt");
  assert.equal(remotePath(windows, "a/b.txt"), "C:\\Users\\me\\a\\b.txt");
});

test("run takes its remote working directory from CNS_CWD unless --cwd overrides it", { timeout: 30000, skip: !posix }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns env "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const override = path.join(directory, "override cwd");
  await mkdir(override);
  await writeFile(path.join(directory, "marker.txt"), "ENV_CWD");
  await writeFile(path.join(override, "marker.txt"), "FLAG_CWD");
  const { cli } = await studioAndLaptop(t);
  const command = "printf '%s' \"$(< marker.txt)\"; exit 7";
  for (const scenario of [
    { args: ["run", "studio", "--", command], env: { CNS_CWD: directory }, output: "ENV_CWD" },
    { args: ["run", "studio", "--cwd", override, "--", command], env: { CNS_CWD: directory }, output: "FLAG_CWD" },
  ]) {
    const run = await cli(scenario.args, { env: scenario.env });
    assert.equal(run.code, 7, run.output);
    assert.equal(run.stdout, scenario.output);
    assert.equal(run.stderr, "");
  }
});

test("a command's connection offers nothing back, and ending it ends its remote processes", { timeout: 30000, skip: !posix }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns transport "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "command.pid");
  const { studio, cli, launch } = await studioAndLaptop(t);
  const run = launch(["run", "studio", "--cwd", directory, "--", "printf '%s' $$ > command.pid; exec sleep 60"]);
  await eventually(async () => { try { return (await readFile(pidFile, "utf8")).length > 0; } catch { return false; } }, "remote command started in requested cwd");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  // Studio's daemon sees laptop's command connection, and laptop offers it nothing to run.
  const control = await connectControl(studio.state);
  try {
    const command = (await control.controller.peers()).find((peer) => peer.peer?.name === "laptop" && !peer.peer.daemon);
    assert.ok(command, "the command's connection is listed");
    assert.equal(command.info.pid, run.child.pid);
    await assert.rejects(() => control.controller.run(command.id, print("MUST_NOT_RUN"), {}), /does not run commands/);
  } finally { control.close(); }
  assert.equal(run.closed, false);
  run.child.kill("SIGTERM");
  await run.exited;
  await eventually(async () => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "disconnected session process group was killed");
  const timed = await cli(["run", "studio", "--timeout", "100", "--", "sleep 60"]);
  assert.equal(timed.code, 124);
});

test("shell runs programs on a remote terminal with piped input and returns their status", { timeout: 30000, skip: !posix }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns shell "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { cli, launch } = await studioAndLaptop(t);
  const tty = launch(["shell", "studio", "--cwd", directory, "--cols", "100", "--rows", "30", "--term", "vt100", "--",
    `tty -s && printf 'IS''TTY %s %s ' "$TERM" "$(pwd)"; stty size; read -r line; printf 'got:%s\n' "$line"; exit 5`]);
  await tty.waitFor("ISTTY");
  tty.child.stdin.write("héllo\r");
  assert.equal(await tty.exited, 5, tty.output);
  // The terminal echoes input wherever it arrives, so check each fact separately.
  assert.ok(tty.stdout.includes(`ISTTY vt100 `) && tty.stdout.includes(`${path.basename(directory)} `), tty.stdout);
  assert.match(tty.stdout, /[ \n]30 100\r\n/);
  assert.match(tty.stdout, /got:héllo\r\n/);
  assert.equal(tty.stderr, "");

  const timed = await cli(["shell", "studio", "--timeout", "100", "--", "sleep 60"]);
  assert.equal(timed.code, 124);
  assert.match(timed.stderr, /timed out/);

  // --screen prints the rendered terminal, not the escape sequences that drew it.
  const drawn = "printf '\\033[?1049h\\033[2J\\033[2;3Hdrawn\\033[1;1Htop'; sleep 60";
  const screen = await cli(["shell", "studio", "--screen", "--cols", "20", "--rows", "4", "--timeout", "1000", "--", drawn]);
  assert.equal(screen.code, 124, screen.output);
  assert.equal(screen.stdout, "top\n  drawn\n");
  const history = await cli(["shell", "studio", "--screen", "--rows", "3", "--history", "2", "--", "seq 1 8; exit 4"]);
  assert.equal(history.code, 4, history.output);
  assert.equal(history.stdout, "5\n6\n7\n8\n");
  assert.equal(history.stderr, "");
});

test("named shell sessions persist across CLI calls for keys, screens, attach and kill", { timeout: 60000, skip: !posix }, async (t) => {
  const { cli: run, launch } = await studioAndLaptop(t);
  const cli = async (...args: string[]) => {
    const { code, stdout, stderr } = await run(args);
    return { code, stdout, stderr };
  };
  const program = "printf 'ready\\n'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; [ \"$line\" = quit ] && exit 6; done";
  assert.deepEqual(await cli("shell", "studio", "--name", "app", "--cols", "40", "--rows", "6", "--", program), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await cli("screen", "studio", "app", "--until", "ready"), { code: 0, stdout: "ready\n", stderr: "" });
  assert.deepEqual(await cli("keys", "studio", "app", "hello there", "Enter"), { code: 0, stdout: "", stderr: "" });
  const shown = await cli("screen", "studio", "app", "--until", "got:hello there");
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /got:hello there\n$/);
  const timedOut = await cli("screen", "studio", "app", "--until", "absent", "--timeout", "200");
  assert.equal(timedOut.code, 124);
  assert.match(timedOut.stderr, /timed out waiting/);
  assert.match(timedOut.stdout, /got:hello there/);
  const listed = await cli("sessions", "studio", "--json");
  const [info] = JSON.parse(listed.stdout);
  assert.deepEqual([info.name, info.running, info.cols, info.rows, info.viewers], ["app", true, 40, 6, 0]);
  assert.ok((await cli("sessions", "studio")).stdout.startsWith(`app  running  40x6  0 attached  ${program.slice(0, 20)}`));
  assert.equal((await cli("shell", "studio", "--name", "app", "--", "true")).code, 1);

  // Attaching without a terminal redraws the screen and streams until the program exits.
  // It does not resize a session that others may share.
  const attached = launch(["shell", "studio", "--attach", "app"]);
  await attached.waitFor("got:hello there");
  attached.child.stdin.write("quit\r");
  assert.equal(await attached.exited, 6, attached.output);
  assert.match(attached.stdout, /got:quit/);
  assert.match((await cli("sessions", "studio")).stdout, /^app {2}exited 6 {2}40x6 /);
  const ended = await cli("screen", "studio", "app", "--until", "absent");
  assert.equal(ended.code, 1);
  assert.match(ended.stderr, /ended before the text appeared/);

  assert.deepEqual(await cli("kill", "studio", "app"), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(await cli("sessions", "studio"), { code: 0, stdout: "", stderr: "" });
  const missing = await cli("keys", "studio", "app", "Enter");
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, "No PTY session named app.\n");
});

test("a named session can be manually reattached after an abrupt client loss", { timeout: 60000, skip: !posix }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-reattach-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { devices, studio, cli: run, launch } = await studioAndLaptop(t);
  const cli = async (...args: string[]) => {
    const { code, stdout, stderr } = await run(args);
    return { code, stdout, stderr };
  };
  const command = "printf 'READY\\n'; while IFS= read -r line; do case \"$line\" in check) printf 'PID:%s CWD:%s\\n' \"$$\" \"$PWD\";; quit) exit 6;; esac; done";
  const started = await cli("shell", "studio", "--name", "work", "--cwd", directory, "--", command);
  assert.equal(started.code, 0, started.stderr);
  const before = JSON.parse((await cli("sessions", "studio", "--json")).stdout)[0];
  assert.ok(before.pid > 0);
  assert.equal(before.cwd, directory);

  const first = launch(["shell", "studio", "--attach", "work"]);
  await first.waitFor("READY");
  first.child.kill("SIGKILL");
  await first.exited;
  await eventually(async () => {
    const result = await cli("sessions", "studio", "--json");
    return result.code === 0 && JSON.parse(result.stdout)[0]?.viewers === 0;
  }, "lost viewer detached");

  const after = JSON.parse((await cli("sessions", "studio", "--json")).stdout)[0];
  assert.deepEqual([after.pid, after.cwd, after.running], [before.pid, directory, true]);
  const second = launch(["shell", "studio", "--attach", "work"]);
  await second.waitFor("READY");
  second.child.stdin.write("check\r");
  await second.waitFor(`PID:${before.pid} CWD:${directory}`);
  second.child.stdin.write("quit\r");
  assert.equal(await second.exited, 6, second.output);
  assert.equal((await cli("kill", "studio", "work")).code, 0);
  assert.deepEqual(JSON.parse((await cli("sessions", "studio", "--json")).stdout), []);

  assert.equal((await cli("shell", "studio", "--name", "lost", "--", "sleep 60")).code, 0);
  const lost = JSON.parse((await cli("sessions", "studio", "--json")).stdout)[0];
  assert.equal((await devices.cli(studio, ["stop", "--state", studio.state])).code, 0);
  await eventually(async () => {
    try { process.kill(lost.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "host shutdown ended its session process");
  await devices.up(studio, studio.port);
  assert.deepEqual(JSON.parse((await cli("sessions", "studio", "--json")).stdout), []);
});

test("run reports an unreachable device as failure", { timeout: 15000, skip: !posix }, async (t) => {
  const { devices, studio, cli } = await studioAndLaptop(t);
  assert.equal((await devices.cli(studio, ["stop", "--state", studio.state])).code, 0);
  const run = await cli(["run", "studio", "--", print("MUST_NOT_RUN")]);
  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, "");
  assert.match(run.stderr, /Cannot connect to studio/);
});

test("shell -d types commands into a session that stays running, and starts it on first use", { timeout: 60000, skip: !posix }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-detached-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { cli: run } = await studioAndLaptop(t, { SHELL: "/bin/bash" });
  const cli = async (...args: string[]) => {
    const { code, stdout, stderr } = await run(args);
    return { code, stdout, stderr };
  };
  const screen = async (name: string, text: string) => {
    const shown = await cli("screen", "studio", name, "--until", text, "--timeout", "10000");
    assert.equal(shown.code, 0, shown.stderr + shown.stdout);
    return shown.stdout;
  };

  // The first use of a name starts a login shell there and types the command into it.
  assert.deepEqual(await cli("shell", "studio", "-d", "--session", "work", "--cwd", directory, "--", "cd", "$PWD;", "COUNT=41;", "echo", "one:$PWD"),
    { code: 0, stdout: "", stderr: "cns: started the session work on studio\n" });
  await screen("work", `one:${directory}`);
  // The next types into the same shell: its variables carry over, and --command is the same as --.
  assert.deepEqual(await cli("shell", "studio", "-d", "--session", "work", "--command", "echo two:$((COUNT + 1))"), { code: 0, stdout: "", stderr: "" });
  await screen("work", "two:42");
  const [info] = JSON.parse((await cli("sessions", "studio", "--json")).stdout);
  assert.deepEqual([info.name, info.running, info.command], ["work", true, null]);

  // What describes a session being started is refused once it runs, and nothing is typed.
  const late = await cli("shell", "studio", "-d", "--session", "work", "--cwd", "/", "--", "echo", "three:$PWD");
  assert.deepEqual(late, { code: 1, stdout: "", stderr: "The session work is already running on studio, and --cwd applies only when a session starts. Nothing was typed. Run the command without it, or in a new session.\n" });
  assert.deepEqual(await cli("shell", "studio", "-d", "--session", "work", "--", "echo", "four:done"), { code: 0, stdout: "", stderr: "" });
  assert.doesNotMatch(await screen("work", "four:done"), /three:\//);

  // Without a name the session is the next free shell-N, and stdout carries the name alone.
  const unnamed = await cli("shell", "studio", "-d", "--", "echo", "auto:$((6 * 7))");
  assert.deepEqual(unnamed, { code: 0, stdout: "shell-1\n", stderr: "cns: started the session shell-1 on studio\n" });
  await screen("shell-1", "auto:42");
  // No command: the session starts and waits.
  assert.deepEqual(await cli("shell", "studio", "-d"), { code: 0, stdout: "shell-2\n", stderr: "cns: started the session shell-2 on studio\n" });
  assert.deepEqual(await cli("shell", "studio", "-d", "--session", "shell-2", "--", "echo", "later:ok"), { code: 0, stdout: "", stderr: "" });
  await screen("shell-2", "later:ok");

  // A session that runs a command is not a shell to type into, and one that ended takes nothing.
  assert.equal((await cli("shell", "studio", "--name", "job", "--", "sleep 30")).code, 0);
  const job = await cli("shell", "studio", "-d", "--session", "job", "--", "echo", "no");
  assert.deepEqual([job.code, job.stdout], [1, ""]);
  assert.equal(job.stderr, 'The session job on studio runs "sleep 30", not a shell, so -d cannot type a command into it. Send it keys with cns keys studio job, or name another session.\n');
  assert.deepEqual(await cli("shell", "studio", "-d", "--session", "work", "--", "exit", "3"), { code: 0, stdout: "", stderr: "" });
  let listing = "";
  await eventually(async () => /^work +exited 3 /m.test(listing = (await cli("sessions", "studio")).stdout), "the shell exits").catch((error) => { throw new Error(`${error.message}\n${listing}`); });
  const ended = await cli("shell", "studio", "-d", "--session", "work", "--", "echo", "no");
  assert.deepEqual([ended.code, ended.stdout], [1, ""]);
  assert.match(ended.stderr, /^The session work on studio has ended \(exited 3\)\. Remove it, then run this again: cns kill studio work\.\n$/);

  // The options that go with -d.
  for (const [args, message] of [
    [["shell", "studio", "--session", "work", "--", "true"], /--session names the session -d runs a command in: cns shell studio -d --session work -- command\. To join a session, use --attach work\./],
    [["shell", "studio", "-d", "--name", "x", "--", "true"], /-d runs a command in a session and returns; it does not go with --name\. Name its session with --session\./],
    [["shell", "studio", "-d", "--command", "true", "--", "true"], /Give the command once: after --command, or after --\./],
  ] as const) {
    const refused = await cli(...args);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stderr, message);
  }
  for (const name of ["work", "job", "shell-1", "shell-2"]) assert.equal((await cli("kill", "studio", name)).code, 0);
});

test("shell -d --screen types a command, waits for it to end and prints what it showed, leaving the session running", { timeout: 60000, skip: !posix }, async (t) => {
  const { cli: run } = await studioAndLaptop(t, { SHELL: "/bin/bash" });
  const cli = async (...args: string[]) => {
    const { code, stdout, stderr } = await run(args);
    return { code, stdout, stderr };
  };
  // The form with flags only: the command waits a second between its lines, and all of them are printed.
  const first = await cli("shell", "-d", "-D", "studio", "-s", "build", "-p", "--", "printf 'a\\nb\\n'; sleep 1; echo done:$((40 + 2))");
  assert.deepEqual([first.code, first.stderr], [0, "cns: started the session build on studio\n"], first.stdout);
  const lines = first.stdout.split("\n");
  assert.match(lines[0]!, /printf 'a\\nb\\n'; sleep 1; echo done:\$\(\(40 \+ 2\)\)$/, first.stdout);
  assert.deepEqual(lines.slice(1, 4), ["a", "b", "done:42"], first.stdout);
  // The next prints from its own line on, not what came before it, in the same shell.
  const second = await cli("shell", "studio", "-d", "--session", "build", "--screen", "--", "echo", "second:$((6 * 7))");
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /echo second:\$\(\(6 \* 7\)\)\nsecond:42\n/);
  assert.doesNotMatch(second.stdout, /done:42/);
  const [info] = JSON.parse((await cli("sessions", "studio", "--json")).stdout);
  assert.deepEqual([info.name, info.running], ["build", true]);
  // A job in the background that prints on does not keep it waiting.
  assert.equal((await cli("shell", "studio", "-d", "-s", "build", "--", "(while :; do echo tick; sleep 0.1; done) &")).code, 0);
  const began = Date.now();
  const beside = await cli("shell", "studio", "-d", "-s", "build", "-p", "--", "echo", "third:$((6 * 7))");
  assert.equal(beside.code, 0, beside.stderr);
  assert.match(beside.stdout, /^third:42$/m);
  assert.ok(Date.now() - began < 15000, "waited for the background job");
  assert.equal((await cli("shell", "studio", "-d", "-s", "build", "--", "kill %1")).code, 0);
  // A shell that exits ends the session, and cns exits with its status.
  const exited = await cli("shell", "studio", "-d", "-s", "build", "-p", "--", "exit", "3");
  assert.deepEqual([exited.code, exited.stderr], [3, "cns: the session build on studio has ended (exited 3)\n"], exited.stdout);
  assert.equal((await cli("kill", "-D", "studio", "-s", "build")).code, 0);
});
