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
