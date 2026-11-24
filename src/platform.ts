import os from "node:os";
import path from "node:path";
import { z } from "zod";

// Nix supplies an absolute Bash path without changing the commands’ PATH.
declare const CAPNWEB_DEFAULT_BASH: string;
export const bash = typeof CAPNWEB_DEFAULT_BASH === "string" ? CAPNWEB_DEFAULT_BASH : "bash";

// Largest delay supported by Node timers without overflowing. Zero means no deadline.
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const commandSchema = z.string().max(8192, "Command must be at most 8192 characters.")
  .refine((value) => value.trim().length > 0, "Command must be nonempty.");
/** The most variables a caller adds to a command's environment, and the size of each value: those of mesh secrets. */
export const MAX_ENV_VARIABLES = 64;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;
/**
 * Variables a caller adds to the environment of the command or terminal it starts, such as
 * the secrets `--secret` names. They reach the program and nothing else: no session listing,
 * screen or log holds them.
 */
export const envSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Environment variable names have letters, digits and _, and do not start with a digit."),
  z.string().refine((value) => !value.includes("\0"), "Environment values cannot hold a NUL byte.")
    .refine((value) => Buffer.byteLength(value) <= MAX_ENV_VALUE_BYTES, `Environment values hold at most ${MAX_ENV_VALUE_BYTES} bytes.`),
).refine((env) => Object.keys(env).length <= MAX_ENV_VARIABLES, `At most ${MAX_ENV_VARIABLES} environment variables.`);
export const optionsSchema = z.strictObject({
  timeoutMs: z.int().min(0).max(MAX_TIMEOUT_MS).default(0),
  cwd: z.string().refine(path.isAbsolute, "cwd must be an absolute path on the executing peer.")
    .default(() => os.homedir()),
  env: envSchema.optional(),
});
export type RunOptions = z.input<typeof optionsSchema>;

export const powershell = () => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** Run a command in Windows PowerShell with its quoting and Unicode intact. */
export function powershellArgs(command: string, interactive: boolean): string[] {
  // Base64 preserves quoting/Unicode. Use -Command, not -EncodedCommand:
  // Windows PowerShell 5 serializes stderr as CLIXML with -EncodedCommand.
  const preamble = "$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);\n";
  const encoded = Buffer.from(preamble + command, "utf16le").toString("base64");
  const script = `& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))))`;
  return interactive
    ? ["-NoLogo", "-NoProfile", "-Command", script]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-Command", script];
}
