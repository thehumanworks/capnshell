import { isIP } from "node:net";
import { Command } from "commander";
import { z } from "zod";
import { MAX_TIMEOUT_MS } from "./shell.js";

const roles = ["listen", "connect", "run"] as const;
type PeerRole = typeof roles[number];
const portSchema = z.string().regex(/^\d+$/, "--port requires an integer.")
  .transform(Number).pipe(z.int().min(1).max(65535));
const bindSchema = z.string().refine((value) => isIP(value) !== 0,
  "--bind requires a numeric IPv4 or IPv6 interface address.");
const peerOptionsSchema = z.strictObject({
  bind: bindSchema.default("127.0.0.1"),
  port: portSchema.default(47381),
  repl: z.boolean().default(true),
  allowRemote: z.boolean().default(false),
  daemon: z.boolean().default(false),
  state: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  timeout: z.string().regex(/^\d+$/, "--timeout requires an integer.").transform(Number)
    .pipe(z.int().min(0).max(MAX_TIMEOUT_MS)).optional(),
});

export interface PeerConfig {
  role: PeerRole;
  mode: "listen" | "connect";
  bind: string;
  port: number;
  url: string;
  noRepl: boolean;
  remote: boolean;
  daemon: boolean;
  state?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export function isLoopback(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

function resolveOptions(role: PeerRole, rawOptions: unknown, destination: string | undefined): PeerConfig {
  const mode = role === "listen" ? "listen" : "connect";
  const { bind, port, repl, allowRemote, daemon, state, cwd, timeout } = peerOptionsSchema.parse(rawOptions);
  if (mode === "listen" && !isLoopback(bind) && !allowRemote) {
    throw new Error("A non-loopback listener exposes shell access. Add --allow-remote only for a trusted LAN/VPN test.");
  }
  let url = `ws://${isIP(bind) === 6 ? `[${bind}]` : bind}:${port}`;
  if (role === "connect" || role === "run") {
    if (!destination) throw new Error(`${role} requires one ws:// or wss:// URL.`);
    const parsed = new URL(destination);
    if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
    }
    url = parsed.href;
  }
  return {
    role, mode, bind, port, url, noRepl: role === "run" || !repl, daemon, state, cwd, timeoutMs: timeout,
    remote: mode === "listen" ? !isLoopback(bind) : !isLoopback(new URL(url).hostname),
  };
}

export function addPeerCommands(program: Command, run: (config: PeerConfig) => void | Promise<void>): void {
  program.enablePositionalOptions();
  const descriptions: Record<PeerRole, string> = {
    listen: "Listen for peers (macOS, Linux or Windows)",
    run: "Execute one shell command on a peer and exit with its status",
    connect: "Connect to a ws:// or wss:// peer",
  };
  for (const role of roles) {
    const command = program.command(role).description(descriptions[role])
      .addHelpText("after", "\nNo authentication. Remote mode is only for a temporary trusted LAN/private VPN test.");
    if (role !== "run") command.option("--no-repl", "Disable the interactive command prompt");
    if (role === "listen") command.option("--port <port>", "TCP port (default: 47381)");
    if (role === "listen") {
      command.option("--bind <address>", "Numeric interface address (default: 127.0.0.1)")
        .option("--allow-remote", "Explicitly allow a non-loopback listener")
        .option("--daemon", "Run the listener in the background")
        .option("--state <path>", "Local daemon state file");
    }
    if (role === "run") {
      command.option("--cwd <path>", "Absolute working directory on the remote peer")
        .option("--timeout <ms>", `Command timeout, 0-${MAX_TIMEOUT_MS} ms (0 disables it)`)
        .addHelpText("after", "\nPass exactly one quoted shell string after --. Your local shell removes the outer quotes.\nExample: cns run ws://localhost:47381 -- 'printf \"hello\\n\"'");
    }
    // Commander handles parsing/help; reject repeats rather than silently using
    // the last value for security-sensitive listener options.
    const seen = new Set<string>();
    for (const option of command.options) {
      command.on(`option:${option.name()}`, () => {
        if (seen.has(option.name())) throw new Error(`Duplicate option: --${option.name()}`);
        seen.add(option.name());
      });
    }
    if (role === "run") {
      command.argument("<url>").argument("<command>").action((url: string, shellCommand: string) => {
        // Positional parsing preserves the subcommand delimiter in the parent args.
        const rawArgs = program.args;
        const delimiter = rawArgs.indexOf("--");
        if (delimiter < 0 || rawArgs.length - delimiter !== 2 || rawArgs[delimiter + 1] !== shellCommand) {
          throw new Error("run requires -- followed by exactly one quoted shell command.");
        }
        if (!shellCommand.trim() || shellCommand.length > 8192) throw new Error("Command must contain 1-8192 characters.");
        return run({ ...resolveOptions(role, command.opts(), url), command: shellCommand });
      });
    } else if (role === "connect") {
      command.argument("<url>").action((url: string) => run(resolveOptions(role, command.opts(), url)));
    } else {
      command.action(() => run(resolveOptions(role, command.opts(), undefined)));
    }
  }
}

// The same command definitions are used by the CLI and option unit tests.
export function parseOptions(argv: string[]): PeerConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: PeerConfig | undefined;
  addPeerCommands(program, (parsed) => { config = parsed; });
  program.parse(argv, { from: "user" });
  if (!config) throw new Error("A peer command is required.");
  return config;
}
