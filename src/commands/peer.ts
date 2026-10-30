import { newBunWebSocketRpcSession, newWebSocketRpcSession, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { serve, type Server, type ServerWebSocket } from "bun";
import { z } from "zod";
import { ShellApi, type RunResult, type ShellInfo } from "../shell.js";
import { openConsole, type PeerController } from "../console.js";
import type { PeerConfig } from "../options.js";
import { attachTerminal } from "../terminal.js";
import { serveControl } from "./daemon.js";

// Bound unauthenticated connections, including peers that never complete the RPC handshake.
export const MAX_PEERS = 32;
const HANDSHAKE_MS = 5000;
const infoSchema = z.object({
  platform: z.enum(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32", "cygwin", "netbsd"]),
  name: z.string().max(128), shell: z.enum(["PowerShell", "Bash"]),
  hostname: z.string().max(256), cwd: z.string().max(32768), pid: z.int().positive(),
});
interface SocketData { address: string; transport?: BunWebSocketTransport<SocketData>; session?: Session }
interface Session {
  id: string;
  address: string;
  socket: WebSocket | ServerWebSocket<SocketData>;
  local: ShellApi;
  remote: RpcStub<ShellApi>;
  timer: ReturnType<typeof setTimeout>;
  info?: ShellInfo;
}

export function commandExitCode(result: Pick<RunResult, "exitCode" | "signalNumber" | "timedOut">): number {
  if (result.timedOut) return 124;
  if (result.exitCode !== null) return result.exitCode;
  return result.signalNumber != null ? 128 + result.signalNumber : 1;
}

export async function startPeer(config: PeerConfig): Promise<void> {
  const daemonChild = process.env.CNS_DAEMON_CHILD === "1";
  delete process.env.CNS_DAEMON_CHILD;
  const sessions = new Map<string, Session>();
  let nextId = 1;
  let listener: Server<SocketData> | undefined;
  let input: ReturnType<typeof openConsole> | undefined;
  let controlCleanup: (() => Promise<void>) | undefined;
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  const oneShot = config.role === "run" || config.role === "tty";
  const cancelled = new AbortController();
  const announce = (message: string) => { if (!oneShot) console.log(message); };

  function describe(session: Session): string {
    const endpoint = session.info ? `${session.info.hostname} (${session.address})` : session.address;
    return config.noRepl ? endpoint : `${session.id}: ${endpoint}`;
  }

  function remove(session: Session) {
    if (!sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    session.local[Symbol.dispose]();
    session.remote[Symbol.dispose]();
    session.socket.close(1000, "Shell session ended");
    const timer = setTimeout(() => session.socket.terminate(), 750);
    timer.unref();
    if (!stopping) {
      announce(`Disconnected from ${describe(session)}.`);
      void input?.refresh();
    }
  }

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    cancelled.abort();
    input?.close();
    for (const session of sessions.values()) remove(session);
    try {
      await Promise.all([listener?.stop(true), controlCleanup?.()]);
    } catch (error) {
      process.exitCode = 1;
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      finished();
    }
  }
  const interrupt = () => { void stop(oneShot ? 130 : 0); };
  const terminate = () => { void stop(oneShot ? 143 : 0); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  function requireSession(id: string) {
    const session = sessions.get(id);
    if (!session?.info) throw new Error(`Peer ${id} is not connected. Use :peers and :use ID.`);
    return session;
  }
  const controller: PeerController = {
    async peers() {
      return [...sessions.values()].flatMap(({ id, info }) => info ? [{ id, info: { ...info } }] : []);
    },
    async info(id) { return { ...requireSession(id).info! }; },
    async run(id, command, options) {
      // Capture the session once; its ID is never reused, even after disconnect.
      const session = requireSession(id);
      const result = await session.remote.run(command, options);
      try { return { ...result }; }
      finally { result[Symbol.dispose](); }
    },
    async openPty(id, sink, options) {
      return await requireSession(id).remote.openPty(sink, options);
    },
  };

  function disconnected(session: Session, code = oneShot || !session.info ? 1 : 0) {
    if (!sessions.has(session.id)) return;
    remove(session);
    if (config.mode === "connect") void stop(code);
  }

  function register(socket: Session["socket"], local: ShellApi, remote: RpcStub<ShellApi>, address: string): Session {
    const id = `p${nextId++}`;
    const session: Session = { id, address, socket, local, remote, timer: setTimeout(() => {
      if (!sessions.has(id)) return;
      console.error(`Handshake with ${describe(session)} timed out.`);
      disconnected(session, 1);
    }, HANDSHAKE_MS) };
    sessions.set(id, session);
    remote.onRpcBroken(() => disconnected(session));
    void (async () => {
      try {
        const info = await remote.info();
        try { session.info = infoSchema.parse(info); }
        finally { info[Symbol.dispose]?.(); }
        if (!sessions.has(id) || stopping) return;
        clearTimeout(session.timer);
        announce(`Connected to ${describe(session)} [${session.info.platform} / ${session.info.shell}].`);
        if (config.mode === "connect") {
          if (config.role === "tty") {
            const { command, cwd, timeoutMs, cols, rows, term, screen } = config;
            const { exit: result, screen: captured } = await attachTerminal((sink, options) => controller.openPty(id, sink, options),
              { command, cwd, timeoutMs, cols, rows, term }, { signal: cancelled.signal, screen });
            // Like tmux capture-pane, but without the blank rows below the last output.
            if (captured) process.stdout.write(captured.text.replace(/\n+$/, "") + "\n");
            if (result.error) console.error(`cns: ${result.error}`);
            if (result.timedOut) console.error("cns: command timed out");
            await stop(commandExitCode(result));
          } else if (oneShot) {
            const result = await controller.run(id, config.command!, { cwd: config.cwd, timeoutMs: config.timeoutMs });
            process.stdout.write(result.stdout);
            process.stderr.write(result.stderr);
            if (result.truncated) console.error("cns: OUTPUT TRUNCATED at 1 MiB");
            if (result.timedOut) console.error("cns: command timed out");
            await stop(commandExitCode(result));
          } else if (!config.noRepl) input = openConsole(controller, () => { void stop(); });
        } else void input?.refresh();
      } catch (error) {
        if (!stopping && sessions.has(id)) {
          console.error(error instanceof Error ? error.message : String(error));
          disconnected(session, 1);
        }
      }
    })();
    return session;
  }

  try {
    // Machine-readable run output must contain only the remote command's streams.
    announce(config.remote
      ? "WARNING: unauthenticated remote shell access. Trusted LAN/VPN only; both peers can execute commands as your user."
      : "No authentication. Local shell access only.");
    if (config.mode === "listen") {
      listener = serve<SocketData>({
        hostname: config.bind, port: config.port,
        fetch(request, server) {
          if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
          if (server.pendingWebSockets >= MAX_PEERS) return new Response("Peer limit reached", { status: 503 });
          const remote = server.requestIP(request);
          const address = remote
            ? `${remote.family === "IPv6" ? `[${remote.address}]` : remote.address}:${remote.port}`
            : "unknown address";
          if (server.upgrade(request, { data: { address } })) return;
          return new Response("WebSocket upgrade required", { status: 400 });
        },
        websocket: {
          idleTimeout: 0, maxPayloadLength: 8 * 1024 * 1024,
          open(ws) {
            if (stopping) { ws.close(); return; }
            const local = new ShellApi();
            const { stub, transport } = newBunWebSocketRpcSession<ShellApi, SocketData>(ws, local);
            ws.data.transport = transport;
            ws.data.session = register(ws, local, stub, ws.data.address);
          },
          message(ws, message) { ws.data.transport?.dispatchMessage(message); },
          close(ws, code, reason) {
            ws.data.transport?.dispatchClose(code, reason);
            if (ws.data.session) disconnected(ws.data.session);
          },
        },
      });
      if (daemonChild) {
        controlCleanup = await serveControl(controller, () => { void stop(); }, config.state);
        if (stopping) { await controlCleanup(); return; }
        process.send?.({ ready: true });
        if (process.connected) process.disconnect?.();
      }
      if (!config.noRepl) input = openConsole(controller, () => { void stop(); });
      const label = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux";
      announce(`${label} listening at ${config.url}.`);
    } else {
      const socket = new WebSocket(config.url);
      const local = new ShellApi();
      const remote = newWebSocketRpcSession<ShellApi>(socket, local);
      const session = register(socket, local, remote, new URL(config.url).host);
      socket.addEventListener("error", () => {
        if (!stopping) console.error(`Cannot connect to ${config.url}. Check that the listener is running and reachable.`);
        disconnected(session, 1);
      });
      socket.addEventListener("close", () => disconnected(session));
    }
    await done;
  } catch (error) {
    await stop(1);
    throw error;
  }
}
