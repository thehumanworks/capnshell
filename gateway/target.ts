import type { RpcStub } from "capnweb";
import { fingerprint, type Identity, type PublicKey } from "../src/identity.js";
import { DEVICE_PEER, MAX_CALLS, type Link, type McpTarget, type PeerFiles, type ToolController } from "../src/mcp/target.js";
import { dialAddresses, isRelayAddress } from "../src/relay-hub.js";
import { connectFirst, rpcSession, type SecureChannel } from "../src/secure.js";
import type { ShellApi, ShellInfo } from "../src/shell.js";
import { plain, type RemoteNamedPty } from "../src/terminal.js";
import { CNS_VERSION } from "../src/version.js";
import { RpcTarget } from "capnweb";

/** A device paired with the gateway. */
export interface GatewayDevice {
  /** The gateway's name for it, which tools take as `peer`. */
  name: string;
  publicKey: PublicKey;
  /** Where it can be reached; only relay addresses work from Cloudflare. */
  addresses: string[];
}

/** How long one device gets to answer, so one offline device does not hold up list_peers. */
const DEVICE_ANSWER_MS = 10_000;

/**
 * What the gateway offers a device in return over a link: the handshake's info() and
 * nothing else. Devices ask for info() when a link opens; every other call is refused.
 */
export class GatewayMain extends RpcTarget {
  info(): ShellInfo {
    return { platform: "linux", name: "gateway", shell: "Bash", hostname: "cns-gateway", cwd: "/", pid: 1, version: CNS_VERSION };
  }
}

/** Only relay addresses: a Worker cannot reach a device's LAN, and dialing it would only add a timeout. */
export function gatewayAddresses(device: { publicKey: PublicKey; addresses: readonly string[] }, relay: string): string[] {
  return dialAddresses({ publicKey: device.publicKey, addresses: device.addresses.filter(isRelayAddress) }, relay);
}

interface Opened { channel: SecureChannel; remote: RpcStub<ShellApi> }

/**
 * Tools that reach the gateway's devices, each on its own encrypted connection through the
 * relay for each call, as `cns mcp DEVICE` does from a laptop. `approved` gives the devices
 * this client was approved for; each device enforces its own grants to the gateway on top.
 */
export function gatewayTarget(approved: () => readonly GatewayDevice[], identity: Identity, relay: string): McpTarget {
  let active = 0;
  return {
    label: "the gateway's devices",
    async open(signal: AbortSignal): Promise<Link> {
      signal.throwIfAborted();
      // Read for each call, so a device removed from the gateway is gone at once.
      const devices = approved();
      if (active >= MAX_CALLS) throw new Error(`Too many tool calls in progress (${MAX_CALLS}); wait for some to finish.`);
      active++;
      const opened = new Map<string, Promise<Opened>>();
      let closed = false;
      let lost = false;
      const byName = (id: string) => {
        const device = devices.find((candidate) => candidate.name === id);
        if (!device) throw new Error(`Unknown peer ${id}.`);
        return device;
      };
      const connect = (id: string): Promise<Opened> => {
        const existing = opened.get(id);
        if (existing) return existing;
        const device = byName(id);
        const attempt = (async () => {
          if (closed) throw new Error("This call has ended.");
          const { channel } = await connectFirst(gatewayAddresses(device, relay), identity, {
            expect: device.publicKey, signal: AbortSignal.any([signal, AbortSignal.timeout(DEVICE_ANSWER_MS)]),
          });
          const remote = rpcSession<ShellApi>(channel, new GatewayMain());
          remote.onRpcBroken(() => { if (!closed) lost = true; });
          if (closed) { remote[Symbol.dispose](); channel.close("MCP call ended"); }
          return { channel, remote };
        })();
        attempt.catch(() => {});
        opened.set(id, attempt);
        return attempt;
      };
      const remote = async (id: string) => (await connect(id)).remote;
      const controller: ToolController = {
        async peers() {
          const answers = await Promise.allSettled(devices.map(async (device) => {
            const info = await plain((await remote(device.name)).info());
            return { id: device.name, info, peer: { name: device.name, fingerprint: fingerprint(device.publicKey), daemon: false, via: "relay" as const } };
          }));
          // Devices that are offline or refuse the gateway are left out; their calls say why.
          return answers.flatMap((answer) => answer.status === "fulfilled" ? [answer.value] : []);
        },
        async run(id, command, options) { return await plain((await remote(id)).run(command, options)); },
        async ptySessions(id) { return await plain((await remote(id)).ptySessions()); },
        async startPtySession(id, name, options) {
          using session = await (await remote(id)).startPtySession(name, options);
          return await plain(session.info());
        },
        async ptySession(id, name) { return await (await remote(id)).ptySession(name) as unknown as RemoteNamedPty; },
        async files(id) { return await remote(id) as unknown as PeerFiles; },
      };
      return {
        controller,
        get lost() { return lost; },
        async peer(requested) {
          if (requested !== undefined) {
            if (devices.some((device) => device.name === requested)) return requested;
            if (requested === DEVICE_PEER && devices.length === 1) return devices[0]!.name;
            throw new Error(`Unknown peer ${requested}. ${devices.length ? `This connector reaches: ${devices.map((device) => device.name).join(", ")}.` : "This connector reaches no devices."}`);
          }
          if (devices.length === 1) return devices[0]!.name;
          throw new Error(devices.length
            ? `This connector reaches several devices (${devices.map((device) => device.name).join(", ")}); pass peer to choose one.`
            : "This connector reaches no devices. Pair the gateway with one (cns gateway pair) and approve the connector for it.");
        },
        close() {
          if (closed) return;
          closed = true;
          active--;
          for (const attempt of opened.values()) {
            attempt.then(({ channel, remote }) => { remote[Symbol.dispose](); channel.close("MCP call ended"); }, () => {});
          }
        },
      };
    },
  };
}
