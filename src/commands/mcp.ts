import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createMcpHandler, hostHeaderValidationResponse, isLegacyRequest, localhostAllowedHostnames } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { serve } from "bun";
import { errorMessage } from "../errors.js";
import { LegacySessions } from "../mcp/legacy-sessions.js";
import { createMcpServer } from "../mcp/server.js";
import { daemonTarget, listenerTarget, type McpTarget } from "../mcp/target.js";
import type { McpConfig } from "../options.js";

/** Where the Streamable HTTP endpoint answers. */
export const MCP_PATH = "/mcp";
const tokenPattern = /^[A-Za-z0-9._~+/-]{32,1024}=*$/;

/** Serve the MCP tools on stdio or Streamable HTTP until stopped. */
export async function startMcp(config: McpConfig): Promise<void> {
  const target = config.daemon ? daemonTarget(config.state, config.cwd) : listenerTarget(config.url, config.cwd);
  if (config.http) await serveHttp(target, config.http);
  else await serveOnStdio(target);
}

/** Answer until stdin closes or a signal arrives. Stdout carries only MCP messages. */
async function serveOnStdio(target: McpTarget): Promise<void> {
  const handle = serveStdio(() => createMcpServer(target), {
    onerror: (error) => console.error(`MCP: ${errorMessage(error)}`),
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.stdin.off("end", stop);
      process.stdin.off("close", stop);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.stdin.once("end", stop);
    process.stdin.once("close", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  // Closing aborts calls in progress, which closes their connections.
  await handle.close().catch(() => {});
  process.stdin.destroy();
  exitSoon();
}

/** Bun stays alive while sockets close; leave once they have had a moment. */
function exitSoon() {
  setTimeout(() => process.exit(), 1000).unref();
}

function readToken(): { token: string; generated: boolean } {
  const supplied = process.env.CNS_MCP_TOKEN;
  delete process.env.CNS_MCP_TOKEN;
  if (supplied === undefined || supplied === "") return { token: randomBytes(32).toString("base64url"), generated: true };
  if (!tokenPattern.test(supplied)) {
    throw new Error("CNS_MCP_TOKEN must be 32-1024 characters: letters, digits and . _ ~ + / - (for example, openssl rand -hex 32).");
  }
  return { token: supplied, generated: false };
}

interface HttpOptions { bind: string; port: number; remote: boolean }

/**
 * Serve Streamable HTTP until a signal arrives. Every request must carry the
 * bearer token, and browsers are refused outright: their pages could otherwise
 * reach a local endpoint, and no MCP client of this server is a web page.
 */
export async function serveHttp(target: McpTarget, { bind, port, remote }: HttpOptions): Promise<void> {
  const { token, generated } = readToken();
  const expected = Buffer.from(`Bearer ${token}`);
  const host = isIP(bind) === 6 ? `[${bind}]` : bind;
  // Loopback endpoints also reject DNS-rebound host names; remote ones rely on the token.
  const hostnames = remote ? undefined : [...new Set([...localhostAllowedHostnames(), host])];
  const build = () => createMcpServer(target);
  const onerror = (error: Error) => console.error(`MCP: ${errorMessage(error)}`);
  const modern = createMcpHandler(build, { legacy: "reject", onerror });
  const legacy = new LegacySessions(build, onerror);

  const server = serve({
    hostname: bind,
    port,
    // The SDK's own limit; MCP messages here are small.
    maxRequestBodySize: 4 * 1024 * 1024,
    async fetch(request, server) {
      if (new URL(request.url).pathname !== MCP_PATH) return new Response("Not found. The MCP endpoint is /mcp.", { status: 404 });
      if (request.headers.has("Origin")) return new Response("Browser origins are not allowed.", { status: 403 });
      const rejected = hostnames && hostHeaderValidationResponse(request, hostnames);
      if (rejected) return rejected;
      const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return new Response("A valid Authorization: Bearer token is required.", {
          status: 401, headers: { "WWW-Authenticate": 'Bearer realm="cns"' },
        });
      }
      // Calls can stay quiet far longer than Bun's 10 s idle timeout. Bun 1.4.4 does
      // not apply it to pending responses; this keeps that true for other versions.
      server.timeout(request, 0);
      return await (await isLegacyRequest(request) ? legacy.fetch(request) : modern.fetch(request));
    },
  });

  const url = `http://${host}:${server.port}${MCP_PATH}`;
  console.log(remote
    ? `WARNING: ${url} grants shell access to anyone with the token, over unencrypted HTTP. Trusted LAN/VPN only.`
    : `MCP endpoint: ${url}`);
  console.log(`Tools reach ${target.label}.`);
  console.log(generated
    ? `Authorization: Bearer ${token}\nThis token changes on every start; set CNS_MCP_TOKEN to keep one.`
    : "Authorization: Bearer token from CNS_MCP_TOKEN.");

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await Promise.allSettled([legacy.close(), modern.close()]);
  await server.stop(true);
  exitSoon();
}
