import { isIP } from "node:net";
import { Command } from "commander";
import { z } from "zod";

const roles = ["listen", "connect", "windows", "wsl"] as const;
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
});

export interface PeerConfig {
  role: PeerRole;
  mode: "listen" | "connect";
  bind: string;
  port: number;
  url: string;
  noRepl: boolean;
  remote: boolean;
}

export function isLoopback(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

function resolveOptions(role: PeerRole, rawOptions: unknown, destination: string | undefined, platform: NodeJS.Platform): PeerConfig {
  if (role === "windows" && platform !== "win32") throw new Error("The windows shortcut requires a native Windows runtime.");
  if (role === "wsl" && platform !== "linux") throw new Error("The wsl shortcut requires a Linux/WSL runtime.");
  const mode = role === "listen" || role === "windows" ? "listen" : "connect";
  const { bind, port, repl, allowRemote } = peerOptionsSchema.parse(rawOptions);
  if (mode === "listen" && !isLoopback(bind) && !allowRemote) {
    throw new Error("A non-loopback listener exposes shell access. Add --allow-remote only for a trusted LAN/VPN test.");
  }
  let url = `ws://${isIP(bind) === 6 ? `[${bind}]` : bind}:${port}`;
  if (role === "connect") {
    if (!destination) throw new Error("connect requires one ws:// or wss:// URL.");
    const parsed = new URL(destination);
    if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
    }
    url = parsed.href;
  }
  return {
    role, mode, bind, port, url, noRepl: !repl,
    remote: mode === "listen" ? !isLoopback(bind) : !isLoopback(new URL(url).hostname),
  };
}

export function addPeerCommands(program: Command, run: (config: PeerConfig) => void | Promise<void>, platform: NodeJS.Platform = process.platform): void {
  const descriptions: Record<PeerRole, string> = {
    listen: "Listen for one peer (macOS, Linux or Windows)",
    connect: "Connect to a ws:// or wss:// peer",
    windows: "Listen on Windows loopback for the WSL peer",
    wsl: "Connect from WSL to the Windows loopback peer",
  };
  for (const role of roles) {
    const command = program.command(role).description(descriptions[role])
      .option("--no-repl", "Disable the interactive command prompt")
      .addHelpText("after", "\nNo authentication. Remote mode is only for a temporary trusted LAN/private VPN test.");
    if (role !== "connect") command.option("--port <port>", "TCP port (default: 47381)");
    if (role === "listen") {
      command.option("--bind <address>", "Numeric interface address (default: 127.0.0.1)")
        .option("--allow-remote", "Explicitly allow a non-loopback listener");
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
    if (role === "connect") {
      command.argument("<url>").action((url: string) => run(resolveOptions(role, command.opts(), url, platform)));
    } else {
      command.action(() => run(resolveOptions(role, command.opts(), undefined, platform)));
    }
  }
}

// The same command definitions are used by the CLI and option unit tests.
export function parseOptions(argv: string[], platform: NodeJS.Platform = process.platform): PeerConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: PeerConfig | undefined;
  addPeerCommands(program, (parsed) => { config = parsed; }, platform);
  program.parse(argv, { from: "user" });
  if (!config) throw new Error("A peer command is required.");
  return config;
}
