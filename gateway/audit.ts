import type { ToolCall } from "../src/mcp/server.js";

/** What the audit log keeps of a call: enough to see what was done where, never file contents or typed keys. */
export function describeCall(call: ToolCall): string {
  const args = call.args;
  const text = (value: unknown, limit = 500) => {
    const string = String(value);
    return string.length > limit ? `${string.slice(0, limit)}...` : string;
  };
  // Secrets by name only: their values never reach the gateway.
  const secrets = Array.isArray(args.secrets) ? ` with secrets ${text(args.secrets.join(", "), 500)}` : "";
  switch (call.tool) {
    case "run_command": return `${text(args.command)}${args.cwd ? ` (in ${text(args.cwd, 200)})` : ""}${secrets}`;
    case "start_session": return `${text(args.name, 64)}: ${args.command === undefined ? "login shell" : text(args.command)}${secrets}`;
    case "send_keys": return `${text(args.name, 64)}: ${Array.isArray(args.keys) ? args.keys.length : 0} keys`;
    case "read_screen": case "kill_session": return text(args.name, 64);
    case "write_file": return `${text(args.path, 1000)} (${typeof args.content === "string" ? new TextEncoder().encode(args.content).length : 0} bytes)`;
    case "read_file": case "list_directory": return text(args.path, 1000);
    case "glob": return `${text(args.pattern, 500)}${args.path ? ` in ${text(args.path, 500)}` : ""}`;
    case "read_skill": return `${text(args.name, 255)}/${args.file === undefined ? "SKILL.md" : text(args.file, 1000)}`;
    case "search_skills": return text(args.pattern, 500);
    default: return "";
  }
}
