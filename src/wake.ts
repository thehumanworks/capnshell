import dgram from "node:dgram";
import os from "node:os";
import { errorMessage } from "./errors.js";
import { lanSchema, MAC_PATTERN, type LanCard } from "./peers.js";

/**
 * Wake-on-LAN, for cns wake: a sleeping device's network card wakes it when a frame on its network
 * holds a magic packet, 6 bytes of 0xFF and then the card's MAC address 16 times. cns sends one in
 * UDP datagrams to port 9, the discard port, at the broadcast address of the card's network and at
 * 255.255.255.255, from a device on that network: a broadcast does not cross a router.
 */

export const WAKE_PORT = 9;
export const LIMITED_BROADCAST = "255.255.255.255";

/** A MAC address written with colons or hyphens, in either case, as cns writes it; undefined when it is not one. */
export function macAddress(text: string): string | undefined {
  const mac = text.trim().toLowerCase().replaceAll("-", ":");
  return MAC_PATTERN.test(mac) ? mac : undefined;
}

/** The magic packet for the card with this MAC address: 102 bytes. */
export function magicPacket(mac: string): Buffer {
  if (!MAC_PATTERN.test(mac)) throw new Error(`${mac} is not a MAC address as cns writes one.`);
  const card = Buffer.from(mac.replaceAll(":", ""), "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => card)]);
}

const toNumber = (ip: string) => ip.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
const toAddress = (value: number) => [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
function network(cidr: string): { address: number; mask: number } {
  const [ip = "", bits = "32"] = cidr.split("/");
  const prefix = Number(bits);
  return { address: toNumber(ip), mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0 };
}

/** Whether the network of a card with this address and prefix, such as 192.168.1.23/24, holds the IPv4 address `ip`. */
export function holds(cidr: string, ip: string): boolean {
  const { address, mask } = network(cidr);
  return ((address ^ toNumber(ip)) & mask) >>> 0 === 0;
}

/** The broadcast address of a card's network: 192.168.1.255 for 192.168.1.23/24. */
export function broadcastAddress(cidr: string): string {
  const { address, mask } = network(cidr);
  return toAddress((address | ~mask) >>> 0);
}

/** A card's own IPv4 address. */
export const cardAddress = (card: LanCard): string => card.cidr.split("/")[0]!;

/**
 * Whether a card is on a local network a broadcast reaches: a prefix of 8 to 30 bits, and not a
 * link-local address (169.254.0.0/16), which a card takes when no network gave it one. Cards a
 * paired device names are held to it too, as a cns that knows lan does not check it.
 */
export function usable(card: LanCard): boolean {
  const prefix = Number(card.cidr.split("/")[1]);
  return prefix >= 8 && prefix <= 30 && !holds("169.254.0.0/16", cardAddress(card));
}

/**
 * This device's cards on local networks, which it tells paired devices: each usable IPv4 address
 * that is not loopback, of a card with a MAC address (so not a tunnel, as for a VPN or Tailscale),
 * at most 16, those a packet can wake first, so that bridges never crowd out the card that wakes.
 */
export function lanCards(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): LanCard[] {
  const seen = new Set<string>();
  return Object.values(interfaces).flat().flatMap((entry) => {
    if (!entry || entry.internal || !(entry.family === "IPv4" || (entry.family as unknown) === 4) || !entry.cidr) return [];
    const mac = macAddress(entry.mac ?? "");
    if (!mac || mac === "00:00:00:00:00:00") return [];
    const card = lanSchema.element.safeParse({ mac, cidr: entry.cidr }).data;
    if (!card || !usable(card) || seen.has(`${card.mac} ${card.cidr}`)) return [];
    seen.add(`${card.mac} ${card.cidr}`);
    return [card];
  }).sort((a, b) => Number(wakeable(b)) - Number(wakeable(a))).slice(0, 16);
}

/**
 * Whether a magic packet can wake a device through this card: its MAC address is one a maker gave
 * a card. A locally administered one, which Docker's and virtual machines' bridges and a Wi-Fi
 * card's private address use, belongs to no card that sleeps, or changes; 00:15:5d is Hyper-V's,
 * as is the card WSL sees in its default NAT networking, which no packet on the network wakes.
 */
export function wakeable(card: LanCard): boolean {
  return (parseInt(card.mac.slice(0, 2), 16) & 0x03) === 0 && !card.mac.startsWith("00:15:5d:");
}

/**
 * Where a magic packet goes from a device with these cards: the broadcast address of each network
 * that holds `near`, or of each network when there is no `near`, then 255.255.255.255.
 */
export function wakeTargets(cards: readonly LanCard[], near?: string): string[] {
  const subnets = cards.filter((card) => near === undefined || holds(card.cidr, near)).map((card) => broadcastAddress(card.cidr));
  return [...new Set(subnets), LIMITED_BROADCAST];
}

export interface Sent { sent: string[]; failed: Array<{ to: string; error: string }> }
export type SendPacket = (mac: string, to: readonly string[]) => Promise<Sent>;

/** Send the magic packet for `mac` to each address, `rounds` times, as a sleeping card may miss one. */
export async function sendMagicPacket(mac: string, to: readonly string[], { port = WAKE_PORT, rounds = 3, gapMs = 100 } = {}): Promise<Sent> {
  const packet = magicPacket(mac);
  const socket = dgram.createSocket("udp4");
  // Errors also come back to each send's callback; this keeps one from going unhandled.
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, () => { socket.off("error", reject); resolve(); });
    });
    socket.setBroadcast(true);
    const sent = new Set<string>();
    const errors = new Map<string, string>();
    for (let round = 0; round < rounds; round++) {
      if (round) await new Promise((resolve) => setTimeout(resolve, gapMs));
      for (const address of to) {
        try {
          await new Promise<void>((resolve, reject) => socket.send(packet, port, address, (error) => error ? reject(error) : resolve()));
          sent.add(address);
        } catch (error) { errors.set(address, errorMessage(error)); }
      }
    }
    return { sent: to.filter((address) => sent.has(address)), failed: to.filter((address) => !sent.has(address)).map((address) => ({ to: address, error: errors.get(address) ?? "not sent" })) };
  } finally { socket.close(); }
}

/**
 * Send the magic packet for `mac` from this device: to the networks here that hold `near`, the
 * card's last address, or to every network here without one. Returns where it went; throws, with
 * what to do, when no network here holds `near` or nothing could be sent. What to do comes first:
 * the device that asked shows only the first 200 characters.
 */
export async function wakeHere(mac: string, near: string | undefined, cards: readonly LanCard[] = lanCards(), send: SendPacket = sendMagicPacket, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const to = wakeTargets(cards, near);
  if (near !== undefined && to.length === 1) {
    throw new Error(`No network of this device holds ${near}, so a packet from here would not reach ${mac}: a broadcast does not cross a router. Send it from a device on that network.`);
  }
  const { sent, failed } = await send(mac, to);
  if (!sent.length) {
    const hint = platform === "darwin" ? "macOS may keep cns off the local network: allow what runs it in System Settings > Privacy & Security > Local Network." : "Check that this device is on that network.";
    throw new Error(`${hint} No packet for ${mac} went out: ${failed.map(({ to, error }) => `${to}: ${error}`).join("; ")}.`);
  }
  return sent;
}
