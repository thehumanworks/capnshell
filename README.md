# Cap’n Web shell peers

Two peers expose the same typed `ShellApi` over **one WebSocket**. Each terminal executes commands **on the other peer**: Bash on Linux/macOS, Windows PowerShell on Windows. Cap’n Web handles all RPC; there is no custom protocol.

The application is TypeScript, uses **Bun** for dependencies, execution, tests and compilation, and builds a **standalone executable** containing its runtime and dependencies. Node.js and npm are not required.

**No authentication, no sandbox. Anyone who can connect can execute commands as the connected users. Use only for temporary loopback or trusted LAN/private VPN tests, never elevated or exposed to the internet.**

## Build and run with Bun

Install Bun 1.4.2 or newer (or use the Nix development shell below):

```bash
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
./dist/capnweb-shell --help
```

On Windows the output is `dist\capnweb-shell.exe`:

```powershell
.\dist\capnweb-shell.exe --help
```

`bun run build` uses `bun build --compile`. The executable can run without Bun, Node, `node_modules`, or a source checkout. Cross-compilation is also available, for example `bun run build --target=bun-windows-x64 --outfile=dist/capnweb-shell.exe`; Bun may download the target runtime. Nix builds deliberately use only the host runtime so compilation stays offline. It still requires its platform’s normal system libraries and the executing shell (Bash or Windows PowerShell). A binary built with Nix’s Bun can reference Nix-store libraries; distribute that build through Nix, rather than treating it as a universal Linux binary. Compile on the destination platform for a non-Nix deployment.

For development, run TypeScript directly without compiling:

```bash
bun run start --help
bun run listen --bind ::1 --port 47381
bun run connect ws://[::1]:47381
```

Compiled builds disable automatic `.env` and `bunfig.toml` loading from the working directory. Source development follows Bun’s normal configuration-loading behaviour.

### Commands

| Command | Purpose |
| --- | --- |
| `listen` | Listen on macOS, Linux or Windows; defaults to `127.0.0.1:47381`. |
| `connect <url>` | Connect outward to a `ws://` or `wss://` peer. |
| `windows` | Start the native Windows loopback listener. |
| `wsl` | Connect from WSL to Windows using mirrored localhost networking. |
| `bundle-mac [--source PATH] [--output FILE]` | Create a transferable **source** archive. |
| `install-windows [--source PATH] [--destination PATH]` | Copy sources and build a standalone Windows executable. Requires Windows Bun. |
| `integration-smoke [--long]` | Test the installed native Windows peer against WSL. Requires WSL and Windows Bun. |

Use `--help` after any command. Convenience scripts (`bun run wsl`, `windows`, `bundle:mac`, `install:windows`, `test:integration`) use the same CLI.

## Nix flake

The flake exposes `packages.default`, `packages.capnweb-shell`, `apps.default`, a development shell, and build checks. `flake.lock` pins nixpkgs; `bun.lock` pins JavaScript dependencies. Nix is supported on **x86_64 Linux, aarch64 Linux and Apple Silicon macOS**, matching the pinned nixpkgs Bun package. Intel macOS and native Windows are not Nix targets here.

Enable `nix-command` and `flakes` in your Nix configuration if they are not enabled already.

### From this checkout

```bash
# Temporary development tools; no system/global installation
nix develop
bun install --frozen-lockfile --ignore-scripts
bun run test:compiled

# Or build/run without managing node_modules yourself
nix build
./result/bin/capnweb-shell --help
nix run . -- listen --bind ::1

# Check the package, including its offline build and shell tests
nix flake check
```

The Nix package is the **Bun-compiled executable**, not a wrapper that starts an interpreter. It includes a source copy for setup commands and an absolute Nix-provided Bash path, without changing the remote commands’ `PATH`. Normal commands still have access to the executing user’s environment and permissions.

### Run or install from GitHub

After pushing this project to GitHub, replace `OWNER/REPO` with its actual repository:

```bash
nix run github:OWNER/REPO -- --help
nix run github:OWNER/REPO -- connect ws://HOST:47381

# Explicit user-profile installation (not performed by this project)
nix profile add github:OWNER/REPO#capnweb-shell
capnweb-shell --help

# Pin a particular commit when desired
nix run github:OWNER/REPO/COMMIT -- --help
```

For a declarative configuration, add the repository as a flake input and include `inputs.capnweb-shell.packages.${pkgs.stdenv.hostPlatform.system}.default` in `environment.systemPackages` or `home.packages`. No GitHub URL is hard-coded because this checkout has no configured Git remote.

Commit **all source files, `bun.lock`, `flake.nix`, `flake.lock`, and `nix/package.nix`** before using the GitHub flake. A Git-backed local flake ignores untracked files; stage new files before testing that form of the flake.

### Dependency updates

Bun dependencies are fetched in a fixed-output derivation using a frozen lockfile and disabled lifecycle scripts. Compilation and Nix checks then run offline; they do not download packages or cross-compilation runtimes in the build sandbox.

After changing dependencies, run `bun install`, then update the dependency hash in `nix/package.nix`: temporarily set `outputHash = lib.fakeHash`, run `nix build .#default.passthru.dependencies`, and copy the reported `got: sha256-...` value into `outputHash`. Re-run `nix flake check`. Do not disable the sandbox to work around a hash mismatch.

## Connect to a Mac Studio

See [README-MAC.md](README-MAC.md) for setup and reachability requirements. The Mac listens, this host connects outward, and RPC works both ways without an inbound listener on this host.

```bash
# Mac: bind only its reachable trusted LAN/VPN interface
./dist/capnweb-shell listen --bind MAC_LAN_IP --port 47381 --allow-remote

# This host
./dist/capnweb-shell connect ws://MAC_LAN_IP:47381
```

The non-loopback listener requires explicit `--allow-remote`. It is still unauthenticated and unencrypted. This does not make a Mac behind a router internet-reachable; use an approved private VPN or other permitted networking arrangement, not port forwarding.

### Source-based setup from a standalone binary

Peer commands need no source files. `bundle-mac` and `install-windows` intentionally operate on sources and require a complete source tree. Resolution order is:

1. `--source PATH`;
2. `CAPNWEB_SOURCE_DIR`;
3. the source copy included by the Nix package;
4. the source module’s project directory in development, or the current directory for a plain compiled executable.

For example:

```bash
./dist/capnweb-shell bundle-mac --source "$PWD"
# Or from any directory with the Nix-installed CLI:
capnweb-shell bundle-mac --output ./capnweb-shell-mac.tar.gz
```

The default output is `./dist/capnweb-shell-mac.tar.gz`, relative to the caller, never inside a read-only Nix store. The archive includes TypeScript sources, Bun/Nix lockfiles, configuration and documentation—not `node_modules` or a host-specific executable. Archive creation uses the `tar` library, not a system tar command.

## WSL ↔ Windows

This machine uses **WSL mirrored networking**: Windows listens on `127.0.0.1`, WSL connects. Other WSL networking modes may require a different setup; do not expose this unauthenticated listener to a network as a workaround.

### Install or refresh the Windows copy

Install Bun on Windows first. From the WSL source checkout:

```bash
bun install --frozen-lockfile --ignore-scripts
bun run install:windows
```

Or use the compiled/Nix CLI:

```bash
capnweb-shell install-windows --source /absolute/path/to/capnweb-shell
```

The installer copies the source into `%LOCALAPPDATA%\capnweb-shell`, runs native Windows `bun install --frozen-lockfile --ignore-scripts`, then compiles `dist\capnweb-shell.exe`. From WSL it uses `bun.exe` and `wslpath`; from Windows it uses native Bun directly. No PowerShell execution-policy change is needed. The source and installed copy are separate; rerun after changes.

A custom `--destination` is an **absolute Windows path**, even from WSL. The installer refuses unrelated nonempty destinations and paths overlapping the source. It does not install Bun, change firewall rules, add services, or alter the user’s profile.

Start in **Windows PowerShell**:

```powershell
& "$env:LOCALAPPDATA\capnweb-shell\dist\capnweb-shell.exe" windows
```

Then in **WSL**:

```bash
./dist/capnweb-shell wsl
```

The WSL prompt is `windows>`; Windows shows `wsl>`. Each names the **remote** shell. Try `$PSVersionTable.PSVersion.ToString()` at `windows>` and `uname -a` at `wsl>`.

To change ports, pass the same `--port 47382` on both sides. If connection is refused, verify the Windows peer is running and the ports match. The Pi tool sandbox on this host can also block `127.0.0.1` traffic; automated local transport tests use `::1` instead.

## Prompt and execution model

| Command | Purpose |
| --- | --- |
| `:info` | Show remote platform, shell, hostname, home and process ID. |
| `:cwd` | Show the selected remote working directory. |
| `:cwd PATH` | Set an absolute path on the **remote** OS, without surrounding quotes. |
| `:timeout` | Show the deadline; disabled by default. |
| `:timeout 0` | Disable the deadline. |
| `:timeout 3600000` | Set a one-hour deadline in milliseconds. Maximum: 2147483647. |
| `:help` | Show help. |
| `:quit` | Disconnect both peers. |

Every command starts a fresh noninteractive shell in the selected directory (the remote user’s home by default). A standalone `cd`, environment change or shell variable does not persist. Use `:cwd` or combine operations in one command. There is no PTY, streaming terminal, persistent shell session, editor or interactive password-prompt support.

Results include stdout, stderr and exit status. Output is buffered until completion with a **combined 1 MiB capture limit**; additional output is drained and discarded, not used to terminate the process. Commands have **no deadline by default**. `:timeout` is opt-in. Ctrl+C, disconnect or session disposal attempts to stop the process tree. Deliberately detached processes can escape cleanup; this is not a sandbox.

Disconnecting either peer ends both processes. Restart both to reconnect or pick up an updated executable. There are no automatic restarts or background services.

## Security limits

The listener defaults to loopback, accepts one peer and rejects requests carrying a browser `Origin` header. These restrictions reduce accidental exposure but **are not authentication**: local software can connect without credentials. A second peer is rejected during the upgrade with HTTP 409.

Both peers grant arbitrary command execution with their current user’s files, environment and permissions. There is no per-command confirmation. The built-in listener serves `ws://`, not TLS; the client can also connect to `wss://` endpoints. Never run elevated, on public Wi-Fi, with router port forwarding, or exposed to the internet. Bind only the intended trusted interface and stop both peers when finished. These commands do not change OS networking or firewall policy.

## Tests

```bash
bun run typecheck
bun run test              # source-mode CLI and API tests
bun run test:compiled     # builds, then exercises the standalone CLI too
nix flake check           # offline Nix package build + non-network tests
```

Tests cover typed and malformed Cap’n Web calls, simultaneous RPC in both directions, connection restrictions, shell output/encoding/errors, deadlines, output limits, CLI help/errors, source archives, installer safeguards and subprocess failure propagation. The compiled suite also relocates the executable and runs it with an empty `PATH` to verify that no external JS runtime is required. Installer unit tests mock Bun; they do not modify the real Windows installation.

After installing the Windows copy, the WSL-only smoke command starts and stops actual Windows and WSL peers:

```bash
bun run test:integration
bun run test:integration --long
```

`--long` adds 31-second commands in both directions. This command requires native Windows Bun for Windows-side environment/port discovery, even though the installed peer itself is standalone.

## Code and libraries

- `src/cli.ts`, `src/cli-program.ts`: one CLI entrypoint and Commander subcommands.
- `src/commands/peer.ts`: Bun native WebSockets with Cap’n Web’s `newBunWebSocketRpcSession` on the listener and `newWebSocketRpcSession<ShellApi>` on the client. Both export a local `ShellApi` over the same socket.
- `src/shell.ts`: `RpcTarget`, Zod runtime validation, shell subprocesses and bounded capture. `tree-kill` handles Windows cleanup; POSIX uses native process-group signalling.
- `src/commands/bundle.ts`, `install-windows.ts`, `integration-smoke.ts`: setup/test commands using `tar` and Execa where appropriate.
- `src/project.ts`, `src/runtime.ts`: source resolution and source/standalone invocation handling.
- `src/*.test.ts`: tests, run by Bun.
- `nix/package.nix`, `flake.nix`, `flake.lock`: dependency fetch, native build, package/app/dev-shell outputs and checks.

TypeScript is strict. `skipLibCheck` works around recursive tuple declarations in Cap’n Web 0.12’s published types without disabling application checking. Bun’s export condition selects Cap’n Web’s official Bun support; there is no WebSocket type cast or hand-rolled transport.
