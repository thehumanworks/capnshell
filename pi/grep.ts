import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine,
  type AgentToolResult, type GrepToolDetails, type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import { quote, type Host } from "./host.js";

const DEFAULT_LIMIT = 100;
/** truncateLine's default, which Pi's grep notice names. */
const GREP_MAX_LINE_LENGTH = 500;
const MAX_STDERR = 64 * 1024;
/** Printed by the remote command when the host has no rg. */
const NO_RG = "cns: rg not found";

interface RgText { text?: string; bytes?: string }
interface RgEvent {
  type: string;
  data?: { path?: RgText; lines?: RgText; line_number?: number };
}

const decode = (value: RgText | undefined) =>
  value?.text ?? (value?.bytes === undefined ? undefined : Buffer.from(value.bytes, "base64").toString("utf8"));

/** One line of a file without its line ending, as Pi shows it. */
const sanitize = (line: string) => line.replace(/\r?\n$/, "").replace(/\r/g, "");

/**
 * Pi's grep, run on a cns host with the host's ripgrep. Pi's own grep always
 * starts a local rg, even with custom operations, so it cannot search a remote
 * host. This keeps its contract: the same rg flags, match limit, context blocks,
 * line and byte truncation and notices. Context lines come from rg itself, so no
 * file is read twice over the connection.
 */
export async function remoteGrep(host: Host, input: GrepToolInput, signal?: AbortSignal): Promise<AgentToolResult<GrepToolDetails | undefined>> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const { pattern, glob, ignoreCase, literal } = input;
  const searchPath = host.resolve(input.path || ".");
  let isDirectory: boolean;
  try {
    isDirectory = (await host.stat(searchPath)).kind === "directory";
  } catch (error) {
    if (host.lost) throw error;
    throw new Error(`Path not found: ${searchPath}`);
  }
  const context = input.context && input.context > 0 ? Math.floor(input.context) : 0;
  const limit = Math.max(1, input.limit ?? DEFAULT_LIMIT);
  const formatPath = (file: string) => {
    if (isDirectory) {
      const relative = path.posix.relative(searchPath, file);
      if (relative && !relative.startsWith("..")) return relative;
    }
    return path.posix.basename(file);
  };

  const args = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
  if (ignoreCase) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);
  if (context) args.push("--context", String(context));
  args.push("--", pattern, searchPath);
  const command = `command -v rg >/dev/null 2>&1 || { printf '%s\\n' ${quote(NO_RG)} >&2; exit 127; }\nexec rg ${args.map(quote).join(" ")}`;

  const matches: { file: string; line: number; text: string }[] = [];
  /** Lines rg reported, with their line endings, for context blocks: file -> line number -> text. */
  const lines = new Map<string, Map<number, string>>();
  let last: (typeof matches)[number] | undefined;
  let stderr = "";
  let pending = "";
  const decoder = new StringDecoder("utf8");
  const stopped = new AbortController();
  const stop = () => { if (!stopped.signal.aborted) stopped.abort(); };

  const handle = (line: string) => {
    if (stopped.signal.aborted || !line.trim()) return;
    let event: RgEvent;
    try { event = JSON.parse(line); }
    catch { return; }
    if (event.type !== "match" && event.type !== "context") {
      // Past the limit, the last match's context ends with its file.
      if (matches.length >= limit) stop();
      return;
    }
    const file = decode(event.data?.path);
    const number = event.data?.line_number;
    if (!file || typeof number !== "number") return;
    const raw = decode(event.data?.lines) ?? "";
    const text = sanitize(raw);
    if (matches.length >= limit) {
      // Keep the context after the last match; then stop rg.
      if (!last || file !== last.file || number > last.line + context) return stop();
    } else if (event.type === "match") {
      last = { file, line: number, text };
      matches.push(last);
    }
    if (context) {
      let known = lines.get(file);
      if (!known) lines.set(file, known = new Map());
      known.set(number, raw);
    } else if (matches.length >= limit) stop();
  };

  let exitCode: number | null = null;
  try {
    ({ exitCode } = await host.exec(command, host.cwd, {
      signal: signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal,
      onData(data, stream) {
        if (stream === "stderr") {
          if (stderr.length < MAX_STDERR) stderr += data.toString("utf8");
          return;
        }
        pending += decoder.write(data);
        const complete = pending.split("\n");
        pending = complete.pop()!;
        for (const line of complete) handle(line);
      },
    }));
    handle(pending + decoder.end());
  } catch (error) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (!stopped.signal.aborted) throw error;
  }
  if (!stopped.signal.aborted && exitCode !== 0 && exitCode !== 1) {
    if (exitCode === 127 && stderr.includes(NO_RG)) {
      throw new Error(`ripgrep (rg) is not installed on ${host.label}. Install it there, or search with bash.`);
    }
    throw new Error(stderr.trim() || `ripgrep exited with code ${exitCode}`);
  }
  if (matches.length === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  let linesTruncated = false;
  const show = (text: string) => {
    const { text: shown, wasTruncated } = truncateLine(text);
    if (wasTruncated) linesTruncated = true;
    return shown;
  };
  const output: string[] = [];
  for (const match of matches) {
    const relative = formatPath(match.file);
    if (!context) {
      output.push(`${relative}:${match.line}: ${show(match.text)}`);
      continue;
    }
    const known = lines.get(match.file)!;
    for (let current = Math.max(1, match.line - context); current <= match.line + context; current++) {
      const raw = known.get(current);
      if (raw === undefined) {
        // rg reports every line around a match that exists, so a gap after it is the end
        // of the file. Pi splits the file's text into lines, which after a final line
        // ending gives one more, empty line.
        if (current > match.line) {
          if (known.get(current - 1)?.endsWith("\n")) output.push(`${relative}-${current}- `);
          break;
        }
        continue;
      }
      const text = show(sanitize(raw));
      output.push(current === match.line ? `${relative}:${current}: ${text}` : `${relative}-${current}- ${text}`);
    }
  }

  // No line limit: the match limit already capped the rows.
  const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let text = truncation.content;
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matches.length >= limit) {
    notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
    details.matchLimitReached = limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}
