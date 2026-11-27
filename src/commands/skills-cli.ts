import { realpath } from "node:fs/promises";
import path from "node:path";
import type { RpcStub } from "capnweb";
import { openDeviceLink, type DeviceLink } from "../device-link.js";
import { errorMessage, printable } from "../errors.js";
import { setModified, type FileChunk, type FileKind } from "../files.js";
import { failure, LIST_TIMEOUT_MS } from "../fleet-sessions.js";
import { ensureIdentity, type Identity } from "../identity.js";
import { explainDenial, listPeers, resolvePeer, type Permission } from "../peers.js";
import { secureReady } from "../secure.js";
import type { ShellApi } from "../shell.js";
import {
  byNewest, listSkillFiles, listSkills, mainFile, readSkillFile, skillNameSchema, skillsDirectory, type SkillFile, type SkillSummary,
} from "../skills.js";
import { plain } from "../terminal.js";
import { copy, localSide, remoteSide, type Side } from "./copy.js";

/**
 * `cns skills`: the agent skills of this device and of every paired device that lets this one
 * read them, as one set. Each device keeps its own in ~/.agents/skills; where two hold a skill
 * of the same name, the one modified last wins, and DEVICE:NAME picks a device's own copy.
 */

/** The release that first shares skills, for messages about devices that run an older one. */
const SKILLS_RELEASE = "2.2.0";

/** A device's skills, as this command reads them: this device's directly, a paired device's over its link. */
interface Host {
  /** The paired device's name; undefined for this device. */
  device?: string;
  skills(): Promise<SkillSummary[]>;
  files(name: string): Promise<SkillFile[]>;
  read(name: string, file: string, offset: number): Promise<FileChunk>;
}

/** One device's copy of a skill. */
interface Copy extends SkillSummary { host: Host }

/** A paired device that was not listed, and why. */
interface Unlisted { device: string; state: "not-granted" | "refused" | "unreachable"; reason: string }

const where = (host: Host) => host.device ?? "this device";
/** NAME as a command names this copy: DEVICE:NAME for a paired device's. */
const named = (host: Host, name: string) => host.device === undefined ? name : `${host.device}:${name}`;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

const localHost: Host = {
  skills: () => listSkills(),
  files: (name) => listSkillFiles(name),
  read: (name, file, offset) => readSkillFile(name, file, { offset }),
};

/** A refusal or an error from `device`, saying what to run, or which cns to install there. */
export function explained(error: unknown, device: string): Error {
  const message = errorMessage(error);
  if (/^'(skills|skillFiles|readSkillFile|setModified)' is not a function/.test(message)) {
    return new Error(`${device} runs a cns from before skills. Update cns on ${device} to ${SKILLS_RELEASE} or later.`, { cause: error });
  }
  const explanation = explainDenial(message, device);
  return new Error(explanation === message ? `${device}: ${printable(message)}` : explanation, { cause: error });
}

function remoteHost(device: string, remote: RpcStub<ShellApi>): Host {
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { throw explained(error, device); }
  };
  return {
    device,
    skills: () => call(() => plain(remote.skills() as unknown as Promise<SkillSummary[]>)),
    files: (name) => call(() => plain(remote.skillFiles(name) as unknown as Promise<SkillFile[]>)),
    read: (name, file, offset) => call(() => plain(remote.readSkillFile(name, file, { offset }) as unknown as Promise<FileChunk>)),
  };
}

/** Whether a device's saved grants let this one read its skills: `skills`, or `files`, which covers them. */
const mayRead = (outgoing: readonly Permission[]) => outgoing.includes("skills") || outgoing.includes("files");

/** The links this command opened, closed together when it ends. */
class Links {
  #links: DeviceLink[] = [];
  #named = new Map<string, Promise<{ remote: RpcStub<ShellApi>; host: Host }>>();
  #identity: Identity;
  constructor(identity: Identity) { this.#identity = identity; }
  /** Reach a paired device as any command does: through the local daemon's link when it has one. */
  async open(device: { name: string; publicKey: string; addresses: readonly string[] }, signal = new AbortController().signal): Promise<RpcStub<ShellApi>> {
    const link = await openDeviceLink(device, this.#identity, signal);
    this.#links.push(link);
    if (signal.aborted) throw signal.reason;
    return link.remote;
  }
  /** The paired device a command names, reached once however often it is named. */
  device(name: string): Promise<{ remote: RpcStub<ShellApi>; host: Host }> {
    let pending = this.#named.get(name);
    if (!pending) {
      pending = this.open(resolvePeer(name)).then((remote) => ({ remote, host: remoteHost(name, remote) }), (error: unknown) => { throw explained(error, name); });
      this.#named.set(name, pending);
    }
    return pending;
  }
  close() {
    for (const link of this.#links.splice(0)) { link.remote[Symbol.dispose](); link.close("Command ended"); }
  }
}

/** `promise`, or the reason `signal` aborts first. */
const before = <T>(signal: AbortSignal, promise: Promise<T>) => new Promise<T>((resolve, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  promise.then(resolve, reject);
});

/**
 * Every skill this device and its paired devices hold. Paired devices are asked at once, each
 * within `timeoutMs`, so one that is slow or offline never hides the others' skills.
 */
async function gather(links: Links, timeoutMs = LIST_TIMEOUT_MS): Promise<{ copies: Copy[]; unlisted: Unlisted[] }> {
  const devices = listPeers(() => {});
  const asked = devices.map(async (peer): Promise<Copy[] | Unlisted> => {
    if (!mayRead(peer.grants.outgoing)) {
      return { device: peer.name, state: "not-granted", reason: `${peer.name} does not let this device read its skills (skills or files); cns doctor ${peer.name} checks what it grants now` };
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const host = remoteHost(peer.name, await before(deadline, links.open(peer, deadline)));
      const skills = await before(deadline, host.skills());
      return skills.filter((skill) => skillNameSchema.safeParse(skill.name).success).map((skill) => ({ ...skill, host }));
    } catch (error) {
      if (deadline.aborted) return failure(peer.name, error, timeoutMs) as Unlisted;
      if (/from before skills/.test(errorMessage(error))) return { device: peer.name, state: "refused", reason: errorMessage(error) };
      // A refusal that explained() wrapped is classified by the device's own message.
      return failure(peer.name, error instanceof Error && error.cause !== undefined ? error.cause : error) as Unlisted;
    }
  });
  const local = (await listSkills()).map((skill) => ({ ...skill, host: localHost }));
  const answers = await Promise.all(asked);
  return {
    copies: [...local, ...answers.flatMap((answer) => Array.isArray(answer) ? answer : [])],
    unlisted: answers.filter((answer): answer is Unlisted => !Array.isArray(answer)),
  };
}

const newest = (copies: readonly Copy[]) => byNewest(copies.map((copy) => ({ ...copy, device: copy.host.device })));

/** A line on stderr for each paired device that was not listed. */
function noteUnlisted(unlisted: readonly Unlisted[], include: (entry: Unlisted) => boolean = () => true) {
  for (const entry of unlisted) {
    if (include(entry)) process.stderr.write(`cns: ${entry.device}: ${entry.state === "not-granted" ? "not listed" : entry.state}: ${entry.reason}\n`);
  }
}

/** `[DEVICE:]NAME`: a paired device's own copy, or the newest one anywhere. */
function parseTarget(value: string): { device?: string; name: string } {
  const colon = value.indexOf(":");
  const device = colon < 0 ? undefined : value.slice(0, colon);
  const name = colon < 0 ? value : value.slice(colon + 1);
  if (device !== undefined) resolvePeer(device);
  if (!skillSchema(name)) throw new Error(`${name || value} is not a skill's name. cns skills list shows the skills there are.`);
  return { device, name };
}
const skillSchema = (name: string) => skillNameSchema.safeParse(name).success;

/** The copy of each skill a command names: the named device's, else the newest that answered. */
async function find(links: Links, targets: readonly string[]): Promise<Copy[]> {
  const parsed = targets.map(parseTarget);
  const anywhere = parsed.some((target) => target.device === undefined) ? gather(links) : undefined;
  anywhere?.catch(() => {}); // Awaited below; a named device's error may end the command first.
  const found: Copy[] = [];
  for (const { device, name } of parsed) {
    if (device !== undefined) {
      const { host } = await links.device(device);
      const skills = await host.skills();
      const skill = skills.find((entry) => entry.name === name);
      if (!skill) throw new Error(`${device} has no skill ${name}${skills.length ? `; it has ${skills.map((entry) => entry.name).join(", ")}` : ""}.`);
      found.push({ ...skill, host });
      continue;
    }
    const { copies, unlisted } = await anywhere!;
    const copy = newest(copies).get(name)?.[0];
    if (!copy) {
      noteUnlisted(unlisted, (entry) => entry.state !== "not-granted");
      throw new Error(`No skill ${name} on this device or the paired devices that answered. cns skills list shows the skills there are.`);
    }
    found.push(copy);
  }
  if (anywhere) {
    // A copy that a device which did not answer holds might be newer: say which ones were not asked.
    const { unlisted } = await anywhere;
    noteUnlisted(unlisted, (entry) => entry.state !== "not-granted");
  }
  return found;
}

/** Run `action` with links that are closed when it ends, however it ends. */
async function withLinks<T>(action: (links: Links) => Promise<T>): Promise<T> {
  await secureReady();
  const links = new Links(ensureIdentity().identity);
  try { return await action(links); } finally { links.close(); }
}

/** Write to stdout, waiting while its buffer is full. */
const out = (data: string | Uint8Array) => new Promise<void>((resolve, reject) => {
  process.stdout.write(data, (error) => error ? reject(error) : resolve());
});

/** Every byte of one of a skill's files, in the parts its device returns. */
async function readAll(host: Host, name: string, file: string, each: (data: Uint8Array) => Promise<void>): Promise<void> {
  for (let offset = 0; ;) {
    const chunk = await host.read(name, file, offset);
    if (chunk.data.byteLength) await each(chunk.data);
    offset += chunk.data.byteLength;
    if (chunk.eof || !chunk.data.byteLength) return;
  }
}

/** `cns skills list`: every skill once, the newest copy of each, with the devices that hold others. */
export async function listCommand(options: { json?: boolean }): Promise<number> {
  return await withLinks(async (links) => {
    const { copies, unlisted } = await gather(links);
    const skills = [...newest(copies)].map(([name, group]) => ({ name, winner: group[0]!, others: group.slice(1) }));
    if (options.json) {
      process.stdout.write(JSON.stringify({
        skills: skills.map(({ name, winner, others }) => ({
          name, device: winner.host.device ?? null, modified: new Date(winner.modifiedMs).toISOString(), description: printable(winner.description),
          copies: [winner, ...others].map((copy) => ({ device: copy.host.device ?? null, modified: new Date(copy.modifiedMs).toISOString() })),
        })),
        devices: unlisted,
      }, null, 2) + "\n");
    } else if (skills.length) {
      const rows = skills.map(({ name, winner, others }) => [
        printable(name), where(winner.host), utc(winner.modifiedMs), others.map((copy) => where(copy.host)).join(", ") || "-", printable(winner.description),
      ]);
      const table = [["NAME", "DEVICE", "MODIFIED (UTC)", "ALSO ON", "DESCRIPTION"], ...rows];
      const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
      // At a terminal, a description is cut to fit the line; piped, as for an agent, it is whole.
      const room = process.stdout.isTTY ? Math.max(20, (process.stdout.columns || 80) - widths.slice(0, -1).reduce((sum, width) => sum + width + 2, 0)) : Infinity;
      for (const row of table) {
        const description = row.at(-1)!;
        const cells = [...row.slice(0, -1).map((cell, index) => cell.padEnd(widths[index]!)), description.length > room ? `${description.slice(0, room - 1)}…` : description];
        process.stdout.write(cells.join("  ").trimEnd() + "\n");
      }
    }
    noteUnlisted(unlisted);
    if (!skills.length && !options.json) process.stderr.write(`cns: No skills on this device (${skillsDirectory()}) or the paired devices that answered.\n`);
    return unlisted.some((entry) => entry.state !== "not-granted") ? 1 : 0;
  });
}

/** `cns skills load [DEVICE:]NAME`: print the skill's SKILL.md, and say where it came from and what else it holds. */
export async function loadCommand(target: string): Promise<void> {
  await withLinks(async (links) => {
    const [copy] = await find(links, [target]);
    const { host, name } = copy!;
    const files = await host.files(name);
    const main = mainFile(files);
    if (!main) throw new Error(`The skill ${name} on ${where(host)} has no SKILL.md.`);
    await readAll(host, name, main.path, out);
    const others = files.filter((file) => file !== main).map((file) => file.path);
    const listed = others.length > 10 ? `${others.slice(0, 10).join(", ")} and ${others.length - 10} more (cns skills ls ${named(host, name)})` : others.join(", ");
    const origin = host.device === undefined ? `is in ${path.join(skillsDirectory(), name)}` : `is from ${host.device}`;
    const rest = others.length ? `, with ${others.length} other ${others.length === 1 ? "file" : "files"}: ${listed}` : "";
    const hint = host.device !== undefined && others.length ? ` Read one with cns skills cat ${named(host, name)} FILE, or keep a copy here with cns skills sync ${named(host, name)}.` : "";
    process.stderr.write(`cns: ${name} ${origin} (modified ${utc(copy!.modifiedMs)} UTC)${rest}.${hint}\n`);
  });
}

/** `cns skills ls [DEVICE:]NAME`: the files of a skill, with their sizes and modification times. */
export async function lsCommand(target: string): Promise<void> {
  await withLinks(async (links) => {
    const [copy] = await find(links, [target]);
    const files = await copy!.host.files(copy!.name);
    const table = [["PATH", "SIZE", "MODIFIED (UTC)"], ...files.map((file) => [printable(file.path), String(file.size), utc(file.modifiedMs)])];
    const widths = table.reduce((max, row) => row.map((cell, index) => Math.max(cell.length, max[index] ?? 0)), [] as number[]);
    for (const row of table) await out(row.map((cell, index) => index === 1 ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!)).join("  ").trimEnd() + "\n");
  });
}

/** `cns skills cat [DEVICE:]NAME FILE...`: print files of a skill, one after another. */
export async function catCommand(target: string, files: string[]): Promise<void> {
  if (!files.length) throw new Error("cat needs a file of the skill, such as SKILL.md: cns skills cat NAME FILE. cns skills ls NAME lists them.");
  await withLinks(async (links) => {
    const [copy] = await find(links, [target]);
    for (const file of files) await readAll(copy!.host, copy!.name, file.replaceAll("\\", "/"), out);
  });
}

/** Run `task` on every item, `limit` at a time, and give the results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await task(items[index]!); }
  }));
  return results;
}

/** Files larger than this are not searched; skills are text. */
const MAX_SEARCH_BYTES = 1024 * 1024;

/**
 * `cns skills rg PATTERN [[DEVICE:]NAME...]`: the lines of the named skills, or of the newest copy
 * of every skill, that match a regular expression, as NAME/FILE:LINE:TEXT. Exits 1 when none match.
 */
export async function rgCommand(pattern: string, targets: string[], options: { ignoreCase?: boolean }): Promise<number> {
  let expression: RegExp;
  try { expression = new RegExp(pattern, options.ignoreCase ? "i" : ""); }
  catch (error) { throw new Error(`${pattern} is not a regular expression (${errorMessage(error)}); put \\ before characters such as ( [ { . * + ? to match them as they are.`); }
  return await withLinks(async (links) => {
    const copies = targets.length ? await find(links, targets) : await (async () => {
      const { copies: all, unlisted } = await gather(links);
      noteUnlisted(unlisted, (entry) => entry.state !== "not-granted");
      return [...newest(all).values()].map((group) => group[0]!);
    })();
    const files = (await Promise.all(copies.map(async (copy) => (await copy.host.files(copy.name))
      .filter((file) => file.size <= MAX_SEARCH_BYTES).map((file) => ({ copy, file })))))
      .flat();
    const matches = await mapLimit(files, 8, async ({ copy, file }) => {
      const parts: Uint8Array[] = [];
      await readAll(copy.host, copy.name, file.path, async (data) => { parts.push(data); });
      const bytes = Buffer.concat(parts);
      if (bytes.includes(0)) return []; // Binary.
      const prefix = printable(`${copy.name}/${file.path}`);
      return bytes.toString("utf8").split(/\r?\n/).flatMap((line, index) => expression.test(line) ? [`${prefix}:${index + 1}:${printable(line)}\n`] : []);
    });
    for (const line of matches.flat()) await out(line);
    return matches.some((lines) => lines.length) ? 0 : 1;
  });
}

/**
 * A skill's copy as the source of cns cp's copy: a directory /NAME holding its files, read
 * through the skill's device, so the skills grant is enough and only the skill's files are read.
 */
function skillSide(host: Host, name: string, files: readonly SkillFile[]): Side {
  const paths = path.posix;
  const entries = new Map<string, { kind: FileKind; mode: number }>([[`/${name}`, { kind: "directory", mode: 0o755 }]]);
  const children = new Map<string, Map<string, FileKind>>();
  for (const file of files) {
    let parent = `/${name}`;
    const parts = file.path.split("/");
    parts.forEach((part, index) => {
      const child = `${parent}/${part}`;
      const kind: FileKind = index === parts.length - 1 ? "file" : "directory";
      if (!children.has(parent)) children.set(parent, new Map());
      children.get(parent)!.set(part, kind);
      if (!entries.has(child)) entries.set(child, { kind, mode: kind === "file" ? file.mode : 0o755 });
      parent = child;
    });
  }
  const refuse = async (): Promise<never> => { throw new Error("A skill is only copied from."); };
  return {
    prefix: host.device === undefined ? "" : `${host.device}:`,
    paths,
    writeLimit: 0,
    resolve: (value) => paths.join("/", value),
    directoryIntent: () => false,
    stat: async (target) => entries.get(target),
    list: async (directory) => [...children.get(directory) ?? []].map(([entry, kind]) => ({ name: entry, kind })),
    mkdir: refuse,
    async openRead(file) {
      const relative = file.slice(name.length + 2);
      return { read: (offset) => host.read(name, relative, offset), async close() {} };
    },
    openWrite: refuse,
  };
}

/** Where a skill goes: `--to [DEVICE:]PATH`, by default this device's ~/.agents/skills; DEVICE: alone is that device's. */
function parseDestination(value: string | undefined): { device?: string; path: string } {
  if (value === undefined) return { path: skillsDirectory() };
  const colon = value.indexOf(":");
  const prefix = colon < 0 ? "" : value.slice(0, colon);
  // As with cns cp: a colon before any slash names a device, except a Windows drive letter.
  if (colon < 0 || /[\\/]/.test(prefix) || (process.platform === "win32" && /^[A-Za-z]$/.test(prefix))) return { path: value };
  if (!prefix) throw new Error(`Name the paired device before the colon: --to DEVICE${value}.`);
  resolvePeer(prefix);
  return { device: prefix, path: value.slice(colon + 1) || "~/.agents/skills" };
}

/** `cns skills sync [--to [DEVICE:]PATH] [DEVICE:]NAME...`: copy skills to this device, or elsewhere, keeping their times. */
export async function syncCommand(targets: string[], options: { to?: string }): Promise<void> {
  if (!targets.length) throw new Error("sync needs a skill's name: cns skills sync NAME, or DEVICE:NAME for that device's copy. cns skills list shows them.");
  const destination = parseDestination(options.to);
  await withLinks(async (links) => {
    const copies = await find(links, targets);
    let to: Side;
    let stamp: (file: string, mtimeMs: number) => Promise<void>;
    if (destination.device === undefined) {
      to = localSide();
      stamp = setModified;
    } else {
      const device = destination.device;
      const { remote } = await links.device(device);
      to = remoteSide(device, remote, await plain(remote.info()));
      let older = false;
      stamp = async (file, mtimeMs) => {
        if (older) return;
        try { await remote.setModified(file, mtimeMs); } catch (error) {
          const explanation = explained(error, device);
          if (!/from before skills/.test(explanation.message)) throw explanation;
          if (!older) process.stderr.write(`cns: ${device} runs a cns from before ${SKILLS_RELEASE}, so the copied files there carry the time of this sync, not their source's.\n`);
          older = true;
        }
      };
    }
    const into = to.resolve(destination.path);
    for (const skill of copies) {
      const { host, name } = skill;
      const target = to.paths.join(into, name);
      const shown = `${to.prefix}${target}`;
      // Copying a skill onto itself would empty its files before reading them.
      if (host.device === destination.device) {
        const here = host.device === undefined
          ? await realpath(target).then(async (real) => real === await realpath(path.join(skillsDirectory(), name)), () => false)
          : target === to.paths.join(to.resolve("~/.agents/skills"), name);
        if (here) { process.stdout.write(`${name}: the copy on ${where(host)} is already in ${target}.\n`); continue; }
        // Within one paired device, where links lead cannot be checked from here.
        if (host.device !== undefined) throw new Error(`${named(host, name)} would be copied within ${host.device}; copy it there with cns run ${host.device} -- cp -r, or sync it to another device.`);
      }
      const existing = await to.stat(target);
      if (existing && (existing.kind !== "directory" || !(await to.list(target)).some((entry) => /^skill\.md$/i.test(entry.name)))) {
        throw new Error(`${shown} exists and is not a skill (it has no SKILL.md), so ${name} is not copied over it. Choose another --to.`);
      }
      const files = await host.files(name);
      await copy(skillSide(host, name, files), name, to, `${into}${to.paths.sep}`, { recursive: true });
      await Promise.all(files.map((file) => stamp(to.paths.join(target, ...file.path.split("/")), file.modifiedMs)));
      process.stdout.write(`${name}: copied ${files.length} ${files.length === 1 ? "file" : "files"} from ${where(host)} (modified ${utc(skill.modifiedMs)} UTC) to ${shown}.\n`);
    }
  });
}
