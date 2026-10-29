# This host ↔ Mac Studio: outbound connection from the firewalled host

```text
Firewalled host (WSL or Windows) ── opens outbound TCP/WebSocket ──▶ Mac Studio
                              ◀══════ RPC calls both ways ══════▶
```

The Mac listens; this host does not. After connecting, either terminal can execute shell commands on the other peer over the SAME socket. You do not need the earlier Windows/WSL pair running for this test.

## Prerequisites and scope

- Bun 1.4.2+ on the Mac to build the executable (`bun --version`), or Nix on Apple Silicon macOS. The compiled executable does not need Bun/Node installed to run.
- A **trusted LAN or restricted private VPN**, with the Mac reachable from this host.
- Permission for this host to make outbound TCP connections to the Mac's chosen port (47381 by default).
- The Mac must accept the incoming connection. If macOS asks whether capnweb-shell may accept connections, allow it only if appropriate for your network policy. Do not turn off the firewall globally.

This does NOT make a Mac behind an unrelated home router reachable over the internet. That case requires an approved private VPN or relay. It also does not bypass blocked outbound connections on this host.

**No authentication, no TLS, no sandbox. Both peers grant arbitrary shell execution as their current user. Use only for a temporary trusted-network test; do not use on public Wi-Fi, expose to the internet, add router port forwarding, or run as administrator/root.** Browser-originated WebSocket connections are rejected, but that is not authentication.

## 1. Install and start on the Mac

Create the archive on this host with `bun run bundle:mac`, then transfer `dist/capnweb-shell-mac.tar.gz` to your Mac using an existing file-transfer method. The archive contains `src/`, build configuration and a dependency lockfile, not platform-specific node_modules.

In Mac Terminal, assuming the archive is in Downloads:

```bash
mkdir -p ~/capnweb-demo
cd ~/capnweb-demo
tar -xzf ~/Downloads/capnweb-shell-mac.tar.gz
cd capnweb-shell
bun install --frozen-lockfile --ignore-scripts
bun run build
```

Alternatively, build and run from the checkout with `nix build` and `./result/bin/capnweb-shell` on Apple Silicon macOS. See [README.md](README.md#nix-flake) for `nix run github:OWNER/REPO` and profile installation. The Nix package includes the sources needed by `bundle-mac`.

Find the active interface and its IPv4 address:

```bash
IFACE=$(route -n get default | awk '/interface:/{print $2; exit}')
MAC_IP=$(ipconfig getifaddr "$IFACE")
printf 'Mac address: %s\n' "$MAC_IP"
```

If that prints no address, use System Settings → Network to find the interface/address reachable from this host. For a private VPN, use its assigned interface address instead.

Start the listener on **that one interface address**, not all interfaces:

```bash
./dist/capnweb-shell listen --bind "$MAC_IP" --port 47381 --allow-remote
```

`--allow-remote` is an explicit acknowledgment that the listener is no longer loopback-only. Leave this terminal open. Nothing is installed as a service and nothing restarts automatically.

## 2. Connect from this host

In WSL, substitute the Mac address printed above for `MAC_IP`:

```bash
cd /home/nixos/projects/capnweb-shell
bun run connect ws://MAC_IP:47381
```

Or connect from native Windows PowerShell instead:

```powershell
& "$env:LOCALAPPDATA\capnweb-shell\dist\capnweb-shell.exe" connect ws://MAC_IP:47381
```

Choose ONE connecting peer. The listener accepts only one connection, and no inbound listener is opened on the connecting host.

## 3. Test both directions

At this host's `mac>` prompt:

```bash
uname -s
sw_vers
whoami
```

At the Mac's `wsl>` prompt (if WSL connected):

```bash
uname -s
whoami
pwd
```

At the Mac's `windows>` prompt (if native Windows connected):

```powershell
$PSVersionTable.PSVersion.ToString()
Get-Location
```

The prompt always names the REMOTE peer. `:info` reports its platform, shell, home and process ID.

`:quit` or Ctrl+C ends both processes. A standalone `cd` does not persist between commands: use `:cwd ABSOLUTE_PATH`. Commands use fresh noninteractive Bash on the Mac/WSL, or Windows PowerShell on Windows. There is no PTY, streaming terminal, or interactive program support. Output is buffered and capped at 1 MiB. Commands have **no time limit by default**. `:timeout` shows the current setting; `:timeout 0` disables the deadline, while `:timeout 3600000` opts into a one-hour deadline (maximum 2147483647 ms, about 24.8 days). Ctrl+C or disconnect still attempts to stop in-flight commands.

When updating an existing Mac installation, replace its files from the latest bundle, run `bun install --frozen-lockfile --ignore-scripts` and `bun run build`, then restart **both** peers. An older connecting peer still sends its previous timeout setting; updating only the executing peer is not enough.

## Connection problems

- **Connection refused:** verify the Mac listener is running and the address/port match.
- **Timeout:** verify routing, Wi-Fi/client isolation, Mac firewall permissions, and outbound policy on this host. Do not disable firewalls globally to test.
- **Different networks / Mac behind NAT:** use a permitted private VPN or relay; a private LAN address is not internet-routable.
- **Outbound high ports blocked:** ask for an allowed path or use an approved VPN/relay. Merely choosing port 443 does not add TLS or guarantee the connection will be permitted.

No firewall rules, router settings, or OS networking configuration are changed by these commands.

## Tests

```bash
bun run test:compiled
```

Tests cover shell execution, encoding, errors, timeouts, output limits, option validation, and actual calls in both directions between two local processes over IPv6 loopback. They do not verify the path between this host and your Mac.
