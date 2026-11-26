import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readFileChunk, type FileChunk, type ReadFileOptions } from "./files.js";

/**
 * Agent skills on this device: each directory in ~/.agents/skills that holds a SKILL.md.
 * A paired device with the `skills` grant, or `files`, may list them and read their files,
 * and nothing else. A name or path that would leave a skill's directory is refused, hidden
 * files and directories (such as .git or .env) are not part of a skill, and a link is
 * followed only to a file inside its own skill.
 */

/** Skills listed per device at most. */
export const MAX_SKILLS = 1000;
/** Files per skill at most; a skill with more cannot be listed file by file or copied. */
export const MAX_SKILL_FILES = 1000;
/** Directory levels inside a skill that are looked into. */
const MAX_DEPTH = 16;
/** Characters of a description kept. */
const MAX_DESCRIPTION = 1024;
/** Bytes of SKILL.md read to find its front matter. */
const FRONT_MATTER_BYTES = 64 * 1024;

/** ~/.agents/skills for the user running cns: the profile directory on Windows, the Linux home in WSL. */
export function skillsDirectory(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

// RPC callers are not necessarily TypeScript: validate at the trust boundary.
/** A name or path part that stays where it is put: no separators, drive or stream colons, control characters or leading dot. */
const plainPart = /^[^./\\:\u0000-\u001f\u007f][^/\\:\u0000-\u001f\u007f]*$/;
export const skillNameSchema = z.string().min(1).max(255).regex(plainPart, "A skill's name is its directory's name: no slashes, colons or leading dot.");
/** A file of a skill, relative to its directory, with / between parts on every platform. */
export const skillFileSchema = z.string().min(1).max(4096)
  .refine((value) => value.split("/").every((part) => plainPart.test(part)), "A skill's file is a path inside it, such as references/api.md, with no .. and no hidden parts.");

export interface SkillSummary {
  /** The skill's directory name, which is what other devices call it. */
  name: string;
  /** The `description` in SKILL.md's front matter, on one line, or "" when it has none. */
  description: string;
  /** When the skill last changed: its newest file's modification time. */
  modifiedMs: number;
}
export interface SkillFile {
  /** Relative to the skill's directory, with / between parts. */
  path: string;
  size: number;
  modifiedMs: number;
  /** Permission bits, so a copy keeps scripts executable. */
  mode: number;
}

const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
/** `target` is inside `directory`, both real paths. */
const inside = (directory: string, target: string) => {
  const relative = path.relative(directory, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/**
 * The files of the skill in `directory`, up to `limit`, sorted by path: regular files, and
 * links to files inside the skill as those files. Hidden entries, links to directories or
 * out of the skill, and unreadable directories below it are left out.
 */
async function walk(directory: string, limit: number): Promise<{ files: SkillFile[]; complete: boolean }> {
  const real = await realpath(directory);
  const files: SkillFile[] = [];
  const visit = async (parts: string[], depth: number): Promise<boolean> => {
    let entries;
    try { entries = await readdir(path.join(real, ...parts), { withFileTypes: true }); }
    catch (error) { if (!parts.length) throw error; return true; }
    for (const entry of entries.sort(byName)) {
      if (!plainPart.test(entry.name)) continue;
      const relative = [...parts, entry.name];
      const full = path.join(real, ...relative);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !await visit(relative, depth + 1)) return false;
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let stats;
      try {
        const target = entry.isSymbolicLink() ? await realpath(full) : full;
        if (target !== full && !inside(real, target)) continue;
        stats = await stat(target);
      } catch { continue; }
      if (!stats.isFile()) continue;
      if (files.length >= limit) return false;
      files.push({ path: relative.join("/"), size: stats.size, modifiedMs: stats.mtimeMs, mode: stats.mode & 0o777 });
    }
    return true;
  };
  const complete = await visit([], 0);
  return { files, complete };
}

/** SKILL.md, or another spelling of it such as skill.md, among a skill's files. */
export const mainFile = (files: readonly SkillFile[]): SkillFile | undefined => files.find((file) => file.path === "SKILL.md") ?? files.find((file) => /^skill\.md$/i.test(file.path));

/** The `description` in a SKILL.md's YAML front matter, on one line; "" when there is none. */
export function skillDescription(text: string): string {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return "";
  let data: unknown;
  try { data = Bun.YAML.parse(match[1]!); } catch { return ""; }
  const description = data && typeof data === "object" ? (data as Record<string, unknown>).description : undefined;
  return typeof description === "string" ? description.replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION) : "";
}

/** Every skill in `root`, by name: directories, or links to them, that hold a SKILL.md. */
export async function listSkills(root = skillsDirectory()): Promise<SkillSummary[]> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return []; throw error; }
  const skills: SkillSummary[] = [];
  for (const entry of entries.sort(byName)) {
    if (skills.length >= MAX_SKILLS) break;
    if (!skillNameSchema.safeParse(entry.name).success || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    try {
      const directory = path.join(root, entry.name);
      const { files } = await walk(directory, MAX_SKILL_FILES);
      const main = mainFile(files);
      if (!main) continue;
      const head = await readFileChunk(path.join(await realpath(directory), main.path), { length: FRONT_MATTER_BYTES });
      skills.push({
        name: entry.name,
        description: skillDescription(new TextDecoder().decode(head.data)),
        modifiedMs: Math.max(...files.map((file) => file.modifiedMs)),
      });
    } catch { /* Unreadable, or gone meanwhile: not listed. */ }
  }
  return skills;
}

/** The real directory of skill `name` in `root`, with a message that names it when there is none. */
async function skillDirectory(name: string, root: string): Promise<string> {
  try { return await realpath(path.join(root, skillNameSchema.parse(name))); }
  catch (error) {
    if (missing(error)) throw new Error(`There is no skill ${name} in ${root}.`);
    throw error;
  }
}

/** The files of skill `name`, sorted by path. */
export async function listSkillFiles(name: string, root = skillsDirectory()): Promise<SkillFile[]> {
  const directory = await skillDirectory(name, root);
  const { files, complete } = await walk(directory, MAX_SKILL_FILES);
  if (!complete) throw new Error(`The skill ${name} has more than ${MAX_SKILL_FILES} files; cns skills handles skills with fewer.`);
  return files;
}

/** Up to MAX_FILE_CHUNK_BYTES of one of skill `name`'s files from `offset`; read a larger file in several calls. */
export async function readSkillFile(name: string, file: string, options: ReadFileOptions = {}, root = skillsDirectory()): Promise<FileChunk> {
  const directory = await skillDirectory(name, root);
  let target: string;
  try { target = await realpath(path.join(directory, ...skillFileSchema.parse(file).split("/"))); }
  catch (error) {
    if (missing(error)) throw new Error(`The skill ${name} has no file ${file}.`);
    throw error;
  }
  if (!inside(directory, target)) throw new Error(`${file} leads out of the skill ${name}, so it is not read.`);
  return await readFileChunk(target, options);
}

