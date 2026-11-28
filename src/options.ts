import { isIP } from "node:net";
import { resolvePeer, type Permission } from "./peers.js";
import { Command, Option } from "commander";
import { z } from "zod";
import { MAX_SCREEN_HISTORY, MAX_TIMEOUT_MS, sessionNameSchema } from "./shell.js";
import { MAX_KEYS } from "./keys.js";
import { parseSwitchKey } from "./switcher.js";
import type { CopyRequest } from "./commands/copy.js";

const roles = ["run", "shell", "cp", "sessions", "keys", "screen", "kill"] as const;
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
  supervise: z.boolean().default(false),
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
  detached: z.boolean().optional(),
  session: sessionNameSchema.optional(),
  device: z.string().min(1).optional(),
  command: z.string().optional(),
  secret: z.array(z.string()).optional(),
  key: z.string().optional(),
  kittyKeys: z.boolean().optional(),
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
  /** Run the daemon with --service and start it again after it fails: the Windows scheduled task's command. */
  supervise?: true;
  state: string;
}

/** `cns sessions` without a device: every paired device's named sessions. */
export interface SessionsEverywhereConfig {
  role: "sessions";
  everywhere: true;
  json: boolean;
}

/** One command on a paired device. */
export interface PeerConfig {
  role: PeerRole;
  /** The paired device the command reaches, from its saved name. */
  expect: ExpectedPeer;
  /** The shell string for run; optional for shell, which otherwise starts a login shell. */
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  cols?: number;
  rows?: number;
  term?: string;
  /** For shell: print the rendered screen when the program ends instead of streaming. For screen: its scrollback. */
  screen?: { history: number };
  /** The named PTY session to start (shell --name), attach to (shell --attach), run a command in (shell -d --session) or address. */
  name?: string;
  attach?: boolean;
  /**
   * For shell -d: type the command into the session `name`, a login shell that keeps running
   * on the device, starting it first when there is none. Without a name, the next free shell-N.
   */
  detached?: boolean;
  /** For shell -d: the options given that apply only when a session starts, so a running one cannot take them. */
  startOnly?: string[];
  /** For run and shell: the mesh secrets to set in the program's environment, each NAME or MESH:NAME. */
  secrets?: string[];
  /** The variables those secrets become, read on this device just before it connects. */
  env?: Record<string, string>;
  /**
   * For shell at a terminal: the key that detaches from a named session, or null when every
   * key goes to the session. Ctrl-] when not set.
   */
  detachKey?: { byte: number; label: string } | null;
  /** For shell at a terminal: pass the kitty keyboard protocol between the session's programs and this terminal. */
  kittyKeys?: boolean;
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

/** Options that are given more than once on purpose: each use adds to a list. */
const repeatable = new Set(["secret"]);
const collect = (value: string, earlier: string[] | undefined) => {
  // Commander hands an option its next word whatever it is, so a forgotten name would take the delimiter.
  if (value === "--") throw new Error("--secret needs a secret's name: --secret NAME, or --secret MESH:NAME.");
  return [...earlier ?? [], value];
};
/** --device and --session, which name what a command reaches, and so must not take the delimiter as a name. */
const naming = (option: string, what: string) => (value: string) => {
  if (value === "--") throw new Error(`--${option} needs ${what}: --${option} NAME.`);
  return value;
};
/** -D, --device: the device a command reaches, given as an option in place of its DEVICE argument. */
export const deviceOption = (description = "The paired device, in place of the DEVICE argument") =>
  new Option("-D, --device <name>", description).argParser(naming("device", "a paired device's name"));
/** For a command whose device may be left out: the one named either way, refusing it named both ways. */
export function oneDevice(command: string, argument: string | undefined, option: string | undefined): string | undefined {
  if (argument !== undefined && option !== undefined) throw new Error(`Name the device once: cns ${command} ${option}, or cns ${command} --device ${option}.`);
  return option ?? argument;
}
/**
 * For a command that needs a device: the one --device names, else its first argument, and the
 * arguments after it. Commander fills the DEVICE argument first, so with --device given, what
 * it holds is the first of the others.
 */
export function deviceAndRest(command: string, operands: string[], option: string | undefined, usage = "DEVICE"): { device: string; rest: string[] } {
  if (option !== undefined) return { device: option, rest: operands };
  const [device, ...rest] = operands;
  if (device === undefined) throw new Error(`${command} requires a paired device's name: cns ${command} ${usage}, or --device DEVICE.`);
  return { device, rest };
}

// Commander handles parsing/help; reject repeats rather than silently using
// the last value for security-sensitive listener options.
function rejectRepeatedOptions(command: Command) {
  const seen = new Set<string>();
  for (const option of command.options) {
    if (repeatable.has(option.name())) continue;
    command.on(`option:${option.name()}`, () => {
      if (seen.has(option.name())) throw new Error(`Duplicate option: --${option.name()}`);
      seen.add(option.name());
    });
  }
}

function resolveOptions(role: PeerRole, command: Command, device: string): PeerConfig {
  const expect = resolvePeer(device);
  const { cwd, timeout, cols, rows, term, screen, history, name, attach, detached, session, secret, key, kittyKeys, literal, until, json, stdin } = peerOptionsSchema.parse({ ...command.opts() });
  const given = (options: string[]) => options.filter((option) => command.getOptionValueSource(option) === "cli");
  // The key cns ui switches with is the key cns shell detaches with; only cns shell can do without one.
  const detach = role === "shell" ? key ?? process.env.CNS_KEY : undefined;
  if (role === "shell") {
    if (history !== undefined && !screen) throw new Error("--history requires --screen.");
    if (name !== undefined && attach !== undefined) throw new Error("Use either --name to start a session or --attach to join one, not both.");
    if ((name !== undefined || attach !== undefined) && screen) throw new Error("--screen applies to unnamed sessions and to -d; use cns screen DEVICE NAME for a named one.");
    if (detached && history !== undefined) throw new Error("-d --screen prints everything from the line the command is typed on, so --history does not go with -d.");
    // The program and its settings were chosen when the session started.
    const fixed = given(["cwd", "timeout", "term", "secret"]);
    if (attach !== undefined && fixed.length) throw new Error(`--attach cannot change --${fixed[0]}; it was set when the session started.`);
    if (session !== undefined && !detached) throw new Error(`--session names the session -d runs a command in: cns shell ${device} -d --session ${session} -- command. To join a session, use --attach ${session}.`);
    // -d returns at once: nothing is shown here, so nothing that starts, joins or shows a session another way goes with it.
    const other = detached ? given(["name", "attach", "key", "kittyKeys"])[0] : undefined;
    if (other !== undefined) throw new Error(`-d runs a command in a session and returns; it does not go with --${other === "kittyKeys" ? "kitty-keys" : other}.${other === "name" ? " Name its session with --session." : ""}`);
  }
  if (role === "screen" && timeout !== undefined && until === undefined) throw new Error("--timeout requires --until.");
  return {
    role, expect, cwd, timeoutMs: timeout,
    cols, rows, term, screen: screen || role === "screen" ? { history: history ?? 0 } : undefined,
    name: name ?? attach ?? session, attach: attach !== undefined, literal, until, json, ...role === "run" ? { stdin } : {},
    ...detached ? { detached: true, startOnly: given(["cwd", "timeout", "term", "cols", "rows", "secret"]) } : {},
    ...secret?.length ? { secrets: secret } : {},
    ...detach === undefined ? {} : { detachKey: /^none$/i.test(detach.trim()) ? null : parseSwitchKey(detach) },
    ...role === "shell" && (kittyKeys ?? /^(1|true|yes|on)$/i.test(process.env.CNS_KITTY_KEYS?.trim() ?? "")) ? { kittyKeys: true } : {},
  };
}

/**
 * `cns daemon`, whose start, stop and restart subcommands cli-program adds. Given --bind, --port
 * and --state instead, it runs the daemon itself, as `cns up` and the services start it; those
 * options are hidden because `cns up` chooses them and supervises the daemon.
 */
export function addDaemonCommand(program: Command, run: (config: DaemonConfig) => void | Promise<void>): Command {
  const command = program.command("daemon")
    .description("Start, stop or restart this device's peer daemon")
    .addOption(new Option("--bind <address>", "Numeric interface address").hideHelp())
    .addOption(new Option("--port <port>", "TCP port").hideHelp())
    .addOption(new Option("--state <path>", "Daemon state file").hideHelp())
    .addOption(new Option("--service", "Run in the foreground for launchd or systemd (used by cns up --install)").hideHelp())
    .addOption(new Option("--supervise", "Run the daemon with --service and restart it after a failure (used by the Windows scheduled task)").hideHelp());
  rejectRepeatedOptions(command);
  command.action(() => {
    const given = command.opts();
    const missing = ["bind", "port", "state"].filter((name) => given[name] === undefined);
    if (missing.length === 3 && !given.service && !given.supervise) command.help({ error: true });
    if (missing.length) throw new Error(`Running the daemon needs --${missing.join(", --")}. To manage it, use cns daemon start, stop or restart.`);
    const { bind, port, service, supervise, state } = daemonOptionsSchema.parse({ ...given });
    return run({ role: "daemon", bind, port, url: endpointUrl(bind, port), remote: !isLoopback(bind), service, ...supervise ? { supervise: true as const } : {}, state });
  });
  return command;
}

export function addPeerCommands(
  program: Command,
  run: (config: PeerConfig) => void | Promise<void>,
  everywhere: (config: SessionsEverywhereConfig) => void | Promise<void> = () => { throw new Error("sessions requires a paired device's name."); },
): void {
  program.enablePositionalOptions();
  const descriptions: Record<PeerRole, string> = {
    run: "Execute one shell command on a paired device and exit with its status",
    shell: "Open an interactive terminal (PTY) on a paired device, or start a named session",
    cp: "Copy files or directories between this device and a paired device, or between two paired devices",
    sessions: "List a paired device's named PTY sessions, or without a device, every paired device's",
    keys: "Send keys to a named PTY session",
    screen: "Print a named PTY session's screen, optionally once it shows some text",
    kill: "End a named PTY session and remove it",
  };
  const device = "The paired device's name, as cns pair saved it";
  for (const role of roles) {
    const command = program.command(role).description(descriptions[role]);
    if (role === "sessions" || sessionRoles.has(role)) {
      command.addHelpText("after", "\nNamed sessions run on the device in processes of their own: they survive this command, reconnects\nand restarts of its daemon, and end when they are killed, their program exits, --timeout passes or\nthe device reboots (on Windows, also when its daemon stops). A session whose program has ended\nkeeps its final screen for an hour, or until a new session needs its place. Start one with\ncns shell DEVICE --name NAME.");
    }
    if (role !== "cp") command.addOption(deviceOption());
    if (sessionRoles.has(role)) command.addOption(new Option("-s, --session <name>", "The session, in place of the NAME argument").argParser(naming("session", "a session's name")));
    if (role === "run" || role === "shell") {
      command.addOption(new Option("-w, --cwd <path>", "Absolute working directory on the device").env("CNS_CWD"))
        .option("-t, --timeout <ms>", `Command timeout, 0-${MAX_TIMEOUT_MS} ms (0 disables it)`);
    }
    if (role === "run" || role === "shell") {
      command.option("-e, --secret <names>", "Set mesh secrets this device reads as the program's environment variables: NAME or MESH:NAME, separated by commas or given again", collect);
    }
    if (role === "run") command.option("-n, --no-stdin", "Do not forward this process's stdin to the command");
    if (role === "sessions") command.option("-j, --json", "Print the sessions as JSON");
    if (role === "cp") {
      command.option("-r, --recursive", "Copy directories and everything in them");
      command.addHelpText("after", "\nEither path, or both, is on a paired device, written DEVICE:PATH. A relative or ~/ remote path\nstarts at the remote user's home. A destination that is a directory, or ends with /, receives\nthe source under its own name. New files keep the source's permission bits. -r copies a\ndirectory; links to files are copied as files, links to directories and special files are\nskipped, and the command then exits 1. Between two paired devices the data passes through\nthis one. Needs the files grant on each paired device.\nExamples: cns cp ./build.tar.gz studio:/tmp/    cns cp studio:~/notes.txt .\n          cns cp -r ./site studio:/srv/    cns cp -r studio:~/photos nas:~/backup/");
    }
    if (role === "keys") {
      command.option("-l, --literal", "Send every argument as literal text, without key names")
        .addHelpText("after", `\nEach argument is a tmux-style key name or literal text, up to ${MAX_KEYS} arguments:\n  Enter Tab BTab Escape Space BSpace Up Down Left Right Home End PageUp PageDown\n  Insert Delete F1-F12, and C-, M- or S- prefixes, such as C-c, M-x, C-Left or S-Tab.\nArguments that are not key names are typed as they are. Put -- before text starting with -.\nExamples: cns keys studio build 'make test' Enter    cns keys studio build C-c\n          cns keys studio build -- -n Enter`);
    }
    if (role === "screen") {
      command.option("-H, --history <lines>", `Include up to ${MAX_SCREEN_HISTORY} scrollback lines`)
        .option("-u, --until <text>", "Wait until the screen shows this text, then print it")
        .option("-t, --timeout <ms>", `With --until, stop waiting after this long (default: 30000; 0 waits indefinitely)`)
        .addHelpText("after", "\n--until exits 0 once the text appears, 1 if the program ends first and 124 on timeout,\nprinting the screen in each case. It checks the screen after every chunk of output.");
    }
    if (role === "shell") {
      command.option("-x, --cols <n>", "Terminal width (default: this terminal's, else 80)")
        .option("-y, --rows <n>", "Terminal height (default: this terminal's, else 24)")
        .option("-T, --term <name>", "TERM for the remote program (default: xterm-256color)")
        .option("-p, --screen", "Print the rendered screen when the program ends instead of its raw output; with -d, once the command ends")
        .option("-H, --history <lines>", `With --screen, include up to ${MAX_SCREEN_HISTORY} scrollback lines`)
        .option("-N, --name <name>", "Start a named session in the background and return; see cns keys, screen and kill")
        .option("-a, --attach <name>", "Attach to a named session; Ctrl-] detaches and leaves it running")
        .option("-d, --detached", "Type the command into a session that keeps running on the device, starting it if needed, and return")
        .addOption(new Option("-s, --session <name>", "With -d, the session to run the command in (default: the next free shell-N, whose name is printed)").argParser(naming("session", "a session's name")))
        .option("-c, --command <command>", "The command, in place of -- command")
        .option("-k, --key <key>", "The key that detaches, such as C-b, or none to send every key to the session (default: CNS_KEY, else C-])")
        .option("-K, --kitty-keys", "Let programs in the session tell keys such as Shift+Enter from Enter; CNS_KITTY_KEYS=1 does the same")
        .addHelpText("after", "\nWithout a command, starts the remote user's login shell (PowerShell on Windows). At a terminal it\nruns in a session of its own, shell-1, shell-2 and so on, which survives disconnects and ends with the\nshell or when this terminal closes; Ctrl-] detaches and leaves it running for --attach NAME.\nIt is shown as ssh shows a shell: its lines scroll into this terminal's own scrollback, and\nevery key but the detach key goes to the session; --key none sends that one too. CNS_KEY sets\nthe key for cns shell and cns ui alike. As over ssh, clear on the device also clears this\nterminal's scrollback. If cns is killed outright (kill -9) while a full-screen program has the\nterminal, run reset to get the terminal back.\n--kitty-keys passes the kitty keyboard protocol on, for programs that ask for it, such as\nClaude Code and Neovim: they then see Shift+Enter, Ctrl+Enter and the like as their own keys.\nIt needs a terminal that speaks the protocol (kitty, Ghostty, foot, Alacritty, iTerm2, Warp,\nWindows Terminal, Rex; not Apple Terminal) and cns 1.10.0 or later on the device; without\neither it changes nothing and says so. The detach key keeps working. A terminal attached to the\nsame session without it, or cns ui, types plain keys there: Shift+Enter is Enter from that one.\nAfter kill -9 the terminal may type codes such as 9;5u: run reset.\nOtherwise everything after -- is the command, in the remote shell's syntax; several words are\njoined with spaces, as ssh does. A local terminal is switched to raw mode, so keys such as\nCtrl-C go to the remote program. Piped input is forwarded verbatim; send \\x04 yourself for Ctrl-D.\n--screen prints what the terminal shows, like tmux capture-pane; combine it with --timeout to\nsnapshot a program that keeps running.\n--name starts a session that outlives this command; --timeout then limits its lifetime.\n-d --session NAME types the command into the session NAME and returns. The session is a login\nshell that keeps running on the device: the first -d starts it, and each later one types another\ncommand into the same shell, so its directory and variables carry over. A program still running\nthere receives what is typed. Read the result with cns screen, join with --attach, end it with\ncns kill. --cwd, --timeout, --term and --secret apply when the session starts.\n-d --screen waits for the command to end, prints what the session shows from the line it was typed\non, and exits 0 with the session still running, whatever the command's status; when the shell\nexits, with the shell's status. The device's\ncns 2.1.0 or later says when the command ends; with an older one, or on Windows, it is once nothing\nnew shows for two seconds. A command that waits for input keeps it waiting: Ctrl-C stops waiting.\n--secret NAME sets a mesh secret this device reads as the variable NAME of the program or session\nstarted; MESH:NAME says which mesh when two hold the name. Values cross the encrypted link beside\nthe command, never in it. See cns secret --help.\nExamples: cns shell studio    cns shell studio --cwd /srv/app -- 'claude'    printf 'ls\\nexit\\n' | cns shell studio\n          cns shell studio --screen --timeout 5000 -- 'htop'\n          cns shell studio --name build -- 'make watch'    cns shell studio --attach build\n          cns shell studio -d --session work -- 'cd /srv/app && make'    cns screen studio work\n          cns shell -d -D studio -s work -p -- 'make test'\n          cns shell studio --secret NPM_TOKEN -- 'npm publish'");
    }
    if (role === "run") {
      command.addHelpText("after", "\nEverything after -- is the command, in the remote shell's syntax. Several words are joined\nwith spaces, as ssh does; quote what your local shell would otherwise expand, such as $HOME,\nglobs, pipes and ;. One quoted string reaches the remote shell unchanged.\n--secret NAME sets a mesh secret this device reads as the command's variable NAME; MESH:NAME says\nwhich mesh when two hold the name. The value crosses the encrypted link beside the command, never\nin it, and the device needs cns 2.0.0 or later. See cns secret --help.\nExamples: cns run studio -- git status    cns run studio -- ls -la /tmp\n          cns run studio -- 'cd /srv && make'    cns run studio -- 'printf \"hello\\n\"'\n          cns run studio --secret home:DEPLOY_KEY -- './deploy.sh'");
    }
    rejectRepeatedOptions(command);
    if (role === "run" || role === "shell") {
      command.usage(role === "run" ? "<device> [options] -- <command...>" : "<device> [options] [-- <command...>]")
        .argument("[device]", `${device}, or --device`).argument("[command...]");
      command.action((first: string | undefined, rest: string[]) => {
        // Positional parsing preserves the subcommand delimiter in the parent args.
        const rawArgs = program.args;
        const delimiter = rawArgs.indexOf("--");
        const words = delimiter < 0 ? [] : rawArgs.slice(delimiter + 1);
        // Commander gives the first operand to DEVICE even when it came after --: what came before -- is the rest.
        const operands = first === undefined ? [] : [first, ...rest];
        const before = operands.slice(0, operands.length - words.length);
        const option = command.opts<{ device?: string }>().device;
        if (option !== undefined && before.length) throw new Error(`With --device, give no DEVICE argument: cns ${role} --device ${option} -- command.`);
        const { device: name, rest: extra } = deviceAndRest(role, before, option, "DEVICE -- command");
        if (extra.length || (delimiter < 0 && role === "run")) {
          throw new Error(`${role} requires -- before its command: cns ${role} DEVICE -- command.`);
        }
        // Everything after the first -- is the command. Several words are joined with spaces, as ssh does,
        // and the remote shell parses the result; one quoted string reaches it unchanged.
        const commandOption = role === "shell" ? command.opts<{ command?: string }>().command : undefined;
        if (commandOption !== undefined && delimiter >= 0) throw new Error("Give the command once: after --command, or after --.");
        const shellCommand = delimiter < 0 ? commandOption : words.join(" ");
        if (shellCommand !== undefined && (!shellCommand.trim() || shellCommand.length > 8192)) throw new Error("Command must contain 1-8192 characters.");
        const config = resolveOptions(role, command, name);
        if (config.attach && shellCommand !== undefined) throw new Error("--attach joins a running session; it does not take a command.");
        if (config.detached && config.screen && shellCommand === undefined) throw new Error("-d --screen prints what a command shows: give the command after --, or with --command.");
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
      command.usage("[device] [options]").argument("[device]", `${device}; without one, every paired device`)
        .addHelpText("after", "\nWithout a device, each paired device that lets this one list its sessions is asked at once, through\nthe local daemon's link when it has one. Devices that do not, or do not answer within 10 seconds,\nare named on stderr. Exit 0 when every device asked answered, 1 when one did not.\n--json then prints one entry per device: { device, state, sessions | reason }, where state is\nlisted, not-granted, refused or unreachable.")
        .action((argument: string | undefined) => {
          const name = oneDevice(role, argument, command.opts<{ device?: string }>().device);
          if (name !== undefined) return run(resolveOptions(role, command, name));
          const { json } = peerOptionsSchema.parse({ ...command.opts() });
          return everywhere({ role: "sessions", everywhere: true, json: json === true });
        });
    } else {
      command.usage(role === "keys" ? "<device> [options] <name> <keys...>" : "<device> [options] <name>")
        .argument("[device]", `${device}, or --device`).argument("[arguments...]");
      command.action((first: string | undefined, values: string[]) => {
        const options = command.opts<{ device?: string; session?: string }>();
        const usage = role === "keys" ? "DEVICE NAME KEYS..." : "DEVICE NAME";
        const { device: target, rest: args } = deviceAndRest(role, first === undefined ? [] : [first, ...values], options.device, usage);
        const given = options.session ?? args.shift();
        if (given === undefined) throw new Error(`${role} requires a session's name: cns ${role} ${usage}, or --session NAME.`);
        const name = sessionNameSchema.parse(given);
        if (role === "keys") {
          if (!args.length) throw new Error("keys requires at least one key or text after the session name.");
          if (args.length > MAX_KEYS) throw new Error(`keys accepts at most ${MAX_KEYS} keys.`);
        } else if (args.length) {
          throw new Error(options.session !== undefined || options.device !== undefined
            ? `${role} takes one session name: with --device or --session, leave that argument out: cns ${role} --device DEVICE --session NAME.`
            : `${role} takes one session name.`);
        }
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
export function parseOptions(argv: string[]): PeerConfig | DaemonConfig | SessionsEverywhereConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: PeerConfig | DaemonConfig | SessionsEverywhereConfig | undefined;
  addPeerCommands(program, (parsed) => { config = parsed; }, (parsed) => { config = parsed; });
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
  /** Variables of this process that tool calls may set for their programs, by name. */
  env?: string[];
  /** Serve Streamable HTTP rather than stdio. */
  http?: { bind: string; port: number; remote: boolean };
}

const mcpOptionsSchema = z.strictObject({
  device: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.string().optional().transform((value, ctx) => {
    const names = [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
    const wrong = names.find((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name));
    if (wrong !== undefined) ctx.addIssue({ code: "custom", message: `--env takes variable names separated by commas, such as GITHUB_TOKEN,NPM_TOKEN; ${wrong} is not one.` });
    return names.length ? names : undefined;
  }),
  http: portSchema("--http").optional(),
  httpBind: bindSchema("--http-bind").optional(),
  allowRemote: z.boolean().default(false),
});

function resolveMcpOptions(command: Command, device: string | undefined): McpConfig {
  const { state, cwd, env, http, httpBind, allowRemote } = mcpOptionsSchema.parse({ ...command.opts() });
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
    ...expect ? { expect } : {}, state, cwd, ...env ? { env } : {},
    http: http === undefined ? undefined : { bind: address, port: http, remote: !isLoopback(address) },
  };
}

export function addMcpCommand(program: Command, run: (config: McpConfig) => void | Promise<void>): void {
  const command = program.command("mcp")
    .description("Serve MCP tools that run commands and terminal sessions on paired devices")
    .usage("[device] [options]")
    .argument("[device]", "A paired device's name; without one, the devices linked to the local daemon")
    .addOption(deviceOption())
    .option("-S, --state <path>", "Without a device, the local daemon's state file")
    .addOption(new Option("-w, --cwd <path>", "Absolute working directory on devices for calls that do not name one").env("CNS_CWD"))
    .addOption(new Option("-e, --env <names>", "Variables of this process, comma-separated, that tools may set for programs on devices, by name").env("CNS_MCP_ENV"))
    .option("-p, --http <port>", "Serve Streamable HTTP at http://127.0.0.1:PORT/mcp instead of stdio")
    .option("-b, --http-bind <address>", "Numeric interface address for --http (default: 127.0.0.1)")
    .option("-R, --allow-remote", "Explicitly allow a non-loopback --http-bind")
    .addHelpText("after", `
By default an MCP client starts cns mcp and talks to it over stdin and stdout. With a device's
name the tools reach that paired device, connecting for each call. Without one they use the
devices linked to this device's daemon (cns up), chosen by name in each call.
--http clients must send Authorization: Bearer TOKEN. TOKEN is CNS_MCP_TOKEN, at least 32
characters, or else a random token printed at startup. Browser origins are refused.
Clients get shell access as the devices' users: connect only clients you would trust with it.
--env GITHUB_TOKEN,NPM_TOKEN lets run_command and start_session set those variables, with the
values they have here, for programs on devices: the agent names them and never sees the values,
unless a program prints them. Only the names listed are offered.
Examples: cns mcp studio    cns mcp --cwd /srv/app    cns mcp studio --env GITHUB_TOKEN
          CNS_MCP_TOKEN=$(openssl rand -hex 32) cns mcp studio --http 47382`);
  rejectRepeatedOptions(command);
  command.action((device: string | undefined) => run(resolveMcpOptions(command, oneDevice("mcp", device, command.opts<{ device?: string }>().device))));
}

export function parseMcpOptions(argv: string[]): McpConfig {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  let config: McpConfig | undefined;
  addMcpCommand(program, (parsed) => { config = parsed; });
  program.parse(["mcp", ...argv], { from: "user" });
  if (!config) throw new Error("The mcp command did not run.");
  return config;
}
