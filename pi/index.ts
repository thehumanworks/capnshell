import {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type, type TUnsafe } from "typebox";
import { CONNECT_MS } from "../src/connect.js";
import { errorMessage } from "../src/errors.js";
import { cnsInvocation, findDaemon, listen, listenSettings, type Invocation, type Listener } from "./daemon.js";
import { connectPeer, connectUrl, lostMessage, type Host } from "./host.js";
import { parseTarget, targetLabel, type Target } from "./target.js";
import { registerTools, SHADOWED_TOOLS } from "./tools.js";

/** Output `/cns run` keeps while a command runs; Pi's truncation then applies. */
const MAX_RUN_OUTPUT = 4 * DEFAULT_MAX_BYTES;
/** How often the status line checks the daemon's peers. */
const REFRESH_MS = 3000;
const ENTRY = "cns";

/** A string enum providers without anyOf support accept, as pi-ai's StringEnum. */
const StringEnum = <T extends readonly string[]>(values: T, options: { description?: string } = {}) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options }) as TUnsafe<T[number]>;

const USAGE = [
  "/cns listen: start this machine's cns daemon (or use the running one) so peers can connect",
  "/cns status: the daemon, its peers and the attached host",
  "/cns attach HOST [DIRECTORY]: run Pi's tools and ! commands on HOST (p1, host[:port] or ws://...)",
  "/cns detach: run them on this machine again",
  "/cns run HOST COMMAND: run one command on HOST and show its output",
].join("\n");

interface Entry { host: string | null; hostname?: string; cwd?: string }

export interface CnsOptions {
  /** The daemon's state file; by default ~/.cns/daemon.json, as cns uses. */
  statePath?: string;
  /** Environment for CNS_BIND, CNS_PORT, CNS_BIN and PATH; by default this process's. */
  env?: NodeJS.ProcessEnv;
  /** How to run cns for the daemon; by default --cns-bin, CNS_BIN or cns on PATH. */
  invocation?: Invocation;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
/** A host's directory with its home as ~. */
const homeRelative = (host: Host) =>
  host.cwd === host.home ? "~" : host.cwd.startsWith(`${host.home}/`) ? `~${host.cwd.slice(host.home.length)}` : host.cwd;
const address = (status: Listener["status"]) => status.url.replace(/^wss?:\/\//, "");

/** A Pi extension that runs Pi's tools on cns hosts. */
export function createCnsExtension(options: CnsOptions = {}) {
  const env = options.env ?? process.env;
  return function cns(pi: ExtensionAPI) {
    let host: Host | undefined;
    let blocked: string | undefined;
    let listener: Listener | undefined;
    let peers: number | undefined;
    let ui: ExtensionContext["ui"] | undefined;
    let refresh: ReturnType<typeof setInterval> | undefined;
    /** Where this session's tools ran before, when that was a host. */
    let previous: string | undefined;
    // Attach, detach and listen one at a time.
    let queue: Promise<unknown> = Promise.resolve();
    const serially = <T>(work: () => Promise<T>): Promise<T> => {
      const run = queue.then(work, work);
      queue = run.catch(() => {});
      return run;
    };

    registerTools(pi, { host: () => host, blocked: () => blocked });

    /** Short enough for a narrow terminal, with what matters most first. */
    function statusLine(): string | undefined {
      const parts: string[] = [];
      if (blocked) parts.push("tools blocked: /cns attach or /cns detach");
      else if (host?.lost) parts.push(`${host.label} lost: /cns attach or /cns detach`);
      else if (host) parts.push(`tools on ${host.label} ${host.info.hostname}:${homeRelative(host)}`);
      if (listener) parts.push(`listening ${address(listener.status)}${peers === undefined ? "" : ` (${plural(peers, "peer")})`}`);
      if (!parts.length) return undefined;
      const text = `cns: ${parts.join(" · ")}`;
      return ui && (blocked || host?.lost) ? ui.theme.fg("warning", text) : text;
    }
    const showStatus = () => ui?.setStatus("cns", statusLine());

    async function refreshPeers() {
      const current = listener;
      if (!current) return;
      try {
        const connected = await current.control.controller.peers();
        if (listener !== current) return;
        peers = connected.length;
        // A daemon peer that left is gone for good: its ID is never reused while the daemon runs.
        if (host?.target.kind === "peer" && !host.lost) {
          const attached = host;
          if (!connected.some((peer) => peer.id === attached.label && peer.info.pid === attached.info.pid)) attached.markLost("the peer disconnected");
        }
      } catch { /* The daemon stopping is reported when its connection breaks. */ }
      showStatus();
    }

    function useListener(next: Listener) {
      if (listener === next) return;
      listener?.control.close();
      listener = next;
      peers = next.status.peers;
      next.control.remote.onRpcBroken(() => {
        if (listener !== next) return;
        listener = undefined;
        peers = undefined;
        clearInterval(refresh);
        ui?.notify("The cns daemon stopped.", "warning");
        showStatus();
      });
      clearInterval(refresh);
      refresh = setInterval(() => void refreshPeers(), REFRESH_MS);
      refresh.unref?.();
      showStatus();
    }

    function startListening(): Promise<string> {
      return serially(async () => {
        if (listener) return `Already listening on ${address(listener.status)} (cns daemon, pid ${listener.status.pid}).`;
        const settings = listenSettings(env, options.statePath);
        const flag = pi.getFlag("cns-bin");
        const next = await listen(settings, () => options.invocation ?? cnsInvocation(typeof flag === "string" ? flag : undefined, env));
        useListener(next);
        const { status } = next;
        const lines = [next.started
          ? `Started the cns daemon (pid ${status.pid}), listening on ${address(status)}. It keeps running after Pi exits; stop it with cns stop.${next.log ? ` Log: ${next.log}` : ""}`
          : `Using the cns daemon already running (pid ${status.pid}), listening on ${address(status)}, with ${plural(status.peers, "peer")}. Other Pi sessions and cns attach share it.`];
        if (!next.started && (status.bind !== settings.bind || status.port !== settings.port)) {
          lines.push(`It was started with other settings than ${settings.bind}:${settings.port}; stop it with cns stop to start one with these.`);
        }
        if (status.oneWay) lines.push("It runs with --one-way: its peers cannot run commands on this machine.");
        else if (status.remote) lines.push(`WARNING: no authentication. Anyone who can reach ${address(status)} can run commands and read and write files on this machine as you. Use it only on a trusted LAN or VPN.`);
        lines.push("Peers connect with: cns connect ws://THIS_MACHINE:" + status.port + ". Then /cns attach p1.");
        return lines.join("\n");
      });
    }

    /**
     * Tools of the names cns routes that Pi takes from another extension, such as
     * pi-remote: Pi uses the first extension's tool of each name.
     */
    function conflicts(): string[] {
      const tools = pi.getAllTools();
      const own = tools.find((tool) => tool.name === "cns")?.sourceInfo.path;
      return tools.filter((tool) => (SHADOWED_TOOLS as readonly string[]).includes(tool.name) && tool.sourceInfo.path !== own)
        .map((tool) => `${tool.name} (${tool.sourceInfo.source || tool.sourceInfo.path})`);
    }

    async function connect(target: Exclude<Target, { kind: "local" }>, signal?: AbortSignal): Promise<Host> {
      if (target.kind === "url") return await connectUrl(target, signal ?? AbortSignal.timeout(CONNECT_MS));
      if (!listener) {
        const running = await findDaemon(options.statePath);
        if (!running) throw new Error(`${target.id} is a peer of this machine's cns daemon, and none runs. Run /cns listen, connect the peer to it, then attach.`);
        useListener(running);
      }
      return await connectPeer(listener!.control, target);
    }

    /** Attach to a host; with `hostname`, only if the host is still that machine. */
    function attach(text: string, cwd: string | undefined, signal?: AbortSignal, hostname?: string): Promise<Host | undefined> {
      return serially(async () => {
        const target = parseTarget(text, env);
        if (target.kind === "local") {
          detachNow();
          return undefined;
        }
        if (process.platform === "win32") throw new Error("Attaching from Windows is not supported: Pi resolves tool paths with this machine's path rules.");
        const shadowed = conflicts();
        if (shadowed.length) throw new Error(`Another extension provides ${shadowed.join(", ")}, so cns cannot route those tools. Disable it (pi-remote, for example) to use cns attach.`);
        const next = await connect(target, signal);
        try {
          if (hostname !== undefined && next.info.hostname !== hostname) {
            throw new Error(`${next.label} is now ${next.info.hostname}, not ${hostname}`);
          }
          if (cwd?.trim()) {
            const directory = next.resolve(cwd.trim(), next.home);
            const found = await next.stat(directory).catch(() => undefined);
            if (found?.kind !== "directory") throw new Error(`${directory} is not a directory on ${next.label}.`);
            next.cwd = directory;
          }
        } catch (error) {
          next.close();
          throw error;
        }
        host?.close();
        host = next;
        blocked = undefined;
        next.onLost(() => {
          if (host !== next) return;
          ui?.notify(lostMessage(next), "warning");
          showStatus();
        });
        pi.appendEntry<Entry>(ENTRY, { host: next.label, hostname: next.info.hostname, cwd: next.cwd });
        previous = next.label;
        showStatus();
        return next;
      });
    }

    function detachNow() {
      const wasAttached = host !== undefined || blocked !== undefined;
      host?.close();
      host = undefined;
      blocked = undefined;
      if (wasAttached) pi.appendEntry<Entry>(ENTRY, { host: null });
      showStatus();
    }

    const attachedText = (attached: Host) =>
      `Attached to ${attached.describe()}, in ${attached.cwd}. Pi's tools (${SHADOWED_TOOLS.join(", ")}) and ! commands run there; paths are paths on that host. Detach to use this machine again.`;

    async function statusText(): Promise<string> {
      const lines: string[] = [];
      const daemon = listener ?? await findDaemon(options.statePath).then((found) => {
        found?.control.close();
        return found;
      }).catch(() => undefined);
      if (daemon) {
        const { status } = daemon;
        lines.push(`cns daemon: pid ${status.pid}, listening on ${address(status)}${status.oneWay ? " (one-way)" : ""}, since ${new Date(status.startedAt).toLocaleString()}.`);
        try {
          const connected = listener ? await listener.control.controller.peers() : [];
          if (listener) {
            peers = connected.length;
            lines.push(connected.length
              ? `Peers: ${connected.map((peer) => `${peer.id} ${peer.info.hostname} (${peer.info.platform}, ${peer.info.shell})`).join("; ")}.`
              : "No peers are connected.");
          } else {
            lines.push(`${plural(status.peers, "peer")} connected. /cns listen to use them from this session.`);
          }
        } catch (error) { lines.push(`Cannot list peers: ${errorMessage(error)}`); }
      } else {
        lines.push("No cns daemon runs on this machine. /cns listen starts one.");
      }
      if (blocked) lines.push(blocked);
      else if (host?.lost) lines.push(lostMessage(host));
      else if (host) lines.push(`Tools run on ${host.describe()}, in ${host.cwd}.`);
      else lines.push(`Tools run on this machine${previous ? `; earlier in this session they ran on ${previous}` : ""}.`);
      showStatus();
      return lines.join("\n");
    }

    /** Run one command on a host, connecting just for it unless it is the attached one. */
    async function runOnce(text: string, command: string, signal?: AbortSignal) {
      const target = parseTarget(text, env);
      if (target.kind === "local") throw new Error("Use ! to run a command on this machine.");
      const reuse = host && !host.lost && host.label === targetLabel(target) ? host : undefined;
      const once = reuse ?? await connect(target, signal);
      try {
        const chunks: Buffer[] = [];
        let kept = 0;
        const started = Date.now();
        const { exitCode } = await once.exec(command, once.cwd, {
          signal,
          onData(data) {
            chunks.push(data);
            kept += data.byteLength;
            while (kept > MAX_RUN_OUTPUT && chunks.length > 1) kept -= chunks.shift()!.byteLength;
          },
        });
        const truncation = truncateTail(Buffer.concat(chunks).toString("utf8"), { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        return { host: once, exitCode, output: truncation.content, truncated: truncation.truncated, elapsedMs: Date.now() - started };
      } finally {
        if (once !== reuse) once.close();
      }
    }

    pi.registerFlag("cns-listen", { type: "boolean", description: "Start this machine's cns daemon, or use the running one, when Pi starts" });
    pi.registerFlag("cns-attach", { type: "string", description: "Run Pi's tools on a cns host from the start: p1, host[:port] or ws://..." });
    pi.registerFlag("cns-cwd", { type: "string", description: "With --cns-attach, the working directory on the host (default: its home)" });
    pi.registerFlag("cns-bin", { type: "string", description: "The cns executable that runs the daemon (default: CNS_BIN, then cns on PATH)" });

    pi.registerCommand("cns", {
      description: "Cap'n Shell: listen for peers, attach Pi's tools to a host, run a command there",
      getArgumentCompletions(prefix): AutocompleteItem[] | null {
        const words = ["listen", "status", "attach", "detach", "run"];
        if (prefix.includes(" ")) return null;
        const items = words.filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word }));
        return items.length ? items : null;
      },
      async handler(args, ctx) {
        ui = ctx.ui;
        const [subcommand = "", ...rest] = args.trim().split(/\s+/);
        const remainder = args.trim().slice(subcommand.length).trim();
        try {
          switch (subcommand) {
            case "listen":
              ctx.ui.notify(await startListening(), "info");
              break;
            case "status":
              ctx.ui.notify(await statusText(), "info");
              break;
            case "attach": {
              if (!rest[0]) throw new Error("Usage: /cns attach HOST [DIRECTORY]");
              const attached = await attach(rest[0], remainder.slice(rest[0].length).trim() || undefined);
              ctx.ui.notify(attached ? attachedText(attached) : "Tools run on this machine.", "info");
              break;
            }
            case "detach":
              await serially(async () => detachNow());
              ctx.ui.notify("Tools run on this machine.", "info");
              break;
            case "run": {
              const command = remainder.slice((rest[0] ?? "").length).trim();
              if (!rest[0] || !command) throw new Error("Usage: /cns run HOST COMMAND");
              const result = await runOnce(rest[0], command);
              const where = `${result.host.describe()}, in ${result.host.cwd}`;
              const ending = result.exitCode === 0 ? "" : `\n\n[exit code ${result.exitCode ?? "unknown"}]`;
              // The host's output is data, not instructions: keep it fenced.
              const fence = "`".repeat(Math.max(3, ...[...result.output.matchAll(/`+/g)].map((run) => run[0].length + 1)));
              const content = `Output of \`${command}\` on ${where}${result.truncated ? ` (last ${formatSize(DEFAULT_MAX_BYTES)})` : ""}:\n\n${fence}\n${result.output || "(no output)"}\n${fence}${ending}`;
              pi.sendMessage({ customType: "cns-run", content, display: true, details: { host: result.host.label, command, exitCode: result.exitCode } },
                ctx.isIdle() ? undefined : { deliverAs: "nextTurn" });
              break;
            }
            default:
              ctx.ui.notify(USAGE, subcommand ? "warning" : "info");
          }
        } catch (error) {
          ctx.ui.notify(`cns: ${errorMessage(error)}`, "error");
        }
      },
    });

    pi.registerTool({
      name: "cns",
      label: "cns",
      description: [
        "Choose where Pi's tools run: this machine, or a host reached through Cap'n Shell (cns).",
        `attach: run ${SHADOWED_TOOLS.join(", ")} on a host until detach. Hosts are peers connected to this machine's cns daemon (p1, p2, ...), shown by status, or cns listeners (host[:port] or ws://host:port). cwd sets the working directory there (default: its home).`,
        "detach: run the tools on this machine again.",
        "status: the daemon's connected peers and where the tools run.",
      ].join("\n"),
      promptSnippet: "Run Pi's tools on a cns host (attach), on this machine again (detach), or list hosts (status)",
      promptGuidelines: ["Use cns to attach only to a host the user named or asked for; read, write, edit, bash, grep, find and ls then work on that host's files until detach."],
      parameters: Type.Object({
        action: StringEnum(["status", "attach", "detach"] as const),
        host: Type.Optional(Type.String({ description: "For attach: p1, host[:port] or ws://host:port" })),
        cwd: Type.Optional(Type.String({ description: "For attach: working directory on the host (absolute, or relative to its home)" })),
      }),
      // Calls in the same turn run after the attachment changes, not alongside it.
      executionMode: "sequential",
      async execute(_id, params, signal, _onUpdate, ctx) {
        ui = ctx.ui;
        let text: string;
        if (params.action === "status") text = await statusText();
        else if (params.action === "detach") {
          await serially(async () => detachNow());
          text = "Detached: the tools run on this machine again.";
        } else {
          if (!params.host) throw new Error("attach needs a host, such as p1 or 192.168.1.20:47381; status lists the daemon's peers.");
          const attached = await attach(params.host, params.cwd, signal);
          text = attached ? attachedText(attached) : "Detached: the tools run on this machine again.";
        }
        return { content: [{ type: "text", text }], details: { host: host?.label ?? null, cwd: host?.cwd } };
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      ui = ctx.ui;
      const entries = ctx.sessionManager.getBranch()
        .flatMap((entry) => entry.type === "custom" && entry.customType === ENTRY ? [entry.data as Entry] : []);
      previous = entries.map((entry) => entry?.host).filter((label): label is string => typeof label === "string").at(-1);
      const last = entries.at(-1);
      if (pi.getFlag("cns-listen") === true) {
        try { ctx.ui.notify(await startListening(), "info"); }
        catch (error) { ctx.ui.notify(`cns: cannot listen: ${errorMessage(error)}`, "error"); }
      }
      const requested = pi.getFlag("cns-attach");
      if (typeof requested === "string" && requested.trim()) {
        const text = requested.trim();
        const directory = pi.getFlag("cns-cwd");
        try {
          const attached = await attach(text, typeof directory === "string" ? directory : undefined);
          if (attached) ctx.ui.notify(attachedText(attached), "info");
        } catch (error) {
          // Pi was asked to work on that host: never fall back to this machine.
          blocked = `Pi was started to run its tools on ${text}, and attaching failed: ${errorMessage(error)}. Nothing runs on this machine instead. /cns attach ${text} to try again, or /cns detach to use this machine.`;
          ctx.ui.notify(blocked, "error");
        }
      } else if (last?.host) {
        // A resumed, forked or reloaded session that ran its tools on a host goes back
        // there, or runs nothing until the user chooses: its model expects that host.
        try {
          const attached = await attach(last.host, last.cwd, undefined, last.hostname);
          if (attached) ctx.ui.notify(`This session ran Pi's tools on ${last.host}; attached again. ${attachedText(attached)}`, "info");
        } catch (error) {
          blocked = `This session ran Pi's tools on ${last.host}, and attaching again failed: ${errorMessage(error)}. Nothing runs on this machine instead. /cns attach ${last.host} to try again, or /cns detach to use this machine.`;
          ctx.ui.notify(blocked, "error");
        }
      }
      showStatus();
    });

    pi.on("session_shutdown", () => {
      clearInterval(refresh);
      host?.close();
      host = undefined;
      // The daemon is shared and outlives this session; only the connection to it ends.
      listener?.control.close();
      listener = undefined;
      ui?.setStatus("cns", undefined);
    });

    pi.on("user_bash", () => {
      // A result, not an error: Pi shows it as the command's output, and runs nothing here.
      const refuse = (message: string) => ({ result: { output: `cns: ${message}`, exitCode: 1, cancelled: false, truncated: false } });
      if (blocked) return refuse(blocked);
      const current = host;
      if (!current) return undefined;
      if (current.lost) return refuse(lostMessage(current));
      // The host's directory and environment, not this machine's.
      return { operations: { exec: (command, _cwd, { onData, signal, timeout }) => current.exec(command, current.cwd, { onData, signal, timeout }) } };
    });

    pi.on("before_agent_start", (event) => {
      const prompt = event.systemPromptOptions;
      if (blocked) {
        prompt.sections.cns = `${blocked} Tell the user; do not work around it.`;
      } else if (host) {
        prompt.cwd = host.cwd;
        prompt.sections.cns = [
          `Pi's tools (${SHADOWED_TOOLS.join(", ")}) and the user's ! commands run on the cns host ${host.describe()}, not on the machine Pi runs on.`,
          `Paths are paths on that host; ~ is its home, ${host.home}. Relative paths and commands start in ${host.cwd}.`,
          "Files on Pi's machine are not reachable through these tools. Use the cns tool to detach only when the user wants to work on Pi's machine.",
          host.lost ? lostMessage(host) : "",
        ].filter(Boolean).join("\n");
      } else if (previous) {
        prompt.sections.cns = `Pi's tools run on this machine. Earlier in this session they ran on the cns host ${previous}; results from then describe that host.`;
      }
    });
  };
}

export default createCnsExtension();
