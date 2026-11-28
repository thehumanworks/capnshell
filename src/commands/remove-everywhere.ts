import { z } from "zod";
import { AuthError } from "../auth.js";
import { openDeviceLink } from "../device-link.js";
import { errorMessage, printable, printableJson } from "../errors.js";
import { fingerprint, loadIdentity, type Identity, type PublicKey } from "../identity.js";
import { listMeshes, nextList, signList, writeMesh, type MeshState } from "../mesh.js";
import { peerFileExists, peerNames, removePeerFile } from "../peer-files.js";
import { describeGrants, grantWords, listPeers, revokedDevices, revokeDevice, savedKey, type PeerEntry } from "../peers.js";
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
 * - here: its pairing, and its key goes on this device's revoked list, so no mesh gives it a
 *   record here again until this device pairs with it directly; with `--meshes`, also its place
 *   in the meshes this device runs, and the access of members of the meshes it runs;
 * - the gateway CNS_GATEWAY names, when this device is one of its owners, as `cns gateway remove` would;
 * - each paired device that lets this one run commands: there it runs, as `cns run` would,
 *   `cns peer remove --fingerprint FP --meshes`, so that device's cns does the same there.
 *
 * Nothing goes further than that: a device reached here does not reach on, and no grant widens.
 */

export const OUTCOMES = ["removed", "would remove", "narrowed", "would narrow", "already gone", "not permitted", "not used", "unreachable", "failed"] as const;
export type Outcome = typeof OUTCOMES[number];
/** One place the device was looked for, and what became of it there. */
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
/** How long a device has to answer, and how long the command may run there. */
const DEVICE_MS = 30_000;
const RUN_MS = 20_000;

/** What a device answers, taken as data: at most a few short places, in outcomes this cns knows. */
const answerSchema = z.array(z.object({
  place: z.string().max(100), outcome: z.enum(OUTCOMES), detail: z.string().max(1000).optional(), next: z.string().max(500).optional(),
})).max(20);

export interface RemoveOptions { fingerprint?: string; everywhere?: boolean; meshes?: boolean; dryRun?: boolean; json?: boolean; state?: string }

/** What each device runs, by its own cns. */
const commandFor = (fp: string) => `cns peer remove --fingerprint ${fp} --meshes`;

/**
 * `cns peer remove NAME`, and `cns mesh remove --unpair` for each device it unpairs: the pairing
 * step of removeHere, reported in short. `expectedKey` is the device's key when the caller chose
 * it by key, so that a different device now saved as `name` is not removed.
 */
export async function removePeer(name: string, options: { state?: string }, expectedKey?: PublicKey): Promise<void> {
  if (!peerFileExists(name)) throw new Error(`No paired device is saved as ${name}. cns peers shows them.`);
  const key = expectedKey ?? savedKey(name);
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
  // Loaded, never made: a dry run changes nothing, and a device with no identity has paired with nothing.
  const identity = loadIdentity();
  const peers = options.everywhere && identity ? listPeers(() => {}).filter((peer) => peer.fingerprint !== target.fingerprint) : [];
  const places = await removeHere(target.fingerprint, { meshes: options.meshes || options.everywhere, dryRun: options.dryRun, state: options.state });
  if (options.everywhere) {
    await secureReady();
    const { fingerprint: gateway, ...atGateway } = await forgetAtGateway(target.fingerprint, !!options.dryRun);
    const reached = await Promise.all(peers.map((peer) => gatewayLike(peer, gateway)
      ? Promise.resolve<Place[]>([{ device: peer.name, place: "", outcome: "not used", detail: notAsked(peer, gateway, target.fingerprint) }])
      : onDevice(peer, target.fingerprint, identity!, !!options.dryRun).catch((error): Place[] => [
        { device: peer.name, place: "", outcome: "failed", detail: printable(errorMessage(error)), next: `Later, run: cns run ${peer.name} -- ${commandFor(target.fingerprint)}` },
      ])));
    places.push(...reached.flat(), { device: null, place: "the gateway", ...atGateway });
  }
  if (options.json) console.log(printableJson(places));
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
 * says so, the gateway answered with its fingerprint, or, as the gateway's pairing does, it gave
 * no address and lets this device do nothing (worthDialing in link-rules.ts uses the same sign).
 */
export function gatewayLike(peer: Pick<PeerEntry, "fingerprint" | "addresses" | "grants" | "mesh" | "gateway">, gateway: string | undefined): boolean {
  return peer.gateway === true || peer.fingerprint === gateway || (peer.mesh === undefined && !peer.addresses.length && !peer.grants.outgoing.length);
}

function notAsked(peer: PeerEntry, gateway: string | undefined, fp: string): string {
  if (peer.gateway === true || peer.fingerprint === gateway) return "it is the gateway, which runs no commands: see the gateway line";
  return `it gave no address and lets this device do nothing, as the gateway does, so it was not asked: see the gateway line. If it is one of your devices, run there: ${commandFor(fp)}`;
}

/**
 * Take the device with fingerprint `fp` out of this device: put it on the revoked list, so that no
 * mesh gives it a record here again until this device pairs with it directly, then remove its
 * pairing, direct or a mesh's. With `meshes`, also take it out of the meshes this device runs, by
 * a new member list it signs, and let members of the meshes `fp` runs use nothing here. A mesh
 * another device runs still lists it, as only that mesh's admin changes that list.
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
    catch (error) { places.push(here(place, "failed", errorMessage(error), `Later, run: ${command}`)); }
  };

  await attempt("its pairing", async () => {
    const found = savedRecord(fp);
    const kept = revokedDevices().has(fp) ? undefined : `no mesh ${dryRun ? "would give" : "gives"} it a record here again, until this device pairs with it directly`;
    // Revoked first, so that no mesh list arriving meanwhile gives it a record once its pairing is gone.
    if (!dryRun) revokeDevice(fp, found?.publicKey);
    if (!found) return [here("its pairing", "already gone", kept)];
    if (!dryRun) await unpair(found.name, found.publicKey, state);
    return [here("its pairing", dryRun ? "would remove" : "removed", kept)];
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
  // A mesh it runs: whoever has its key can list any device there, so members get nothing here.
  // Leaving is this device's person's call: it ends the other members' records here too.
  for (const mesh of states.filter((each) => is(each.admin))) {
    await attempt(`mesh ${mesh.name}`, () => {
      const leave = `To finish, leave it: cns mesh leave ${mesh.name}`;
      const why = "it runs this mesh, so whoever has its key can add any device to it, and the mesh's secrets still go to every member it lists, so narrowing is not enough";
      if (!mesh.allow.length) return [here(`mesh ${mesh.name}`, "not permitted", `${why}; members may use nothing here already`, leave)];
      if (!dryRun) writeMesh({ ...mesh, allow: [] });
      return [here(`mesh ${mesh.name}`, dryRun ? "would narrow" : "narrowed", `members ${dryRun ? "would" : "may"} use nothing here, not ${describeGrants(mesh.allow)}; ${why}`, `${leave}. To undo the narrowing: cns mesh allow ${mesh.name} ${grantWords(mesh.allow)}`)];
    });
  }
  // Records follow the lists and grants at once, and the running daemon offers the new lists to linked devices.
  if (!dryRun) await attempt("its meshes", async () => { await settle({ state }, self.publicKey); return []; });
  return places;
}

/** Whether reaching a device failed because it refused this one: it no longer accepts it, or no longer lets it run commands. */
export function refused(error: unknown): boolean {
  return error instanceof AuthError || /^Permission denied/.test(errorMessage(error));
}

/**
 * What a device answered to its cns peer remove --json, taken as data: its places, made printable,
 * with `left` for each that said something is left to do there; undefined when it is no answer
 * this cns can read, or when a dry run says it changed something.
 */
export function readAnswer(stdout: string, dryRun: boolean): Array<{ place: string; outcome: Outcome; detail?: string; left: boolean }> | undefined {
  let answer: z.infer<typeof answerSchema>;
  try { answer = answerSchema.parse(JSON.parse(stdout)); } catch { return undefined; }
  if (dryRun && answer.some((place) => place.outcome === "removed" || place.outcome === "narrowed")) return undefined;
  return answer.map(({ place, outcome, detail, next }) => ({ place: printable(place), outcome, ...detail === undefined ? {} : { detail: printable(detail) }, left: next !== undefined }));
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
  if (!peer.grants.outgoing.includes("shell")) return one("not permitted", `${peer.name} does not let this device run commands`, `On ${peer.name}, run: ${command}`);
  const signal = AbortSignal.timeout(DEVICE_MS);
  let result: RunResult;
  try {
    const link = await openDeviceLink(peer, identity, signal);
    const close = () => { link.remote[Symbol.dispose](); link.close("Removal ended"); };
    signal.addEventListener("abort", close, { once: true });
    try { result = await plain(link.remote.run(`${command} --json${dryRun ? " --dry-run" : ""}`, { timeoutMs: RUN_MS })); }
    finally { signal.removeEventListener("abort", close); close(); }
  } catch (error) {
    if (signal.aborted) return one("unreachable", `no answer within ${DEVICE_MS / 1000} seconds, so it may be gone there already`, later);
    if (refused(error)) return one("not permitted", printable(errorMessage(error)), `On ${peer.name}, run: ${command}`);
    return one("unreachable", printable(errorMessage(error)), later);
  }
  if (result.timedOut) return one("unreachable", `it did not finish there within ${RUN_MS / 1000} seconds`, later);
  const said = printable((result.stderr || result.stdout).trim()).slice(0, 300) || `exit status ${result.exitCode}`;
  if (/unknown option '--(fingerprint|meshes|json|dry-run)'/.test(result.stderr)) {
    return one("failed", `${peer.name} runs a cns from before this: ${said}`, `Upgrade cns on ${peer.name}, then run: cns run ${peer.name} -- ${command}`);
  }
  const answer = readAnswer(result.stdout, dryRun);
  if (!answer) return one("failed", `${peer.name} answered: ${said}`, see);
  const done = answer.filter((place) => place.outcome !== "already gone");
  if (!done.length) return one("already gone");
  return done.map(({ place, outcome, detail, left }) => {
    const next = outcome === "failed" ? later : left || outcome === "not permitted" ? see : undefined;
    return { device: peer.name, place, outcome, ...detail ? { detail } : {}, ...next ? { next } : {} };
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
