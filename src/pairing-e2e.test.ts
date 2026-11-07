import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { generateIdentity } from "./identity.js";
import { suggestedName } from "./pairing.js";
import { savePairedPeer } from "./peers.js";
import { connectControl } from "./commands/daemon.js";
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();

/** Run cns on a pseudo-terminal, as a person at a terminal would. */
function inTerminal(t: TestContext, args: string[], env: Record<string, string>) {
  const invocation = cliInvocation(args);
  let output = "";
  let notify = () => {};
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    env: cliEnvironment(env) as Record<string, string>,
    terminal: { cols: 200, rows: 30, name: "xterm-256color", data: (_terminal, data) => { output += decoder.decode(data, { stream: true }); notify(); } },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return {
    write: (text: string) => child.terminal!.write(text),
    get output() { return output; },
    exited: child.exited,
    waitFor: (needle: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Waiting for ${JSON.stringify(needle)} in ${JSON.stringify(output.slice(-600))}`)), 15000);
      notify = () => { if (output.includes(needle)) { clearTimeout(timer); resolve(); } };
      notify();
    }),
  };
}

test("two devices pair, run commands within their grants, and refuse everyone else", { skip: !posix, timeout: 90000 }, async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-pairing-")));
  // Hooks run in the order they were added: stop the daemons first, then remove their directories.
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir }, state: path.join(dir, "daemon.json"), dir };
  };
  const studio = await device("studio");
  const laptop = await device("laptop");
  const reader = await device("reader");
  const stranger = await device("stranger");
  const port = await unusedPort("127.0.0.1");
  const cli = async (dev: { env: Record<string, string> }, args: string[], input?: string) => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end(input ?? "");
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr, output: child.output };
  };

  // A daemon that crashed leaves its state file behind; cns up recovers from it, as listen --daemon does.
  await writeFile(studio.state, JSON.stringify({ version: 1, pid: 2147483646, port: Number(await unusedPort("127.0.0.1")), token: "a".repeat(64) }), { mode: 0o600 });
  // Studio runs the paired daemon on loopback for this test.
  const up = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state]);
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /^Started as [a-z2-7]{4}(-[a-z2-7]{4}){5} \(pid \d+\), listening at ws:\/\/127\.0\.0\.1:\d+\.\nReachable at ws:\/\/127\.0\.0\.1:\d+\.\nNo paired devices yet/);
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));
  const again = await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state]);
  assert.match(again.stdout, /^Running as/);

  /** Studio prints an invite and waits for a device to use it. */
  async function startInvite(studioArgs: string[]) {
    const inviting = launchCli(t, ["pair", "--yes", "--state", studio.state, ...studioArgs], { env: studio.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    return { invite, inviting, finished: async () => ({ code: await inviting.exited, stdout: inviting.stdout, stderr: inviting.stderr }) };
  }
  /** Studio prints an invite and waits; `other` pastes it. Returns both results. */
  async function pairWith(other: typeof laptop, studioArgs: string[], otherArgs: string[]) {
    const { invite, finished } = await startInvite(studioArgs);
    const accepting = await cli(other, ["pair", invite, "--yes", "--state", other.state, ...otherArgs]);
    return { inviting: await finished(), accepting };
  }

  // Laptop gets everything on studio and lets studio use its shell.
  const first = await pairWith(laptop, ["--name", "laptop", "--grant", "all"], ["--name", "studio", "--request", "all", "--grant", "shell"]);
  assert.equal(first.accepting.code, 0, first.accepting.stderr);
  assert.match(first.accepting.stdout, /^Paired with studio \([a-z2-7-]+\)\. This device may use its: shell, files, sessions\. It may use this device's: shell\.$/m);
  assert.equal(first.inviting.code, 0, first.inviting.stderr);
  assert.match(first.inviting.stdout, /Paired with laptop \([a-z2-7-]+\)\. It may use this machine's: shell, files, sessions\. This machine may use its: shell\./);
  const studioIdentity = JSON.parse((await cli(studio, ["identity", "--json"])).stdout);
  assert.match(first.accepting.stdout, new RegExp(studioIdentity.fingerprint));

  // Names in use are refused before anyone waits: the inviting side before printing an invite,
  // and a device already paired before it connects. An invite whose cns pair went away is void.
  const clash = await cli(studio, ["pair", "--yes", "--name", "laptop", "--state", studio.state]);
  assert.deepEqual([clash.code, clash.stdout], [1, ""]);
  assert.match(clash.stderr, /already named laptop/);
  const abandoned = await startInvite(["--name", "anyone"]);
  const twice = await cli(laptop, ["pair", abandoned.invite, "--yes", "--name", "studio2"]);
  assert.equal(twice.code, 1, twice.stderr);
  assert.match(twice.stderr, /already paired with it as studio/);
  abandoned.inviting.child.kill();
  await abandoned.finished();
  await new Promise((resolve) => setTimeout(resolve, 500)); // Let the daemon see its control connection close.
  const late = await cli(stranger, ["pair", abandoned.invite, "--yes", "--name", "studio"]);
  assert.equal(late.code, 3, late.stderr);
  assert.match(late.stderr, /Unknown or expired invite/);
  assert.equal((await cli(stranger, ["peer", "list"])).stdout, "", "a refused pairing saves nothing");

  // One unreadable file in the peers directory does not stop the paired devices from working.
  await writeFile(path.join(studio.dir, "peers", ".DS_Store"), "x", { mode: 0o600 });
  await writeFile(path.join(studio.dir, "peers", "junk"), "{ not json", { mode: 0o600 });

  // Commands name the paired device and run within its grants.
  const run = await cli(laptop, ["run", "studio", "--", "printf ok; printf err >&2; exit 3"]);
  assert.deepEqual([run.code, run.stdout, run.stderr], [3, "ok", "err"]);
  const sessions = await cli(laptop, ["sessions", "studio", "--json"]);
  assert.deepEqual([sessions.code, JSON.parse(sessions.stdout)], [0, []]);
  const started = await cli(laptop, ["tty", "studio", "--name", "work", "--", "printf READY; sleep 30"]);
  assert.equal(started.code, 0, started.stderr);
  const screen = await cli(laptop, ["screen", "studio", "work", "--until", "READY"]);
  assert.deepEqual([screen.code, screen.stdout], [0, "READY\n"]);
  assert.equal((await cli(laptop, ["kill", "studio", "work"])).code, 0);
  assert.equal((await cli(laptop, ["run", "--peer", "studio", "--", "printf viaflag"])).stdout, "viaflag");

  // Both sides list the pairing; laptop has no daemon of its own, so studio sees it offline between commands.
  const laptopPeers = JSON.parse((await cli(laptop, ["peers", "--json", "--state", laptop.state])).stdout);
  assert.deepEqual(laptopPeers.map((peer: Record<string, unknown>) => [peer.name, peer.kind, peer.status, peer.access, peer.grants]),
    [["studio", "paired", "offline", ["shell", "files", "sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"], ["shell"]]]);
  const studioPeers = await cli(studio, ["peers", "--state", studio.state]);
  assert.match(studioPeers.stdout, /^NAME +STATUS +CONNECTION +ACCESS +FINGERPRINT\nlaptop +offline +- +shell +[a-z2-7-]+\n$/);
  assert.match((await cli(laptop, ["peer", "list"])).stdout, /^studio\t/);

  // Status and doctor describe this device, its daemon and how it reaches a peer.
  const status = await cli(studio, ["status", "--state", studio.state]);
  assert.match(status.stdout, new RegExp(`^This device: ${studioIdentity.fingerprint}\nDaemon: +pid \\d+ at ws://127\\.0\\.0\\.1:${port}, reachable at ws://127\\.0\\.0\\.1:${port}\nPaired: +1 device: laptop\nLinks: +none\n$`));
  const laptopStatus = JSON.parse((await cli(laptop, ["status", "--json", "--state", laptop.state])).stdout);
  assert.deepEqual([laptopStatus.daemon, laptopStatus.links, laptopStatus.paired], [null, [], 1]);
  const doctor = await cli(laptop, ["doctor", "studio", "--state", laptop.state]);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.match(doctor.stdout, new RegExp(`^studio: paired device ${studioIdentity.fingerprint}\n  This device may use its:  shell, files, sessions\n  It may use this device's: shell\n  Daemon link: no daemon running here \\(cns up\\)\n  ws://127\\.0\\.0\\.1:${port}: ok \\(`));
  const doctorJson = JSON.parse((await cli(laptop, ["doctor", "studio", "--json", "--state", laptop.state])).stdout);
  assert.equal(doctorJson.attempts[0].result, "ok");

  // Grants change after pairing, and apply to the next connection.
  const revoked = await cli(studio, ["peer", "revoke", "laptop", "shell", "--state", studio.state]);
  assert.deepEqual([revoked.code, revoked.stdout], [0, "laptop may use this device's: files, sessions.\n"]);
  assert.equal((await cli(laptop, ["run", "studio", "--", "printf x"])).code, 4);
  const granted = await cli(studio, ["peer", "grant", "laptop", "shell,files", "--state", studio.state]);
  assert.deepEqual([granted.code, granted.stdout], [0, "laptop may use this device's: shell, files, sessions.\n"]);
  assert.equal((await cli(laptop, ["run", "studio", "--", "printf regranted"])).stdout, "regranted");
  const addressed = await cli(studio, ["peer", "address", "laptop", "ws://127.0.0.1:1", "--state", studio.state]);
  assert.deepEqual([addressed.code, addressed.stdout], [0, "laptop is dialed at: ws://127.0.0.1:1/.\n"]);
  assert.equal((await cli(studio, ["peer", "address", "laptop", "ws://127.0.0.1:1", "--remove", "--state", studio.state])).stdout, "laptop has no saved address.\n");

  // A device granted only files cannot run commands, and the refusal has its own exit status.
  // Its first attempt names an alias it already uses, so it stops before connecting and the invite stays open.
  assert.equal((await cli(reader, ["peer", "add", "studio", "ws://127.0.0.1:1"])).code, 0);
  const readerInvite = await startInvite(["--name", "reader", "--grant", "all"]);
  const taken = await cli(reader, ["pair", readerInvite.invite, "--yes", "--name", "studio", "--request", "files"]);
  assert.equal(taken.code, 1, taken.stderr);
  assert.match(taken.stderr, /already named studio/);
  assert.equal((await cli(reader, ["peer", "remove", "studio"])).code, 0);
  const second = { accepting: await cli(reader, ["pair", readerInvite.invite, "--yes", "--name", "studio", "--request", "files"]), inviting: await readerInvite.finished() };
  assert.equal(second.accepting.code, 0, second.accepting.stderr);
  assert.match(second.inviting.stdout, /It may use this machine's: files\. This machine may use its: none\./);
  const denied = await cli(reader, ["run", "studio", "--", "printf x"]);
  assert.equal(denied.code, 4, denied.stderr);
  assert.match(denied.stderr, /^Permission denied: shell not granted to reader\. To allow it, run on studio: cns peer grant reader shell$/m);
  assert.equal((await cli(reader, ["sessions", "studio"])).code, 4);

  // --yes alone grants nothing; the invited device saves the other under the name the invite suggests.
  const guest = await device("guest");
  const third = await pairWith(guest, ["--name", "guest"], []);
  const inviterName = suggestedName(os.hostname());
  assert.equal(third.accepting.code, 0, third.accepting.stderr);
  assert.match(third.accepting.stdout, new RegExp(`^Paired with ${inviterName} \\([a-z2-7-]+\\)\\. This device may use its: none\\. It may use this device's: none\\.$`, "m"));
  assert.match(third.inviting.stdout, /Paired with guest \([a-z2-7-]+\)\. It may use this machine's: none\. This machine may use its: none\./);
  assert.equal((await cli(guest, ["run", inviterName, "--", "printf x"])).code, 4);
  // Listing a device that grants nothing says what to run there; doctor picks up a later grant.
  const guestIdentity = JSON.parse((await cli(guest, ["identity", "--json"])).stdout);
  const guestPeers = await cli(guest, ["peers", "--state", guest.state]);
  assert.match(guestPeers.stderr, new RegExp(`${inviterName} grants this device no access\\. To change that, run on ${inviterName}: cns peer grant NAME shell`));
  assert.match(guestPeers.stderr, new RegExp(`with fingerprint ${guestIdentity.fingerprint}`));
  assert.equal((await cli(studio, ["peer", "grant", "guest", "shell", "--state", studio.state])).code, 0);
  const guestDoctor = await cli(guest, ["doctor", inviterName, "--state", guest.state]);
  assert.equal(guestDoctor.code, 0, guestDoctor.stderr);
  assert.match(guestDoctor.stdout, /\n  This device may use its: {2}shell \(changed since it was saved as none; saved now\)\n/);
  const guestAfter = await cli(guest, ["peers", "--json", "--state", guest.state]);
  assert.deepEqual(JSON.parse(guestAfter.stdout)[0].access, ["shell"]);
  assert.equal((await cli(guest, ["peers", "--state", guest.state])).stderr, "");

  // At a terminal, the accepting side asks what the other device may use, until the answer is valid.
  const asked = await device("asked");
  const askedInvite = await startInvite(["--name", "asked", "--grant", "all"]);
  const accepting = inTerminal(t, ["pair", askedInvite.invite, "--state", asked.state], asked.env);
  await accepting.waitFor("Pair with it?");
  accepting.write("y\r");
  await accepting.waitFor("Save it as");
  accepting.write("\r");
  await accepting.waitFor(`What may ${inviterName} use on this device?`);
  accepting.write("root\r");
  await accepting.waitFor("Answer none, shell");
  accepting.write("shell\r");
  assert.equal(await accepting.exited, 0, accepting.output);
  assert.match(accepting.output, new RegExp(`It may use this device's: shell\\.`));
  assert.match((await askedInvite.finished()).stdout, /Paired with asked \([a-z2-7-]+\)\. It may use this machine's: shell, files, sessions\. This machine may use its: shell\./);

  // A device studio never paired with is refused before anything is exported, as is a legacy cns.
  process.env.CNS_CONFIG_DIR = stranger.dir;
  try { savePairedPeer("studio", { publicKey: studioIdentity.publicKey, addresses: [`ws://127.0.0.1:${port}`], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: ["shell"] } }); }
  finally { delete process.env.CNS_CONFIG_DIR; }
  const unpaired = await cli(stranger, ["run", "studio", "--", "printf x"]);
  assert.equal(unpaired.code, 3, unpaired.stderr);
  assert.match(unpaired.stderr, /Not paired with this device/);
  const legacy = await cli(stranger, ["run", `ws://127.0.0.1:${port}`, "--", "printf x"]);
  assert.notEqual(legacy.code, 0);
  assert.equal(legacy.stdout, "");

  // When both devices run daemons and dial each other, exactly one link survives on each side.
  const laptopPort = await unusedPort("127.0.0.1");
  const laptopUp = await cli(laptop, ["up", "--bind", "127.0.0.1", "--port", laptopPort, "--state", laptop.state]);
  assert.equal(laptopUp.code, 0, laptopUp.stderr);
  cleanups.push(() => cli(laptop, ["stop", "--state", laptop.state]));
  assert.equal((await cli(studio, ["peer", "address", "laptop", `ws://127.0.0.1:${laptopPort}`, "--state", studio.state])).code, 0);
  const linkCounts = async () => {
    const counts: number[] = [];
    for (const dev of [studio, laptop]) {
      const control = await connectControl(dev.state);
      try { counts.push((await control.controller.peers()).filter((peer) => peer.peer).length); } finally { control.close(); }
    }
    return counts;
  };
  const deadline = Date.now() + 15000;
  let counts = await linkCounts();
  while (Date.now() < deadline && !(counts[0] === 1 && counts[1] === 1)) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    counts = await linkCounts();
  }
  assert.deepEqual(counts, [1, 1], "one link between the two daemons");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(await linkCounts(), [1, 1], "the link stays single");
  const online = await cli(laptop, ["peers", "--state", laptop.state]);
  assert.match(online.stdout, /\nstudio +online +direct +shell, files, sessions +/);
  assert.match((await cli(studio, ["status", "--state", studio.state])).stdout, /Links: +laptop \(direct, /);

  // Laptop uses studio through the daemons' link. Revoking reaches that link even under a renamed alias,
  // and ends a command already running; widening applies without dropping it; unpairing ends it.
  const waitForLink = async () => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const current = await linkCounts();
      if (current[0] === 1 && current[1] === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.fail("the daemons did not link again");
  };
  const viaLink = async (command: string) => {
    const control = await connectControl(laptop.state);
    try {
      const id = (await control.controller.peers()).find((peer) => peer.peer?.daemon)!.id;
      return await control.controller.run(id, command, {});
    } finally { control.close(); }
  };
  const studioLinkIds = async () => {
    const control = await connectControl(studio.state);
    try { return (await control.controller.peers()).filter((peer) => peer.peer?.daemon).map((peer) => peer.id); } finally { control.close(); }
  };
  assert.equal((await viaLink("printf linked")).stdout, "linked");
  // Settled at once into a value, so its rejection is never unhandled while the revocation runs.
  const running = viaLink("sleep 20; printf finished").then((result) => result.stdout, (error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rename(path.join(studio.dir, "peers", "laptop"), path.join(studio.dir, "peers", "work"));
  const started_ = Date.now();
  assert.equal((await cli(studio, ["peer", "revoke", "work", "shell", "--state", studio.state])).code, 0);
  const outcome = await running;
  assert.ok(outcome instanceof Error, `the running command ended with the revocation, not with ${JSON.stringify(outcome)}`);
  assert.ok(Date.now() - started_ < 5000, "it ended at once");
  await waitForLink();
  await assert.rejects(viaLink("printf x"), /Permission denied: shell not granted to work/);
  const before = await studioLinkIds();
  assert.equal((await cli(studio, ["peer", "grant", "work", "shell", "--state", studio.state])).code, 0);
  assert.equal((await viaLink("printf widened")).stdout, "widened");
  assert.deepEqual(await studioLinkIds(), before, "widening a grant keeps the link");

  // A changed identity behind a saved address is never accepted.
  const file = path.join(laptop.dir, "peers", "studio");
  const saved = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...saved, publicKey: generateIdentity().publicKey }));
  const changed = await cli(laptop, ["run", "studio", "--", "printf x"]);
  assert.equal(changed.code, 3, changed.stderr);
  assert.match(changed.stderr, /identity is not the one saved/);
  await writeFile(file, JSON.stringify(saved));
  const back = await cli(laptop, ["run", "studio", "--", "printf back"]);
  assert.equal(back.stdout, "back", `exit ${back.code}: ${back.stderr}`);

  // Unpairing ends the link at once and refuses the device from then on.
  assert.deepEqual(await cli(studio, ["peer", "remove", "work", "--state", studio.state]), { code: 0, stdout: "Removed work.\n", stderr: "", output: "Removed work.\n" });
  const until = Date.now() + 5000;
  while (Date.now() < until && (await studioLinkIds()).length) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await studioLinkIds(), []);
  assert.equal((await cli(laptop, ["run", "studio", "--", "printf x"])).code, 3);
});
