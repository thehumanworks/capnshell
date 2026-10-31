# Cap’n Shell (`cns`)

Bidirectional remote shells for Linux, macOS and Windows. Run one executable on each machine. Both peers can execute commands on the other over the same WebSocket; a listener can accept multiple peers.

## Usage

```sh
# Machine A: accept connections
cns listen

# Machine B: connect interactively
cns connect ws://127.0.0.1:47381

# Or run one command, return its output and exit status, and disconnect
cns run ws://127.0.0.1:47381 -- 'uname -a'
```

The same commands work on every supported OS, including Linux under WSL. On Windows use `cns.exe`; commands execute in Windows PowerShell. On Linux and macOS they execute in Bash. The command string must use the **remote** shell's syntax, so use e.g. `'$PSVersionTable.PSVersion'` when targeting Windows.

By default `listen` binds to `127.0.0.1:47381`. For another machine on a trusted private network, bind its reachable interface explicitly:

```sh
cns listen --bind 192.168.1.10 --port 47381 --allow-remote
cns connect ws://192.168.1.10:47381
```

Use an address reachable from the other machine. This does not configure routing, VPNs, firewalls or port forwarding.

| Command | Purpose |
| --- | --- |
| `listen` | Start a foreground listener and interactive console. |
| `listen --no-repl` | Start a foreground listener without a console. |
| `listen --daemon` | Start a background listener. |
| `connect <url>` | Open a bidirectional connection and interactive console. |
| `connect <url> --no-repl` | Connect and expose local execution without a console. |
| `run [url] -- '<command>'` | Execute one shell command and exit with its status. |
| `tty [url] [-- '<command>']` | Open an interactive terminal (PTY) running a login shell or one command. |
| `tty [url] --name NAME [-- '<command>']` | Start a named PTY session in the background. |
| `tty [url] --attach NAME` | Attach to a named session; Ctrl-] detaches. |
| `sessions [url]` | List a peer's named sessions. |
| `keys [url] NAME KEY...` | Send keys or text to a named session. |
| `screen [url] NAME` | Print a named session's screen, optionally once it shows some text. |
| `kill [url] NAME` | End a named session and remove it. |
| `attach` | Open a console for the local daemon. |
| `stop` | Stop the local daemon and its sessions. |

Use `cns <command> --help` for options.

## Multiple peers

Each console can list and select its remote peers:

```text
:peers
:use p2
:info
```

A listener remains available after a peer disconnects. Each connection owns its shell API and commands; disconnecting one does not stop other connections. Peer IDs are never reused during a listener's lifetime.

Non-interactive connection logs identify the remote hostname and network address, including its port. Short IDs such as `p1` are used for interactive selection.

The console automatically selects the initial sole peer. When several peers are present, use `:use ID` explicitly. An explicit selection remains until that peer disconnects; commands never silently switch to another peer. Each console keeps working-directory and timeout settings separately for each peer.

| Prompt command | Purpose |
| --- | --- |
| `:peers` | List connected peers and their IDs. |
| `:use ID` | Select the peer to execute commands on. |
| `:info` | Show the selected peer's platform, shell, hostname and process ID. |
| `:cwd [PATH]` | Show/set its working directory; use an absolute remote path without quotes. |
| `:timeout [MS]` | Show/set its deadline; `0` disables it (the default). |
| `:tty [COMMAND]` | Open an interactive terminal on it: its login shell, or `COMMAND`. Returns to the prompt when the program exits. |
| `:sessions` | List its named PTY sessions. |
| `:attach NAME` | Attach to one of them; Ctrl-] returns to the prompt and leaves it running. |
| `:help` | Show prompt help. |
| `:quit` | Exit this CLI; from `attach`, detach the console. |

## Command execution

Pass exactly one shell string after `--`; quote it to preserve spaces, redirects and variables for the remote shell:

```sh
cns run ws://127.0.0.1:47381 -- 'printf "hello\n"; exit 7'
cns run ws://127.0.0.1:47381 --cwd /tmp --timeout 10000 -- 'pwd; ls -la'
```

### Environment defaults

Set these environment variables in your shell to avoid repeating the endpoint and remote working directory:

```sh
export CNS_BIND=192.168.1.10
export CNS_PORT=47381
export CNS_CWD=/srv/project
cns run -- 'pwd; ls -la'

# Override any default for one invocation
cns run --bind 192.168.1.20 --port 47382 --cwd /tmp -- 'pwd'
```

In PowerShell, set variables with e.g. `$env:CNS_BIND = '192.168.1.10'`.

| Environment variable | CLI override | Applies to | Default when unset |
| --- | --- | --- | --- |
| `CNS_BIND` | `--bind <address>` | `run`/`tty` destination; `listen` interface | `127.0.0.1` |
| `CNS_PORT` | `--port <port>` | `run`/`tty` destination; `listen` port | `47381` |
| `CNS_CWD` | `--cwd <path>` | `run`/`tty` remote working directory | Remote user's home directory |

Precedence is **CLI flag > environment variable > built-in default**. `CNS_BIND` must be a numeric IPv4 or IPv6 address, and `CNS_PORT` must be an integer from 1 to 65535. Empty or invalid values are rejected unless overridden. The working directory is an absolute path on the **remote** machine, not the local one.

Without a URL, `run` and `tty` connect to `ws://<bind>:<port>` using these defaults. An explicit URL (including a hostname, path or `wss://` endpoint) replaces `CNS_BIND` and `CNS_PORT`; do not combine a URL with `--bind` or `--port`. `CNS_CWD` still applies with an explicit URL. `connect` continues to require a URL and ignores these environment variables.

`listen` also uses `CNS_BIND` and `CNS_PORT`, including with `--daemon`. A non-loopback bind still requires explicit `--allow-remote`; environment variables do not opt in to remote shell access.

### Output and execution behavior

`run` writes remote stdout and stderr to the corresponding local streams without prompts or added newlines and propagates the exit status. A timeout exits with status 124. The connection remains bidirectional while the command runs, so the listener can execute commands on the connecting machine too.

Every command starts a fresh noninteractive shell. Shell variables and standalone `cd` commands do not persist; use `:cwd` or combine operations in one command. Remote stdin is closed; piping input to `cns run` does not forward it. For interactive programs, editors and TUIs, use [`tty`](#interactive-terminals-pty).

Output is buffered until completion, with a combined 1 MiB capture limit. Excess output is drained and discarded. Truncation and timeouts add a diagnostic to stderr. Commands have no deadline by default; the maximum optional timeout is 2147483647 ms. Stopping a peer or disconnecting its session attempts to kill that session's process trees; deliberately detached processes can escape cleanup.

The listener allows up to 32 connections and four concurrent commands per connection. Incomplete RPC handshakes expire after five seconds.

## Interactive terminals (PTY)

`tty` runs a program on a pseudo-terminal on the peer, so interactive CLIs and full-screen TUIs such as `vim`, `top` or Claude Code render and take keyboard input:

```sh
cns tty                                   # the remote user's login shell ($SHELL -l, else Bash; PowerShell on Windows)
cns tty --cwd /srv/app -- 'claude'        # one command, with the run quoting rules
cns tty ws://192.168.1.10:47381 -- 'htop'
```

From a console, `:tty` and `:tty COMMAND` do the same on the selected peer, including the reverse direction from a listener or `attach` to a connected peer. The console's `:cwd` and `:timeout` apply.

- A local terminal is switched to raw mode, so Ctrl-C, Ctrl-D, Esc and arrow keys go to the remote program. Its size is sent on start and on every resize. The local terminal is restored when the program exits or the connection drops.
- `tty` exits with the remote program's status (124 after `--timeout`, 128 + signal number after a signal). A timeout or `:tty` hang-up sends SIGHUP to the program, then SIGKILL after one second.
- Without a local terminal, for example from an agent, piped stdin is forwarded byte for byte and output is written raw, including escape sequences. Pass `--cols`/`--rows` for a fixed size (default 80×24) and `--term` for `TERM` (default `xterm-256color`). The end of piped input is not sent as a keystroke. Send `\x04` yourself where a program expects Ctrl-D:

  ```sh
  printf 'ls --color\nexit\n' | cns tty --cols 120 --rows 40
  printf 'hello\n\x04' | cns tty -- 'cat'
  ```

### Rendered screens

Each PTY session renders its output into a headless terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)) on the executing peer, as tmux does for its panes. `--screen` prints what that terminal shows when the program ends, like `tmux capture-pane -p`, instead of the escape sequences that drew it. The renderer only renders; you choose when to look. A program's own exit captures its final screen, and `--timeout` captures a program that keeps running at that moment, then hangs it up:

```sh
cns tty --screen --cols 120 --rows 40 --timeout 5000 -- 'htop'
(sleep 1; printf 'ihello\033') | cns tty --screen --timeout 3000 -- 'vim notes.txt'
cns tty --screen --history 100 -- 'make test'   # include up to 100 scrollback lines
```

Rows are printed with trailing spaces and the blank rows below the last output removed. With `--screen`, or without a local terminal, the remote screen answers terminal queries such as cursor-position reports. TUIs that wait for such answers, including Claude Code, then draw without a real terminal attached. A program that exits through the alternate screen, as vim does on `:wq`, leaves the normal screen behind; that is what a real terminal shows then, too.

### Named sessions

A named session keeps running between commands, so an agent can work with a TUI in steps, as with `tmux send-keys` and `capture-pane`:

```sh
cns tty --name claude --cwd /srv/app -- 'claude'   # start in the background; prints nothing
cns screen claude --until 'trust this folder'       # wait for the prompt, then print the screen
cns keys claude Down                                 # move to "Yes, I trust this folder"
cns screen claude --until '❯ Yes'                    # confirm the key landed before pressing Enter
cns keys claude Enter
cns keys claude 'fix the failing tests' Enter
cns screen claude --history 50
cns keys claude C-c
cns sessions                                         # name, status, size, viewers, command
cns kill claude
```

- **Lifetime:** sessions live in the `cns` process running the program, the listener or the connected peer, not in a connection. They survive the commands and connections that use them and end when killed or when that process stops. Nothing is written to disk. Each process holds up to 16 named sessions, running or finished. A finished session keeps its final screen and exit status until it is killed. `--timeout` on `tty --name` limits the session's lifetime.
- **`keys`** takes tmux-style key names: `Enter`, `Tab`, `BTab`, `Escape`, `Space`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1`–`F12`, with `C-`, `M-` and `S-` prefixes such as `C-c` or `C-Left`. Other arguments are typed as text; `--literal` types every argument as text. The executing peer encodes keys, so arrow keys follow the program's cursor-key mode.
- **`screen`** prints the current screen like `tty --screen`. `--until TEXT` first waits for the screen to show TEXT, checking after every chunk of output. It exits 0 when the text appears, 1 if the program ends first and 124 after `--timeout` (default 30000 ms; 0 waits indefinitely). It prints the screen in each case. The renderer does not decide when a program is finished; `--until` is a convenience over it. To confirm that a key took effect, wait for the screen it should produce rather than sleeping.
- **`tty --attach NAME`** shows a session in your terminal, on its alternate screen as tmux does: detaching or the program's exit returns your terminal to what it showed before. It redraws the current screen, then streams live output and sends your keys. When the program switches between its normal and alternate screens, as vim does, `cns` redraws from its own copy of the session's screen instead of letting your terminal switch. As in tmux, lines that scroll by while attached are not added to your terminal's scrollback; `cns screen NAME --history N` has them. Ctrl-] detaches and leaves the program running; exiting the program ends the attach with its status. Attaching from a terminal resizes the session to that terminal, as in tmux. Several viewers can attach at once. Without a local terminal, `--attach` streams raw output and forwards stdin, without detach key or resize.
- **Terminal queries** are answered by the session's screen unless an attached terminal answers them, so programs keep drawing with no one attached.

### RPC interface

`ShellApi.openPty(sink, options)` starts the program and returns a `PtySession` stub:

| Method | Purpose |
| --- | --- |
| `write(data)` | Send keystrokes or other input, at most 64 KiB per call. |
| `keys(keys, { literal })` | Send tmux-style key names and text, as `cns keys` does. |
| `resize(cols, rows)` | Resize the terminal (1–1000 each). |
| `capture({ history })` | Render the screen now: `text`, `cols`, `rows`, `cursor`, `alternateScreen` and `title`. Works while the program runs and after it ends, until the session is released. `history` adds up to 1000 scrollback lines. |
| `wait({ text, timeoutMs, history })` | Resolve with `{ matched, running, screen }` once the screen shows `text`, the program ends or `timeoutMs` passes (0, the default, has no deadline). |
| `close()` | Hang up. |

Releasing (disposing) the stub also hangs up and frees the screen. Options are `command`, `cwd`, `timeoutMs`, `cols`, `rows` and `term`, plus `stream: false` to receive no raw output and `respond: true` to have the screen answer terminal queries.

Named sessions use `ShellApi.startPtySession(name, options)` and `ShellApi.ptySession(name)`, which return a `NamedPty` handle, and `ShellApi.ptySessions()`, which lists them. A handle has `write`, `keys`, `resize`, `capture` and `wait`, plus:

| Method | Purpose |
| --- | --- |
| `info()` | Name, command, cwd, pid, size, title, start time, `running`, `exit` and the number of viewers. |
| `attach(sink, { cols, rows, answers })` | Stream the session to `sink`, starting with a redraw of the screen. `cols`/`rows` resize the session first. `answers: true` means the caller's terminal answers terminal queries. Returns a `PtyAttachment` with the same controls; releasing it detaches. |
| `kill()` | Hang up, remove the session and resolve with how it ended. |

Releasing a handle leaves its session running, and ends its pending `wait` calls. A handle only reaches the session it was issued for, never a later one that reuses the name. A viewer that stops acknowledging output is detached, and its sink's optional `detached(reason)` is called; the program keeps running.

The caller passes `sink`, an `RpcTarget` with `output(bytes)` and `exit(result)`, by reference. The executor waits for each `output` acknowledgement before sending more, coalescing reads into messages of up to 64 KiB. Bun cannot pause PTY reads, so a caller that falls more than 8 MiB behind is hung up with an error. Each connection allows four unnamed PTY sessions until they are released. The daemon proxies all of these stubs between `attach` and its peers.

`ShellApi.fork()` returns another `ShellApi` on the same peer, with its own limit of four commands and the same named sessions. Releasing the fork kills its commands, so a caller can cancel a `run` without closing its connection. Each shell has up to 32 unreleased forks; closing a shell closes them. Daemon control's `runWhileConnected(id, command, options)` uses a fork so the command ends with the control connection, as `cns mcp` needs. Its `run` leaves commands running after an attached console detaches. Peers running a `cns` without `fork` fall back to `run`.

On Windows peers, programs run on a ConPTY in Windows PowerShell, with the same quoting as `run`. **This path is untested.** It compiles, and `src/shell.test.ts` has a Windows-only PTY test, but it has not been run on Windows yet. The manually triggered `Windows` GitHub Actions workflow (`.github/workflows/windows.yml`) runs both test suites on `windows-latest`, including Windows versions of the named-session tests. Expected differences, from [Bun's ConPTY notes](https://bun.com/docs/runtime/child-process#platform-differences):

- Hang-up and `--timeout` kill the program's process tree; Windows has no SIGHUP for programs to handle.
- ConPTY redraws output itself, so raw output differs from what the program wrote, though rendered screens should match.
- Ctrl-C may not interrupt programs, because the system console host does not always turn it into an interrupt.
- Mouse input needs Windows 11 or Server 2022.

## Background operation

```sh
cns listen --daemon
cns attach
# :peers, :use p1, then commands; :quit detaches
cns stop
```

The daemon is a detached process, not an installed OS service; it does not restart automatically. Its private local state defaults to `~/.cns/daemon.json`. To run separate daemons, use different ports and pass the same custom `--state PATH` to `listen --daemon`, `attach` and `stop`. Startup prints the log location.

Detaching with `:quit` or Ctrl+C leaves the daemon, peer connections and pending commands running. `stop` shuts down the daemon and cleans up its sessions. A foreground listener stops when its console exits or it receives a termination signal. It does not create daemon state.

## MCP server

`cns mcp` gives MCP clients such as Claude Code, Codex and Cursor tools that use a peer the way the commands above do:

| Tool | Purpose |
| --- | --- |
| `list_peers` | Each peer's ID, hostname, OS, shell and home directory. |
| `run_command` | Run one command as `cns run` does and return its exit code, stdout and stderr. |
| `start_session` | Start a named PTY session, as `cns tty --name` does, optionally waiting for its first screen. |
| `send_keys` | Send keys and text, as `cns keys` does, optionally waiting for the screen they produce. |
| `read_screen` | Return the rendered screen, as `cns screen` does, optionally once it shows some text. |
| `list_sessions` | A peer's named sessions. |
| `kill_session` | End and remove a named session. |

Results include text for the agent and structured content matching each tool's output schema. A command that exits nonzero is a normal result with its exit code; an unreachable peer, a missing session or invalid arguments are tool errors. `run_command` has a default deadline of 120 seconds (`timeoutMs: 0` removes it) and returns the start and end of output longer than 30,000 characters. Peers still keep at most 1 MiB. With several daemon peers connected, calls must name a `peer`.

By default the client starts `cns mcp` and talks to it over stdin and stdout. The tools use the listener at the URL, or else `--bind`/`--port`, `CNS_BIND`/`CNS_PORT` or `127.0.0.1:47381`, as `cns run` does. With `--daemon [--state PATH]` they use the peers connected to `cns listen --daemon`, which suits machines behind NAT that connect out to yours. `--cwd PATH` (or `CNS_CWD`) sets the working directory for calls that do not pass `cwd`.

```sh
claude mcp add cns -- /absolute/path/to/cns mcp ws://build-box:47381
codex mcp add cns -- /absolute/path/to/cns mcp --daemon
```

Cursor reads `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "cns": { "command": "/absolute/path/to/cns", "args": ["mcp"] } } }
```

`--http PORT` serves Streamable HTTP at `http://127.0.0.1:PORT/mcp` instead. Every request must carry `Authorization: Bearer TOKEN`, where `TOKEN` is `CNS_MCP_TOKEN` (32 or more characters). Without `CNS_MCP_TOKEN`, a random token is printed at startup and changes on each start. Requests from browsers (any `Origin` header) and loopback requests naming another host are refused. `--http-bind ADDRESS --allow-remote` serves beyond loopback over unencrypted HTTP; use it only on a trusted LAN or VPN.

```sh
export CNS_MCP_TOKEN=$(openssl rand -hex 32)
cns mcp --http 47382 &
claude mcp add -t http -H "Authorization: Bearer $CNS_MCP_TOKEN" cns http://127.0.0.1:47382/mcp
codex mcp add cns --url http://127.0.0.1:47382/mcp --bearer-token-env-var CNS_MCP_TOKEN
```

The server speaks MCP 2026-07-28 and serves 2025-era clients too. Over HTTP, a 2025-era client gets a protocol session so that its cancellations reach its calls; the server keeps no events for it to resume from, so a dropped response also cancels its call. Up to 64 sessions can be open; past that the longest-idle one is closed, and a session idle for an hour is closed too. The server connects to the listener or daemon for each call and closes the connection when the call ends. Cancelling a call, or a client disconnecting, therefore kills its command and ends its screen wait; named sessions keep running. Through a daemon, cancelling a command needs the daemon and the peer to run a `cns` with this server; with older ones the command runs until it ends. While a long call runs, the server reports elapsed time to clients that ask for progress. Clients impose their own tool-call time limits, for example Codex's 300-second default `tool_timeout_sec`, so pass `until` and `waitMs` rather than waiting indefinitely. A listener sees each call as a short-lived peer, but the MCP server refuses its requests: it never gives a listener a shell on its own machine.

## Build and distribute

The compiled executable contains its JavaScript runtime and dependencies. Copy the executable built for the destination OS and architecture to that machine; **Bun, Node.js, source files and `node_modules` are not needed at runtime**. Linux/macOS need Bash and the platform's normal system libraries; Windows uses its built-in Windows PowerShell.

To build from source, install Bun 1.4.2 or newer and run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run build
./dist/cns --help
```

On Windows the output is `dist\cns.exe`. For development, `bun run start --help` runs the same CLI from source. Compiled builds disable automatic `.env` and `bunfig.toml` loading from the working directory.

Bun also supports cross-compilation; for example:

```sh
bun run build --target=bun-linux-arm64 --outfile=dist/cns-linux-arm64
bun run build --target=bun-linux-x64-baseline --outfile=dist/cns-linux-x64
bun run build --target=bun-windows-x64 --outfile=dist/cns.exe
```

Cross-compilation may download a target runtime. Build for the destination's OS, CPU architecture and libc; a macOS binary cannot run on Linux. Standard Linux targets use glibc; Alpine needs a musl target such as `bun-linux-x64-musl`. Cross-compiling alone does not establish runtime compatibility.

### Nix

The flake supports x86_64 Linux, aarch64 Linux and Apple Silicon macOS:

```sh
nix build
./result/bin/cns --help
nix run . -- listen
nix develop
nix flake check
```

The default package/app is also available as `cns` (and the legacy flake attribute `capnweb-shell`). The package contains the executable with an absolute Nix-provided Bash path; it does not require or install a source checkout. Distribute Nix builds through Nix because their runtime libraries may reference the Nix store.

`flake.lock` pins nixpkgs; `bun.lock` pins JavaScript dependencies. Nix fetches production dependencies in a fixed-output derivation and builds/tests offline. When production dependencies change, update the hash in `nix/package.nix` using `lib.fakeHash` and the hash reported by Nix; then rerun `nix flake check`.

## Security

Peer connections provide **unauthenticated arbitrary command execution in both directions** as the running users. Use only trusted loopback, LAN or private VPN connections, never elevated or exposed to the public internet. Binding outside loopback requires `--allow-remote`. Browser-origin WebSocket requests are rejected; this is not authentication. Built-in listeners use `ws://`; clients can also connect to externally provided `wss://` endpoints.

Daemon control uses authenticated Cap’n Web RPC on a separate loopback endpoint, with its token in private local state. Keep the state directory private. Peer selection prevents accidental routing; it is not an authorization boundary or sandbox.

`cns mcp` gives every MCP client that can reach it shell access as the peers' users. Its tool annotations mark commands and keys as destructive, which some clients use to ask for approval, but annotations are hints, not a sandbox. Over stdio, the client that starts it is trusted. Over HTTP, the bearer token is the only authentication; loopback binding is not an authentication boundary, because any local process can connect. Keep the token secret, and do not combine `--allow-remote` with untrusted networks: plain HTTP sends the token in the clear. It is a static token, not MCP's OAuth authorization.

## Verification

```sh
bun run typecheck
bun test --timeout 30000 ./src
bun run test:compiled
```

Tests exercise multiple bidirectional peers, target selection, disconnect isolation, reverse calls during one-shot commands and PTY sessions, output/exit-status handling, PTY input, sizing, hang-up, timeouts and flow control, rendered screens and scrollback, named sessions across connections and CLI calls (keys, waits, attach redraws, detach, kill and limits), PTY proxying through the daemon, process cleanup, connection limits, daemon attachment and startup races. MCP tests drive `cns mcp` with the official SDK client over stdio and HTTP, in both protocol eras: every tool, tool errors, cancellation and disconnects killing commands and freeing screen waits, 2025-era session limits, HTTP authentication, origin and host checks, calls beyond Bun's idle timeout with progress, daemon peer selection and the refusal of reverse calls. The compiled suite additionally tests the executable outside its checkout without a JavaScript runtime on `PATH`.
