import { isIP } from "node:net";
import { Command, Option } from "commander";
import { z } from "zod";
import { MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, sessionNameSchema } from "./shell.js";
import { MAX_KEYS } from "./keys.js";

const roles = ["listen", "connect", "run", "tty", "sessions", "keys", "screen", "kill"] as const;
/** Commands that address one named PTY session. */
const sessionRoles = new Set<PeerRole>(["keys", "screen", "kill"]);
type PeerRole = typeof roles[number];
const portSchema = z.string().regex(/^\d+$/, "--port requires an integer.")
  .transform(Number).pipe(z.int().min(1).max(65535));
const bindSchema = z.string().refine((value) => isIP(value) !== 0,
  "--bind requires a numeric IPv4 or IPv6 interface address.");
const dimensionSchema = (name: string) => z.string().regex(/^\d+$/, `${name} requires an integer.`)
  .transform(Number).pipe(z.int().min(1).max(1000));
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
  cols: dimensionSchema("--cols").optional(),
  rows: dimensionSchema("--rows").optional(),
  term: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/, "--term requires a terminfo name.").optional(),
  screen: z.boolean().optional(),
  history: z.string().regex(/^\d+$/, "--history requires an integer.").transform(Number)
    .pipe(z.int().min(0).max(MAX_SCREEN_HISTORY)).optional(),
  name: sessionNameSchema.optional(),
  attach: sessionNameSchema.optional(),
  literal: z.boolean().optional(),
  until: z.string().min(1, "--until requires text.").max(4096).optional(),
  json: z.boolean().optional(),
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
  /** The shell string for run; optional for tty, which otherwise starts a login shell. */
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  cols?: number;
  rows?: number;
  term?: string;
  /** For tty: print the rendered screen when the program ends instead of streaming. For screen: its scrollback. */
  screen?: { history: number };
  /** The named PTY session to start (tty --name), attach to (tty --attach) or address. */
  name?: string;
  attach?: boolean;
  /** For keys: tmux-style key names and literal text. */
  keys?: string[];
  literal?: boolean;
  /** For screen: wait until the screen shows this text. */
  until?: string;
  json?: boolean;
}

export function isLoopback(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

function resolveOptions(role: PeerRole, command: Command, destination: string | undefined): PeerConfig {
  const mode = role === "listen" ? "listen" : "connect";
  const options = { ...command.opts() };
  if (destination !== undefined) {
    for (const name of ["bind", "port"]) {
      if (command.getOptionValueSource(name) === "cli") {
        throw new Error(`Use either a URL or --${name}, not both.`);
      }
      // An explicit URL replaces endpoint defaults, including invalid env values.
      delete options[name];
    }
  }
  const { bind, port, repl, allowRemote, daemon, state, cwd, timeout, cols, rows, term, screen, history, name, attach, literal, until, json } = peerOptionsSchema.parse(options);
  if (role === "tty") {
    if (history !== undefined && !screen) throw new Error("--history requires --screen.");
    if (name !== undefined && attach !== undefined) throw new Error("Use either --name to start a session or --attach to join one, not both.");
    if ((name !== undefined || attach !== undefined) && screen) throw new Error("--screen applies to unnamed sessions; use cns screen NAME for a named one.");
    // The program and its settings were chosen when the session started.
    const fixed = ["cwd", "timeout", "term"].filter((option) => command.getOptionValueSource(option) === "cli");
    if (attach !== undefined && fixed.length) throw new Error(`--attach cannot change --${fixed[0]}; it was set when the session started.`);
  }
  if (role === "screen" && timeout !== undefined && until === undefined) throw new Error("--timeout requires --until.");
  if (mode === "listen" && !isLoopback(bind) && !allowRemote) {
    throw new Error("A non-loopback listener exposes shell access. Add --allow-remote only for a trusted LAN/VPN test.");
  }
  let url = `ws://${isIP(bind) === 6 ? `[${bind}]` : bind}:${port}`;
  if (role === "connect" || destination !== undefined) {
    if (!destination) throw new Error(`${role} requires one ws:// or wss:// URL.`);
    const parsed = new URL(destination);
    if (!["ws:", "wss:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
      throw new Error("Use a ws:// or wss:// URL without credentials or a fragment.");
    }
    url = parsed.href;
  }
  return {
    role, mode, bind, port, url, noRepl: role === "run" || role === "tty" || !repl, daemon, state, cwd, timeoutMs: timeout,
    cols, rows, term, screen: screen || role === "screen" ? { history: history ?? 0 } : undefined,
    name: name ?? attach, attach: attach !== undefined, literal, until, json,
    remote: mode === "listen" ? !isLoopback(bind) : !isLoopback(new URL(url).hostname),
  };
}

export function addPeerCommands(program: Command, run: (config: PeerConfig) => void | Promise<void>): void {
  program.enablePositionalOptions();
  const descriptions: Record<PeerRole, string> = {
    listen: "Listen for peers (macOS, Linux or Windows)",
    run: "Execute one shell command on a peer and exit with its status",
    connect: "Connect to a ws:// or wss:// peer",
    tty: "Open an interactive terminal (PTY) on a peer, or start a named session",
    sessions: "List a peer's named PTY sessions",
    keys: "Send keys to a named PTY session",
    screen: "Print a named PTY session's screen, optionally once it shows some text",
    kill: "End a named PTY session and remove it",
  };
  for (const role of roles) {
    const command = program.command(role).description(descriptions[role])
      .addHelpText("after", "\nNo authentication. Remote mode is only for a temporary trusted LAN/private VPN test.");
    if (role === "listen" || role === "connect") command.option("--no-repl", "Disable the interactive command prompt");
    if (role === "sessions" || sessionRoles.has(role)) {
      command.addHelpText("after", "\nNamed sessions live in the peer's cns process: they survive this command and reconnects,\nand end when they are killed or that process stops. Start one with cns tty --name NAME.");
    }
    if (role !== "connect") {
      command.addOption(new Option("--bind <address>", `Numeric ${role === "listen" ? "interface" : "remote peer"} address (default: 127.0.0.1)`).env("CNS_BIND"))
        .addOption(new Option("--port <port>", "TCP port (default: 47381)").env("CNS_PORT"));
    }
    if (role === "listen") {
      command.option("--allow-remote", "Explicitly allow a non-loopback listener")
        .option("--daemon", "Run the listener in the background")
        .option("--state <path>", "Local daemon state file");
    }
    if (role === "run" || role === "tty") {
      command.addOption(new Option("--cwd <path>", "Absolute working directory on the remote peer").env("CNS_CWD"))
        .option("--timeout <ms>", `Command timeout, 0-${MAX_TIMEOUT_MS} ms (0 disables it)`);
    }
    if (role === "sessions") command.option("--json", "Print the sessions as JSON");
    if (role === "keys") {
      command.option("-l, --literal", "Send every argument as literal text, without key names")
        .addHelpText("after", `\nEach argument is a tmux-style key name or literal text, up to ${MAX_KEYS} arguments:\n  Enter Tab BTab Escape Space BSpace Up Down Left Right Home End PageUp PageDown\n  Insert Delete F1-F12, and C-, M- or S- prefixes, such as C-c, M-x, C-Left or S-Tab.\nArguments that are not key names are typed as they are. Put -- before text starting with -.\nExamples: cns keys build 'make test' Enter    cns keys build C-c    cns keys build -- -n Enter`);
    }
    if (role === "screen") {
      command.option("--history <lines>", `Include up to ${MAX_SCREEN_HISTORY} scrollback lines`)
        .option("--until <text>", "Wait until the screen shows this text, then print it")
        .option("--timeout <ms>", `With --until, stop waiting after this long (default: 30000; 0 waits indefinitely)`)
        .addHelpText("after", "\n--until exits 0 once the text appears, 1 if the program ends first and 124 on timeout,\nprinting the screen in each case. It checks the screen after every chunk of output.");
    }
    if (role === "tty") {
      command.option("--cols <n>", "Terminal width (default: this terminal's, else 80)")
        .option("--rows <n>", "Terminal height (default: this terminal's, else 24)")
        .option("--term <name>", "TERM for the remote program (default: xterm-256color)")
        .option("--screen", "Print the rendered screen when the program ends instead of its raw output")
        .option("--history <lines>", `With --screen, include up to ${MAX_SCREEN_HISTORY} scrollback lines`)
        .option("--name <name>", "Start a named session in the background and return; see cns keys, screen and kill")
        .option("--attach <name>", "Attach to a named session; Ctrl-] detaches and leaves it running")
        .addHelpText("after", "\nWithout a command, starts the remote user's login shell (PowerShell on Windows). Otherwise pass\nexactly one quoted string after -- in the remote shell's syntax. A local terminal is switched to raw mode, so keys such as Ctrl-C go to\nthe remote program. Piped input is forwarded verbatim; send \\x04 yourself for Ctrl-D.\n--screen prints what the terminal shows, like tmux capture-pane; combine it with --timeout to\nsnapshot a program that keeps running.\n--name starts a session that outlives this command; --timeout then limits its lifetime.\nExamples: cns tty    cns tty --cwd /srv/app -- 'claude'    printf 'ls\\nexit\\n' | cns tty\n          cns tty --screen --timeout 5000 -- 'htop'\n          cns tty --name build -- 'make watch'    cns tty --attach build");
    }
    if (role === "run") {
      command.addHelpText("after", "\nPass exactly one quoted shell string after --. Your local shell removes the outer quotes.\nWithout a URL, use --bind/--port, then CNS_BIND/CNS_PORT, then 127.0.0.1:47381.\nAn explicit URL overrides endpoint environment variables; do not combine it with --bind/--port.\nExample: cns run -- 'printf \"hello\\n\"'");
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
      command.usage("[url] [options] -- <command>")
        .argument("[url]").argument("[command]");
      command.action((url: string | undefined, shellCommand: string | undefined) => {
        // With no URL, Commander puts the shell command in the first argument.
        if (shellCommand === undefined) {
          shellCommand = url;
          url = undefined;
        }
        // Positional parsing preserves the subcommand delimiter in the parent args.
        const rawArgs = program.args;
        const delimiter = rawArgs.indexOf("--");
        if (delimiter < 0 || rawArgs.length - delimiter !== 2 || rawArgs[delimiter + 1] !== shellCommand) {
          throw new Error("run requires -- followed by exactly one quoted shell command.");
        }
        if (!shellCommand?.trim() || shellCommand.length > 8192) throw new Error("Command must contain 1-8192 characters.");
        return run({ ...resolveOptions(role, command, url), command: shellCommand });
      });
    } else if (role === "tty") {
      command.usage("[url] [options] [-- <command>]")
        .argument("[url]").argument("[command]");
      command.action((url: string | undefined, shellCommand: string | undefined) => {
        const rawArgs = program.args;
        const delimiter = rawArgs.indexOf("--");
        if (delimiter >= 0) {
          if (rawArgs.length - delimiter !== 2) throw new Error("tty accepts exactly one quoted shell command after --.");
          // With no URL, Commander puts the shell command in the first argument.
          if (shellCommand === undefined) {
            shellCommand = url;
            url = undefined;
          }
          if (rawArgs[delimiter + 1] !== shellCommand) throw new Error("tty accepts exactly one quoted shell command after --.");
          if (!shellCommand?.trim() || shellCommand.length > 8192) throw new Error("Command must contain 1-8192 characters.");
        } else if (shellCommand !== undefined) {
          throw new Error("tty requires -- before its shell command.");
        }
        const config = resolveOptions(role, command, url);
        if (config.attach && shellCommand !== undefined) throw new Error("--attach joins a running session; it does not take a command.");
        return run({ ...config, command: shellCommand });
      });
    } else if (role === "sessions") {
      command.usage("[url] [options]").argument("[url]").action((url: string | undefined) => run(resolveOptions(role, command, url)));
    } else if (sessionRoles.has(role)) {
      command.usage(role === "keys" ? "[url] [options] <name> <keys...>" : "[url] [options] <name>")
        .argument("<arguments...>");
      command.action((values: string[]) => {
        const args = [...values];
        // Session names cannot contain ':', so a ws:// or wss:// URL is unambiguous.
        const url = /^wss?:\/\//i.test(args[0] ?? "") ? args.shift() : undefined;
        const name = sessionNameSchema.parse(args.shift() ?? "");
        if (role === "keys") {
          if (!args.length) throw new Error("keys requires at least one key or text after the session name.");
          if (args.length > MAX_KEYS) throw new Error(`keys accepts at most ${MAX_KEYS} keys.`);
        } else if (args.length) throw new Error(`${role} takes one session name.`);
        return run({ ...resolveOptions(role, command, url), name, keys: role === "keys" ? args : undefined });
      });
    } else if (role === "connect") {
      command.argument("<url>").action((url: string) => run(resolveOptions(role, command, url)));
    } else {
      command.action(() => run(resolveOptions(role, command, undefined)));
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
