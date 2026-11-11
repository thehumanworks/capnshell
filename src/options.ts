import { isIP } from "node:net";
import { resolvePeer, type Permission } from "./peers.js";
import { Command, Option } from "commander";
import { z } from "zod";
import { MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, sessionNameSchema } from "./shell.js";
import { MAX_KEYS } from "./keys.js";
import type { CopyRequest } from "./commands/copy.js";

const roles = ["run", "tty", "cp", "sessions", "keys", "screen", "kill"] as const;
/** Commands that address one named PTY session. */
const sessionRoles = new Set<PeerRole>(["keys", "screen", "kill"]);
type PeerRole = typeof roles[number];
/** A paired device a command reaches: the identity it must prove and every address saved for it. */
export type ExpectedPeer = { name: string; publicKey: string; outgoing: Permission[]; addresses: string[] };
const portSchema = (name = "--port") => z.string().regex(/^\d+$/, `${name} requires an integer.`)
  .transform(Number).pipe(z.int().min(1).max(65535));
const bindSchema = (name = "--bind") => z.string().refine((value) => isIP(value) !== 0,
  `${name} requires a numeric IPv4 or IPv6 interface address.`);
const dimensionSchema = (name: string) => z.string().regex(/^\d+$/, `${name} requires an integer.`)
  .transform(Number).pipe(z.int().min(1).max(1000));
const daemonOptionsSchema = z.strictObject({
  bind: bindSchema(),
  port: portSchema(),
  service: z.boolean().default(false),
  state: z.string().min(1),
});
const peerOptionsSchema = z.strictObject({
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
  stdin: z.boolean().default(true),
  recursive: z.boolean().optional(),
});

/**
 * The daemon `cns up` starts, or the service runs: it listens for paired devices at
 * `url`, registers at the relay and keeps standing links to every paired device.
 */
export interface DaemonConfig {
  role: "daemon";
  bind: string;
  port: number;
  url: string;
  /** The listener accepts connections from other machines. */
  remote: boolean;
  /** Run in the foreground under launchd or systemd: it serves its control endpoint without a parent. */
  service: boolean;
  state: string;
}

/** One command on a paired device. */
export interface PeerConfig {
  role: PeerRole;
  /** The paired device the command reaches, from its saved name. */
  expect: ExpectedPeer;
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
  /** For run: forward this process's stdin when it is not a terminal (the default). */
  stdin?: boolean;
  /** For cp: what to copy, from where to where. */
  copy?: CopyRequest;
  /** For cp between two paired devices: the destination, which `expect`, the source, is not. */
  copyTo?: ExpectedPeer;
}

export function isLoopback(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, "");
  return unwrapped === "::1" || (isIP(unwrapped) === 4 && unwrapped.startsWith("127."));
}

export const endpointUrl = (bind: string, port: number) => `ws://${isIP(bind) === 6 ? `[${bind}]` : bind}:${port}`;

// Commander handles parsing/help; reject repeats rather than silently using
// the last value for security-sensitive listener options.
function rejectRepeatedOptions(command: Command) {
  const seen = new Set<string>();
  for (const option of command.options) {
    command.on(`option:${option.name()}`, () => {
      if (seen.has(option.name())) throw new Error(`Duplicate option: --${option.name()}`);
      seen.add(option.name());
    });
  }
}

function resolveOptions(role: PeerRole, command: Command, device: string): PeerConfig {
  const expect = resolvePeer(device);
  const { cwd, timeout, cols, rows, term, screen, history, name, attach, literal, until, json, stdin } = peerOptionsSchema.parse({ ...command.opts() });
  if (role === "tty") {
    if (history !== undefined && !screen) throw new Error("--history requires --screen.");
    if (name !== undefined && attach !== undefined) throw new Error("Use either --name to start a session or --attach to join one, not both.");
    if ((name !== undefined || attach !== undefined) && screen) throw new Error("--screen applies to unnamed sessions; use cns screen DEVICE NAME for a named one.");
    // The program and its settings were chosen when the session started.
    const fixed = ["cwd", "timeout", "term"].filter((option) => command.getOptionValueSource(option) === "cli");
    if (attach !== undefined && fixed.length) throw new Error(`--attach cannot change --${fixed[0]}; it was set when the session started.`);
  }
  if (role === "screen" && timeout !== undefined && until === undefined) throw new Error("--timeout requires --until.");
  return {
    role, expect, cwd, timeoutMs: timeout,
    cols, rows, term, screen: screen || role === "screen" ? { history: history ?? 0 } : undefined,
    name: name ?? attach, attach: attach !== undefined, literal, until, json, ...role === "run" ? { stdin } : {},
  };
}

/**
 * The hidden `cns daemon` command that `cns up` and the service run. It is not for people:
 * `cns up` chooses its options and supervises it.
 */
export function addDaemonCommand(program: Command, run: (config: DaemonConfig) => void | Promise<void>): void {
  const command = program.command("daemon", { hidden: true })
    .description("Run the paired daemon (started by cns up)")
    .requiredOption("--bind <address>", "Numeric interface address")
    .requiredOption("--port <port>", "TCP port")
    .requiredOption("--state <path>", "Daemon state file")
    .option("--service", "Run in the foreground for launchd or systemd (used by cns up --install)");
  rejectRepeatedOptions(command);
  command.action(() => {
    const { bind, port, service, state } = daemonOptionsSchema.parse({ ...command.opts() });
    return run({ role: "daemon", bind, port, url: endpointUrl(bind, port), remote: !isLoopback(bind), service, state });
  });
}

export function addPeerCommands(program: Command, run: (config: PeerConfig) => void | Promise<void>): void {
  program.enablePositionalOptions();
  const descriptions: Record<PeerRole, string> = {
    run: "Execute one shell command on a paired device and exit with its status",
    tty: "Open an interactive terminal (PTY) on a paired device, or start a named session",
    cp: "Copy files or directories between this device and a paired device, or between two paired devices",
    sessions: "List a paired device's named PTY sessions",
    keys: "Send keys to a named PTY session",
    screen: "Print a named PTY session's screen, optionally once it shows some text",
    kill: "End a named PTY session and remove it",
  };
  const device = "The paired device's name, as cns pair saved it";
  for (const role of roles) {
    const command = program.command(role).description(descriptions[role]);
    if (role === "sessions" || sessionRoles.has(role)) {
      command.addHelpText("after", "\nNamed sessions live in the device's daemon: they survive this command and reconnects,\nand end when they are killed or the daemon stops. A session whose program has ended keeps its\nfinal screen for an hour, or until a new session needs its place. Start one with cns tty DEVICE --name NAME.");
    }
    if (role === "run" || role === "tty") {
      command.addOption(new Option("--cwd <path>", "Absolute working directory on the device").env("CNS_CWD"))
        .option("--timeout <ms>", `Command timeout, 0-${MAX_TIMEOUT_MS} ms (0 disables it)`);
    }
    if (role === "run") command.option("-n, --no-stdin", "Do not forward this process's stdin to the command");
    if (role === "sessions") command.option("--json", "Print the sessions as JSON");
    if (role === "cp") {
      command.option("-r, --recursive", "Copy directories and everything in them");
      command.addHelpText("after", "\nEither path, or both, is on a paired device, written DEVICE:PATH. A relative or ~/ remote path\nstarts at the remote user's home. A destination that is a directory, or ends with /, receives\nthe source under its own name. New files keep the source's permission bits. -r copies a\ndirectory; links to files are copied as files, links to directories and special files are\nskipped, and the command then exits 1. Between two paired devices the data passes through\nthis one. Needs the files grant on each paired device.\nExamples: cns cp ./build.tar.gz studio:/tmp/    cns cp studio:~/notes.txt .\n          cns cp -r ./site studio:/srv/    cns cp -r studio:~/photos nas:~/backup/");
    }
    if (role === "keys") {
      command.option("-l, --literal", "Send every argument as literal text, without key names")
        .addHelpText("after", `\nEach argument is a tmux-style key name or literal text, up to ${MAX_KEYS} arguments:\n  Enter Tab BTab Escape Space BSpace Up Down Left Right Home End PageUp PageDown\n  Insert Delete F1-F12, and C-, M- or S- prefixes, such as C-c, M-x, C-Left or S-Tab.\nArguments that are not key names are typed as they are. Put -- before text starting with -.\nExamples: cns keys studio build 'make test' Enter    cns keys studio build C-c\n          cns keys studio build -- -n Enter`);
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
        .addHelpText("after", "\nWithout a command, starts the remote user's login shell (PowerShell on Windows). At a terminal it\nruns in a session of its own, tty-1, tty-2 and so on, which survives disconnects and ends with the\nshell or when this terminal closes; Ctrl-] detaches and leaves it running for --attach NAME.\nOtherwise everything after -- is the command, in the remote shell's syntax; several words are\njoined with spaces, as ssh does. A local terminal is switched to raw mode, so keys such as\nCtrl-C go to the remote program. Piped input is forwarded verbatim; send \\x04 yourself for Ctrl-D.\n--screen prints what the terminal shows, like tmux capture-pane; combine it with --timeout to\nsnapshot a program that keeps running.\n--name starts a session that outlives this command; --timeout then limits its lifetime.\nExamples: cns tty studio    cns tty studio --cwd /srv/app -- 'claude'    printf 'ls\\nexit\\n' | cns tty studio\n          cns tty studio --screen --timeout 5000 -- 'htop'\n          cns tty studio --name build -- 'make watch'    cns tty studio --attach build");
    }
    if (role === "run") {
      command.addHelpText("after", "\nEverything after -- is the command, in the remote shell's syntax. Several words are joined\nwith spaces, as ssh does; quote what your local shell would otherwise expand, such as $HOME,\nglobs, pipes and ;. One quoted string reaches the remote shell unchanged.\nExamples: cns run studio -- git status    cns run studio -- ls -la /tmp\n          cns run studio -- 'cd /srv && make'    cns run studio -- 'printf \"hello\\n\"'");
    }
    rejectRepeatedOptions(command);
    if (role === "run" || role === "tty") {
      command.usage(role === "run" ? "<device> [options] -- <command...>" : "<device> [options] [-- <command...>]")
        .argument("<device>", device).argument("[command...]");
      command.action((name: string, words: string[]) => {
        // Positional parsing preserves the subcommand delimiter in the parent args.
        const rawArgs = program.args;
        const delimiter = rawArgs.indexOf("--");
        const after = delimiter < 0 ? [] : rawArgs.slice(delimiter + 1);
        if (delimiter >= 0 && !words.length && after[0] === name) throw new Error(`${role} requires a paired device's name: cns ${role} DEVICE -- command.`);
        if (delimiter < 0 ? words.length || role === "run" : after.length !== words.length) {
          throw new Error(`${role} requires -- before its command: cns ${role} DEVICE -- command.`);
        }
        // Everything after the first -- is the command. Several words are joined with spaces, as ssh does,
        // and the remote shell parses the result; one quoted string reaches it unchanged.
        const shellCommand = delimiter < 0 ? undefined : words.join(" ");
        if (shellCommand !== undefined && (!shellCommand.trim() || shellCommand.length > 8192)) throw new Error("Command must contain 1-8192 characters.");
        const config = resolveOptions(role, command, name);
        if (config.attach && shellCommand !== undefined) throw new Error("--attach joins a running session; it does not take a command.");
        return run({ ...config, command: shellCommand });
      });
    } else if (role === "cp") {
      command.usage("[options] <source> <destination>").argument("<source>").argument("<destination>");
      command.action((source: string, destination: string) => {
        const from = splitRemote(source);
        const to = splitRemote(destination);
        if (!from && !to) throw new Error("cp needs a path on a paired device, written DEVICE:PATH.");
        if ((!from && !source) || (!to && !destination)) throw new Error("cp needs a local path.");
        const { recursive } = command.opts<{ recursive?: boolean }>();
        const copy: CopyRequest = {
          source: from ? { device: from.target, path: from.path } : { path: source },
          destination: to ? { device: to.target, path: to.path } : { path: destination },
          recursive: recursive === true,
        };
        // The command connects to the source device when there is one, else to the destination.
        const config = resolveOptions(role, command, (from ?? to)!.target);
        if (from && to && to.target !== from.target) return run({ ...config, copy, copyTo: resolvePeer(to.target) });
        return run({ ...config, copy });
      });
    } else if (role === "sessions") {
      command.usage("<device> [options]").argument("<device>", device).action((name: string) => run(resolveOptions(role, command, name)));
    } else {
      command.usage(role === "keys" ? "<device> [options] <name> <keys...>" : "<device> [options] <name>")
        .argument("<device>", device).argument("<arguments...>");
      command.action((target: string, values: string[]) => {
        const args = [...values];
        const name = sessionNameSchema.parse(args.shift() ?? "");
        if (role === "keys") {
          if (!args.length) throw new Error("keys requires at least one key or text after the session name.");
          if (args.length > MAX_KEYS) throw new Error(`keys accepts at most ${MAX_KEYS} keys.`);
        } else if (args.length) throw new Error(`${role} takes one session name.`);
        return run({ ...resolveOptions(role, command, target), name, keys: role === "keys" ? args : undefined });
      });
    }
  }
}

/**
 * `DEVICE:PATH` names a path on a paired device, as with scp: a colon before any slash. A
 * Windows drive letter such as C:\\ stays local, and a local path with a colon can be written ./a:b.
 */
export function splitRemote(value: string, platform: NodeJS.Platform = process.platform): { target: string; path: string } | undefined {
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = value.slice(0, colon);
  if (/[\\/]/.test(prefix)) return undefined;
  if (platform === "win32" && /^[A-Za-z]$/.test(prefix)) return undefined;
  if (!prefix) throw new Error(`Name the paired device before the colon: DEVICE${value}.`);
  return { target: prefix, path: value.slice(colon + 1) };
}

// The same command definitions are used by the CLI and option unit tests.
export function parseOptions(argv: string[]): PeerConfig | DaemonConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: PeerConfig | DaemonConfig | undefined;
  addPeerCommands(program, (parsed) => { config = parsed; });
  addDaemonCommand(program, (parsed) => { config = parsed; });
  program.parse(argv, { from: "user" });
  if (!config) throw new Error("A peer command is required.");
  return config;
}

export interface McpConfig {
  /** The paired device the tools reach; without one, the devices linked to the local daemon. */
  expect?: { name: string; publicKey: string; addresses: string[] };
  /** The local daemon's state file, when the tools use its linked devices. */
  state?: string;
  cwd?: string;
  /** Serve Streamable HTTP rather than stdio. */
  http?: { bind: string; port: number; remote: boolean };
}

const mcpOptionsSchema = z.strictObject({
  state: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  http: portSchema("--http").optional(),
  httpBind: bindSchema("--http-bind").optional(),
  allowRemote: z.boolean().default(false),
});

function resolveMcpOptions(command: Command, device: string | undefined): McpConfig {
  const { state, cwd, http, httpBind, allowRemote } = mcpOptionsSchema.parse({ ...command.opts() });
  if (state !== undefined && device !== undefined) throw new Error("--state applies to the daemon's linked devices; a named device is reached directly.");
  if (http === undefined) {
    if (httpBind !== undefined) throw new Error("--http-bind requires --http.");
    if (allowRemote) throw new Error("--allow-remote requires --http.");
  }
  const address = httpBind ?? "127.0.0.1";
  if (http !== undefined && !isLoopback(address) && !allowRemote) {
    throw new Error("A non-loopback MCP endpoint exposes shell access. Add --allow-remote only for a trusted LAN/VPN.");
  }
  let expect: McpConfig["expect"];
  if (device !== undefined) {
    const peer = resolvePeer(device);
    expect = { name: peer.name, publicKey: peer.publicKey, addresses: peer.addresses };
  }
  return {
    ...expect ? { expect } : {}, state, cwd,
    http: http === undefined ? undefined : { bind: address, port: http, remote: !isLoopback(address) },
  };
}

export function addMcpCommand(program: Command, run: (config: McpConfig) => void | Promise<void>): void {
  const command = program.command("mcp")
    .description("Serve MCP tools that run commands and terminal sessions on paired devices")
    .usage("[device] [options]")
    .argument("[device]", "A paired device's name; without one, the devices linked to the local daemon")
    .option("--state <path>", "Without a device, the local daemon's state file")
    .addOption(new Option("--cwd <path>", "Absolute working directory on devices for calls that do not name one").env("CNS_CWD"))
    .option("--http <port>", "Serve Streamable HTTP at http://127.0.0.1:PORT/mcp instead of stdio")
    .option("--http-bind <address>", "Numeric interface address for --http (default: 127.0.0.1)")
    .option("--allow-remote", "Explicitly allow a non-loopback --http-bind")
    .addHelpText("after", `
By default an MCP client starts cns mcp and talks to it over stdin and stdout. With a device's
name the tools reach that paired device, connecting for each call. Without one they use the
devices linked to this device's daemon (cns up), chosen by name in each call.
--http clients must send Authorization: Bearer TOKEN. TOKEN is CNS_MCP_TOKEN, at least 32
characters, or else a random token printed at startup. Browser origins are refused.
Clients get shell access as the devices' users: connect only clients you would trust with it.
Examples: cns mcp studio    cns mcp --cwd /srv/app
          CNS_MCP_TOKEN=$(openssl rand -hex 32) cns mcp studio --http 47382`);
  rejectRepeatedOptions(command);
  command.action((device: string | undefined) => run(resolveMcpOptions(command, device)));
}

export function parseMcpOptions(argv: string[]): McpConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: McpConfig | undefined;
  addMcpCommand(program, (parsed) => { config = parsed; });
  program.parse(["mcp", ...argv], { from: "user" });
  if (!config) throw new Error("The mcp command did not run.");
  return config;
}
