import { z } from "zod";
import { AuthError } from "../auth.js";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { errorMessage, strictlyPrintable } from "../errors.js";
import { fingerprint, loadIdentity, type Identity, type PublicKey } from "../identity.js";
import { listMeshes, nextList, signList, writeMesh, type MeshState } from "../mesh.js";
import { peerFileExists, peerNames, removePeerFile } from "../peer-files.js";
import { describeGrants, grantWords, listPeers, revokedDevices, revokeDevice, savedKey, type PeerEntry } from "../peers.js";
import { heldSecrets } from "../secrets.js";
import { secureReady } from "../secure.js";
import type { RunResult } from "../shell.js";
import { plain } from "../terminal.js";
import { call, GatewayError, gatewayUrl, type GatewayOptions, type GatewayStatus } from "./gateway.js";
import { adminName, settle } from "./mesh-cli.js";
import { unpair } from "./pairing-cli.js";

/**
 * `cns peer remove`: take a device's key out of this device, and with --everywhere out of every
 * place this device may change, with the authority it has already and through each place's own
 * checks (docs/adr/0010-removing-a-lost-device.md):
 *
 * - here: its key goes on this device's revoked list, so no mesh gives it a record here again,
 *   no list it signs is taken, no secret is sealed to it and the daemon lets no record of it in,
 *   until this device pairs with it directly; then its pairing goes, and a mesh it runs is
 *   narrowed: its members may use nothing here. With `--meshes`, it also leaves the meshes this
 *   device runs;
 * - the gateway CNS_GATEWAY names, when this device is one of its owners, as `cns gateway remove` would;
 * - each paired device that lets this one run commands: there it runs, as `cns run` would,
 *   `cns peer remove --fingerprint FP --meshes`, so that device's cns does the same there.
 *
 * Nothing goes further than that: a device reached here does not reach on, and no grant widens.
 */

export const OUTCOMES = ["removed", "would remove", "narrowed", "would narrow", "already gone", "not permitted", "not used", "unreachable", "failed"] as const;
export type Outcome = typeof OUTCOMES[number];
/** One place the device was looked for, and what became of it there. Every text in it is strictlyPrintable. */
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
/** The places removeHere reports, which are all of another device's answer that is used; a mesh name in one is safe on a command line. */
const PLACE = /^(its pairing|its meshes|mesh [a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/;
/** How long a device has to answer, and how long the command may run there. */
const DEVICE_MS = 30_000;
const RUN_MS = 20_000;

/** What a device answers, taken as data: at most a few places, in outcomes this cns knows. Nothing else in it is kept. */
const answerSchema = z.array(z.object({ place: z.string().regex(PLACE), outcome: z.enum(OUTCOMES) })).max(20);

export interface RemoveOptions { fingerprint?: string; everywhere?: boolean; meshes?: boolean; dryRun?: boolean; json?: boolean; state?: string }

/** What each device runs, by its own cns. */
const commandFor = (fp: string) => `cns peer remove --fingerprint ${fp} --meshes`;

/** `a`, `a and b`, `a, b and c`. */
const and = (names: readonly string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
/** A text as a clause of a longer sentence: without its full stop. */
const clause = (text: string) => text.replace(/\.$/, "");
/** The parts given, as one detail; undefined when there are none. */
const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join("; ") || undefined;
/** What is said of a key read from a file that is not private or is a link: whoever may write it, or where it links, chose that key. */
const looselyRead = (name: string, fp: string) => `The file saved as ${name} is not a private file, or is a link, so the key in it was read anyway: fingerprint ${fp}.`;

/** `cns peer remove NAME`: removeHere, reported in short, with what the device may still change here. */
export async function removePeer(name: string, options: { state?: string }): Promise<void> {
  if (!peerFileExists(name)) throw new Error(`No paired device is saved as ${name}. cns peers shows them.`);
  const key = savedKey(name);
  // A damaged file that names no key: there is no device to keep out, so it only goes.
  if (key === undefined) { removePeerFile(name); console.log(`Removed ${name}. It named no device, so nothing was put on the revoked list.`); return; }
  const fp = fingerprint(key.publicKey);
  const records = recordsWithKey(fp).map((record) => record.name);
  const [pairing, ...rest] = await removeHere(fp, { state: options.state });
  // Each record that went, by name: another one may name the same device.
  const gone = records.filter((record) => !peerFileExists(record));
  console.log([
    ...key.loose ? [looselyRead(name, fp)] : [],
    pairing!.outcome === "failed" ? `Could not finish removing ${name} here: ${clause(pairing!.detail!)}. ${pairing!.next}.`
      : gone.length > 1 ? `Removed ${and(gone)}, which name the same device.` : gone.length ? `Removed ${gone[0]}.` : `${name} was not paired here any more.`,
    ...hints(name, key.publicKey, rest),
  ].join("\n"));
  if ([pairing!, ...rest].some((place) => place.outcome === "failed")) process.exitCode = 1;
}

/**
 * For a plain removal: what became of the meshes the device runs here, what did not finish, and
 * the meshes here that still list it, which give it no record here now, with what to run for each.
 */
function hints(name: string, key: PublicKey, places: readonly Place[]): string[] {
  let states: MeshState[] = [];
  try { states = listMeshes(); } catch { /* A place that failed says so. */ }
  const self = loadIdentity()?.publicKey;
  return [
    ...places.map((place) => {
      if (place.outcome === "failed") return `Not finished here: ${clause(place.detail!)}. ${place.next}.`;
      const mesh = states.find((state) => state.name === place.place.slice("mesh ".length));
      const secrets = mesh && self && holdsSecrets(self, mesh) ? " The secrets held from it here may have been set by such a device, and leaving the mesh drops them." : "";
      return `${name} runs the mesh ${place.place.slice("mesh ".length)}, which this device is in. It stays at its last list here${mesh ? `, version ${mesh.list.version}` : ""}, which whoever has ${name}'s key may have added devices to, so its members may ${place.outcome === "narrowed" ? "now " : ""}use nothing here.${secrets} ${place.next}.`;
    }),
    ...states.filter((state) => state.admin !== key).flatMap((state) => state.list.members.filter((member) => member.key === key).map((member) => state.admin === self
      ? `${name} is still listed in the mesh ${state.name}, which this device runs. To take it out: cns mesh remove ${state.name} ${member.name}, or cns peer remove --fingerprint ${fingerprint(key)} --everywhere.`
      : `${name} is listed in the mesh ${state.name}, which ${adminName(state)} runs; it gets no record here from that mesh until this device pairs with it directly.`)),
  ];
}

/**
 * `cns peer remove` with --fingerprint, --everywhere, --dry-run or --json. Returns the exit
 * status: 1 when a place was unreachable or failed, else 4 when one still needs something run there, else 0.
 */
export async function removeCommand(name: string | undefined, options: RemoveOptions): Promise<number> {
  const target = resolve(name, options.fingerprint, !!options.everywhere);
  const command = commandFor(target.fingerprint);
  // Loaded, never made: a dry run changes nothing, and a device with no identity has paired with nothing.
  const identity = loadIdentity();
  const unreadable: Place[] = [];
  const peers = options.everywhere && identity ? listPeers((peer) => {
    const key = savedKey(peer);
    if (key === undefined || fingerprint(key.publicKey) !== target.fingerprint) unreadable.push({ device: peer, place: "", outcome: "failed", detail: "this cns cannot read its record here, so it was not asked; cns peers says why", next: `On ${peer}, run: ${command}` });
  }).filter((peer) => peer.fingerprint !== target.fingerprint) : [];
  const places = await removeHere(target.fingerprint, { meshes: options.meshes || options.everywhere, dryRun: options.dryRun, state: options.state });
  if (options.everywhere) {
    await secureReady();
    const { fingerprint: gateway, ...atGateway } = await forgetAtGateway(target.fingerprint, !!options.dryRun);
    const reached = await Promise.all(peers.map((peer) => {
      const skipped = gatewayPlace(peer, gateway, target.fingerprint);
      if (skipped) return Promise.resolve([skipped]);
      return onDevice(peer, target.fingerprint, identity!, !!options.dryRun).catch((error): Place[] => [
        { device: peer.name, place: "", outcome: "failed", detail: strictlyPrintable(errorMessage(error)), next: `Later, run: cns run ${peer.name} -- ${command}` },
      ]);
    }));
    places.push(...[...reached.flat(), ...unreadable].sort((a, b) => a.device!.localeCompare(b.device!)), { device: null, place: "the gateway", ...atGateway });
  }
  // Text from elsewhere is strictlyPrintable where its place is made, so --json carries no line separator either.
  if (options.json) console.log(JSON.stringify(places, null, 2));
  else console.log(report(target, places, options));
  if (places.some((place) => place.outcome === "unreachable" || place.outcome === "failed")) return 1;
  return places.some((place) => place.next !== undefined) ? 4 : 0;
}

/**
 * The saved records whose key has fingerprint `fp`, also those this cns cannot use (savedKey).
 * Those read loosely come first, so that a link goes before the record it points to, and still
 * names its key when it goes.
 */
function recordsWithKey(fp: string): Array<{ name: string; publicKey: PublicKey; loose: boolean }> {
  return peerNames().flatMap((name) => {
    const key = savedKey(name);
    return key !== undefined && fingerprint(key.publicKey) === fp ? [{ name, ...key }] : [];
  }).sort((a, b) => Number(b.loose) - Number(a.loose));
}

/**
 * The device named by `name` here, or by --fingerprint, which also names one removed here already
 * or named otherwise. A key read from a file that is not private, or is a link, is removed
 * everywhere only when --fingerprint names it: whoever may write that file chose it.
 */
function resolve(name: string | undefined, given: string | undefined, everywhere: boolean): { fingerprint: string; label: string } {
  if (given !== undefined) {
    if (!FINGERPRINT.test(given)) throw new Error(`${strictlyPrintable(given)} is not a fingerprint: those are six groups of four letters and digits, as cns peers shows them.`);
    const records = recordsWithKey(given);
    return { fingerprint: given, label: (records.find((record) => !record.loose) ?? records[0])?.name ?? given };
  }
  if (!peerFileExists(name!)) throw new Error(`No paired device is saved as ${name}. If it was removed here already, name it by its fingerprint, which cns peers on another of your devices shows: cns peer remove --fingerprint FINGERPRINT --everywhere.`);
  const key = savedKey(name!);
  if (key === undefined) throw new Error(`The file saved as ${name} names no device, so there is nothing to remove elsewhere. To remove it here, run: cns peer remove ${name}`);
  const fp = fingerprint(key.publicKey);
  if (key.loose && everywhere) throw new Error(`${looselyRead(name!, fp)} A key read that way is not removed everywhere by name. If it is the lost device's, as cns peers on another of your devices shows, run: cns peer remove --fingerprint ${fp} --everywhere`);
  return { fingerprint: fp, label: name! };
}

/**
 * The place for a paired device that is not asked, as it is the gateway, which runs no commands,
 * or looks like one; undefined for a device to ask. Its mesh record says it is the gateway, or the
 * gateway answered with its fingerprint. A pairing as the gateway's is, with no address and
 * letting this device do nothing, looks like one (worthDialing in link-rules.ts uses the same sign).
 */
export function gatewayPlace(peer: Pick<PeerEntry, "name" | "fingerprint" | "addresses" | "grants" | "mesh" | "gateway">, gateway: string | undefined, fp: string): Place | undefined {
  const skipped = (detail: string, next?: string): Place => ({ device: peer.name, place: "", outcome: "not used", detail, ...next ? { next } : {} });
  if (peer.gateway === true || peer.fingerprint === gateway) return skipped("it is the gateway, which runs no commands: see the gateway line");
  if (peer.mesh !== undefined || peer.addresses.length || peer.grants.outgoing.length) return undefined;
  const there = `run there: ${commandFor(fp)}`;
  // While no gateway answered it may be the gateway, which CNS_GATEWAY then finds, or a device, so what is left to do there counts.
  if (gateway === undefined) return skipped("it gave no address and lets this device do nothing, as the gateway does, so it was not asked: if it is the gateway, see the gateway line", `If ${peer.name} is one of your devices, ${there}`);
  // Another gateway, or a device that only dials this one: neither could ever be asked, so nothing run later would clear it.
  return skipped(`it gave no address and lets this device do nothing, as a gateway does, but it is not the gateway CNS_GATEWAY names, so it was not asked: if it is another gateway, run this again with CNS_GATEWAY set to its address; if it is one of your devices, ${there}`);
}

/**
 * Take the device with fingerprint `fp` out of this device: put it on the revoked list, so that no
 * mesh gives it a record here again, no list it signs is taken and the daemon lets no record of it
 * in, until this device pairs with it directly, and remove its pairings, direct or a mesh's
 * (unpair). A mesh it runs stays at its last list, which may name devices whoever has its key
 * added, so this device narrows it: its members may use nothing here (cns mesh allow undoes that,
 * once cns mesh list shows no device the person does not know).
 * With `meshes`, also take it out of the meshes this device runs, by a new member list it signs. A
 * mesh another device runs still lists it, as only that mesh's admin changes that list.
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
    catch (error) { places.push(here(place, "failed", strictlyPrintable(errorMessage(error)), `Later, run: ${command}`)); }
  };

  await attempt("its pairing", async () => {
    const found = recordsWithKey(fp);
    const kept = revokedDevices().has(fp) ? undefined : `no mesh ${dryRun ? "would give" : "gives"} it a record here again, until this device pairs with it directly`;
    if (!found.length) {
      if (!dryRun) revokeDevice(fp);
      return [here("its pairing", "already gone", kept)];
    }
    // Each record by name, as another one may name the same device.
    const saved = `saved here as ${and(found.map(({ name, loose }) => loose ? `${name} (not a private file, or a link, so its key was read anyway)` : name))}`;
    if (dryRun) return [here("its pairing", "would remove", join(saved, kept))];
    for (const { name, publicKey } of found) {
      try { await unpair(name, publicKey, state); }
      catch (error) {
        // What went before this one is said too: its key is on the revoked list then.
        let gone: string[] = [];
        try { gone = found.filter((record) => !peerFileExists(record.name)).map((record) => record.name); } catch { /* The error says why. */ }
        const went = gone.length ? `${and(gone)} ${gone.length === 1 ? "was" : "were"} removed, and its key is on the revoked list` : undefined;
        return [here("its pairing", "failed", join(went, clause(strictlyPrintable(errorMessage(error)))), `Later, run: ${command}`)];
      }
    }
    return [here("its pairing", "removed", join(saved, kept))];
  });
  // A device with no identity runs no mesh and is in none.
  if (!self) return places;

  let states: MeshState[] | undefined;
  await attempt("its meshes", () => { states = listMeshes(); return []; });
  for (const mesh of meshes ? (states ?? []).filter((each) => each.admin === self.publicKey && each.list.members.some((member) => is(member.key))) : []) {
    await attempt(`mesh ${mesh.name}`, () => {
      const list = nextList(mesh.list, (members) => members.filter((member) => !is(member.key)), Date.now());
      if (!dryRun) writeMesh({ ...mesh, signed: signList(list, self) });
      const secrets = holdsSecrets(self.publicKey, mesh) ? "; it keeps the mesh's secrets it read, so change them at their source" : "";
      return [here(`mesh ${mesh.name}`, dryRun ? "would remove" : "removed", `${dryRun ? "version" : "its list is now version"} ${list.version}, without it; members drop it when they get that list${secrets}`)];
    });
  }
  // A mesh it runs: this device takes no new list of it (newerLists), and none of its secrets go
  // to its members (secretsFor). Leaving is this device's person's call: it ends the other
  // members' records here too.
  for (const mesh of (states ?? []).filter((each) => is(each.admin))) {
    await attempt(`mesh ${mesh.name}`, () => {
      const at = `mesh ${mesh.name}`;
      const leave = `To finish, leave it: cns mesh leave ${mesh.name}`;
      const kept = `it runs this mesh, which ${dryRun ? "would stay" : "stays"} at version ${mesh.list.version} here, as this device ${dryRun ? "would take" : "takes"} no new list of it; that list may name devices whoever has its key added`;
      // Secrets this device took before: such a device may have set them, and only leaving drops them.
      const secrets = holdsSecrets(self.publicKey, mesh) ? `; the secrets held from it here may have been set by such a device, and cns mesh leave ${mesh.name} drops them` : "";
      const bots = "; a bot started from one of its tokens lets it in until it is removed there too";
      if (!mesh.allow.length) return [here(at, "not permitted", `${kept}, so its members may use nothing here${secrets}${bots}`, leave)];
      const before = describeGrants(mesh.allow);
      if (dryRun) return [here(at, "would narrow", `${kept}, so its members would use nothing here (they may use ${before} now)${secrets}${bots}`, leave)];
      writeMesh({ ...mesh, allow: [] });
      return [here(at, "narrowed", `${kept}, so its members may now use nothing here (they could use ${before}), and get none of its secrets from here${secrets}${bots}`,
        `${leave}. To let its members use ${before} here again, only once cns mesh list ${mesh.name} shows no device you do not know: cns mesh allow ${mesh.name} ${grantWords(mesh.allow)}`)];
    });
  }
  // Records follow the lists and the revoked list at once, also those a running daemon made while
  // this ran, and the daemon offers the new lists to linked devices. Not when the meshes could
  // not be read, which is said already.
  if (!dryRun && states) await attempt("its meshes", async () => { await settle({ state }, self.publicKey); return []; });
  return places;
}

/** Whether this device holds secrets of `mesh` that still have a value. */
function holdsSecrets(self: PublicKey, mesh: MeshState): boolean {
  return heldSecrets(self, [mesh]).some(({ record }) => record.value !== undefined);
}

/**
 * For `cns peer remove --everywhere`: make the gateway forget the device with fingerprint `fp`, as
 * `cns gateway remove` does, so no connector reaches it; `fingerprint` is the gateway's own, when it
 * answered. Only a gateway CNS_GATEWAY names is asked, so a device that uses none sends nothing
 * anywhere. Only an owner's request is taken: the gateway checks this device's signature against
 * its OWNER_KEYS, as for every owner command.
 */
export async function forgetAtGateway(fp: string, dryRun: boolean): Promise<Pick<Place, "outcome" | "detail" | "next"> & { fingerprint?: string }> {
  // OWNER_KEYS is a Cloudflare secret, so no device changes it. An owner the gateway never paired
  // with can still approve connectors, so this is said whatever the gateway answered.
  const owners = "; if it was one of the gateway's owners too, it can still approve connectors until its key is out of OWNER_KEYS (cd gateway && npx wrangler secret put OWNER_KEYS); cns gateway grants lists the connectors, and cns gateway revoke ID stops one";
  // Text the gateway sent, such as a device's name or an error, is made strictlyPrintable here.
  const place = (outcome: Outcome, detail: string, more: { next?: string; fingerprint?: string } = {}) => ({ outcome, detail: `${clause(strictlyPrintable(detail))}${owners}`, ...more });
  if (!process.env.CNS_GATEWAY) return place("not used", `CNS_GATEWAY is not set here, so no gateway was asked. If this device owns a gateway, run: cns gateway status, then cns gateway remove NAME (fingerprint ${fp})`);
  const options: GatewayOptions = {};
  const later = `Later, run: cns peer remove --fingerprint ${fp} --everywhere`;
  try {
    const signal = AbortSignal.timeout(15_000);
    const status = await call<GatewayStatus>(options, "status", {}, signal);
    const url = gatewayUrl(options);
    const device = status.devices.find((candidate) => candidate.fingerprint === fp);
    const gateway = { fingerprint: status.fingerprint };
    if (!device) return place("already gone", `${url} has no device with this fingerprint`, gateway);
    if (dryRun) return place("would remove", `${url} has it as ${device.name}`, gateway);
    await call(options, "remove", { name: device.name }, signal);
    return place("removed", `${url} had it as ${device.name}; no connector reaches it now`, gateway);
  } catch (error) {
    if (error instanceof GatewayError && error.status === undefined) return place("unreachable", errorMessage(error), { next: later });
    // The gateway's own words, quoted, so that none reads as this cns's advice.
    const detail = !(error instanceof GatewayError) ? errorMessage(error)
      : `The gateway answered ${error.status}${error.said === undefined ? "" : ` and said: ${JSON.stringify(error.said)}`}${error.status === 401 ? `; this device's public key is ${loadIdentity()?.publicKey}` : ""}`;
    if (error instanceof GatewayError && (error.status === 401 || error.status === 503)) {
      return place("not permitted", detail, { next: "Run this on one of the gateway's owners, with CNS_GATEWAY set to its address" });
    }
    return place("failed", detail, { next: later });
  }
}

/** Whether reaching a device failed because it refused this one: it no longer accepts it, or no longer lets it run commands. */
export function refused(error: unknown): boolean {
  return error instanceof AuthError || /^Permission denied/.test(errorMessage(error));
}

/**
 * What a device answered to its cns peer remove --json, taken as data: the place and outcome of
 * each place, and nothing else. Undefined when it is no answer this cns can read, or when a dry
 * run says it changed something.
 */
export function readAnswer(stdout: string, dryRun: boolean): Array<{ place: string; outcome: Outcome }> | undefined {
  let answer: z.infer<typeof answerSchema>;
  try { answer = answerSchema.parse(JSON.parse(stdout)); } catch { return undefined; }
  if (dryRun && answer.some(({ outcome }) => outcome === "removed" || outcome === "narrowed")) return undefined;
  return answer;
}

/**
 * The places for what device `name` answered, in this cns's words: what to run next is built here
 * from each place and outcome alone, with the mesh name PLACE checked as the only text from there.
 */
export function answerPlaces(name: string, fp: string, answer: ReadonlyArray<{ place: string; outcome: Outcome }>): Place[] {
  const done = answer.filter(({ outcome }) => outcome !== "already gone");
  if (!done.length) return [{ device: name, place: "", outcome: "already gone" }];
  const there = (command: string) => `cns run ${name} -- ${command}`;
  return done.map(({ place, outcome }) => {
    const mesh = /^mesh (.+)$/.exec(place)?.[1];
    // A mesh it runs there: that device narrowed it, or would, or had nothing to narrow, and what is left is to leave it.
    const runs = mesh !== undefined && (outcome === "narrowed" || outcome === "would narrow" || outcome === "not permitted");
    const detail = !runs ? undefined
      : outcome === "narrowed" ? `it runs this mesh, so ${name} takes no new list of it, and its members may now use nothing there; only once cns mesh list ${mesh} there shows no device you do not know, cns mesh allow ${mesh} GRANTS there undoes that`
        : outcome === "would narrow" ? `it runs this mesh, so ${name} would take no new list of it, and its members would use nothing there`
          : `it runs this mesh, so ${name} takes no new list of it, and its members may use nothing there`;
    const next = outcome === "failed" ? `Later, run: ${there(commandFor(fp))}`
      : runs ? `To finish, run: ${there(`cns mesh leave ${mesh}`)}`
        : outcome === "removed" || outcome === "would remove" ? undefined
          : `To see what is left there, run: ${there(commandFor(fp))}`;
    return { device: name, place, outcome, ...detail ? { detail } : {}, ...next ? { next } : {} };
  });
}

/**
 * Have a paired device remove `fp` there, by running cns there as `cns run` would: only when it
 * lets this device run commands, and then within its own checks, as for any command. Only the
 * places and outcomes of its answer are used; nothing it says is shown.
 */
async function onDevice(peer: PeerEntry, fp: string, identity: Identity, dryRun: boolean): Promise<Place[]> {
  const command = commandFor(fp);
  const one = (outcome: Outcome, detail?: string, next?: string): Place[] => [{ device: peer.name, place: "", outcome, ...detail ? { detail } : {}, ...next ? { next } : {} }];
  const later = `Later, run: cns run ${peer.name} -- ${command}`;
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
    return one("unreachable", strictlyPrintable(errorMessage(error)), later);
  }
  const close = () => { link.remote[Symbol.dispose](); link.close("Removal ended"); };
  signal.addEventListener("abort", close, { once: true });
  let result: RunResult;
  try { result = await plain(link.remote.run(`${command} --json${dryRun ? " --dry-run" : ""}`, { timeoutMs: RUN_MS })); }
  catch (error) {
    if (signal.aborted) return timedOut();
    if (refused(error)) return refusal(error);
    // What the device sent is not shown: running it there by hand shows it.
    return one("failed", "the command did not finish there", later);
  } finally { signal.removeEventListener("abort", close); close(); }
  if (result.timedOut) return one("unreachable", `it did not finish there within ${RUN_MS / 1000} seconds`, later);
  if (/unknown option '--(fingerprint|meshes|json|dry-run)'/.test(result.stderr)) {
    return one("failed", `${peer.name} runs a cns from before this`, `Upgrade cns on ${peer.name}, then run: cns run ${peer.name} -- ${command}`);
  }
  const answer = readAnswer(result.stdout, dryRun);
  if (!answer) return one("failed", `${peer.name} gave no answer this cns can read (exit status ${result.exitCode})`, `To see what is left there, run: cns run ${peer.name} -- ${command}`);
  return answerPlaces(peer.name, fp, answer);
}

/** The report a person reads: one line per place, outcome first. */
function report(target: { fingerprint: string; label: string }, places: readonly Place[], options: RemoveOptions): string {
  const what = options.everywhere ? "everywhere this device may" : "here";
  const head = options.dryRun ? `Dry run, nothing changed. Removing ${target.label} (fingerprint ${target.fingerprint}) ${what} would do this:` : `Removing ${target.label} (fingerprint ${target.fingerprint}) ${what}:`;
  // Every text in a place is strictlyPrintable already, and its device a saved name.
  return [head, ...places.map((place) => {
    const where = place.device === null ? (place.place === "the gateway" ? place.place : `this device: ${place.place}`) : [place.device, place.place].filter(Boolean).join(": ");
    return `  ${place.outcome.padEnd(13)}  ${where}${place.detail ? `: ${clause(place.detail)}` : ""}${place.next ? `. ${clause(place.next)}.` : ""}`;
  })].join("\n");
}
