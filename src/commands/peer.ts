import readline from "node:readline";
import { newBunWebSocketRpcSession, newWebSocketRpcSession, type BunWebSocketTransport, type RpcStub } from "capnweb";
import { serve, type Server, type ServerWebSocket } from "bun";
import { MAX_TIMEOUT_MS, ShellApi, type ShellInfo } from "../shell.js";
import type { PeerConfig } from "../options.js";

interface SocketData { transport?: BunWebSocketTransport<SocketData> }

export function startPeer(config: PeerConfig): void {
  const { mode, bind, port, url, noRepl } = config;
  let listener: Server<SocketData> | undefined;
  let socket: WebSocket | ServerWebSocket<SocketData> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let local: ShellApi | undefined;
  let input: readline.Interface | undefined;
  let stopping = false;

  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    input?.close();
    local?.[Symbol.dispose]();
    socket?.close(1000, "Shell session ended");
    clearTimeout(handshakeTimer);
    void listener?.stop();
    if (socket) {
      const timer = setTimeout(() => socket?.terminate(), 750);
      timer.unref();
    }
  }

  function help() {
    console.log(`
  Type a shell command to execute it on the OTHER peer.
    :info              Show the remote platform, shell and home directory.
    :cwd PATH          Set the remote working directory (absolute, no quotes).
    :cwd               Show the selected remote working directory.
    :timeout           Show the current command timeout.
    :timeout MS        Set an optional timeout, 1-${MAX_TIMEOUT_MS} ms.
    :timeout 0         Disable the command timeout (the default).
    :help              Show this help.
    :quit              Disconnect both peers.
  Each command starts a fresh shell. No interactive programs or persistent shell state.
  `);
  }

  async function repl(remote: RpcStub<ShellApi>, info: ShellInfo) {
    let cwd = info.cwd;
    let timeoutMs = 0;
    const lines = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    input = lines;
    lines.on("SIGINT", () => stop());
    help();
    const prompt = () => {
      if (!stopping) {
        lines.setPrompt(`${info.name ?? info.platform}> `);
        lines.prompt();
      }
    };
    prompt();
    for await (const raw of lines) {
      const line = raw.trim();
      try {
        if (!line) { /* Just redraw the prompt. */ }
        else if (line === ":quit") { stop(); break; }
        else if (line === ":help") help();
        else if (line === ":info") {
          const details = await remote.info();
          try { console.log(JSON.stringify(details, null, 2)); }
          finally { details[Symbol.dispose]?.(); }
        }
        else if (line === ":cwd") console.log(cwd);
        else if (line.startsWith(":cwd ")) { cwd = line.slice(5).trim(); console.log(`Remote cwd: ${cwd}`); }
        else if (line === ":timeout" || line.startsWith(":timeout ")) {
          if (line !== ":timeout") {
            const value = Number(line.slice(9));
            if (!Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) throw new Error("Invalid timeout.");
            timeoutMs = value;
          }
          console.log(timeoutMs === 0 ? "Timeout: disabled" : `Timeout: ${timeoutMs} ms`);
        } else if (line.startsWith(":")) throw new Error("Unknown command. Try :help.");
        else {
          const result = await remote.run(raw, { cwd, timeoutMs });
          try {
            if (result.stdout) process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : result.stdout + "\n");
            if (result.stderr) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : result.stderr + "\n");
            console.log(`[exit=${result.exitCode ?? result.signal ?? "unknown"}; ${result.elapsedMs} ms${result.timedOut ? "; TIMED OUT" : ""}${result.truncated ? "; OUTPUT TRUNCATED at 1 MiB" : ""}]`);
          } finally { result[Symbol.dispose]?.(); }
        }
      } catch (error) {
        if (!stopping) console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      prompt();
    }
    stop();
  }

  async function attach(remote: RpcStub<ShellApi>) {
    // BOTH endpoints export a ShellApi and receive a typed stub over one socket.
    // Cap'n Web's own Bun/browser transports handle all framing and RPC.
    remote.onRpcBroken(() => {
      if (!stopping) console.log("\nPeer disconnected. Restart both peers to reconnect.");
      stop();
    });
    try {
      const info = await remote.info();
      try {
        console.log(`Connected to ${info.platform} / ${info.shell} on ${info.hostname}.`);
        if (!noRepl && !stopping) await repl(remote, info);
      } finally { info[Symbol.dispose]?.(); }
    } catch (error) {
      if (!stopping) { console.error(error instanceof Error ? error.message : String(error)); stop(1); }
    }
  }

  process.once("SIGINT", () => stop());
  process.once("SIGTERM", () => stop());
  console.log(config.remote
    ? "WARNING: unauthenticated remote shell access. Trusted LAN/VPN test only; each peer can execute commands as your user."
    : "No authentication. Local shell access only; stop both peers when finished.");

  if (mode === "listen") {
    let claimed = false;
    listener = serve<SocketData>({
      hostname: bind,
      port,
      fetch(request, server) {
        if (request.headers.has("Origin")) return new Response("Browser origins are not allowed", { status: 401 });
        if (claimed) return new Response("Only one peer at a time", { status: 409 });
        if (server.upgrade(request, { data: {} })) {
          claimed = true;
          return;
        }
        return new Response("WebSocket upgrade required", { status: 400 });
      },
      websocket: {
        // No idle deadline: commands can legitimately run for hours.
        idleTimeout: 0,
        maxPayloadLength: 8 * 1024 * 1024,
        open(ws) {
          socket = ws;
          local = new ShellApi();
          const { stub, transport } = newBunWebSocketRpcSession<ShellApi, SocketData>(ws, local);
          ws.data.transport = transport;
          void attach(stub);
        },
        message(ws, message) { ws.data.transport?.dispatchMessage(message); },
        close(ws, code, reason) { ws.data.transport?.dispatchClose(code, reason); },
      },
    });
    const label = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "Mac" : "Linux";
    console.log(`${label} listening at ${url}. Start the connecting peer now.`);
  } else {
    const client = new WebSocket(url);
    socket = client;
    handshakeTimer = setTimeout(() => {
      if (!stopping) { console.error(`Connection to ${url} timed out.`); stop(1); }
    }, 5000);
    client.addEventListener("error", () => {
      if (!stopping) { console.error(`Cannot connect to ${url}. Check that the listener is running and reachable from this host.`); stop(1); }
    });
    client.addEventListener("open", () => {
      clearTimeout(handshakeTimer);
      if (stopping) return;
      local = new ShellApi();
      void attach(newWebSocketRpcSession<ShellApi>(client, local));
    }, { once: true });
  }
}
