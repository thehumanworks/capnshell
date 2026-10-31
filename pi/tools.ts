import os from "node:os";
import path from "node:path";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition,
  createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  type BashOperations, type EditOperations, type ExtensionAPI, type FindOperations, type GrepToolInput,
  type LsOperations, type ReadOperations, type ToolDefinition, type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { FileKind } from "../src/shell.js";
import { remoteGrep } from "./grep.js";
import { lostMessage, type FileChunk, type Host } from "./host.js";
import { detectImageMimeType, IMAGE_SNIFF_BYTES } from "./image.js";

/** Pi's built-in tools that run on the attached host instead of this machine. */
export const SHADOWED_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type ShadowedTool = (typeof SHADOWED_TOOLS)[number];
type AnyDefinition = ToolDefinition<any, any, any>;
type Definitions = Record<ShadowedTool, AnyDefinition>;

/** Pi's own tool as this session's settings configure it, for when no host is attached. */
function localDefinition(pi: ExtensionAPI, name: ShadowedTool, cwd: string): AnyDefinition {
  const settings = pi.getSettings();
  switch (name) {
    case "read": return createReadToolDefinition(cwd, { autoResizeImages: settings.images?.autoResize ?? true });
    case "bash": {
      const shellPath = settings.shellPath?.startsWith("~/") ? path.join(os.homedir(), settings.shellPath.slice(2)) : settings.shellPath;
      return createBashToolDefinition(cwd, { commandPrefix: settings.shellCommandPrefix, shellPath });
    }
    case "edit": return createEditToolDefinition(cwd);
    case "write": return createWriteToolDefinition(cwd);
    case "grep": return createGrepToolDefinition(cwd);
    case "find": return createFindToolDefinition(cwd);
    case "ls": return createLsToolDefinition(cwd);
  }
}

/** Definitions for each tool's description, parameters and rendering. */
function templates(cwd: string): Definitions {
  return {
    read: createReadToolDefinition(cwd),
    bash: createBashToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

function readOperations(host: Host): ReadOperations {
  // Pi detects the type first and then reads the file: keep the first chunk for the read.
  let first: { file: string; chunk: FileChunk } | undefined;
  return {
    access: (file) => host.access(file),
    async detectImageMimeType(file) {
      const chunk = await host.readChunk(file);
      first = { file, chunk };
      return detectImageMimeType(chunk.data.subarray(0, IMAGE_SNIFF_BYTES));
    },
    readFile(file) {
      const chunk = first?.file === file ? first.chunk : undefined;
      first = undefined;
      return host.readWhole(file, chunk);
    },
  };
}

function lsOperations(host: Host): LsOperations {
  // Pi stats every entry it lists; answer from the listing rather than asking once per entry.
  const kinds = new Map<string, FileKind>();
  return {
    exists: (file) => host.exists(file),
    async stat(file) {
      const known = kinds.get(file);
      const kind = known && known !== "symlink" ? known : (await host.stat(file)).kind;
      return { isDirectory: () => kind === "directory" };
    },
    async readdir(directory) {
      const entries = await host.readdir(directory);
      for (const entry of entries) kinds.set(path.posix.join(directory, entry.name), entry.kind);
      return entries.map((entry) => entry.name);
    },
  };
}

/**
 * fd, which Pi's find uses, matches a pattern without a slash against names at
 * any depth, and one with a slash against the whole path; cns matches paths
 * relative to the search directory.
 */
export function findPattern(pattern: string, searchPath: string): string {
  if (pattern.startsWith("/")) {
    return pattern.startsWith(`${searchPath}/`) ? pattern.slice(searchPath.length + 1) : pattern;
  }
  return pattern.startsWith("**/") || pattern === "**" ? pattern : `**/${pattern}`;
}

function remoteDefinitions(host: Host, settings: { autoResizeImages: boolean }): Definitions {
  const files = {
    mkdir: (directory: string) => host.mkdir(directory),
    writeFile: (file: string, content: string) => host.writeWhole(file, Buffer.from(content, "utf8")),
  };
  const edit: EditOperations = {
    ...files,
    access: (file) => host.access(file, true),
    readFile: (file) => host.readWhole(file),
  };
  const write: WriteOperations = files;
  const find: FindOperations = {
    exists: (file) => host.exists(file),
    glob: (pattern, cwd, options) => host.glob(findPattern(pattern, cwd), cwd, { ...options, directories: true }),
  };
  // The host's environment, not this machine's: nothing from here is forwarded.
  const bash: BashOperations = { exec: (command, cwd, { onData, signal, timeout }) => host.exec(command, cwd, { onData, signal, timeout }) };
  const grep = createGrepToolDefinition(host.cwd);
  return {
    read: createReadToolDefinition(host.cwd, { autoResizeImages: settings.autoResizeImages, operations: readOperations(host) }),
    bash: createBashToolDefinition(host.cwd, { operations: bash, exposeSessionEnvironment: false }),
    edit: createEditToolDefinition(host.cwd, { operations: edit }),
    write: createWriteToolDefinition(host.cwd, { operations: write }),
    grep: { ...grep, execute: (_id: string, params: GrepToolInput, signal?: AbortSignal) => remoteGrep(host, params, signal) } as AnyDefinition,
    find: createFindToolDefinition(host.cwd, { operations: find }),
    ls: createLsToolDefinition(host.cwd, { operations: lsOperations(host) }),
  };
}

/**
 * Pi expands `~` to this machine's home before a tool sees the path; on the host
 * it means the host's home.
 */
function hostPaths(host: Host, params: Record<string, unknown>): Record<string, unknown> {
  const value = params.path;
  if (typeof value !== "string") return params;
  const bare = value.startsWith("@~") ? value.slice(1) : value;
  return bare === "~" || bare.startsWith("~/") ? { ...params, path: host.resolve(bare) } : params;
}

export interface ToolRouting {
  /** The attached host, or undefined to use this machine. */
  host(): Host | undefined;
  /** Why no tool may run anywhere, such as an attachment Pi was started with that failed. */
  blocked(): string | undefined;
}

/**
 * Register Pi's built-in tools under their own names, so they replace the
 * built-ins, and route every call: to this machine while no host is attached,
 * otherwise to the host attached when the call starts. A call never moves to
 * another host or to this machine partway, and once a host's connection is lost
 * its calls fail until the user attaches again or detaches.
 *
 * The tools are registered inactive: the session keeps the active set it had.
 */
export function registerTools(pi: ExtensionAPI, routing: ToolRouting) {
  // Full output of long remote commands, which Pi saves on this machine.
  const localOutputs = new Set<string>();
  const shown = templates(process.cwd());
  for (const name of SHADOWED_TOOLS) {
    const template = shown[name];
    pi.registerTool({
      ...template,
      defaultActive: false,
      async execute(id, params: Record<string, unknown>, signal, onUpdate, ctx) {
        const blocked = routing.blocked();
        if (blocked) throw new Error(blocked);
        const host = routing.host();
        if (!host) return await localDefinition(pi, name, ctx.cwd).execute(id, params, signal, onUpdate, ctx);
        if (host.lost) throw new Error(lostMessage(host));
        if (name === "read" && typeof params.path === "string" && localOutputs.has(params.path)) {
          return await localDefinition(pi, name, ctx.cwd).execute(id, params, signal, onUpdate, ctx);
        }
        const settings = { autoResizeImages: pi.getSettings().images?.autoResize ?? true };
        // Pi's tools resolve relative paths against ctx.cwd before the factory's.
        const hostContext: typeof ctx = Object.create(ctx, { cwd: { value: host.cwd, enumerable: true } });
        const result = await remoteDefinitions(host, settings)[name].execute(id, hostPaths(host, params), signal, onUpdate, hostContext);
        const output = name === "bash" ? (result.details as { fullOutputPath?: string } | undefined)?.fullOutputPath : undefined;
        if (output) localOutputs.add(output);
        return result;
      },
      renderCall: template.renderCall && ((args, theme, context) => {
        const host = routing.host();
        if (!host) return template.renderCall!(args, theme, context);
        // Show paths relative to the host's directory. The edit preview reads the
        // file here, which is not the host's file; the result shows the real diff.
        return template.renderCall!(args, theme, Object.create(context, {
          cwd: { value: host.cwd, enumerable: true },
          argsComplete: { value: name === "edit" ? false : context.argsComplete, enumerable: true },
        }));
      }),
    });
  }
}
