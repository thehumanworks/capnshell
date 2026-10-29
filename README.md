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
| `run <url> -- '<command>'` | Execute one shell command and exit with its status. |
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
| `:help` | Show prompt help. |
| `:quit` | Exit this CLI; from `attach`, detach the console. |

## Command execution

Pass exactly one shell string after `--`; quote it to preserve spaces, redirects and variables for the remote shell:

```sh
cns run ws://127.0.0.1:47381 -- 'printf "hello\n"; exit 7'
cns run ws://127.0.0.1:47381 --cwd /tmp --timeout 10000 -- 'pwd; ls -la'
```

`run` writes remote stdout and stderr to the corresponding local streams without prompts or added newlines and propagates the exit status. A timeout exits with status 124. The connection remains bidirectional while the command runs, so the listener can execute commands on the connecting machine too.

Every command starts a fresh noninteractive shell. Shell variables and standalone `cd` commands do not persist; use `:cwd` or combine operations in one command. There is no PTY, streaming terminal or interactive editor support. Remote stdin is closed; piping input to `cns run` does not forward it.

Output is buffered until completion, with a combined 1 MiB capture limit. Excess output is drained and discarded. Truncation and timeouts add a diagnostic to stderr. Commands have no deadline by default; the maximum optional timeout is 2147483647 ms. Stopping a peer or disconnecting its session attempts to kill that session's process trees; deliberately detached processes can escape cleanup.

The listener allows up to 32 connections and four concurrent commands per connection. Incomplete RPC handshakes expire after five seconds.

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

Tests exercise multiple bidirectional peers, target selection, disconnect isolation, reverse calls during one-shot commands, output/exit-status handling, process cleanup, connection limits, daemon attachment and startup races. The compiled suite additionally tests the executable outside its checkout without a JavaScript runtime on `PATH`.
