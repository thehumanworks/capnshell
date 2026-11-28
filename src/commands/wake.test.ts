import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprint, generateIdentity } from "../identity.js";
import { revokeDevice, savePairedPeer, type LanCard } from "../peers.js";
import type { SendPacket } from "../wake.js";
import { commandLine, type Device, type Reach } from "./upgrade.js";
import { planWake, reportLine, wake, wakeArguments, wakeExitCode } from "./wake.js";

const key = () => generateIdentity().publicKey;
const card = (mac: string, cidr: string): LanCard => ({ mac, cidr });
const STUDIO_ETH = card("3c:22:fb:12:34:56", "192.168.1.23/24");
const studio = { name: "studio", publicKey: key(), lan: [STUDIO_ETH, card("02:42:ac:11:00:01", "172.17.0.1/16"), card("a6:0b:11:22:33:44", "192.168.1.24/24")] };

test("the packet is sent from this device and from each paired device on the sleeping one's network, and from no other", () => {
  const nas = { name: "nas", publicKey: key(), lan: [card("00:11:32:aa:bb:cc", "192.168.1.10/24")] };
  // Docker's bridge has the same numbers everywhere; the sleeping device's is no card a packet wakes.
  const cloud = { name: "cloud", publicKey: key(), lan: [card("02:42:ac:11:00:02", "172.17.0.1/16"), card("06:aa:bb:cc:dd:ee", "10.0.5.4/24")] };
  const old = { name: "old", publicKey: key() };
  const gateway = { name: "gateway", publicKey: key(), gateway: true as const, lan: [card("00:11:32:aa:bb:cd", "192.168.1.11/24")] };
  // The record of the sleeping device itself, under another name, never sends.
  const peers = [cloud, gateway, nas, old, { ...studio, name: "studio" }];
  assert.deepEqual(planWake(studio, [], peers), [{ device: "nas", cards: [STUDIO_ETH] }]);
  // This device is on that network too, by its Wi-Fi card: it sends, and nas is asked as well,
  // since another network with the same numbers, far away, cannot be told apart.
  assert.deepEqual(planWake(studio, [card("a6:00:00:00:00:01", "192.168.1.40/24")], peers), [{ device: null, cards: [STUDIO_ETH] }, { device: "nas", cards: [STUDIO_ETH] }]);
  // --via names the one, whatever its record says.
  assert.deepEqual(planWake(studio, [card("a6:00:00:00:00:01", "192.168.1.40/24")], peers, "cloud"), [{ device: "cloud", cards: [STUDIO_ETH] }]);
});

test("planning says what to do when no card of the device is known, none wakes it, or no device is on its network", () => {
  assert.throws(() => planWake({ name: "studio", publicKey: key() }, [], []),
    /^Error: cns does not know studio's network card yet: this device's daemon learns it from studio's daemon over their link, while studio is awake and both run a cns that has cns wake\. Wake studio by hand this once\. Then keep a daemon running here \(cns up\), and once cns peers shows studio online, run cns upgrade studio if it shows an older cns there; cns wake studio works from then on\.$/);
  assert.throws(() => planWake({ name: "wsl", publicKey: key(), lan: [card("00:15:5d:01:02:03", "172.23.80.5/20")] }, [], []),
    /^Error: wsl said it has no network card a Wake-on-LAN packet wakes: only virtual ones, such as Docker's, a virtual machine's or WSL's, or ones with a private \(locally administered\) address \(00:15:5d:01:02:03\)\. Wake it by hand\./);
  assert.throws(() => planWake({ name: "pi", publicKey: key(), lan: [] }, [], []), /^Error: pi said it has no network card a Wake-on-LAN packet wakes\. Wake it by hand\./);
  assert.throws(() => planWake(studio, [card("a6:00:00:00:00:01", "10.0.0.2/24")], [{ name: "nas", publicKey: key(), lan: [card("00:11:32:aa:bb:cc", "192.168.2.10/24")] }]),
    /^Error: No device cns knows to be on studio's network \(192\.168\.1\.0\/24\) can send the packet: this device is not on it, and no paired device has said it is\. Name one that is: cns wake studio --via DEVICE\./);
});

test("only a checked MAC address and IPv4 address go on the sending device's command line", () => {
  assert.equal(commandLine("Bash", "cns", wakeArguments(STUDIO_ETH, "Bash")), "cns wake --mac '3c:22:fb:12:34:56' --address '192.168.1.23'");
  assert.equal(commandLine("PowerShell", "cns", wakeArguments(STUDIO_ETH, "PowerShell")),
    "& cns wake --mac '3c:22:fb:12:34:56' --address '192.168.1.23'; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE");
  // A record is checked when it is read; this is checked again, right where the command is made.
  for (const bad of [card("3c:22:fb:12:34:56'; id; '", "192.168.1.23/24"), card("3C:22:FB:12:34:56", "192.168.1.23/24"), card("3c:22:fb:12:34:56", "192.168.1.023/24"), card("3c:22:fb:12:34:56", "$(id)/24")]) {
    assert.throws(() => wakeArguments(bad, "Bash"), /is not a card cns sends a packet for/);
  }
});

test("the exit status is 0 when a packet went out, 4 when each sender refused this device, else 1", () => {
  const sent = { from: "nas", result: "sent", macs: [STUDIO_ETH.mac] } as const;
  const refused = { from: "pi", result: "failed", reason: "Permission denied", refused: true } as const;
  const away = { from: "pi", result: "failed", reason: "unreachable" } as const;
  assert.equal(wakeExitCode([refused, sent]), 0);
  assert.equal(wakeExitCode([refused, refused]), 4);
  assert.equal(wakeExitCode([refused, away]), 1);
  assert.equal(reportLine("studio", { from: null, result: "sent", macs: [STUDIO_ETH.mac], to: ["192.168.1.255", "255.255.255.255"] }),
    "studio: magic packet sent from this device for 3c:22:fb:12:34:56 to 192.168.1.255, 255.255.255.255");
  // What a device said shows each character as itself.
  assert.equal(reportLine("studio", { from: "nas", result: "failed", reason: "bad‮txt.exe" }), "studio: not sent from nas: bad?txt.exe");
});

/** Paired devices saved in a configuration directory of a test's own, as cns wake reads them. */
async function fleet(t: test.TestContext) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-wake-")));
  const previous = process.env.CNS_CONFIG_DIR;
  process.env.CNS_CONFIG_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.CNS_CONFIG_DIR; else process.env.CNS_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const save = (name: string, lan?: LanCard[]) => {
    const publicKey = key();
    savePairedPeer(name, { publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: ["shell"] }, ...lan ? { lan } : {} });
    return publicKey;
  };
  save("studio", [STUDIO_ETH]);
  save("nas", [card("00:11:32:aa:bb:cc", "192.168.1.10/24")]);
  save("pi", [card("b8:27:eb:01:02:03", "192.168.1.11/24")]);
  save("laptop", [card("a6:00:00:00:00:01", "10.0.0.2/24")]);
  return { save };
}

/** Devices as cns wake reaches them: each runs what it is told, and answers as `answers` says. */
function devices(answers: Record<string, (command: string) => { code: number; stdout?: string; stderr?: string }>, shells: Record<string, Device["shell"]> = {}) {
  const commands: Array<[string, string]> = [];
  const reach: Reach = async (name) => {
    const answer = answers[name];
    if (!answer) throw new Error(`Cannot connect to ${name}: connect ECONNREFUSED 192.168.1.9:47381`);
    const shell = shells[name] ?? "Bash";
    return {
      platform: shell === "Bash" ? "linux" : "win32", shell, version: "2.11.0",
      async run(command) { commands.push([name, command]); return { stdout: "", stderr: "", ...answer(command) }; },
      close() {},
    };
  };
  return { reach, commands };
}

/** Run cns wake, keeping what it prints. */
async function run(name: string | undefined, options: Parameters<typeof wake>[1], reach: Reach, here: LanCard[] = [], send?: SendPacket) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (line: string) => out.push(line);
  console.error = (line: string) => err.push(line);
  try { return { code: await wake(name, options, reach, () => here, send), out, err }; }
  finally { console.log = log; console.error = error; }
}

test("cns wake has each paired device on the network run its own cns wake --mac, and reports each", async (t) => {
  await fleet(t);
  const sent = { code: 0, stdout: "Sent a magic packet for 3c:22:fb:12:34:56 to 192.168.1.255, 255.255.255.255, UDP port 9." };
  const { reach, commands } = devices({ nas: () => sent, pi: () => sent }, { pi: "PowerShell" });
  const result = await run("studio", {}, reach);
  assert.equal(result.code, 0);
  assert.deepEqual(result.out.sort(), ["studio: magic packet sent from nas for 3c:22:fb:12:34:56", "studio: magic packet sent from pi for 3c:22:fb:12:34:56"]);
  assert.match(result.err.join("\n"), /If Wake-on-LAN is on there, studio wakes within a minute or so/);
  assert.deepEqual(commands.sort(), [
    ["nas", "cns wake --mac '3c:22:fb:12:34:56' --address '192.168.1.23'"],
    ["pi", "& cns wake --mac '3c:22:fb:12:34:56' --address '192.168.1.23'; if ($null -eq $LASTEXITCODE) { exit 127 }; exit $LASTEXITCODE"],
  ]);
  // One that sends is enough; one that does not answer is reported with what to run.
  const half = devices({ nas: () => sent });
  const some = await run("studio", {}, half.reach);
  assert.equal(some.code, 0);
  assert.deepEqual(some.out.sort(), [
    "studio: magic packet sent from nas for 3c:22:fb:12:34:56",
    "studio: not sent from pi: unreachable (Cannot connect to pi: connect ECONNREFUSED 192.168.1.9:47381). cns doctor pi shows how it is reached",
  ]);
});

test("this device sends the packet itself when it is on the network, and --via asks only the device it names", async (t) => {
  await fleet(t);
  const { reach, commands } = devices({ nas: () => ({ code: 0 }), pi: () => ({ code: 0 }), laptop: () => ({ code: 0 }) });
  const packets: string[][] = [];
  const send: SendPacket = async (mac, to) => { packets.push([mac, ...to]); return { sent: [...to], failed: [] }; };
  const here = await run("studio", {}, reach, [card("a6:00:00:00:00:09", "192.168.1.40/24")], send);
  assert.equal(here.code, 0);
  assert.ok(here.out.includes("studio: magic packet sent from this device for 3c:22:fb:12:34:56 to 192.168.1.255, 255.255.255.255"));
  assert.deepEqual(packets, [["3c:22:fb:12:34:56", "192.168.1.255", "255.255.255.255"]]);
  commands.length = 0;
  packets.length = 0;
  // laptop says it is elsewhere, but --via is the person's call: it is asked, and it alone.
  const via = await run("studio", { via: "laptop" }, reach, [card("a6:00:00:00:00:09", "192.168.1.40/24")], send);
  assert.equal(via.code, 0);
  assert.deepEqual(via.out, ["studio: magic packet sent from laptop for 3c:22:fb:12:34:56"]);
  assert.deepEqual(commands.map(([name]) => name), ["laptop"]);
  assert.deepEqual(packets, []);
  await assert.rejects(run("studio", { via: "studio" }, reach), /studio cannot wake itself\. Name a device on its network: cns wake studio --via DEVICE\./);
});

test("a sending device on an older cns is named with cns upgrade, and one that refuses with the grant to give", async (t) => {
  await fleet(t);
  const old = devices({ nas: () => ({ code: 1, stderr: "error: unknown command 'wake'\n\nUsage: cns [options] [command]" }) });
  const before = await run("studio", { via: "nas" }, old.reach);
  assert.equal(before.code, 1);
  assert.deepEqual(before.out, ["studio: not sent from nas: nas runs a cns from before cns wake. Run cns upgrade nas, then cns wake studio again"]);
  assert.deepEqual(before.err, []);
  const missing = devices({ nas: () => ({ code: 127, stderr: "bash: cns: command not found" }) });
  assert.deepEqual((await run("studio", { via: "nas" }, missing.reach)).out,
    ["studio: not sent from nas: cns is not on its daemon's PATH. To see it there: cns run nas -- cns wake --mac 3c:22:fb:12:34:56 --address 192.168.1.23"]);
  const elsewhere = devices({ nas: () => ({ code: 1, stderr: "No network of this device holds 192.168.1.23, so a packet from here would not reach 3c:22:fb:12:34:56: a broadcast does not cross a router. Send it from a device on that network." }) });
  assert.match((await run("studio", { via: "nas" }, elsewhere.reach)).out[0]!, /^studio: not sent from nas: No network of this device holds 192\.168\.1\.23, so a packet/);
  const denied: Reach = async () => { throw new Error("Permission denied: shell not granted to laptop."); };
  const refused = await run("studio", { via: "nas" }, denied);
  assert.equal(refused.code, 4);
  assert.deepEqual(refused.out, ["studio: not sent from nas: Permission denied: shell not granted to laptop. To allow it, run on nas: cns peer grant laptop shell"]);
});

test("cns wake refuses a device removed here, as a sleeping one or as a sender, and asks none removed", async (t) => {
  const { save } = await fleet(t);
  const { reach, commands } = devices({ nas: () => ({ code: 0 }), pi: () => ({ code: 0 }) });
  const removed = save("old-nas", [card("00:11:32:aa:bb:ff", "192.168.1.12/24")]);
  revokeDevice(fingerprint(removed));
  await assert.rejects(run("studio", { via: "old-nas" }, reach), /old-nas was removed from this device \(cns peer remove\), so cns does not connect to it/);
  const result = await run("studio", {}, reach);
  assert.equal(result.code, 0);
  assert.deepEqual(commands.map(([name]) => name).sort(), ["nas", "pi"]);
  await assert.rejects(run("nobody", {}, reach), /No paired device is saved as nobody\. Pair with it first: cns pair\./);
});

test("cns wake --mac sends from this device, and refuses what is not a MAC address or an IPv4 address", async () => {
  const unused: Reach = async () => { throw new Error("not asked"); };
  const packets: string[][] = [];
  const send: SendPacket = async (mac, to) => { packets.push([mac, ...to]); return { sent: [...to], failed: [] }; };
  const here = [card("a6:00:00:00:00:09", "192.168.1.40/24"), card("02:42:ac:11:00:01", "172.17.0.1/16")];
  const result = await run(undefined, { mac: "3C-22-FB-12-34-56", address: "192.168.1.23" }, unused, here, send);
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, ["Sent a magic packet for 3c:22:fb:12:34:56 to 192.168.1.255, 255.255.255.255, UDP port 9."]);
  // Without an address, to every network here.
  await run(undefined, { mac: "3c:22:fb:12:34:56" }, unused, here, send);
  assert.deepEqual(packets, [["3c:22:fb:12:34:56", "192.168.1.255", "255.255.255.255"], ["3c:22:fb:12:34:56", "192.168.1.255", "172.17.255.255", "255.255.255.255"]]);
  await assert.rejects(run(undefined, { mac: "3c:22:fb:12:34" }, unused, here, send), /3c:22:fb:12:34 is not a MAC address: write it as six pairs of hex digits/);
  await assert.rejects(run(undefined, { mac: "3c:22:fb:12:34:56", address: "192.168.1.300" }, unused, here, send), /--address takes the card's IPv4 address, such as 192\.168\.1\.23, not 192\.168\.1\.300\./);
  await assert.rejects(run("studio", { mac: "3c:22:fb:12:34:56" }, unused, here, send), /Name a paired device or give --mac, not both/);
  await assert.rejects(run("studio", { address: "192.168.1.23" }, unused, here, send), /--address goes with --mac/);
  await assert.rejects(run(undefined, {}, unused, here, send), /Name the paired device to wake: cns wake DEVICE\./);
  assert.equal(packets.length, 2);
});
