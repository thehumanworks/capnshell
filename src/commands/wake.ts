import { AuthError } from "../auth.js";
import { errorMessage, strictlyPrintable } from "../errors.js";
import { explainDenial, getPeer, IPV4_PATTERN, MAC_PATTERN, reachablePeers, resolvePeer, type LanCard, type PeerEntry } from "../peers.js";
import { cardAddress, holds, lanCards, macAddress, networkName, sendMagicPacket, WAKE_PORT, wakeable, wakeHere, type SendPacket } from "../wake.js";
import { commandLine, reachDevice, shellWord, why, type Device, type Reach } from "./upgrade.js";

/**
 * `cns wake DEVICE`: wake a sleeping paired device with a Wake-on-LAN packet sent from a device on
 * its network, as its last saved network cards say (wake.ts): this device, and each paired device
 * that said it is on that network, through the shell grant it gives this one, by running its own
 * `cns wake --mac MAC --address IP` there, as cns run would. Each is asked, as two networks far
 * apart can have the same numbers; one that sends is enough. --via names the one that sends.
 */

/** Who sends the packet, null for this device, and for which of the sleeping device's cards. */
export interface Sender { device: string | null; cards: LanCard[] }

/** The networks of these cards, as people write them. */
const networks = (cards: readonly LanCard[]) => [...new Set(cards.map((card) => networkName(card.cidr)))].join(", ");

/**
 * Who sends the packet to wake `sleeper`: `via` alone when it is named, else this device when one of
 * its networks holds a card of the sleeping device, and each paired device whose saved cards say the
 * same of it. The cns gateway, which is on no local network, never sends one. Throws, with what to
 * do, when cns knows no card of the device or no device on its network.
 */
export function planWake(sleeper: Pick<PeerEntry, "name" | "publicKey" | "lan">, here: readonly LanCard[], peers: readonly Pick<PeerEntry, "name" | "publicKey" | "lan" | "gateway">[], via?: string): Sender[] {
  const { name } = sleeper;
  if (sleeper.lan === undefined) {
    throw new Error(`cns does not know ${name}'s network card yet: this device's daemon learns it from ${name}'s daemon over their link, while ${name} is awake and both run a cns that has cns wake. ` +
      `Wake ${name} by hand this once. Then keep a daemon running here (cns up), and once cns peers shows ${name} online, run cns upgrade ${name} if it shows an older cns there; cns wake ${name} works from then on.`);
  }
  const cards = sleeper.lan.filter(wakeable);
  if (!cards.length) {
    throw new Error(`${name} said it has no network card a Wake-on-LAN packet wakes${sleeper.lan.length ? `: only virtual ones, such as Docker's, a virtual machine's or WSL's, or ones with a private (locally administered) address (${sleeper.lan.map((card) => card.mac).join(", ")})` : ""}. ` +
      `Wake it by hand. A card that wakes its machine is usually a wired one with Wake-on-LAN turned on in its settings; once ${name} uses one, its daemon says so to this one's.`);
  }
  if (via !== undefined) return [{ device: via, cards }];
  const on = (mine: readonly LanCard[]) => cards.filter((card) => mine.some((own) => holds(own.cidr, cardAddress(card))));
  const senders: Sender[] = [{ device: null, cards: on(here) }];
  for (const peer of peers) if (peer.publicKey !== sleeper.publicKey && !peer.gateway) senders.push({ device: peer.name, cards: on(peer.lan ?? []) });
  const chosen = senders.filter((sender) => sender.cards.length);
  if (!chosen.length) {
    throw new Error(`No device cns knows to be on ${name}'s network (${networks(cards)}) can send the packet: this device is not on it, and no paired device has said it is. ` +
      `Name one that is: cns wake ${name} --via DEVICE. A device says which networks it is on when its daemon links to this one's, both running a cns that has cns wake; cns peers shows which are online.`);
  }
  return chosen;
}

/** What became of one sender. Every text in it is strictlyPrintable when reportLine prints it. */
export type Outcome =
  | { from: string | null; result: "sent"; macs: string[]; to?: string[] }
  /** `refused`: the device did not accept this one, or does not let it run commands. */
  | { from: string | null; result: "failed"; reason: string; next?: string; refused?: boolean };

/** The report's line for one sender. */
export function reportLine(sleeper: string, outcome: Outcome): string {
  const from = outcome.from ?? "this device";
  const line = outcome.result === "sent"
    ? `${sleeper}: magic packet sent from ${from} for ${outcome.macs.join(", ")}${outcome.to ? ` to ${outcome.to.join(", ")}` : ""}`
    : `${sleeper}: not sent from ${from}: ${outcome.reason.replace(/\.$/, "")}${outcome.next ? `. ${outcome.next}` : ""}`;
  // Devices said much of it: each character shows as itself.
  return strictlyPrintable(line);
}

/** 0 when a packet went out, else 4 when each sender refused this device, as for a missing grant, else 1. */
export function wakeExitCode(outcomes: readonly Outcome[]): number {
  if (outcomes.some((outcome) => outcome.result === "sent")) return 0;
  return outcomes.length && outcomes.every((outcome) => outcome.result === "failed" && outcome.refused) ? 4 : 1;
}

/**
 * The words of cns wake --mac for a device's command line. Only checked text goes there: a MAC
 * address and an IPv4 address that match strict patterns, quoted for the device's shell besides.
 */
export function wakeArguments(card: LanCard, shell: Device["shell"]): string[] {
  const address = cardAddress(card);
  if (!MAC_PATTERN.test(card.mac) || !IPV4_PATTERN.test(address)) throw new Error(`${strictlyPrintable(card.mac)} at ${strictlyPrintable(address)} is not a card cns sends a packet for.`);
  return ["wake", "--mac", shellWord(card.mac, shell), "--address", shellWord(address, shell)];
}

/** How long cns wake may run on a device: it sends for a third of a second. */
const RUN_MS = 15_000;

/** Send from this device, for each card. */
async function fromHere(cards: readonly LanCard[], here: readonly LanCard[], send: SendPacket): Promise<Outcome> {
  const macs: string[] = [];
  const to = new Set<string>();
  let reason = "";
  for (const card of cards) {
    try {
      for (const address of await wakeHere(card.mac, cardAddress(card), here, send)) to.add(address);
      macs.push(card.mac);
    } catch (error) { reason = errorMessage(error); }
  }
  return macs.length ? { from: null, result: "sent", macs, to: [...to] } : { from: null, result: "failed", reason };
}

/** An error reaching the device or running the command there: refused, so a person must act, or no answer. */
function fault(name: string, error: unknown): Outcome {
  const message = errorMessage(error);
  if (error instanceof AuthError || /^Permission denied/.test(message)) return { from: name, result: "failed", reason: explainDenial(message, name), refused: true };
  return { from: name, result: "failed", reason: `unreachable (${message.replace(/\.$/, "")})`, next: `cns doctor ${name} shows how it is reached` };
}

/** Have paired device `name` send the packet, for each card, by its own cns wake --mac. */
async function fromDevice(name: string, sleeper: string, cards: readonly LanCard[], reach: Reach): Promise<Outcome> {
  let device: Device;
  try { device = await reach(name); } catch (error) { return fault(name, error); }
  try {
    const macs: string[] = [];
    let failure: Outcome | undefined;
    for (const card of cards) {
      const args = wakeArguments(card, device.shell);
      const result = await device.run(commandLine(device.shell, "cns", args), RUN_MS);
      if (result.code === 0) { macs.push(card.mac); continue; }
      if (/unknown command 'wake'|unknown option '--(mac|address)'/.test(result.stderr)) {
        return { from: name, result: "failed", reason: `${name} runs a cns from before cns wake`, next: `Run cns upgrade ${name}, then cns wake ${sleeper} again` };
      }
      failure = { from: name, result: "failed", reason: why(result, "cns"), next: `To see it there: cns run ${name} -- cns wake --mac ${card.mac} --address ${cardAddress(card)}` };
    }
    return macs.length ? { from: name, result: "sent", macs } : failure!;
  } catch (error) { return fault(name, error); }
  finally { device.close(); }
}

export interface WakeOptions { via?: string; mac?: string; address?: string }

/**
 * `cns wake DEVICE [--via PEER]`, or `cns wake --mac MAC [--address IP]` to send the packet from
 * this device, which is what each sender runs. Prints a line for each sender as soon as it is
 * known, and returns the exit status (wakeExitCode).
 */
export async function wake(name: string | undefined, options: WakeOptions, reach: Reach = reachDevice, here: () => LanCard[] = lanCards, send: SendPacket = sendMagicPacket): Promise<number> {
  if (options.mac !== undefined) {
    if (name !== undefined || options.via !== undefined) throw new Error("Name a paired device or give --mac, not both: cns wake DEVICE, or cns wake --mac MAC.");
    const mac = macAddress(options.mac);
    if (!mac) throw new Error(`${strictlyPrintable(options.mac)} is not a MAC address: write it as six pairs of hex digits, such as 3c:22:fb:12:34:56.`);
    if (options.address !== undefined && !IPV4_PATTERN.test(options.address)) throw new Error(`--address takes the card's IPv4 address, such as 192.168.1.23, not ${strictlyPrintable(options.address)}.`);
    const to = await wakeHere(mac, options.address, here(), send);
    console.log(`Sent a magic packet for ${mac} to ${to.join(", ")}, UDP port ${WAKE_PORT}.`);
    return 0;
  }
  if (options.address !== undefined) throw new Error("--address goes with --mac: cns wake --mac MAC --address IP.");
  if (name === undefined) throw new Error("Name the paired device to wake: cns wake DEVICE. For a machine cns does not know: cns wake --mac MAC.");
  // Refused as other commands refuse them: a device not saved here, or removed here (cns peer remove).
  resolvePeer(name);
  const sleeper = getPeer(name)!;
  if (options.via !== undefined) {
    resolvePeer(options.via);
    if (getPeer(options.via)!.publicKey === sleeper.publicKey) throw new Error(`${name} cannot wake itself. Name a device on its network: cns wake ${name} --via DEVICE.`);
  }
  const cards = here();
  const senders = planWake(sleeper, cards, reachablePeers(), options.via);
  const outcomes = await Promise.all(senders.map(async (sender) => {
    const outcome = sender.device === null ? await fromHere(sender.cards, cards, send) : await fromDevice(sender.device, name, sender.cards, reach);
    // As soon as it is known: a device that is slow to answer holds up only its own line.
    console.log(reportLine(name, outcome));
    return outcome;
  }));
  if (outcomes.some((outcome) => outcome.result === "sent")) console.error(`If Wake-on-LAN is on there, ${name} wakes within a minute or so; cns peers shows it online once its daemon has linked again.`);
  return wakeExitCode(outcomes);
}
