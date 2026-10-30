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

`tty` runs a program on a pseudo-terminal on a Linux or macOS peer, so interactive CLIs and full-screen TUIs such as `vim`, `top` or Claude Code render and take keyboard input:

```sh
cns tty                                   # the remote user's login shell ($SHELL -l, else Bash)
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

### RPC interface

`ShellApi.openPty(sink, options)` starts the program and returns a `PtySession` stub:

| Method | Purpose |
| --- | --- |
| `write(data)` | Send keystrokes or other input, at most 64 KiB per call. |
| `resize(cols, rows)` | Resize the terminal (1–1000 each). |
| `capture({ history })` | Render the screen now: `text`, `cols`, `rows`, `cursor`, `alternateScreen` and `title`. Works while the program runs and after it ends, until the session is released. `history` adds up to 1000 scrollback lines. |
| `close()` | Hang up. |

Releasing (disposing) the stub also hangs up and frees the screen. Options are `command`, `cwd`, `timeoutMs`, `cols`, `rows` and `term`, plus `stream: false` to receive no raw output and `respond: true` to have the screen answer terminal queries.

The caller passes `sink`, an `RpcTarget` with `output(bytes)` and `exit(result)`, by reference. The executor waits for each `output` acknowledgement before sending more, coalescing reads into messages of up to 64 KiB. Bun cannot pause PTY reads, so a caller that falls more than 8 MiB behind is hung up with an error. Each connection allows four PTY sessions until they are released. The daemon proxies both stubs between `attach` and its peers.

Windows peers do not support PTYs yet. Bun implements `Bun.Terminal` on Windows through ConPTY, but `cns` has not been adapted to it or tested on Windows. ConPTY differs from POSIX PTYs in how it signals, echoes and translates input.

## Background operation

```sh
cns listen --daemon
cns attach
# :peers, :use p1, then commands; :quit detaches
cns stop
```

The daemon is a detached process, not an installed OS service; it does not restart automatically. Its private local state defaults to `~/.cns/daemon.json`. To run separate daemons, use different ports and pass the same custom `--state PATH` to `listen --daemon`, `attach` and `stop`. Startup prints the log location.

Detaching with `:quit` or Ctrl+C leaves the daemon, peer connections and pending commands running. `stop` shuts down the daemon and cleans up its sessions. A foreground listener stops when its console exits or it receives a termination signal. It does not create daemon state.

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

## Verification

```sh
bun run typecheck
bun test --timeout 30000 ./src
bun run test:compiled
```

Tests exercise multiple bidirectional peers, target selection, disconnect isolation, reverse calls during one-shot commands and PTY sessions, output/exit-status handling, PTY input, sizing, hang-up, timeouts and flow control, rendered screens and scrollback, PTY proxying through the daemon, process cleanup, connection limits, daemon attachment and startup races. The compiled suite additionally tests the executable outside its checkout without a JavaScript runtime on `PATH`.
