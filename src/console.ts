import readline from "node:readline";
import { formatSessions } from "./commands/one-shot.js";
import { errorMessage } from "./errors.js";
import {
  MAX_TIMEOUT_MS, type PtyOptions, type PtySessionInfo, type PtySessionOptions, type PtySink, type RunOptions, type RunResult, type ShellInfo,
} from "./shell.js";
import { attachSession, attachTerminal, type RemoteNamedPty, type RemotePty } from "./terminal.js";

export interface PeerSummary { id: string; info: ShellInfo }
export interface PeerController {
  peers(): Promise<PeerSummary[]>;
  info(id: string): Promise<ShellInfo>;
  run(id: string, command: string, options: RunOptions): Promise<RunResult>;
  openPty(id: string, sink: PtySink, options: PtyOptions): Promise<RemotePty>;
  ptySessions(id: string): Promise<PtySessionInfo[]>;
  startPtySession(id: string, name: string, options: PtySessionOptions): Promise<PtySessionInfo>;
  ptySession(id: string, name: string): Promise<RemoteNamedPty>;
}

const help = `
  Type a shell command to execute it on the selected peer.
    :peers             List connected peers.
    :use ID            Select a peer explicitly.
    :info              Show the selected peer's platform, shell and process ID.
    :cwd [PATH]        Show/set its remote working directory (absolute, no quotes).
    :timeout [MS]      Show/set its deadline; 0 disables it (the default).
    :tty [COMMAND]     Open an interactive terminal (login shell or COMMAND) on it.
    :sessions          List its named PTY sessions (started with cns tty --name).
    :attach NAME       Attach to a named session; Ctrl-] detaches and leaves it running.
    :help              Show this help.
    :quit              Exit this console (a foreground listener stops its peers).
  Each command starts a fresh shell without persistent state; use :tty for TUIs.
`;

/** Selection belongs to a console, never to the shared listener or another attachment. */
export function openConsole(controller: PeerController, onQuit: () => void) {
  const lines = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const settings = new Map<string, { cwd: string; timeoutMs: number }>();
  let selected: string | undefined;
  let explicit = false;
  let selectionRequired = false;
  let closed = false;
  let inputEnded = false;
  lines.once("close", () => { inputEnded = true; });
  let busy = false;
  let revision = 0;
  const cancelled = new AbortController();

  const close = () => {
    if (closed) return;
    closed = true;
    cancelled.abort();
    lines.close();
  };

  // Readline keeps editing the prompt line from keypresses. Detach it while the
  // remote program owns the terminal, then give it back unchanged.
  async function terminal(id: string, target: { command?: string; session?: string }, options: { cwd: string; timeoutMs: number }) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(":tty and :attach require an interactive local terminal. Use cns tty with piped input.");
    const keypress = process.stdin.listeners("keypress") as ((...args: unknown[]) => void)[];
    for (const listener of keypress) process.stdin.off("keypress", listener);
    try {
      const outcome = target.session !== undefined
        ? await attachSession(controller, id, target.session, { signal: cancelled.signal })
        : await attachTerminal((sink, ptyOptions) => controller.openPty(id, sink, ptyOptions),
          { ...options, command: target.command }, { signal: cancelled.signal });
      const result = outcome.exit;
      if (!result) {
        console.log(`[detached from ${target.session}${"detached" in outcome && outcome.detached ? `: ${outcome.detached}` : ""}]`);
        return;
      }
      if (result.error) console.error(`Error: ${result.error}`);
      console.log(`\r\n[exit=${result.exitCode ?? result.signal ?? "unknown"}; ${result.elapsedMs} ms${result.timedOut ? "; TIMED OUT" : ""}]`);
    } finally {
      for (const listener of keypress) process.stdin.on("keypress", listener);
      process.stdin.resume();
    }
  }
  const quit = () => { close(); onQuit(); };
  lines.on("SIGINT", quit);

  async function peers() {
    const available = await controller.peers();
    if (selected && !available.some((peer) => peer.id === selected)) {
      selected = undefined;
      selectionRequired = true;
    }
    if (!explicit && available.length > 1) {
      selected = undefined;
      selectionRequired = true;
    }
    if (!selected && !selectionRequired && available.length === 1) selected = available[0]!.id;
    for (const peer of available) {
      if (!settings.has(peer.id)) settings.set(peer.id, { cwd: peer.info.cwd, timeoutMs: 0 });
    }
    for (const id of settings.keys()) if (!available.some((peer) => peer.id === id)) settings.delete(id);
    return available;
  }

  async function refresh() {
    const current = ++revision;
    try {
      const available = await peers();
      if (closed || inputEnded || busy || current !== revision) return;
      const peer = available.find((peer) => peer.id === selected);
      lines.setPrompt(peer ? `${peer.id} (${peer.info.name})> ` : "cns (:use ID)> ");
      lines.prompt();
    } catch (error) {
      if (!closed) console.error(`Error: ${errorMessage(error)}`);
    }
  }

  // Begin reading immediately so piped commands cannot disappear during the first RPC.
  void (async () => {
    console.log(help);
    void refresh();
    for await (const raw of lines) {
      if (closed) break;
      busy = true;
      try {
        const line = raw.trim();
        if (line === ":quit") { quit(); break; }
        if (line === ":help") console.log(help);
        else if (line) {
          const available = await peers();
          if (line === ":peers") {
            console.log(available.length ? available.map(({ id, info }) =>
              `${id === selected ? "*" : " "} ${id} ${info.hostname} ${info.platform}/${info.shell} pid=${info.pid}`).join("\n") : "No connected peers.");
          } else if (line.startsWith(":use ")) {
            const id = line.slice(5).trim();
            if (!available.some((peer) => peer.id === id)) throw new Error(`Unknown peer ${id}. Use :peers, then :use ID.`);
            selected = id;
            explicit = true;
            console.log(`Selected ${id}.`);
          } else {
            // Capture the ID before awaiting anything. Disconnects cannot redirect this command.
            const id = selected;
            if (!id) throw new Error("Select a connected peer with :peers and :use ID.");
            const options = settings.get(id)!;
            if (line === ":info") console.log(JSON.stringify(await controller.info(id), null, 2));
            else if (line === ":cwd") console.log(options.cwd);
            else if (line.startsWith(":cwd ")) {
              options.cwd = line.slice(5).trim();
              console.log(`Remote cwd: ${options.cwd}`);
            } else if (line === ":timeout" || line.startsWith(":timeout ")) {
              if (line !== ":timeout") {
                const value = Number(line.slice(9));
                if (!Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) throw new Error("Invalid timeout.");
                options.timeoutMs = value;
              }
              console.log(options.timeoutMs === 0 ? "Timeout: disabled" : `Timeout: ${options.timeoutMs} ms`);
            } else if (line === ":tty" || line.startsWith(":tty ")) {
              await terminal(id, { command: line.slice(5).trim() || undefined }, { ...options });
            } else if (line === ":sessions") {
              const sessions = await controller.ptySessions(id);
              console.log(sessions.length ? formatSessions(sessions) : "No named PTY sessions.");
            } else if (line.startsWith(":attach ")) {
              await terminal(id, { session: line.slice(8).trim() }, { ...options });
            } else if (line.startsWith(":")) throw new Error("Unknown command. Try :help.");
            else {
              const result = await controller.run(id, raw, { ...options });
              if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
              if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
              console.log(`[exit=${result.exitCode ?? result.signal ?? "unknown"}; ${result.elapsedMs} ms${result.timedOut ? "; TIMED OUT" : ""}${result.truncated ? "; OUTPUT TRUNCATED at 1 MiB" : ""}]`);
            }
          }
        }
      } catch (error) {
        if (!closed) console.error(`Error: ${errorMessage(error)}`);
      } finally { busy = false; }
      if (!closed) await refresh();
    }
    if (!closed) quit();
  })();
  return { close, refresh };
}
