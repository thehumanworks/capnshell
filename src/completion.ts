import type { Command, Option } from "commander";
import { pathsOf, remotePath } from "./commands/copy.js";
import { strictlyPrintable } from "./errors.js";
import type { DirectoryEntry, FileKind, FileStat } from "./files.js";
import { shouldAsk } from "./fleet-sessions.js";
import { loadIdentity } from "./identity.js";
import { splitRemote } from "./options.js";
import { reachablePeers, type PeerEntry, type Permission } from "./peers.js";
import { sessionNameSchema, type PtySessionInfo, type ShellInfo } from "./shell.js";
import { plain } from "./terminal.js";

/**
 * Tab completion. `cns completion SHELL` prints a small script; on each Tab it runs
 * `cns __complete SHELL WORDS...` with the words after cns, the last one being typed, and
 * offers the lines it prints. Commands and options come from the commander program, so they
 * never go stale. Device names are the records here. Sessions and remote paths come through
 * the local daemon's standing link to the device, with calls its grants already allow, and
 * only within LOOKUP_MS: completion never dials a device, waits on the relay or starts a daemon.
 */

export const SHELLS = ["bash", "zsh", "fish", "pwsh"] as const;
export type Shell = typeof SHELLS[number];
/** How long a lookup on a device may take before completion offers only what it knows here. */
export const LOOKUP_MS = 300;
/** Candidates offered at most. */
export const MAX_CANDIDATES = 200;

/** What each operand of a command is, by the command's words after cns. A kind ending in ... is every operand from there on. */
const OPERANDS: Record<string, readonly string[]> = {
  run: ["device"], shell: ["device"], sessions: ["device"], keys: ["device", "session"], screen: ["device", "session"], kill: ["device", "session"],
  cp: ["copy..."], ui: ["target"], mcp: ["device"], doctor: ["device"], upgrade: ["device"], wake: ["device"],
  "peer remove": ["device"], "peer grant": ["device"], "peer revoke": ["device"], "peer address": ["device"], "mesh add": ["", "device..."],
};
/** What an option's value is, by the option's name. */
const VALUES: Record<string, string> = { device: "device", via: "device", peer: "device", session: "session", attach: "session" };

/** A device's shell through the local daemon's link, as far as completion uses it. */
export interface Borrowed {
  info(): Promise<Pick<ShellInfo, "platform" | "cwd">>;
  readdir(directory: string): Promise<Array<{ name: string; kind: FileKind }>>;
  stat(target: string): Promise<{ kind: FileKind }>;
  sessions(): Promise<Array<{ name: string }>>;
  close(): void;
}

/** Where completion looks names up. */
export interface Lookups {
  /** The paired devices here, with what each lets this one use. */
  devices(): Array<{ name: string; outgoing: readonly Permission[] }>;
  /** The device's shell through the local daemon's standing link, or undefined when there is none. Never dials. */
  borrow(device: string, signal: AbortSignal): Promise<Borrowed | undefined>;
}

/** This device's records, and the links its daemon lends. */
export function localLookups(): Lookups {
  let saved: PeerEntry[] | undefined;
  // reachablePeers leaves out devices removed with cns peer remove. Bad records are skipped quietly.
  const peers = () => saved ??= (() => { try { return reachablePeers(() => {}); } catch { return []; } })();
  return {
    devices: () => peers().map((peer) => ({ name: peer.name, outgoing: peer.grants.outgoing })),
    async borrow(name, signal) {
      const peer = peers().find((entry) => entry.name === name);
      const identity = peer && loadIdentity();
      if (!peer || !identity) return undefined;
      const { borrowDeviceLink } = await import("./device-link.js");
      const link = await borrowDeviceLink(peer, identity, signal, LOOKUP_MS);
      if (!link) return undefined;
      const remote = link.remote;
      let closed = false;
      return {
        info: () => plain(remote.info() as unknown as Promise<ShellInfo>),
        readdir: (directory) => plain(remote.readdir(directory) as unknown as Promise<DirectoryEntry[]>),
        stat: (target) => plain(remote.stat(target) as unknown as Promise<FileStat>),
        sessions: () => plain(remote.ptySessions() as unknown as Promise<PtySessionInfo[]>),
        close() {
          if (closed) return;
          closed = true;
          remote[Symbol.dispose]();
          link.close("Completion ended");
        },
      };
    },
  };
}

/** `use` on the device's lent shell, or undefined when there is none, it fails, or LOOKUP_MS pass first. */
async function through<T>(lookups: Lookups, device: string, use: (remote: Borrowed) => Promise<T>): Promise<T | undefined> {
  const signal = AbortSignal.timeout(LOOKUP_MS);
  const work = (async () => {
    const remote = await lookups.borrow(device, signal);
    if (!remote) return undefined;
    // Past the deadline, closing the link ends the calls still waiting on it.
    const close = () => remote.close();
    signal.addEventListener("abort", close, { once: true });
    try { signal.throwIfAborted(); return await use(remote); }
    finally { signal.removeEventListener("abort", close); close(); }
  })();
  const deadline = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  try { return await Promise.race([work, deadline]); } catch { return undefined; }
}

/** The named sessions on `name`, when it lets this device list them. */
async function sessionNames(lookups: Lookups, name: string): Promise<string[]> {
  const device = lookups.devices().find((entry) => entry.name === name);
  if (!device || shouldAsk(device)) return [];
  const sessions = await through(lookups, name, (remote) => remote.sessions());
  // Only names cns would take, whatever the device sends.
  return (Array.isArray(sessions) ? sessions : []).map((session) => session?.name).filter((session): session is string => sessionNameSchema.safeParse(session).success);
}

/** DEVICE:PATH for the entries of the directory `typed` is in on `name`, when it grants files: one level, as shells complete paths. */
async function remotePaths(lookups: Lookups, name: string, typed: string): Promise<string[]> {
  if (!lookups.devices().find((entry) => entry.name === name)?.outgoing.includes("files")) return [];
  if (typed === "~") return [`${name}:~/`];
  return await through(lookups, name, async (remote) => {
    const info = await remote.info();
    const paths = pathsOf(info);
    const at = Math.max(typed.lastIndexOf("/"), info.platform === "win32" ? typed.lastIndexOf("\\") : -1);
    const [typedDirectory, base] = [typed.slice(0, at + 1), typed.slice(at + 1)];
    const directory = remotePath(info, typedDirectory);
    const listed = await remote.readdir(directory);
    // Hidden entries only once a dot is typed, as shells do.
    const entries = (Array.isArray(listed) ? listed : [])
      .filter((entry) => typeof entry?.name === "string" && entry.name.startsWith(base) && (base.startsWith(".") || !entry.name.startsWith(".")) && safe(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).slice(0, MAX_CANDIDATES);
    // A link to a directory is completed as one.
    const kinds = await Promise.all(entries.map((entry) => entry.kind !== "symlink" ? entry.kind
      : remote.stat(paths.join(directory, entry.name)).then((target) => target.kind, () => entry.kind)));
    // A directory ends with the separator typed last, else /, which Windows takes too.
    const separator = at < 0 ? "/" : typed[at]!;
    return entries.map((entry, index) => `${name}:${typedDirectory}${entry.name}${kinds[index] === "directory" ? separator : ""}`);
  }) ?? [];
}

const commandPath = (command: Command): string => command.parent?.parent ? `${commandPath(command.parent)} ${command.name()}` : command.name();

/**
 * What to offer for the last of `words`, the words after cns as the shell gives them, unquoted.
 * Never throws for what the words say; a lookup that fails or takes too long offers nothing.
 */
export async function complete(program: Command, words: readonly string[], lookups: Lookups): Promise<string[]> {
  const help = program.createHelp();
  const current = words.at(-1) ?? "";
  let command = program;
  const operands: string[] = [];
  const values = new Map<string, string>();
  let pending: Option | undefined;
  let delimited = false;
  for (const word of words.slice(0, -1)) {
    if (pending) { values.set(pending.attributeName(), word); pending = undefined; }
    else if (delimited) operands.push(word);
    else if (word === "--") delimited = true;
    else if (/^-./.test(word)) {
      const option = [...command.options, ...help.visibleOptions(command)].find((candidate) => candidate.long === word || candidate.short === word);
      if (option?.required) pending = option;
    } else {
      const sub = operands.length ? undefined : command.commands.find((candidate) => candidate.name() === word || candidate.aliases().includes(word));
      if (sub) command = sub;
      else operands.push(word);
    }
  }
  const kinds = OPERANDS[commandPath(command)] ?? [];
  const device = values.get("device") ?? (kinds[0] === "device" || kinds[0] === "target" ? operands[0]?.split("/")[0] : undefined);
  const devices = () => lookups.devices().map((entry) => entry.name);
  const sessions = () => device === undefined ? [] : sessionNames(lookups, device);
  const offer = async (kind: string | undefined, choices: readonly string[] = []): Promise<readonly string[]> => {
    if (kind === "device") return devices();
    if (kind === "session") return await sessions();
    if (kind === "target") {
      // cns ui DEVICE or DEVICE/SESSION.
      const slash = current.indexOf("/");
      return slash < 0 ? devices() : (await sessionNames(lookups, current.slice(0, slash))).map((name) => `${current.slice(0, slash)}/${name}`);
    }
    if (kind === "copy") {
      let remote: ReturnType<typeof splitRemote>;
      try { remote = splitRemote(current); } catch { return []; }
      return remote ? await remotePaths(lookups, remote.target, remote.path) : devices().map((name) => `${name}:`);
    }
    return choices;
  };
  let found: readonly string[];
  if (pending) found = await offer(VALUES[pending.attributeName()], pending.argChoices);
  else if (delimited) found = [];
  else if (current.startsWith("-")) found = help.visibleOptions(command).flatMap((option) => option.long ?? option.short ?? []);
  else if (!operands.length && command.commands.length) found = help.visibleCommands(command).map((sub) => sub.name());
  else {
    // With --device, the DEVICE operand is left out.
    const shifted = values.has("device") && kinds[0] === "device" ? kinds.slice(1) : kinds;
    const kind = shifted[operands.length] ?? (shifted.at(-1)?.endsWith("...") ? shifted.at(-1) : undefined);
    found = await offer(kind?.replace(/\.\.\.$/, ""), command.registeredArguments[operands.length]?.argChoices);
  }
  return [...new Set(found)].filter((candidate) => candidate.startsWith(current)).sort();
}

/** Text that shows as itself, with nothing a shell or terminal would take as a line, a field or a control. */
const safe = (text: string) => text.length > 0 && strictlyPrintable(text) === text;

const SINGLE_QUOTES = "'‘’‚‛";
const DOUBLE_QUOTES = "\"“”„";

/** A word as bash or PowerShell hands it over, with its quotes and escapes removed; zsh and fish remove them themselves. */
export const unquote = (shell: Shell, word: string): string => unquoted(shell, word).text;

/** The word without its quotes and escapes, and whether it leaves a quote open. */
function unquoted(shell: Shell, word: string): { text: string; open: boolean } {
  if (shell === "zsh" || shell === "fish") return { text: word, open: false };
  const escape = shell === "pwsh" ? "`" : "\\";
  let out = "";
  let quote: "'" | '"' | undefined;
  for (let at = 0; at < word.length; at++) {
    const char = word[at]!;
    if (quote === "'") {
      if (!SINGLE_QUOTES.includes(char)) out += char;
      // PowerShell writes a quote inside single quotes twice.
      else if (shell === "pwsh" && at + 1 < word.length && SINGLE_QUOTES.includes(word[at + 1]!)) out += word[++at];
      else quote = undefined;
    } else if (char === escape && at + 1 < word.length) {
      const next = word[++at]!;
      // Inside double quotes, bash keeps a backslash that escapes nothing.
      if (shell === "bash" && quote === '"' && !"$`\"\\".includes(next)) out += char;
      out += next;
    } else if (quote === '"') {
      if (DOUBLE_QUOTES.includes(char) && (shell === "pwsh" || char === '"')) quote = undefined;
      else out += char;
    } else if (shell === "pwsh" ? SINGLE_QUOTES.includes(char) : char === "'") quote = "'";
    else if (shell === "pwsh" ? DOUBLE_QUOTES.includes(char) : char === '"') quote = '"';
    else out += char;
  }
  return { text: out, open: quote !== undefined };
}

/** A candidate as the shell inserts it: bash and PowerShell insert it as it is, so it is quoted here; zsh and fish quote it themselves. */
export function quote(shell: Shell, candidate: string): string {
  if (shell === "bash") return candidate.replace(/[^\w.,/~:@%+=^\u0080-￿-]/g, "\\$&");
  if (shell === "pwsh" && /[^\w./\\~:%+=^-]/.test(candidate)) return `'${candidate.replace(/['‘’‚‛]/g, "$&$&")}'`;
  return candidate;
}

/**
 * The scripts `cns completion SHELL` prints. Each passes the words before the cursor to
 * cns __complete and offers its lines; with none, the shell completes local files. A
 * candidate that ends in /, \ or : (a directory, or DEVICE:) gets no space after it.
 */
const SCRIPTS: Record<Shell, string> = {
  bash: `# cns tab completion for bash 3.2 and later. In ~/.bashrc: eval "$(cns completion bash)"
_cns() {
  local line=\${COMP_LINE:0:COMP_POINT} words=() word rest i n=0 cur pre c q= at=0 open
  # Bash splits a word at COMP_WORDBREAKS, such as the colon in DEVICE:PATH: join the parts no space separates.
  for ((i = 0; i <= COMP_CWORD; i++)); do
    word=\${COMP_WORDS[i]}
    rest=\${line#"\${line%%[![:space:]]*}"}
    if ((i)) && [[ \${#rest} == "\${#line}" ]]; then words[n-1]+=$word; else words[n++]=$word; fi
    line=\${rest#"$word"}
  done
  cur=\${words[n-1]}
  # Bash replaces the word from after its last unquoted COMP_WORDBREAKS character (from the character, for @),
  # or from after a quote it leaves open: what comes before stays, and is taken off each candidate.
  for ((i = 0; i < \${#cur}; i++)); do
    c=\${cur:i:1}
    if [[ $c == "$q" ]]; then q=
    elif [[ $c == \\\\ && $q != "'" ]]; then ((i++))
    elif [[ -n $q ]]; then :
    elif [[ $c == [\\"\\'] ]]; then q=$c open=$((i + 1))
    elif [[ $COMP_WORDBREAKS == *"$c"* ]]; then at=$((i + 1)); [[ $c == @ ]] && at=$i
    fi
  done
  [[ -n $q ]] && at=$open
  pre=\${cur:0:at}
  COMPREPLY=()
  while IFS= read -r c; do
    [[ $c == "$pre"* ]] || continue
    case $c in *[/:\\\\]) [[ -n $_cns_space ]] || compopt -o nospace ;; *) c+=$_cns_space ;; esac
    COMPREPLY+=("\${c#"$pre"}")
  done < <(cns __complete bash "\${words[@]:1}" 2>/dev/null)
  # Nothing for what follows the colon of DEVICE:PATH, or another break: keep it as typed, rather than let bash put a local file there.
  if ((at)) && [[ \${#COMPREPLY[@]} == 0 ]]; then COMPREPLY=("\${cur:at}"); [[ -n $_cns_space ]] || compopt -o nospace; fi
}
# Bash 3.2 has no compopt: there, a space is added to each candidate that takes one.
if type compopt >/dev/null 2>&1; then _cns_space=; complete -o default -F _cns cns
else _cns_space=' '; complete -o default -o nospace -F _cns cns; fi
`,
  zsh: `#compdef cns
# cns tab completion for zsh. In ~/.zshrc, after compinit: source <(cns completion zsh)
_cns() {
  local -a found
  found=(\${(f)"$(cns __complete zsh "\${(@Q)words[2,CURRENT-1]}" "\${(Q)PREFIX}" 2>/dev/null)"})
  (( $#found )) || { _files; return }
  # As with files: the word up to its last / or : stays as typed, and only the rest is listed.
  compset -P '*[/:]'
  found=(\${found#\${(Q)IPREFIX}})
  compadd -S '' -- \${(M)found:#*[/:\\\\]}
  compadd -- \${found:#*[/:\\\\]}
}
if [[ $zsh_eval_context[-1] == loadautofunc ]]; then _cns "$@"; else compdef _cns cns; fi
`,
  fish: `# cns tab completion for fish: cns completion fish > ~/.config/fish/completions/cns.fish
function __cns_complete
    set -l current (commandline -ct | string unescape)
    set -g __cns_found (cns __complete fish (commandline -opc)[2..-1] "$current" 2>/dev/null)
    test (count $__cns_found) -gt 0
end
complete -c cns -n __cns_complete -f -a '$__cns_found'
`,
  pwsh: `# cns tab completion for PowerShell 7. In $PROFILE: cns completion pwsh | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName cns, cns.exe -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $words = @($commandAst.CommandElements | Where-Object { $_.Extent.StartOffset -lt $cursorPosition } | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
    if ($wordToComplete -eq '') { $words += '' }
    # cns writes UTF-8, which Windows does not read by default.
    $encoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
        cns __complete pwsh @words 2>$null | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
    } finally { [Console]::OutputEncoding = $encoding }
}
`,
};

/** The script that completes cns in `shell`. */
export const completionScript = (shell: Shell): string => SCRIPTS[shell];

/** `cns __complete SHELL WORDS...`: print what to offer, one per line, and never anything on stderr. Returns the exit status, 0. */
export async function completeCommand(program: Command, [shell, ...words]: readonly string[], lookups: Lookups = localLookups()): Promise<number> {
  try {
    if (!(SHELLS as readonly string[]).includes(shell ?? "")) return 0;
    // Inside a quote the word leaves open, bash quotes a candidate again: such a word stays as typed.
    if (shell === "bash" && unquoted(shell, words.at(-1) ?? "").open) return 0;
    const given = words.map((word) => unquote(shell as Shell, word));
    const found = (await complete(program, given.length ? given : [""], lookups)).filter(safe).slice(0, MAX_CANDIDATES);
    if (found.length) process.stdout.write(found.map((candidate) => quote(shell as Shell, candidate)).join("\n") + "\n");
  } catch { /* Completion never gets in the way of typing. */ }
  return 0;
}
