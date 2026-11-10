/**
 * Measure how fast this device reaches a paired device it cannot dial, such as cns running
 * in WSL, whose Windows host drops inbound connections while outbound ones work.
 *
 * Two devices, "studio" and "wsl", run real daemons on loopback with their own homes. A
 * local relay (src/relay-server.ts) stands in for the Cloudflare one, behind one TCP proxy
 * per device that adds that device's round trip to the relay, plus a TCP and TLS handshake
 * on every new connection. iptables drops SYNs to wsl's port, as the Hyper-V firewall does,
 * so studio's direct dials to wsl hang until they time out; wsl's dials out work.
 *
 * Then, from studio, it times `cns run wsl -- true`, and `cns tty wsl` under a pseudo
 * terminal: how long until the shell prompt shows, and how long each typed key takes to
 * echo back.
 *
 *   sudo bun scripts/bench-unreachable-peer.ts [--binary dist/cns] [--rounds 7] [--keys 20]
 *     [--studio-rtt 140] [--wsl-rtt 66] [--studio-dns 5] [--wsl-dns 70] [--settle 40] [--block-studio]
 *
 * Before measuring, it waits up to --settle seconds for the daemons' standing link to be
 * direct. --block-studio drops SYNs to studio's port too, so the devices can only link
 * through the relay. Linux only; it needs root for iptables and util-linux's script(1).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { connectControl, stopDaemon } from "../src/commands/daemon.js";
import { startRelay } from "../src/relay-server.js";

const { values } = parseArgs({
  options: {
    binary: { type: "string", default: "dist/cns" },
    rounds: { type: "string", default: "7" },
    keys: { type: "string", default: "20" },
    "studio-rtt": { type: "string", default: "140" },
    "wsl-rtt": { type: "string", default: "66" },
    "studio-dns": { type: "string", default: "5" },
    "wsl-dns": { type: "string", default: "70" },
    "block-studio": { type: "boolean", default: false },
    settle: { type: "string", default: "40" },
  },
});
const binary = path.resolve(values.binary!);
const rounds = Number(values.rounds);
const keyCount = Number(values.keys);
const studioRtt = Number(values["studio-rtt"]);
const wslRtt = Number(values["wsl-rtt"]);
const studioDns = Number(values["studio-dns"]);
const wslDns = Number(values["wsl-dns"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
const summary = (values: number[]) => `median ${median(values).toFixed(0)} ms (min ${Math.min(...values).toFixed(0)}, max ${Math.max(...values).toFixed(0)}, n=${values.length})`;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** How far a device is from the relay: its round trip, and the DNS lookup each new connection makes. */
interface Distance { rttMs: number; dnsMs: number }

/**
 * A TCP proxy to the relay at `target` that puts each connection as far away as the device
 * that made it: it reads the request line, asks `distance` for that device, holds the
 * connection for the DNS lookup and two round trips (TCP's and TLS 1.3's handshakes), then
 * delays each direction by half a round trip, keeping order.
 */
async function latencyProxy(target: number, distance: (path: string) => Distance): Promise<{ port: number; close(): void }> {
  const delayed = (to: net.Socket, oneWay: number) => {
    let last = 0;
    return (chunk: Buffer | null) => {
      const at = Math.max(Date.now() + oneWay, last);
      last = at;
      setTimeout(() => { if (chunk) to.write(chunk); else to.end(); }, at - Date.now());
    };
  };
  const server = net.createServer((client) => {
    const held: Buffer[] = [];
    let started = false;
    client.on("error", () => {});
    const collect = (chunk: Buffer) => {
      held.push(chunk);
      const head = Buffer.concat(held).toString("latin1");
      if (started || !head.includes("\r\n")) return;
      started = true;
      const { rttMs, dnsMs } = distance(head.split(" ")[1] ?? "/");
      setTimeout(() => {
        const upstream = net.connect(target, "127.0.0.1");
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        upstream.once("connect", () => {
          const toUpstream = delayed(upstream, rttMs / 2);
          const toClient = delayed(client, rttMs / 2);
          client.off("data", collect);
          for (const part of held) toUpstream(part);
          client.on("data", toUpstream);
          client.on("end", () => toUpstream(null));
          upstream.on("data", toClient);
          upstream.on("end", () => toClient(null));
          client.on("close", () => upstream.destroy());
          upstream.on("close", () => client.destroy());
        });
      }, dnsMs + 2 * rttMs);
    };
    client.on("data", collect);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

function iptables(action: "-I" | "-D", port: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("iptables", [action, "INPUT", "-p", "tcp", "--dport", String(port), "--syn", "-j", "DROP"], { stdio: "inherit" });
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`iptables ${action} failed (${code})`)));
  });
}

interface Device { name: string; dir: string; env: NodeJS.ProcessEnv; state: string; port: number }

function cli(device: Device, args: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(binary, args, { env: device.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    child.once("close", (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
  });
}

/** `cns tty wsl` at a pseudo terminal: time to the prompt, then each key's echo. */
async function ttyRound(device: Device, peer: string): Promise<{ promptMs: number; echoMs: number[] }> {
  const started = performance.now();
  const child = spawn("script", ["-qfec", `stty rows 24 cols 80; exec ${binary} tty ${peer}`, "/dev/null"], { env: { ...device.env, TERM: "xterm-256color" }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const waiters = new Set<() => void>();
  child.stdout.on("data", (chunk) => { output += chunk; for (const waiter of waiters) waiter(); });
  const waitFor = (test: () => boolean, label: string, ms = 30000) => new Promise<void>((resolve, reject) => {
    const check = () => { if (test()) { waiters.delete(check); clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Timed out waiting for ${label}:\n${output.slice(-2000)}`)); }, ms);
    waiters.add(check);
    check();
  });
  try {
    await waitFor(() => output.includes("READY$"), "the prompt");
    const promptMs = performance.now() - started;
    const echoMs: number[] = [];
    // Let the redraw settle, then type lowercase letters one at a time.
    await sleep(300);
    for (let i = 0; i < keyCount; i++) {
      const key = String.fromCharCode(97 + (i % 26));
      const from = output.length;
      const sent = performance.now();
      child.stdin.write(key);
      await waitFor(() => output.indexOf(key, from) >= 0, `the echo of ${key}`);
      echoMs.push(performance.now() - sent);
      await sleep(30);
    }
    // Clear the typed line, then detach with Ctrl-], leaving the session running.
    child.stdin.write("\x15");
    await sleep(100);
    child.stdin.write("\x1d");
    await new Promise((resolve) => child.once("close", resolve));
    return { promptMs, echoMs };
  } finally {
    child.kill("SIGKILL");
  }
}

async function main() {
  if (process.platform !== "linux") throw new Error("This benchmark needs Linux, iptables and script(1).");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-bench-")));
  const relayPort = await freePort();
  const relay = startRelay({ bind: "127.0.0.1", port: relayPort });
  // Which device made a relay request: the key's own daemon registers and answers; the other device dials it.
  const keys = new Map<string, "studio" | "wsl">();
  const distances = { studio: { rttMs: studioRtt, dnsMs: studioDns }, wsl: { rttMs: wslRtt, dnsMs: wslDns } };
  const proxy = await latencyProxy(relayPort, (request) => {
    const [, , kind, key] = /^\/(v1)\/(accept|dial|answer)\/([A-Za-z0-9_-]{43})/.exec(request) ?? [];
    const owner = key ? keys.get(key) : undefined;
    if (!owner) return distances.studio;
    return distances[kind === "dial" ? (owner === "wsl" ? "studio" : "wsl") : owner];
  });
  const device = async (name: string): Promise<Device> => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    // A login shell with a prompt the benchmark can wait for.
    await writeFile(path.join(dir, ".bash_profile"), "PS1='READY$ '\n");
    return {
      name, dir, port: await freePort(), state: path.join(dir, ".cns", "daemon.json"),
      env: { PATH: process.env.PATH, HOME: dir, CNS_CONFIG_DIR: dir, CNS_RELAY: `ws://127.0.0.1:${proxy.port}`, SHELL: "/bin/bash" },
    };
  };
  const studio = await device("studio");
  const wsl = await device("wsl");
  for (const dev of [studio, wsl]) {
    const identity = await cli(dev, ["identity", "--json"]);
    keys.set(JSON.parse(identity.stdout).publicKey, dev.name as "studio" | "wsl");
  }
  const blocked = [wsl.port, ...values["block-studio"] ? [studio.port] : []];
  const cleanup = async () => {
    for (const dev of [studio, wsl]) { try { await stopDaemon(dev.state); } catch { /* Not running. */ } }
    if (process.env.BENCH_LOGS) {
      const { readdir } = await import("node:fs/promises");
      for (const dev of [studio, wsl]) {
        const dir = path.dirname(dev.state);
        for (const file of (await readdir(dir)).filter((name) => name.endsWith(".log"))) console.log(`--- ${dev.name}\n${await readFile(path.join(dir, file), "utf8")}`);
      }
    }
    for (const port of blocked) { try { await iptables("-D", port); } catch { /* Not added. */ } }
    proxy.close();
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  };
  process.once("SIGINT", () => { void cleanup().then(() => process.exit(130)); });
  try {
    for (const port of blocked) await iptables("-I", port);
    for (const dev of [studio, wsl]) {
      const up = await cli(dev, ["up", "--bind", "127.0.0.1", "--port", String(dev.port), "--state", dev.state]);
      if (up.code !== 0) throw new Error(`cns up failed on ${dev.name}:\n${up.stdout}${up.stderr}`);
    }
    // The WSL device invites, as lf did; studio can reach it only through the relay.
    await sleep(1000);
    const inviting = spawn(binary, ["pair", "--yes", "--name", "studio", "--grant", "all", "--state", wsl.state], { env: wsl.env, stdio: ["pipe", "pipe", "pipe"] });
    inviting.stdin.end();
    let invite = "";
    await new Promise<void>((resolve, reject) => {
      inviting.stdout.on("data", (chunk) => {
        invite += chunk;
        if (/Invite: cns1:[A-Za-z0-9_-]+/.test(invite)) resolve();
      });
      inviting.once("close", () => reject(new Error(`cns pair exited:\n${invite}`)));
    });
    const text = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(invite)![1]!;
    const accepted = await cli(studio, ["pair", text, "--yes", "--name", "wsl", "--grant", "all", "--request", "all", "--state", studio.state]);
    if (accepted.code !== 0) throw new Error(`Pairing failed:\n${accepted.stdout}${accepted.stderr}`);
    // Wait for one standing link between the daemons, and give it the time a newer cns takes
    // to replace a link through the relay with a direct one, which it does after 10 s or more.
    const linkVia = async () => {
      const control = await connectControl(studio.state);
      try {
        const links = (await control.controller.peers()).filter((peer) => peer.peer?.name === "wsl" && peer.peer.daemon);
        return links.length === 1 ? links[0]!.peer!.via : "";
      } finally { control.close(); }
    };
    let via = "";
    const settleBy = Date.now() + Number(values.settle) * 1000;
    while (Date.now() < settleBy) {
      via = await linkVia();
      if (via === "direct") break;
      await sleep(250);
    }
    await sleep(1000);
    via = await linkVia();
    const saved = JSON.parse(await readFile(path.join(studio.dir, "peers", "wsl"), "utf8")).addresses as string[];
    console.log(`studio's standing link to wsl: ${via || "none"}; studio dials wsl at ${saved.join(", ")}`);
    console.log(`relay round trip: studio ${studioRtt} ms, wsl ${wslRtt} ms; DNS: studio ${studioDns} ms, wsl ${wslDns} ms; blocked ports: ${blocked.join(", ")}`);

    const run: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const result = await cli(studio, ["run", "wsl", "--", "true"]);
      if (result.code !== 0) throw new Error(`cns run failed:\n${result.stderr}`);
      run.push(result.ms);
    }
    console.log(`cns run wsl -- true:         ${summary(run)}`);
    const prompt: number[] = [];
    const echoes: number[] = [];
    for (let i = 0; i < Math.max(1, Math.floor(rounds / 2)); i++) {
      const round = await ttyRound(studio, "wsl");
      prompt.push(round.promptMs);
      echoes.push(...round.echoMs);
    }
    console.log(`cns tty wsl, to the prompt: ${summary(prompt)}`);
    console.log(`cns tty wsl, key echo:      ${summary(echoes)}`);
    console.log(`studio's standing link to wsl afterwards: ${await linkVia() || "none"}`);
  } finally {
    await cleanup();
  }
}

await main();
