import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { stopDaemon } from "./commands/daemon.js";
import type { Place } from "./commands/remove-everywhere.js";
import { makePrivateDirectory } from "./config.js";
import { OWNER_HEADER, verifyOwner } from "./owner-proof.js";
import { cliInvocation, launchCli, testDevices, type TestDevice } from "./test-support.js";

/** Wait until `check` holds, as lists and links take a moment to reach every daemon. */
async function eventually(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A gateway that answers owner requests as the real one does: signed by a key in `owners`, each nonce once. */
function fakeGateway(t: test.TestContext) {
  const owners: string[] = [];
  const devices: Array<{ name: string; fingerprint: string; granted: string[]; pairedAt: string }> = [];
  const nonces = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const body = new Uint8Array(await request.arrayBuffer());
      const checked = await verifyOwner(request.headers.get(OWNER_HEADER), request, body, { owners, claimNonce: async (nonce) => !nonces.has(nonce) && !!nonces.add(nonce) });
      if ("refused" in checked) return Response.json({ error: checked.refused }, { status: 401 });
      const input = JSON.parse(new TextDecoder().decode(body)) as { name?: string };
      switch (new URL(request.url).pathname) {
        case "/admin/status": return Response.json({ fingerprint: "gate-gate-gate-gate-gate-gate", name: "gateway", relay: "", devices, pending: [], grants: [], owner: checked.fingerprint });
        case "/admin/remove": {
          const at = devices.findIndex((device) => device.name === input.name);
          if (at >= 0) devices.splice(at, 1);
          return Response.json({ removed: at >= 0 });
        }
        default: return Response.json({ error: "Unknown action." }, { status: 404 });
      }
    },
  });
  t.after(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, owners, devices };
}

test("a trusted device removes a lost one everywhere it may, and the lost one cannot use it against the others", { skip: process.platform === "win32", timeout: 240000 }, async (t) => {
  const devices = await testDevices(t, "cns-remove-");
  const gateway = fakeGateway(t);
  // What a device's daemon runs as cns: this cns, or one from before --fingerprint.
  const bin = path.join(devices.root, "bin");
  const old = path.join(devices.root, "old");
  await mkdir(bin);
  await mkdir(old);
  const { file, args } = cliInvocation([]);
  const quoted = [file, ...args].map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(" ");
  await writeFile(path.join(bin, "cns"), `#!/bin/sh\nexec ${quoted} "$@"\n`, { mode: 0o755 });
  await writeFile(path.join(old, "cns"), "#!/bin/sh\necho \"error: unknown option '--fingerprint'\" >&2\nexit 1\n", { mode: 0o755 });
  const on = (dir: string) => `${dir}${path.delimiter}${process.env.PATH}`;
  const device = async (name: string) => {
    const made = await devices.device(name, { PATH: on(bin), CNS_GATEWAY: gateway.url });
    // The daemon at the default state path, which cns run there finds, as on a real device.
    makePrivateDirectory(path.join(made.dir, ".cns"));
    made.state = path.join(made.dir, ".cns", "daemon.json");
    return made;
  };
  const [hub, laptop, studio, phone, tv, nas, box] = await Promise.all(["hub", "laptop", "studio", "phone", "tv", "nas", "box"].map(device));
  for (const each of [hub, laptop, studio, phone, tv, nas, box]) await devices.up(each!);
  const identityOf = async (of: TestDevice) => (JSON.parse((await devices.cli(of, ["identity", "--json"])).stdout) as { fingerprint: string; publicKey: string });
  const lost = await identityOf(phone!);
  gateway.owners.push((await identityOf(laptop!)).publicKey);
  gateway.devices.push({ name: "phone-gw", fingerprint: lost.fingerprint, granted: ["shell"], pairedAt: "" });

  // laptop may use all of hub, nas and box, run commands on studio, and use only the files of tv.
  // phone, the device to lose, may run commands on laptop and nas, use hub's files, and nothing on tv or box.
  await devices.pair(hub!, laptop!);
  await devices.pair(hub!, studio!);
  await devices.pair(hub!, tv!);
  await devices.pair(hub!, phone!, { hostGrants: "files" });
  await devices.pair(laptop!, phone!, { hostGrants: "shell" });
  await devices.pair(studio!, laptop!, { hostGrants: "shell" });
  await devices.pair(tv!, laptop!, { hostGrants: "files" });
  await devices.pair(tv!, phone!, { hostGrants: "none" });
  await devices.pair(nas!, laptop!);
  await devices.pair(nas!, phone!, { hostGrants: "shell" });
  await devices.pair(box!, laptop!);
  await devices.pair(box!, phone!, { hostGrants: "none" });
  // hub runs a mesh of laptop, studio, tv and phone. tv lets every member run commands there,
  // and studio lets them use its files; phone, paired with tv, gets nothing there by its pairing.
  const mesh = (of: TestDevice, words: string[]) => devices.cli(of, ["mesh", ...words, "--state", of.state]);
  assert.equal((await mesh(hub!, ["create", "home"])).code, 0);
  assert.equal((await mesh(hub!, ["add", "home", "laptop", "studio", "tv", "phone"])).code, 0);
  for (const [member, allow] of [[laptop, "shell"], [studio, "files"], [tv, "shell"], [phone, "none"]] as const) {
    const joined = await mesh(member!, ["join", "home", "--via", "hub", "--allow", allow]);
    assert.equal(joined.code, 0, joined.output);
  }
  const has = (of: TestDevice, name: string) => existsSync(path.join(of.dir, "peers", name));
  const revoked = (of: TestDevice, fp: string) => existsSync(path.join(of.dir, "revoked", fp));
  await eventually("studio and phone have each other's member records", () => has(phone!, "studio") && has(studio!, "phone"));
  const listed = async (name: string) => (JSON.parse((await devices.cli(hub!, ["mesh", "list", "home", "--json"])).stdout)[0].members as Array<{ name: string }>).some((member) => member.name === name);
  const incoming = async (of: TestDevice, name: string) => (JSON.parse((await devices.cli(of, ["peer", "list", "--json"])).stdout) as Array<{ name: string; grants: { incoming: string[] } }>).find((peer) => peer.name === name)?.grants.incoming;
  const remove = async (of: TestDevice, words: string[]) => {
    const ran = await devices.cli(of, ["peer", "remove", ...words, "--json", "--state", of.state]);
    return { ...ran, places: JSON.parse(ran.stdout || "[]") as Place[] };
  };
  const outcome = (places: Place[], device: string | null, place: string) => places.find((entry) => entry.device === device && entry.place === place);
  const runs = (of: TestDevice, on: string) => devices.cli(of, ["run", on, "--", "echo", "in"]);

  // Whoever has phone's key runs it against laptop, before anyone notices: a copy of phone's
  // configuration, whose record still says nas lets it run commands, which nas has just taken back.
  const thief = await device("thief");
  copyFileSync(path.join(phone!.dir, "identity.json"), path.join(thief.dir, "identity.json"));
  makePrivateDirectory(path.join(thief.dir, "peers"));
  for (const name of readdirSync(path.join(phone!.dir, "peers"))) {
    copyFileSync(path.join(phone!.dir, "peers", name), path.join(thief.dir, "peers", name));
    chmodSync(path.join(thief.dir, "peers", name), 0o600);
  }
  chmodSync(path.join(thief.dir, "identity.json"), 0o600);
  assert.equal((await devices.cli(nas!, ["peer", "revoke", "phone", "shell", "--state", nas!.state])).code, 0);
  const laptopFp = (await identityOf(laptop!)).fingerprint;
  const attack = await remove(thief, ["laptop", "--everywhere"]);
  assert.equal(attack.code, 4, attack.output);
  assert.deepEqual(attack.places.map((place) => [place.device, place.place, place.outcome]), [
    [null, "its pairing", "removed"],
    ["box", "", "not permitted"],
    ["hub", "", "not permitted"],
    ["nas", "", "not permitted"],
    ["studio", "", "not permitted"],
    ["tv", "", "not permitted"],
    [null, "the gateway", "not permitted"],
  ]);
  assert.match(outcome(attack.places, "hub", "")!.detail!, /^hub does not let this device run commands$/);
  assert.equal(outcome(attack.places, "nas", "")!.detail, "nas does not let this device run commands", "refused by nas itself");
  for (const of of [hub, studio, tv, nas, box]) assert.ok(has(of!, "laptop") && !revoked(of!, laptopFp), `${of!.name} still has laptop`);
  assert.ok(await listed("laptop"));

  // phone runs a mesh of tv and hub, both of which let its members run commands there.
  assert.equal((await mesh(phone!, ["create", "work"])).code, 0);
  assert.equal((await mesh(phone!, ["add", "work", "tv", "hub"])).code, 0);
  for (const member of [tv, hub]) {
    const joined = await mesh(member!, ["join", "work", "--via", "phone", "--allow", "shell"]);
    assert.equal(joined.code, 0, joined.output);
  }
  const work = async (of: TestDevice) => JSON.parse((await devices.cli(of, ["mesh", "list", "work", "--json"])).stdout)[0] as { version: number; allow: string[] };

  // Removed on tv, a member of hub's mesh, phone gets no member record there when the mesh changes:
  // before, deleting its pairing made way for one, with the shell tv lets members use. The mesh
  // phone runs is narrowed there, and tv says which meshes list phone.
  assert.equal((await runs(phone!, "tv")).code, 4);
  const backup = JSON.parse(readFileSync(path.join(tv!.dir, "peers", "phone"), "utf8")) as { addresses: string[]; grants: { incoming: string[] } };
  const plainly = await devices.cli(tv!, ["peer", "remove", "phone", "--state", tv!.state]);
  assert.deepEqual([plainly.code, plainly.stdout], [0, [
    "Removed phone.",
    "phone runs the mesh work, which this device is in. It stays at its last list here, version 2, which whoever has phone's key may have added devices to, so its members may now use nothing here. To finish, leave it: cns mesh leave work. To let its members use shell here again, only once cns mesh list work shows no device you do not know: cns mesh allow work shell.",
    "phone is listed in the mesh home, which hub runs; it gets no record here from that mesh until this device pairs with it directly.",
  ].join("\n") + "\n"]);
  assert.deepEqual((await work(tv!)).allow, []);
  assert.equal((await mesh(tv!, ["allow", "home", "shell"])).code, 0);
  const stillOut = await runs(phone!, "tv");
  assert.equal(stillOut.code, 3, stillOut.output);
  assert.ok(!has(tv!, "phone") && revoked(tv!, lost.fingerprint));
  // phone's record restored on tv from a backup, with its address and now with shell, lets it in no
  // more, after tv restarts too: tv's daemon neither accepts it nor dials it, which would offer it
  // that shell on tv's own link.
  assert.ok(backup.addresses.length, "the record has an address for tv to dial");
  await writeFile(path.join(tv!.dir, "peers", "phone"), JSON.stringify({ ...backup, grants: { ...backup.grants, incoming: ["shell"] } }), { mode: 0o600 });
  await stopDaemon(tv!.state);
  await devices.up(tv!, tv!.port);
  await eventually("tv links to hub again", async () => (await devices.cli(tv!, ["status", "--json", "--state", tv!.state])).stdout.includes("\"hub\""));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const leftover = await devices.cli(phone!, ["run", "tv", "--", "echo", "pwned"]);
  assert.equal(leftover.code, 3, leftover.output);
  assert.ok(!leftover.stdout.includes("pwned"));
  // On tv, cns peers marks that record, and cns run does not dial it.
  assert.deepEqual((JSON.parse((await devices.cli(tv!, ["peers", "--json", "--state", tv!.state])).stdout) as Array<{ name: string; revoked: boolean }>).find((peer) => peer.name === "phone")?.revoked, true);
  const dialed = await devices.cli(tv!, ["run", "phone", "--", "true"]);
  assert.notEqual(dialed.code, 0);
  assert.match(dialed.stderr, /phone was removed from this device \(cns peer remove\), so cns does not connect to it\./);
  await rm(path.join(tv!.dir, "peers", "phone"));
  // phone adds nas to its mesh: hub takes that list and offers it on, and tv, which removed phone, does not take it.
  assert.equal((await mesh(phone!, ["add", "work", "nas"])).code, 0);
  await eventually("hub takes version 3 of phone's mesh", async () => (await work(hub!)).version === 3);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal((await work(tv!)).version, 2, "tv takes no list phone signs");
  // Pairing with it directly again is the way back, and both sides say so.
  assert.equal((await devices.cli(phone!, ["peer", "remove", "tv", "--state", phone!.state])).code, 0);
  const back = await devices.pair(tv!, phone!, { hostGrants: "none" });
  for (const side of [back.host, back.guest]) assert.match(side, /It was removed from this device before \(cns peer remove\); pairing again lets it back in/);
  assert.ok(!revoked(tv!, lost.fingerprint));
  const again = await runs(phone!, "tv");
  assert.equal(again.code, 4, `tv lets it in again, with what this pairing grants: nothing\n${again.output}`);

  // phone runs a command on laptop, which the dry run leaves alone. box has already removed laptop,
  // and nas is off.
  const running = launchCli(t, ["run", "laptop", "--", "echo started; sleep 60"], { env: phone!.env });
  running.child.stdin.end();
  await running.waitFor("started");
  assert.equal((await devices.cli(box!, ["peer", "remove", "laptop", "--state", box!.state])).code, 0);
  await stopDaemon(nas!.state);
  const dry = await remove(laptop!, ["phone", "--everywhere", "--dry-run"]);
  assert.equal(dry.code, 1, dry.output);
  const command = `cns peer remove --fingerprint ${lost.fingerprint} --meshes`;
  assert.deepEqual(dry.places.map((place) => [place.device, place.place, place.outcome, place.next]), [
    [null, "its pairing", "would remove", undefined],
    ["box", "", "not permitted", `On box, run: ${command}`],
    ["hub", "its pairing", "would remove", undefined],
    ["hub", "mesh home", "would remove", undefined],
    ["hub", "mesh work", "would narrow", "To finish, run: cns run hub -- cns mesh leave work"],
    ["nas", "", "unreachable", `Later, run: cns run nas -- ${command}`],
    ["studio", "its pairing", "would remove", undefined],
    ["tv", "", "not permitted", `On tv, run: ${command}`],
    [null, "the gateway", "would remove", undefined],
  ]);
  assert.ok(has(hub!, "phone") && has(studio!, "phone") && await listed("phone") && gateway.devices.length === 1, "a dry run changes nothing");
  assert.ok(!revoked(laptop!, lost.fingerprint) && !revoked(hub!, lost.fingerprint));
  assert.deepEqual(await incoming(laptop!, "phone"), ["shell"]);
  assert.equal(running.closed, false);

  // nas comes back with a cns from before this, which says so.
  nas!.env.PATH = on(old);
  await devices.up(nas!, nas!.port);
  await eventually("laptop links to nas again", async () => (await devices.cli(laptop!, ["status", "--json", "--state", laptop!.state])).stdout.includes("\"nas\""));
  const text = await devices.cli(laptop!, ["peer", "remove", "phone", "--everywhere", "--state", laptop!.state]);
  assert.equal(text.code, 1, text.output);
  const kept = "no mesh gives it a record here again, until this device pairs with it directly";
  assert.match(text.stdout, new RegExp(`^Removing phone \\(fingerprint ${lost.fingerprint}\\) everywhere this device may:\n {2}removed {8}this device: its pairing: saved here as phone; ${kept}\n`));
  assert.match(text.stdout, /^ {2}not permitted {2}box: /m);
  // Another device's answer is shown by its places and outcomes, in this cns's words only.
  assert.match(text.stdout, /^ {2}removed {8}hub: its pairing$/m);
  assert.match(text.stdout, /^ {2}removed {8}hub: mesh home$/m);
  assert.match(text.stdout, /^ {2}narrowed {7}hub: mesh work: it runs this mesh, so hub takes no new list of it, and its members may now use nothing there; only once cns mesh list work there shows no device you do not know, cns mesh allow work GRANTS there undoes that\. To finish, run: cns run hub -- cns mesh leave work\.$/m);
  assert.match(text.stdout, new RegExp(`^ {2}failed {9}nas: nas runs a cns from before this\\. Upgrade cns on nas, then run: cns run nas -- ${command}\\.$`, "m"));
  // hub's new list may reach studio first, which then drops phone by itself.
  assert.match(text.stdout, /^ {2}(removed {8}studio: its pairing|already gone {3}studio)$/m);
  assert.match(text.stdout, new RegExp(`^ {2}not permitted {2}tv: tv does not let this device run commands\\. On tv, run: ${command}\\.$`, "m"));
  assert.match(text.stdout, /^ {2}removed {8}the gateway: http:\/\/127\.0\.0\.1:\d+ had it as phone-gw; no connector reaches it now; if it was one of the gateway's owners too/m);
  // On laptop, phone's command ended, and it may run none now; studio dropped it at once.
  assert.notEqual(await Promise.race([running.exited, new Promise((resolve) => setTimeout(() => resolve("still running"), 15000))]), "still running");
  assert.notEqual(await running.exited, 0);
  const refused = await runs(phone!, "laptop");
  assert.equal(refused.code, 3, refused.output);
  assert.equal(gateway.devices.length, 0);
  assert.ok(!has(hub!, "phone") && !await listed("phone"));
  assert.deepEqual((await work(hub!)).allow, [], "hub narrowed the mesh phone runs");
  for (const of of [laptop, hub, studio]) assert.ok(!has(of!, "phone") && revoked(of!, lost.fingerprint), `${of!.name} has removed phone`);
  assert.ok(has(nas!, "phone"));

  // Running it again is safe. Gone from laptop, it is named by its fingerprint.
  const gone = await devices.cli(laptop!, ["peer", "remove", "phone", "--everywhere", "--state", laptop!.state]);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /No paired device is saved as phone\. If it was removed here already, name it by its fingerprint, which cns peers on another of your devices shows: cns peer remove --fingerprint FINGERPRINT --everywhere\./);
  const rerun = await remove(laptop!, ["--fingerprint", lost.fingerprint, "--everywhere"]);
  assert.equal(rerun.code, 1, rerun.output);
  assert.deepEqual(rerun.places.map((place) => [place.device, place.place, place.outcome]), [
    [null, "its pairing", "already gone"],
    ["box", "", "not permitted"],
    ["hub", "mesh work", "not permitted"],
    ["nas", "", "failed"],
    ["studio", "", "already gone"],
    ["tv", "", "not permitted"],
    [null, "the gateway", "already gone"],
  ]);

  // With cns back on its PATH, the command it gave for nas does the rest there.
  await stopDaemon(nas!.state);
  nas!.env.PATH = on(bin);
  await devices.up(nas!, nas!.port);
  await eventually("laptop links to nas again", async () => (await devices.cli(laptop!, ["status", "--json", "--state", laptop!.state])).stdout.includes("\"nas\""));
  const later = await devices.cli(laptop!, ["run", "nas", "--", ...command.split(" ")]);
  assert.equal(later.code, 0, later.output);
  assert.match(later.stdout, new RegExp(`^ {2}removed {8}this device: its pairing: saved here as phone; ${kept}$`, "m"));
  assert.ok(!has(nas!, "phone"));
  const last = await remove(laptop!, ["--fingerprint", lost.fingerprint, "--everywhere"]);
  assert.equal(last.code, 4, last.output);
  assert.deepEqual(last.places.map((place) => place.outcome), ["already gone", "not permitted", "not permitted", "already gone", "already gone", "not permitted", "already gone"]);
});
