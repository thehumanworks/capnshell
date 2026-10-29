// Run from WSL after installing the Windows copy. Starts and stops both real peers.
// Add --long to verify real commands that take longer than the old 30-second deadline.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { selfInvocation } from "../runtime.js";

export async function runIntegrationSmoke(options: { long?: boolean } = {}): Promise<void> {
  if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME) {
    throw new Error("Run this integration test from WSL.");
  }
  const windowsDirectory = execFileSync("bun.exe", [
    "-e", "console.log(require('path').join(process.env.LOCALAPPDATA, 'capnweb-shell'))",
  ], { encoding: "utf8" }).trim();
  // Allocate on Windows, not WSL: mirrored networking may reserve WSL-bound ports on Windows.
  const port = execFileSync("bun.exe", ["-e", "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()});"], { encoding: "utf8" }).trim();

  function start(command: string, args: string[], name: string) {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const state = { child, name, output: "", done: false, code: null as number | null, waiters: new Set<() => void>() };
    const check = () => {
      for (const waiter of [...state.waiters]) waiter();
    };
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { state.output += chunk.toString(); check(); });
    child.on("error", (error) => { state.output += error.message; state.done = true; check(); });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => { state.code = code; state.done = true; check(); resolve(code); }));
    const waitFor = (needle: string, from = 0, timeoutMs = 20000) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        state.waiters.delete(checkOne);
        if (error) reject(error); else resolve();
      };
      const checkOne = () => {
        if (state.output.includes(needle, from)) finish();
        else if (state.done) finish(new Error(`${name} exited before ${JSON.stringify(needle)}.\n${state.output.slice(-4000)}`));
      };
      const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${name}: ${JSON.stringify(needle)}.\n${state.output.slice(-4000)}`)), timeoutMs);
      state.waiters.add(checkOne);
      checkOne();
    });
    const send = async (line: string, expected: string, exitCode?: number, timeoutMs = 20000) => {
      const from = state.output.length;
      child.stdin.write(line + "\n");
      await waitFor(expected, from, timeoutMs);
      if (exitCode !== undefined) await waitFor(`[exit=${exitCode};`, from, timeoutMs);
    };
    return Object.assign(state, { exited, waitFor, send });
  }

  const peers: ReturnType<typeof start>[] = [];
  try {
    const windowsExecutable = execFileSync("wslpath", ["-u", windowsDirectory + "\\dist\\capnweb-shell.exe"], { encoding: "utf8" }).trim();
    const windows = start(windowsExecutable, ["windows", "--port", port], "Windows");
    peers.push(windows);
    await windows.waitFor("Windows listening");
    // WSL's mirrored networking routes 127.0.0.1 connections to the Windows listener.
    const rejected = await fetch(`http://127.0.0.1:${port}`, {
      headers: { Origin: "https://example.invalid", Upgrade: "websocket" }, signal: AbortSignal.timeout(5000),
    });
    assert.equal(rejected.status, 401);
    console.log("PASS: browser-origin connection rejected (no authentication required for native peers)");

    const invocation = selfInvocation(["wsl", "--port", port]);
    const wsl = start(invocation.file, invocation.args, "WSL");
    peers.push(wsl);
    await Promise.all([wsl.waitFor("windows> "), windows.waitFor("wsl> ")]);
    assert.match(wsl.output, /Connected to win32 \/ PowerShell/);
    assert.match(windows.output, /Connected to linux \/ Bash/);
    console.log("PASS: native Windows and WSL peers connected through mirrored localhost networking");

    await Promise.all([
      wsl.send("[Console]::WriteLine('CAPNWEB_WINDOWS=' + $env:OS); [Console]::Error.WriteLine('WINDOWS_STDERR'); exit 7", "CAPNWEB_WINDOWS=Windows_NT", 7),
      windows.send("printf 'CAPNWEB_WSL='; uname -s; printf 'WSL_STDERR\\n' >&2; exit 9", "CAPNWEB_WSL=Linux", 9),
    ]);
    // Separate stdout/stderr pipes can reach this driver in either order.
    await Promise.all([wsl.waitFor("WINDOWS_STDERR"), windows.waitFor("WSL_STDERR")]);
    console.log("PASS: simultaneous RPC in BOTH directions, including stderr and nonzero exit status");

    await Promise.all([
      wsl.send("[Console]::Write('héllo 漢字 ''quoted''')", "héllo 漢字 'quoted'", 0),
      windows.send(`printf '%s' "héllo 漢字 'quoted'"`, "héllo 漢字 'quoted'", 0),
    ]);
    console.log("PASS: Unicode and quoting in both directions");

    await Promise.all([
      wsl.send(":timeout", "Timeout: disabled"),
      windows.send(":timeout", "Timeout: disabled"),
    ]);
    if (options.long) {
      await Promise.all([
        wsl.send("Start-Sleep -Seconds 31; [Console]::Write('LONG_WINDOWS_OK')", "LONG_WINDOWS_OK", 0, 45000),
        windows.send("sleep 31; printf LONG_WSL_OK", "LONG_WSL_OK", 0, 45000),
      ]);
      console.log("PASS: real 31-second commands complete in both directions without a deadline");
    }

    // Control bytes expand 6x in JSON; verify the permitted result fits the transport.
    await windows.send("head -c 1048676 /dev/zero", "OUTPUT TRUNCATED at 1 MiB", 0);
    console.log("PASS: 1 MiB output limit survives JSON escaping over RPC");

    await Promise.all([wsl.send(":timeout 200", "Timeout: 200 ms"), windows.send(":timeout 200", "Timeout: 200 ms")]);
    await Promise.all([
      wsl.send("Start-Sleep -Seconds 10", "TIMED OUT"),
      windows.send("sleep 10", "TIMED OUT"),
    ]);
    console.log("PASS: optional timeouts over RPC on both operating systems");
    await Promise.all([
      wsl.send(":timeout 0", "Timeout: disabled"),
      windows.send(":timeout 0", "Timeout: disabled"),
    ]);

    wsl.child.stdin.write(":quit\n");
    let timer: NodeJS.Timeout | undefined;
    try {
      const codes = await Promise.race([
        Promise.all(peers.map((peer) => peer.exited)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Peers did not shut down.")), 5000); }),
      ]);
      assert.ok(codes.every((code) => code === 0), `Unexpected peer exit codes: ${codes}`);
    } finally { clearTimeout(timer); }
    console.log("PASS: quitting one peer closes both; no listener left running");
  } finally {
    for (const peer of peers) {
      if (!peer.done) {
        peer.child.stdin.write(":quit\n");
        const killTimer = setTimeout(() => { if (!peer.done) peer.child.kill("SIGKILL"); }, 1500);
        await peer.exited;
        clearTimeout(killTimer);
      }
    }
  }
}
