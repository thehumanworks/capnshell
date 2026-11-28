import { z } from "zod";
import { AuthError } from "../auth.js";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { errorMessage, printable } from "../errors.js";
import { fingerprint, loadIdentity, type Identity, type PublicKey } from "../identity.js";
import { listMeshes, nextList, signList, writeMesh, type MeshState } from "../mesh.js";
import { peerFileExists, peerNames, removePeerFile } from "../peer-files.js";
import { listPeers, revokedDevices, revokeDevice, savedKey, type PeerEntry } from "../peers.js";
import { heldSecrets } from "../secrets.js";
import { secureReady } from "../secure.js";
import type { RunResult } from "../shell.js";
import { plain } from "../terminal.js";
import { forgetAtGateway } from "./gateway.js";
import { settle } from "./mesh-cli.js";
import { unpair } from "./pairing-cli.js";

/**
 * `cns peer remove`: take a device's key out of this device, and with --everywhere out of every
 * place this device may change, with the authority it has already and through each place's own
 * checks (docs/adr/0010-removing-a-lost-device.md):
 *
 * - here: its key goes on this device's revoked list, so no mesh gives it a record here again,
 *   no list it signs is taken and no secret is sealed to it, until this device pairs with it
 *   directly; then its pairing goes. With `--meshes`, also its place in the meshes this device runs;
 * - the gateway CNS_GATEWAY names, when this device is one of its owners, as `cns gateway remove` would;
 * - each paired device that lets this one run commands: there it runs, as `cns run` would,
 *   `cns peer remove --fingerprint FP --meshes`, so that device's cns does the same there.
 *
 * Nothing goes further than that: a device reached here does not reach on, and no grant widens.
 */

export const OUTCOMES = ["removed", "would remove", "already gone", "not permitted", "not used", "unreachable", "failed"] as const;
export type Outcome = typeof OUTCOMES[number];
/** One place the device was looked for, and what became of it there. Every text in it is printable. */
export interface Place {
  /** The paired device it is about, or null for this device and the gateway. */
  device: string | null;
  place: string;
  outcome: Outcome;
  detail?: string;
  /** What to run next, when something is left to do: always built here, never taken from another device. */
  next?: string;
}

/** A fingerprint as `cns peers` shows it, and nothing else: it is the only text put on another device's command line. */
const FINGERPRINT = /^[a-z2-7]{4}(-[a-z2-7]{4}){5}$/;
/** The places removeHere reports, which are all of another device's answer that is shown. */
const PLACE = /^(its pairing|its meshes|mesh [a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/;
/** How long a device has to answer, and how long the command may run there. */
const DEVICE_MS = 30_000;
const RUN_MS = 20_000;

/** What a device answers, taken as data: at most a few places, in outcomes this cns knows. Its wording is not kept. */
const answerSchema = z.array(z.object({ place: z.string().regex(PLACE), outcome: z.enum(OUTCOMES), next: z.string().max(500).optional() })).max(20);

export interface RemoveOptions { fingerprint?: string; everywhere?: boolean; meshes?: boolean; dryRun?: boolean; json?: boolean; state?: string }

/** What each device runs, by its own cns. */
const commandFor = (fp: string) => `cns peer remove --fingerprint ${fp} --meshes`;

/** `cns peer remove NAME`: the pairing step of removeHere, reported in short. */
export async function removePeer(name: string, options: { state?: string }): Promise<void> {
  if (!peerFileExists(name)) throw new Error(`No paired device is saved as ${name}. cns peers shows them.`);
  const key = savedKey(name);
  // A damaged file that names no key: there is no device to keep out, so it only goes.
  if (key === undefined) { removePeerFile(name); console.log(`Removed ${name}.`); return; }
  const [pairing] = await removeHere(fingerprint(key), { state: options.state });
  if (pairing!.outcome === "failed") throw new Error(pairing!.detail);
  console.log([pairing!.outcome === "removed" ? `Removed ${name}.` : `${name} was not paired here any more.`, ...meshHints(name, key)].join("\n"));
}

/** For a plain removal: the meshes here that the removed device can still change, with what to run for each. */
function meshHints(name: string, key: PublicKey): string[] {
  let states: MeshState[];
  try { states = listMeshes(); } catch { return []; }
  const self = loadIdentity()?.publicKey;
  const everywhere = `cns peer remove --fingerprint ${fingerprint(key)} --everywhere`;
  return [
    ...states.filter((state) => state.admin === key).map((state) => `${name} runs the mesh ${state.name}, which this device is in. To shut it out of that too: cns mesh leave ${state.name}, or ${everywhere}.`),
    ...states.filter((state) => state.admin === self).flatMap((state) => state.list.members.filter((member) => member.key === key).map((member) => `${name} is still listed in the mesh ${state.name}, which this device runs. To take it out: cns mesh remove ${state.name} ${member.name}, or ${everywhere}.`)),
  ];
}

/**
 * `cns peer remove` with --fingerprint, --everywhere, --dry-run or --json. Returns the exit
 * status: 1 when a place was unreachable or failed, else 4 when one still needs something run there, else 0.
 */
export async function removeCommand(name: string | undefined, options: RemoveOptions): Promise<number> {
  const target = resolve(name, options.fingerprint);
  const command = commandFor(target.fingerprint);
  // Loaded, never made: a dry run changes nothing, and a device with no identity has paired with nothing.
  const identity = loadIdentity();
  const unreadable: Place[] = [];
  const peers = options.everywhere && identity ? listPeers((peer) => {
    const key = savedKey(peer);
    if (key === undefined || fingerprint(key) !== target.fingerprint) unreadable.push({ device: peer, place: "", outcome: "failed", detail: "this cns cannot read its record here, so it was not asked; cns peers says why", next: `On ${peer}, run: ${command}` });
  }).filter((peer) => peer.fingerprint !== target.fingerprint) : [];
  const places = await removeHere(target.fingerprint, { meshes: options.meshes || options.everywhere, dryRun: options.dryRun, state: options.state });
  if (options.everywhere) {
    await secureReady();
    const { fingerprint: gateway, ...atGateway } = await forgetAtGateway(target.fingerprint, !!options.dryRun);
    const reached = await Promise.all(peers.map((peer) => {
      const skipped = notAsked(peer, gateway, target.fingerprint);
      if (skipped) return Promise.resolve([skipped]);
      return onDevice(peer, target.fingerprint, identity!, !!options.dryRun).catch((error): Place[] => [
        { device: peer.name, place: "", outcome: "failed", detail: printable(errorMessage(error)), next: `Later, run: cns run ${peer.name} -- ${command}` },
      ]);
    }));
    places.push(...[...reached.flat(), ...unreadable].sort((a, b) => a.device!.localeCompare(b.device!)), { device: null, place: "the gateway", ...atGateway });
  }
  if (options.json) console.log(JSON.stringify(places, null, 2));
  else console.log(report(target, places, options));
  if (places.some((place) => place.outcome === "unreachable" || place.outcome === "failed")) return 1;
  return places.some((place) => place.next !== undefined) ? 4 : 0;
}

/** The saved record whose key has fingerprint `fp`, also one this cns cannot use. */
function savedRecord(fp: string): { name: string; publicKey: PublicKey } | undefined {
  for (const name of peerNames()) {
    const publicKey = savedKey(name);
    if (publicKey !== undefined && fingerprint(publicKey) === fp) return { name, publicKey };
  }
  return undefined;
}

/** The device named by `name` here, or by --fingerprint, which also names one removed here already or named otherwise. */
function resolve(name: string | undefined, given: string | undefined): { fingerprint: string; label: string } {
  if (given !== undefined) {
    if (!FINGERPRINT.test(given)) throw new Error(`${printable(given)} is not a fingerprint: those are six groups of four letters and digits, as cns peers shows them.`);
    return { fingerprint: given, label: savedRecord(given)?.name ?? given };
  }
  if (!peerFileExists(name!)) throw new Error(`No paired device is saved as ${name}. If it was removed here already, name it by its fingerprint, which cns peers on another of your devices shows: cns peer remove --fingerprint FINGERPRINT --everywhere.`);
  const key = savedKey(name!);
  if (key === undefined) throw new Error(`The file saved as ${name} names no device, so there is nothing to remove elsewhere. To remove it here, run: cns peer remove ${name}`);
  return { fingerprint: fingerprint(key), label: name! };
}

/**
 * Whether a paired device is the gateway, which runs no commands, so is not asked: its mesh record
 * says so, or the gateway answered with its fingerprint. When no gateway answered, a pairing as
 * the gateway's is, with no address and letting this device do nothing, counts too (worthDialing
 * in link-rules.ts uses the same sign); when one did, the gateway is known, and that is a device.
 */
export function gatewayLike(peer: Pick<PeerEntry, "fingerprint" | "addresses" | "grants" | "mesh" | "gateway">, gateway: string | undefined): boolean {
  if (peer.gateway === true || peer.fingerprint === gateway) return true;
  return gateway === undefined && peer.mesh === undefined && !peer.addresses.length && !peer.grants.outgoing.length;
}

/** The place for a paired device that is not asked, as it looks like the gateway; undefined for one to ask. */
function notAsked(peer: PeerEntry, gateway: string | undefined, fp: string): Place | undefined {
  if (!gatewayLike(peer, gateway)) return undefined;
  if (peer.gateway === true || peer.fingerprint === gateway) return { device: peer.name, place: "", outcome: "not used", detail: "it is the gateway, which runs no commands: see the gateway line" };
  // It may be a device after all, so what is left to do there counts.
  return { device: peer.name, place: "", outcome: "not used", detail: "it gave no address and lets this device do nothing, as the gateway does, so it was not asked: if it is the gateway, see the gateway line", next: `If ${peer.name} is one of your devices, run there: ${commandFor(fp)}` };
}

/**
 * Take the device with fingerprint `fp` out of this device: put it on the revoked list, so that no
 * mesh gives it a record here again and no list it signs is taken, until this device pairs with it
 * directly, and remove its pairing, direct or a mesh's (unpair). With `meshes`, also take it out of
 * the meshes this device runs, by a new member list it signs. A mesh another device runs still
 * lists it, as only that mesh's admin changes that list; one that `fp` runs is left to leave.
 */
export async function removeHere(fp: string, { meshes = false, dryRun = false, state }: { meshes?: boolean; dryRun?: boolean; state?: string }): Promise<Place[]> {
  const self = loadIdentity();
  if (fp === self?.fingerprint) throw new Error("That is this device's own fingerprint. Run this on another of your devices.");
  const is = (key: PublicKey) => fingerprint(key) === fp;
  const command = commandFor(fp);
  const here = (place: string, outcome: Outcome, detail?: string, next?: string): Place => ({ device: null, place, outcome, ...detail ? { detail } : {}, ...next ? { next } : {} });
  const places: Place[] = [];
  // Each place on its own: one that fails is reported, and the others go on.
  const attempt = async (place: string, work: () => Place[] | Promise<Place[]>) => {
    try { places.push(...await work()); }
    catch (error) { places.push(here(place, "failed", printable(errorMessage(error)), `Later, run: ${command}`)); }
  };

  await attempt("its pairing", async () => {
    const found = savedRecord(fp);
    const kept = revokedDevices().has(fp) ? undefined : `no mesh ${dryRun ? "would give" : "gives"} it a record here again, until this device pairs with it directly`;
    if (!dryRun) { if (found) await unpair(found.name, found.publicKey, state); else revokeDevice(fp); }
    return [here("its pairing", found ? dryRun ? "would remove" : "removed" : "already gone", kept)];
  });
  // A device with no identity runs no mesh and is in none.
  if (!meshes || !self) return places;

  let states: MeshState[] = [];
  await attempt("its meshes", () => { states = listMeshes(); return []; });
  for (const mesh of states.filter((each) => each.admin === self.publicKey && each.list.members.some((member) => is(member.key)))) {
    await attempt(`mesh ${mesh.name}`, () => {
      const list = nextList(mesh.list, (members) => members.filter((member) => !is(member.key)), Date.now());
      if (!dryRun) writeMesh({ ...mesh, signed: signList(list, self) });
      const secrets = heldSecrets(self.publicKey, [mesh]).some(({ record }) => record.value !== undefined) ? "; it keeps the mesh's secrets it read, so change them at their source" : "";
      return [here(`mesh ${mesh.name}`, dryRun ? "would remove" : "removed", `${dryRun ? "version" : "its list is now version"} ${list.version}, without it; members drop it when they get that list${secrets}`)];
    });
  }
  // A mesh it runs: this device takes no new list of it now (newerLists), but its members keep
  // what they may use here, and its secrets. Leaving is this device's person's call: it ends the
  // other members' records here too.
  for (const mesh of states.filter((each) => is(each.admin))) {
    places.push(here(`mesh ${mesh.name}`, "not permitted", "it runs this mesh, so this device takes no new list of it, but the members its last list names keep what members may use here, and the mesh's secrets", `To finish, leave it: cns mesh leave ${mesh.name}`));
  }
  // Records follow the lists at once, and the running daemon offers the new lists to linked devices.
  if (!dryRun) await attempt("its meshes", async () => { await settle({ state }, self.publicKey); return []; });
  return places;
}

/** Whether reaching a device failed because it refused this one: it no longer accepts it, or no longer lets it run commands. */
export function refused(error: unknown): boolean {
  return error instanceof AuthError || /^Permission denied/.test(errorMessage(error));
}

/**
 * What a device answered to its cns peer remove --json, taken as data: the place and outcome of
 * each place, with `left` for each that said something is left to do there. Its wording is not
 * kept: the report says it in this cns's words. Undefined when it is no answer this cns can read,
 * or when a dry run says it removed something.
 */
export function readAnswer(stdout: string, dryRun: boolean): Array<{ place: string; outcome: Outcome; left: boolean }> | undefined {
  let answer: z.infer<typeof answerSchema>;
  try { answer = answerSchema.parse(JSON.parse(stdout)); } catch { return undefined; }
  if (dryRun && answer.some((place) => place.outcome === "removed")) return undefined;
  return answer.map(({ place, outcome, next }) => ({ place, outcome, left: next !== undefined }));
}

/**
 * Have a paired device remove `fp` there, by running cns there as `cns run` would: only when it
 * lets this device run commands, and then within its own checks, as for any command. What it
 * answers is its report; what to run next is always built here.
 */
async function onDevice(peer: PeerEntry, fp: string, identity: Identity, dryRun: boolean): Promise<Place[]> {
  const command = commandFor(fp);
  const one = (outcome: Outcome, detail?: string, next?: string): Place[] => [{ device: peer.name, place: "", outcome, ...detail ? { detail } : {}, ...next ? { next } : {} }];
  const later = `Later, run: cns run ${peer.name} -- ${command}`;
  const see = `To see what is left there, run: cns run ${peer.name} -- ${command}`;
  const there = `On ${peer.name}, run: ${command}`;
  const refusal = (error: unknown) => one("not permitted", error instanceof AuthError ? `${peer.name} does not accept this device` : `${peer.name} does not let this device run commands`, there);
  if (!peer.grants.outgoing.includes("shell")) return refusal(undefined);
  const signal = AbortSignal.timeout(DEVICE_MS);
  const timedOut = () => one("unreachable", `no answer within ${DEVICE_MS / 1000} seconds, so it may be gone there already`, later);
  let link: DeviceLink;
  try { link = await openDeviceLink(peer, identity, signal); }
  catch (error) {
    if (signal.aborted) return timedOut();
    if (refused(error)) return refusal(error);
    return one("unreachable", printable(errorMessage(error)), later);
  }
  const close = () => { link.remote[Symbol.dispose](); link.close("Removal ended"); };
  signal.addEventListener("abort", close, { once: true });
  let result: RunResult;
  try { result = await plain(link.remote.run(`${command} --json${dryRun ? " --dry-run" : ""}`, { timeoutMs: RUN_MS })); }
  catch (error) {
    if (signal.aborted) return timedOut();
    if (refused(error)) return refusal(error);
    // An error the device sent: quoted, as its words, not this cns's.
    return one("failed", `${peer.name} said: "${printable(errorMessage(error)).slice(0, 300)}"`, later);
  } finally { signal.removeEventListener("abort", close); close(); }
  if (result.timedOut) return one("unreachable", `it did not finish there within ${RUN_MS / 1000} seconds`, later);
  if (/unknown option '--(fingerprint|meshes|json|dry-run)'/.test(result.stderr)) {
    return one("failed", `${peer.name} runs a cns from before this`, `Upgrade cns on ${peer.name}, then run: cns run ${peer.name} -- ${command}`);
  }
  const answer = readAnswer(result.stdout, dryRun);
  if (!answer) {
    const said = printable((result.stderr || result.stdout).trim()).slice(0, 300);
    return one("failed", said ? `${peer.name} said: "${said}"` : `${peer.name} answered nothing this cns can read (exit status ${result.exitCode})`, see);
  }
  const done = answer.filter((place) => place.outcome !== "already gone");
  if (!done.length) return one("already gone");
  return done.map(({ place, outcome, left }) => {
    const next = outcome === "failed" ? later : left || outcome === "not permitted" ? see : undefined;
    return { device: peer.name, place, outcome, ...next ? { next } : {} };
  });
}

/** The report a person reads: one line per place, outcome first. */
function report(target: { fingerprint: string; label: string }, places: readonly Place[], options: RemoveOptions): string {
  const what = options.everywhere ? "everywhere this device may" : "here";
  const head = options.dryRun ? `Dry run, nothing changed. Removing ${target.label} (fingerprint ${target.fingerprint}) ${what} would do this:` : `Removing ${target.label} (fingerprint ${target.fingerprint}) ${what}:`;
  const sentence = (text: string) => printable(text).replace(/\.$/, "");
  return [head, ...places.map((place) => {
    const where = place.device === null ? (place.place === "the gateway" ? place.place : `this device: ${place.place}`) : [place.device, place.place].filter(Boolean).join(": ");
    return `  ${place.outcome.padEnd(13)}  ${printable(where)}${place.detail ? `: ${sentence(place.detail)}` : ""}${place.next ? `. ${sentence(place.next)}.` : ""}`;
  })].join("\n");
}
