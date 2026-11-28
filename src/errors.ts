import { z } from "zod";

/** A one-line message for people and agents, including validation errors from peers. */
export function errorMessage(error: unknown): string {
  const issues = error instanceof z.ZodError ? error.issues : parseIssues(error instanceof Error ? error.message : String(error));
  if (!issues) return error instanceof Error ? error.message : String(error);
  return issues.map((issue) => (issue.path?.length ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");
}

// A peer's ZodError arrives as a plain Error whose message is the JSON issue list.
function parseIssues(message: string): { path?: PropertyKey[]; message: string }[] | undefined {
  if (!message.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    if (Array.isArray(parsed) && parsed.length && parsed.every((issue) => typeof issue?.message === "string")) return parsed;
  } catch { /* Not an issue list. */ }
  return undefined;
}

/** Characters that reorder how text around them is shown, so that it reads as something else. */
export const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text from another machine, made safe to print or log: no terminal control sequences, and nothing that reorders it. */
export function printable(text: string): string {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?").replace(BIDI, "?");
}

/** JSON for a terminal or a log: as JSON.stringify writes it, with C1 controls, reordering characters and line separators written as \uXXXX too. */
export function printableJson(value: unknown): string {
  const unsafe = new RegExp(`[\\u007f-\\u009f\\u2028\\u2029]|${BIDI.source}`, "g");
  return JSON.stringify(value, null, 2).replace(unsafe, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
