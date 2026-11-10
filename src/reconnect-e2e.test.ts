import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";

test("an attached session survives losing the connection and reports what it missed", { skip: !posix, timeout: 120000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-reconnect-")));
  // Hooks run in the order they were added: stop the daemon and proxy, then remove the directory.
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir, SHELL: "/bin/bash" }, state: path.join(dir, "daemon.json"), dir };
  };
  const studio = await device("studio");
  const laptop = await device("laptop");
  const cli = async (dev: { env: Record<string, string> }, args: string[], input = "") => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end(input);
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const port = await unusedPort("127.0.0.1");
  assert.equal((await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state])).code, 0);
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));
  const inviting = launchCli(t, ["pair", "--yes", "--name", "laptop", "--grant", "all", "--state", studio.state], { env: studio.env });
  inviting.child.stdin.end();
  await inviting.waitFor("Invite: cns1:");
  const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
  assert.equal((await cli(laptop, ["pair", invite, "--yes", "--name", "studio", "--request", "all"])).code, 0);
  assert.equal(await inviting.exited, 0);

  // Piped input to `cns tty studio` gets an unnamed terminal of its own, never a named session.
  const shell = await cli(laptop, ["tty", "studio"], "echo hi-$((40+2))\nexit 7\n");
  assert.equal(shell.code, 7, shell.stderr);
  assert.match(shell.stdout, /hi-42/);
  assert.doesNotMatch(shell.stderr, /as session/);

  // Laptop reaches studio through a proxy that can cut connections and refuse new ones.
  let refusing = false;
  const pairs: net.Socket[] = [];
  const proxyPort = Number(await unusedPort("127.0.0.1"));
  const proxy = net.createServer((client) => {
    if (refusing) { client.destroy(); return; }
    const upstream = net.connect(Number(port), "127.0.0.1");
    pairs.push(client, upstream);
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const socket of pairs) socket.destroy(); proxy.close(); });
  const file = path.join(laptop.dir, "peers", "studio");
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, addresses: [`ws://127.0.0.1:${proxyPort}`] }), { mode: 0o600 });
  const cut = () => { for (const socket of pairs.splice(0)) socket.destroy(); };

  // macOS ships bash 3.2, whose `read -t` takes whole seconds only, so a ticker in the
  // background keeps output flowing while the foreground loop blocks on input.
  const program = "printf 'READY\\n'; while :; do printf .; sleep 0.2; done & while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done";
  assert.equal((await cli(laptop, ["tty", "studio", "--name", "work", "--", program])).code, 0);
  const attached = launchCli(t, ["tty", "studio", "--attach", "work"], { env: laptop.env });
  await attached.waitFor("READY");
  attached.child.stdin.write("one\r");
  await attached.waitFor("got:one");

  // The connection drops and stays down for a while; the program keeps writing.
  refusing = true;
  cut();
  await attached.waitFor("the connection to studio was lost; reconnecting");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  refusing = false;
  await attached.waitFor("reattached to studio/work via a direct link;");
  const missed = Number(/; (\d+) bytes of output were written while disconnected/.exec(attached.output)?.[1]);
  assert.ok(missed >= 3, `the gap is reported: ${attached.output.slice(-400)}`);
  const from = attached.output.length;
  attached.child.stdin.write("two\r");
  await attached.waitFor("got:two", from);

  // The session is killed while the attachment is cut off: it says so instead of waiting.
  refusing = true;
  cut();
  await attached.waitFor("reconnecting", from);
  record.addresses = [`ws://127.0.0.1:${port}`];
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await cli(laptop, ["kill", "studio", "work"])).code, 0);
  refusing = false;
  assert.equal(await attached.exited, 1);
  assert.match(attached.stderr, /the session work no longer exists on studio/);
});
