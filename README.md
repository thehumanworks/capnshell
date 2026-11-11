# Cap’n Shell (`cns`)

Shells, terminals and files on your own devices, on Linux, macOS and Windows. Run one executable on each machine, pair two devices once, and reach each by name: directly, or through the relay built into cns when they are on different networks. Every link is authenticated and encrypted end to end, and each device gets only what the other's owner granted.

## Install

Each [GitHub release](https://github.com/thehumanworks/capnshell/releases) has the executable for Linux (x64, arm64), macOS (Apple Silicon, Intel) and Windows (x64), which [mise](https://mise.jdx.dev) installs:

```sh
mise use -g github:thehumanworks/capnshell
```

Or download `cns-VERSION-OS-ARCH.tar.gz` (`.zip` on Windows) from the release yourself: it holds just `cns`, and `SHA256SUMS` lists every archive's checksum. With Nix, see [Nix](#nix). To build it, see [Build and distribute](#build-and-distribute).

## Usage

```sh
# On the machine you want to reach
studio $ cns up                     # start this device's daemon
studio $ cns pair                   # show a short code and wait

# On the other machine
laptop $ cns pair 42-orbit-canyon-velvet   # the code studio's cns pair shows; compare fingerprints, then confirm on both
laptop $ cns run studio -- 'uname -a'
laptop $ cns tty studio
```

[Paired devices](#paired-devices) below covers pairing, grants and the relay. The command string must use the **remote** shell's syntax: on Linux and macOS commands execute in Bash, on Windows in Windows PowerShell, so use e.g. `'$PSVersionTable.PSVersion'` when targeting Windows.

| Command | Purpose |
| --- | --- |
| `up` | Start this device's daemon, which paired devices link to; `--install` makes it a service. |
| `pair [CODE]` | Pair with another device: show a code, or type the one the other device shows (`--long` for a pasteable invite). |
| `peers` | List paired devices, their status and the access each has. |
| `peer grant/revoke/remove/address NAME` | Change a pairing. |
| `status`, `doctor [NAME]` | Show this device's daemon and links, or check how a paired device is reached. |
| `run DEVICE -- '<command>'` | Execute one shell command and exit with its status; piped stdin is forwarded. |
| `cp SOURCE DEST` | Copy one file to or from a paired device, with the remote side written `DEVICE:PATH`. |
| `tty DEVICE [-- '<command>']` | Open an interactive terminal (PTY): a login shell in a session of its own (`tty-1`, `tty-2`, ...), or one command. |
| `tty DEVICE --name NAME [-- '<command>']` | Start a named PTY session in the background. |
| `tty DEVICE --attach NAME` | Attach to a named session; Ctrl-] detaches. |
| `sessions DEVICE` | List a device's named sessions. |
| `keys DEVICE NAME KEY...` | Send keys or text to a named session. |
| `screen DEVICE NAME` | Print a named session's screen, optionally once it shows some text. |
| `kill DEVICE NAME` | End a named session and remove it. |
| `mcp [DEVICE]` | Serve MCP tools on a paired device, or on the devices linked to the daemon. |
| `attach` | Open a console for the local daemon. |
| `stop` | Stop the local daemon and its sessions. |

Use `cns <command> --help` for options, and `cns --version` for the version of this cns.

## Device identity

Pairing (see [docs/paired-peers.md](docs/paired-peers.md)) identifies devices by a long-lived Ed25519 key pair, created on first use:

```sh
cns identity          # Fingerprint: k7qm-3h2x-...   Public key: ...
cns identity --json   # { publicKey, fingerprint, createdAt, path }
```

The key lives in `~/.cns/identity.json` (or `$CNS_CONFIG_DIR/identity.json`), readable only by your user, under the same trusted-path checks as paired devices (see Storage below). The public key is this device's name on the wire; the fingerprint, SHA-256 of the public key in base32, is what people compare when pairing. The file is never replaced: deleting it makes this a new device that every peer must pair with again. On Windows, cns creates `~/.cns` with an ACL that lets in only your user, SYSTEM and Administrators, and refuses a configuration directory whose ACL allows anyone else, as Windows OpenSSH does for `~/.ssh`.

## Paired devices

Two devices you know can pair once and then reach each other by name, each granted only what the other's owner allowed. Pairing uses the device identities above; [docs/paired-peers.md](docs/paired-peers.md) has the design.

```sh
# On the machine you want to reach
studio $ cns up                       # run as a paired peer; creates the identity on first use
studio $ cns pair                     # shows a code and waits
Code: 42-orbit-canyon-velvet

# On the other machine
laptop $ cns pair 42-orbit-canyon-velvet   # shows studio's fingerprint and asks before pairing
# studio's cns pair shows laptop's fingerprint and asks what laptop may use there

laptop $ cns run studio -- 'git status'
laptop $ cns cp ./notes.md studio:~/      # needs only the files grant
laptop $ cns tty studio                 # a login shell of its own, session tty-1, that survives disconnects
laptop $ cns sessions studio            # each terminal's session, and any other named sessions
laptop $ cns sessions                   # every paired device's sessions in one table
laptop $ cns ui                         # all of them in a switcher: Ctrl-] moves between sessions
laptop $ cns peers
NAME    STATUS  CONNECTION  VERSION  ACCESS                  FINGERPRINT
studio  online  direct      1.4.0    shell, files, sessions  k7qm-3h2x-...
```

- **`cns up`** runs this device's peer daemon. It listens on every interface by default (`--bind` narrows it; `CNS_BIND`/`CNS_PORT` apply) and accepts only paired devices: a connection must authenticate with its identity before anything is exported, and an unpaired device, or an older `cns`, is refused with a message saying so. The daemon also dials the saved addresses of paired devices and keeps those links up with backoff, so either side can initiate. Once a link is up, each daemon asks the other where it can be reached now and saves that in its record: the listening and relay addresses the other device advertises replace the ones it advertised before, while hostnames added with `cns peer address` and the address the link was just dialed at are kept. A device that moved networks or changed relays is then dialed where it is, and a device that paired with an inviter learns where to dial it back. A standing link that runs through the relay is replaced by a direct one once either daemon can dial the other directly, ten seconds or more after the link was made, so two devices on one network end up linked directly even when only one of them accepts connections, as with a device in WSL. Each also reports what it currently lets the other do, so the access `cns peers` shows follows grants changed on the other device since pairing. `attach` and `stop` work on it as on any daemon, and `cns up` recovers from the state file a crashed daemon left behind.
- **`cns up --install`** makes the daemon a service, so it survives reboots: a launchd agent (`~/Library/LaunchAgents/com.thehumanworks.cns.plist`, log in `~/.cns/service.log`) on macOS, a systemd user service (`~/.config/systemd/user/cns.service`, log in `journalctl --user -u cns`) on Linux. The service starts the daemon at login and restarts it if it fails. It keeps the running daemon's `--bind` and `--port` unless you pass new ones, and replaces that daemon. The service file is private (`0600`). `cns stop` stops the daemon until the next login or `cns up`, which starts it through the service. Run `cns up --install` again to change its settings or after moving `cns`, and `cns up --uninstall` to stop and remove it. On Linux, systemd stops user services at logout unless lingering is on (`loginctl enable-linger $USER`); `cns` says so when it is off. Other platforms are refused.
- **`cns pair`** on the device to be reached shows a single-use pairing code, such as `42-orbit-canyon-velvet` (five minutes by default, `--expires`), and waits; the code ends early if that `cns pair` exits. Type it on the other device: `cns pair 42-orbit-canyon-velvet`, with dashes or spaces, in any case, and the first four letters of each word are enough. A word that is not on cns's list is refused before anything is sent. The number names a room on the relay and the three words are a password the two devices check against each other there with a PAKE (CPace), so neither the relay nor anyone watching learns the words or can test guesses offline. A wrong code is reported on both devices, and three wrong ones end it. Once the words match, the inviting device sends its invite, encrypted under the key they agreed, and pairing continues as with an invite. Without the relay (offline, or for scripts), `cns pair --long` prints the invite itself, `cns1:...`, to paste with `cns pair 'cns1:...'`; it is also printed when the relay cannot give a code. [docs/adr/0004-pairing-codes.md](docs/adr/0004-pairing-codes.md) has the design and its threat model. The device with the invite connects to one of the invite's addresses, proves it knows the invite's secret, and proposes a pairing: the name it suggests for itself, what it asks to use (`--request`, default `all`) and what it lets the other device use in return (`--grant`, default none). Both people see the other device's fingerprint and confirm, and each side chooses its own alias for the other (`--name`; by default the name the other device suggests, made unique). Without `--grant`, each side asks what the other may use here: the inviting side whether to allow what was requested, the accepting side `What may studio use on this device?` (`none`, the default, `shell`, `files`, `sessions`, `all` or a comma-separated list). The inviting side grants at most what was requested. `--yes` answers every prompt for scripted setups after you have compared fingerprints yourself, and alone grants nothing. A name already in use, or a device already paired, is refused before anything is sent. Declined or refused pairings, expired or unknown invites and codes, and wrong codes exit 3.
- **Grants** are directional and enforced by the device that grants them: `shell` (run commands and open terminals), `files` (read, write and list files), and five session permissions, granted together as `sessions`: `sessions:list` (list them), `sessions:create` (start one), `sessions:view` (read the screen, wait for text and watch it attached), `sessions:control` (type, send keys and resize) and `sessions:kill`. A device may always view, type into and kill the sessions it started, which `cns sessions --json` shows as their `owner`, so `sessions:create` alone amounts to running commands; a viewer without `sessions:control` cannot type into, resize or answer the program's queries on a session it watches. A denied call fails with `Permission denied` and exit status 4, with no side effects; the message names the missing grant and the command to run on the other device, such as `To allow it, run on studio: cns peer grant laptop shell`. What a device may do on the other is shown under `ACCESS` in `cns peers`, which, for a device that grants this one nothing, says what to run there. `ACCESS` is what was granted at pairing; `cns doctor NAME` asks the device and saves what it says now.
- **The daemon's link.** When this device's daemon (at the default state path, running as this identity) has a standing link to the device a command names, `run`, `tty`, `cp`, `sessions`, `keys`, `screen`, `kill` and `mcp DEVICE` use it instead of dialing: the daemon lends the command a fork of the device's shell over the link, which the device releases, ending the command's commands, terminals and handles, when the command exits, and the command loses its connection if the link drops, as it would its own. The device's grants to this device apply as on any connection. Nothing is dialed, so a device that cannot be dialed at all, such as one in WSL behind its host's firewall, answers as quickly as any other on the network. Without such a link, or with an older daemon, the command dials the device itself.
- **Targets.** `run`, `tty`, `cp`, `sessions`, `keys`, `screen`, `kill` and `mcp` take a paired device's name as their first argument. They connect with this device's identity and require the saved identity on the other end: if the device behind the address changed, the command exits 3 and nothing runs. A name that is not a paired device is an error, never a hostname, and names never fall back to another device.
- **Reconnecting terminals.** At a terminal, `cns tty studio` starts a login shell in a named session of its own on that device, `tty-1`, `tty-2` and so on (the first name free there), so every terminal window gets its own shell; `cns tty studio --attach NAME` attaches to a named session, which others may be attached to as well. A session `cns tty studio` started belongs to its terminal: it is removed when its shell exits, and ended when `cns` is stopped or the terminal window closes while the device can be reached, as an ssh session would be. Ctrl-] detaches and leaves it running, and `cns tty studio --attach tty-1` returns to it; when `cns` cannot end it, such as after giving up on reconnecting, it says that the session keeps running and how to return to or kill it. If the connection drops, either keeps trying to reach the device again, through any of its saved addresses, for ten minutes, and then reattaches to the same session: the screen is redrawn and `cns` reports how many bytes of output were written meanwhile. Input that was in flight is reported as possibly lost and never sent twice; keys typed while disconnected are discarded rather than typed blind, except Ctrl-C, which stops, and Ctrl-], which gives up and leaves the session running. A session that ended and was replaced while disconnected is not joined silently. If the device revoked access (exit 4), no longer accepts this one (exit 3) or the session is gone (exit 1), it says so and stops. Ctrl-] detaches; the session keeps running on the device. Piped input, `cns tty studio -- COMMAND`, and a device that does not let this one start sessions get an unnamed terminal that ends with the connection.
- **`cns status [--json]`** shows this device's fingerprint, the version of this cns and of its daemon, and its live links. **`cns doctor NAME`** tries each saved address of a paired device with this device's identity, within ten seconds each, and reports `ok`, `unreachable` or the handshake's refusal (`identity-changed`, `not-paired`, `refused`, `protocol`) per address, plus the grants in both directions (this device's access as the device reports it, saved when it changed), the version of cns it runs, with what to upgrade when it differs from this one, and whether the local daemon has a standing link; it exits 3 when an address answered as another device or refused the pairing and 5 when none answered or none is saved. **`cns doctor`** with no name checks this device instead: its identity, whether a paired daemon runs with that identity, the relay and whether the daemon is registered there, and each advertised address marked private or reachable from other networks, with a warning when every one is private or when the daemon runs another version of cns (see [Upgrading](#upgrading)); it exits 3 when the daemon runs as another identity and 5 when there is no identity, no paired daemon or no address.
- **Changing a pairing.** `cns peer grant NAME shell,files` widens what a paired device may do here, at once and without interrupting its links. `cns peer revoke NAME [grants]` narrows it: the running daemon drops that device's links and dials again, so commands, terminals and session handles that relied on the revoked access end. `cns peer remove NAME` unpairs it and ends its links. `cns peer address NAME URL... [--remove]` changes where it is dialed. The daemon finds a device's links by its key, so this also works after renaming its file.
- **Links.** Each device uses the other through the other's daemon, whose grants revocation reaches. A command you run (`cns run studio`, `cns tty studio`) only uses the other device and offers nothing back. When both devices run daemons and dial each other at once, exactly one link survives: the device with the smaller public key keeps the one it dialed. A daemon dials only when it has no link, so a dial arriving later replaces the link this side holds, which must have died on the other side. Each side sends a heartbeat every 15 seconds when idle, and a link that delivers nothing for 45 seconds is closed, so a device that vanished shows `offline` within a minute and the daemons redial.
- **`cns peers [--json]`** lists paired devices with status (`online` while the local daemon has a link, else `offline`), the connection path, the version of cns an online device runs (`older` for a release from before devices reported it), the access this device has there, and the fingerprint, then names the online devices that run an older cns than this one. The JSON fields are `name`, `status`, `connection`, `version` (null while offline or not reported), `fingerprint`, `access`, `grants` (what the peer may do here) and `addresses`. `cns peer list [--json]` prints each device's name, fingerprint and first address, for scripts.
- **Storage.** A paired device is a private JSON file under `~/.cns/peers/<name>` (or `$CNS_CONFIG_DIR/peers`), keyed by its public key. Renaming the file renames the device without changing trust. A device cannot be saved twice under different names, and pairing never replaces an existing name. A file there that is not a paired-device record is reported and skipped by the daemon, and refused when named; remove it with `cns peer remove NAME`. The configuration directory and its entire path must be trusted and protected by the user from modification by other users; custom `CNS_CONFIG_DIR` directories must already exist. On Unix, untrusted owners and shared-writable ancestors other than root-owned sticky directories are rejected. These pathname checks are best-effort safeguards, not a filesystem security boundary or a guarantee against path races, and they do not protect against a process running as the same user. On Windows, the configuration and peers directories' ACLs must allow only your user, SYSTEM and Administrators; the error names the `icacls` command that fixes one that allows more.
- **Relay.** Devices that cannot reach each other directly meet at the relay built into cns, with nothing to set up: `cns up` registers this device there by proving its key, and its invites list the relay address after its direct ones. Other devices try the direct addresses first and the relay last, for commands, pairing, `doctor`, MCP, Pi and the daemons' standing link, including for paired devices whose saved record names no relay (`cns doctor` lists that attempt as `[built-in relay]`); `cns peers`, `cns status` and `cns doctor` say which path a link uses. The relay forwards encrypted records it cannot read and cannot impersonate either device. It accepts only cns as a client: every request carries a header made with a key built into cns, which keeps other programs off the relay but not someone who takes cns apart, so the relay is never what keeps a device safe; the end-to-end authentication below is. [docs/adr/0001-built-in-relay.md](docs/adr/0001-built-in-relay.md) records the design and its limits, and [relay/](relay/README.md) is the relay itself, a Cloudflare Worker. A daemon re-registers after the relay restarts or stops answering its pings, answers at most 32 dialers through it at once, and saved addresses are tried direct first and relays last whatever their order.
- **Security.** Links between paired devices are authenticated and encrypted end to end. Both devices prove their identities before anything is exported, and a saved identity that changes is refused. The handshake also exchanges fresh libsodium `crypto_kx` keys, covered by both signatures, so each connection has its own keys for each direction; every later message is a libsodium `secretstream` record (XChaCha20-Poly1305), which is encrypted, authenticated, kept in order and never accepted twice. A tampered, replayed or unencrypted message closes the link. The handshake itself is not encrypted: anyone on the network, or a relay, sees both devices' public keys (so the same devices can be recognized on any network), whether it is a daemon link or one command, an invite's id, refusal reasons, and the size and timing of encrypted messages, but nothing of what they carry. Close frames carry only fixed phrases. The session keys exist for one connection, so a stolen identity file does not decrypt recorded traffic; this device's own copies are wiped when the link closes, though libsodium may leave copies in its memory until reused.

## Multiple peers

`cns attach` opens a console on the local daemon, which lists and selects the devices linked to it:

```text
:peers
:use p2
:info
```

The daemon remains available after a device disconnects. Each connection owns its shell API and commands; disconnecting one does not stop other connections. Peer IDs are never reused during a daemon's lifetime.

The daemon's log identifies each connection's device, hostname and network address, including its port. Short IDs such as `p1` are used for interactive selection.

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

Everything after the first `--` is the command, in the remote shell's syntax; options after it belong to the command. Several words are joined with spaces, as `ssh` does, so simple commands need no quotes. Your local shell still expands what is unquoted, such as `$HOME`, globs, `|`, `;` and `>`, before `cns` sees it: quote those to have the remote shell handle them. One quoted string reaches the remote shell unchanged. `tty` takes its command the same way.

```sh
cns run studio -- git status
cns run studio -- ls -la /tmp
cns run studio -- 'printf "hello\n"; exit 7'
cns run studio --cwd /tmp --timeout 10000 -- 'pwd; ls -la'
```

### Environment defaults

`CNS_CWD` sets the remote working directory for `run`, `tty` and `mcp` when `--cwd` is not given; by default commands start in the remote user's home. It is an absolute path on the **remote** machine, not the local one. `CNS_BIND` and `CNS_PORT` set the interface and port `cns up` listens on (default every interface, port 47381) when `--bind` and `--port` are not given. Precedence is **CLI flag > environment variable > built-in default**. `CNS_BIND` must be a numeric IPv4 or IPv6 address, and `CNS_PORT` must be an integer from 1 to 65535. Empty or invalid values are rejected unless overridden. In PowerShell, set variables with e.g. `$env:CNS_CWD = 'C:\src'`.

### Output and execution behavior

`run` streams remote stdout and stderr to the corresponding local streams as they are produced, byte for byte, without prompts or added newlines, and propagates the exit status. A timeout exits with status 124. When the local reader goes away, as with `| head`, the remote command is killed and `run` exits with 141, as a local command ends on SIGPIPE.

Every command starts a fresh noninteractive shell. Shell variables and standalone `cd` commands do not persist; use `:cwd` or combine operations in one command. For interactive programs, editors and TUIs, use [`tty`](#interactive-terminals-pty).

Piped or redirected stdin is forwarded to the command, as `ssh` does, and the command sees its end when local input ends. A terminal's stdin is not forwarded, so a command run from an interactive shell still sees closed input. `-n`/`--no-stdin` closes it explicitly, for example inside a `while read` loop whose input belongs to the loop:

```sh
tar czf - src | cns run studio -- 'tar xzf - -C /srv/app'
cns run studio -- 'sha256sum' < build.tar.gz
cns run studio -- 'cat /var/log/app.log' | grep ERROR
```

A command that never reads its input still ends normally. With an open stdin that never ends, a command that waits for input waits too; pass `-n`. A peer running an older `cns` closes the command's input instead.

`run` keeps no output in memory, so it has no output limit. The interactive console's commands still buffer until completion, with a combined 1 MiB capture limit; excess output is drained and discarded, and truncation adds a diagnostic. Commands have no deadline by default; the maximum optional timeout is 2147483647 ms. Stopping a peer or disconnecting its session attempts to kill that session's process trees; deliberately detached processes can escape cleanup.

The daemon allows up to 32 connections and four concurrent commands per connection. Incomplete RPC handshakes expire after five seconds.

## Copying files

`cp` copies a file, or with `-r` a directory, between this device and a paired device, or between two paired devices. It uses the devices' `stat`, `readdir`, `mkdir`, `readFile` and `writeFileAt` methods, in parts of up to 1 MiB and 4 MiB, so files of any size work. A remote path is written `DEVICE:PATH` as with `scp`, where `DEVICE` is a paired device's name:

```sh
cns cp ./build.tar.gz studio:/tmp/          # into a remote directory, under the same name
cns cp studio:~/notes.txt .                 # into the local working directory
cns cp studio:logs/app.log ./app.log        # a relative remote path starts at the remote home
cns cp -r ./site studio:/srv/               # a directory and everything in it
cns cp -r studio:~/photos nas:~/backup/     # from one paired device to another
```

A remote path that is relative or starts with `~/` is resolved against the remote user's home. A destination that is an existing directory, or ends with `/`, receives the source under its own name; otherwise the source is copied to that name, as `scp` does. An existing destination is overwritten in place and keeps its permissions; a new one gets the source's permission bits, less the umask. A copy that fails partway leaves a partial destination, as `scp` does. `cp` needs only the `files` grant on each paired device it uses. A peer running an older `cns` accepts files of up to 4 MiB.

Without `-r`, a directory is refused. With it, directories are created as needed and their files are copied a few at a time. A link to a file is copied as the file. Links to directories (which could loop), broken links and special files such as sockets are skipped with a note on stderr, and `cp` then exits 1 after copying the rest. A directory of 10,000 entries or more is refused. Copying a file onto itself, or a directory into itself, is refused.

Between two paired devices, `cns` connects to both and the data passes through this device, as `scp -3` does, so this device must be paired with both and the two need not be paired with each other. Within one device (`cns cp -r studio:a studio:b`), one connection serves both ends.

A local path with a colon before any slash would read as remote: write it as `./name:with:colons`. On Windows, a drive letter such as `C:\` is local.

## Interactive terminals (PTY)

`tty` runs a program on a pseudo-terminal on the peer, so interactive CLIs and full-screen TUIs such as `vim`, `top` or Claude Code render and take keyboard input:

```sh
cns tty studio                            # a session of its own (tty-1, ...): the remote user's login shell ($SHELL -l, else Bash; PowerShell on Windows)
cns tty studio --cwd /srv/app -- 'claude' # one command, with the run quoting rules
cns tty studio -- 'htop'
```

From a console, `:tty` and `:tty COMMAND` do the same on the selected peer, on any device linked to the daemon. The console's `:cwd` and `:timeout` apply.

- A local terminal is switched to raw mode, so Ctrl-C, Ctrl-D, Esc and arrow keys go to the remote program. Its size is sent on start and on every resize. The local terminal is restored when the program exits or the connection drops.
- `tty` exits with the remote program's status (124 after `--timeout`, 128 + signal number after a signal). A timeout or `:tty` hang-up sends SIGHUP to the program, then SIGKILL after one second.
- Without a local terminal, for example from an agent, piped stdin is forwarded byte for byte and output is written raw, including escape sequences. Pass `--cols`/`--rows` for a fixed size (default 80×24) and `--term` for `TERM` (default `xterm-256color`). The end of piped input is not sent as a keystroke. Send `\x04` yourself where a program expects Ctrl-D:

  ```sh
  printf 'ls --color\nexit\n' | cns tty studio --cols 120 --rows 40
  printf 'hello\n\x04' | cns tty studio -- 'cat'
  ```

### Rendered screens

Each PTY session renders its output into a headless terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)) on the executing peer, as tmux does for its panes. `--screen` prints what that terminal shows when the program ends, like `tmux capture-pane -p`, instead of the escape sequences that drew it. The renderer only renders; you choose when to look. A program's own exit captures its final screen, and `--timeout` captures a program that keeps running at that moment, then hangs it up:

```sh
cns tty studio --screen --cols 120 --rows 40 --timeout 5000 -- 'htop'
(sleep 1; printf 'ihello\033') | cns tty studio --screen --timeout 3000 -- 'vim notes.txt'
cns tty studio --screen --history 100 -- 'make test'   # include up to 100 scrollback lines
```

Rows are printed with trailing spaces and the blank rows below the last output removed. With `--screen`, or without a local terminal, the remote screen answers terminal queries such as cursor-position reports. TUIs that wait for such answers, including Claude Code, then draw without a real terminal attached. A program that exits through the alternate screen, as vim does on `:wq`, leaves the normal screen behind; that is what a real terminal shows then, too.

### Named sessions

A named session keeps running between commands, so an agent can work with a TUI in steps, as with `tmux send-keys` and `capture-pane`:

```sh
cns tty studio --name claude --cwd /srv/app -- 'claude'  # start in the background; prints nothing
cns screen studio claude --until 'trust this folder'      # wait for the prompt, then print the screen
cns keys studio claude Down                               # move to "Yes, I trust this folder"
cns screen studio claude --until '❯ Yes'                  # confirm the key landed before pressing Enter
cns keys studio claude Enter
cns keys studio claude 'fix the failing tests' Enter
cns screen studio claude --history 50
cns keys studio claude C-c
cns sessions studio                                       # name, status, size, viewers, command
cns sessions                                              # every paired device's, with a DEVICE column
cns kill studio claude
```

- **Lifetime:** sessions live in the device's daemon, not in a connection. They survive the commands and connections that use them and end when killed or when that process stops. Nothing is written to disk. Each process holds up to 16 named sessions, running or finished, including the ones `cns tty DEVICE` terminals start. A finished session keeps its final screen and exit status for an hour after its program ends, then the device removes it. When all 16 places are taken, starting a session removes the finished one that ended first; only when every session is still running, or someone is attached to it, is a new one refused. `--timeout` on `tty --name` limits the session's lifetime.
- **`keys`** takes tmux-style key names: `Enter`, `Tab`, `BTab`, `Escape`, `Space`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1`–`F12`, with `C-`, `M-` and `S-` prefixes such as `C-c` or `C-Left`. Other arguments are typed as text; `--literal` types every argument as text. The executing peer encodes keys, so arrow keys follow the program's cursor-key mode.
- **`screen`** prints the current screen like `tty --screen`. `--until TEXT` first waits for the screen to show TEXT, checking after every chunk of output. It exits 0 when the text appears, 1 if the program ends first and 124 after `--timeout` (default 30000 ms; 0 waits indefinitely). It prints the screen in each case. The renderer does not decide when a program is finished; `--until` is a convenience over it. To confirm that a key took effect, wait for the screen it should produce rather than sleeping.
- **`tty --attach NAME`** shows a session in your terminal, on its alternate screen as tmux does: detaching or the program's exit returns your terminal to what it showed before. It redraws the current screen, then streams live output and sends your keys. When the program switches between its normal and alternate screens, as vim does, `cns` redraws from its own copy of the session's screen instead of letting your terminal switch. As in tmux, lines that scroll by while attached are not added to your terminal's scrollback; `cns screen NAME --history N` has them. Ctrl-] detaches and leaves the program running; exiting the program ends the attach with its status. Attaching from a terminal resizes the session to that terminal, as in tmux. Several viewers can attach at once. Without a local terminal, `--attach` streams raw output and forwards stdin, without detach key or resize.
- **Terminal queries** are answered by the session's screen unless an attached terminal answers them, so programs keep drawing with no one attached.

At a terminal, `cns tty studio` and `cns tty studio --attach NAME` reconnect by themselves when the connection drops (see [Paired devices](#paired-devices)). Without a terminal, run it again: the new attachment redraws the current screen and streams subsequent output. It does not replay all output missed during the outage, and input in flight when the connection failed may or may not have reached the program; inspect the session before retrying it. Unnamed PTYs end with their connection. Named sessions end when the device's daemon stops; they do not survive a daemon restart. `cns kill` with the same target and session name explicitly ends and removes a named session.

### Switching between sessions

`cns ui` shows one session at a time, with a switcher over every session on every paired device, much like tmux's session chooser:

```sh
cns ui                  # the switcher: each paired device and its sessions
cns ui studio           # the switcher, with studio selected
cns ui studio/claude    # straight into studio's session claude
cns ui --key C-b        # switch with Ctrl-B instead of Ctrl-]
```

- In a session, Ctrl-] (`--key` or `CNS_KEY` choose another control key, such as `C-b`) opens the switcher over it; the session keeps running. Up and Down (or j and k) move, Enter opens the selected session, 1 to 9 open the numbered sessions, Tab opens the session before the last one, Esc returns to the one you came from, `n` (or Enter on a device) starts the next free `tty-N` there, and `x` kills the selected session after asking. When the terminal is at least 90 columns wide, the selected session's screen is shown beside the list.
- `d` or `q` detaches: `cns ui` ends and every session keeps running, including the ones started from it, as does closing the terminal. A session started in `cns ui` is kept so you can return to it, unlike the one `cns tty DEVICE` starts, which ends with its window.
- The switcher asks each device for its sessions when it opens and every three seconds while it shows, each over its own connection, so a slow or unreachable device is marked as such without holding up the others. A device whose saved grants do not include `sessions:list` is shown but not asked. The device's grants apply as everywhere else: without `sessions:control`, a session's output is shown but your keys are not sent, and the switcher says so.
- If the connection to a device drops while one of its sessions is on screen, `cns ui` returns to the switcher and says so; Esc tries again. It does not reconnect by itself as `cns tty` does.
- To see sessions side by side, run `cns ui` in each pane of your terminal or multiplexer (tmux, WezTerm, Windows Terminal and the like): each pane picks and switches its own session.
- `cns ui` needs a terminal. Without one, use `cns sessions`, `cns screen`, `cns keys` and `cns tty --attach`.

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

Releasing a handle leaves its session running, and ends its pending `wait` calls. A handle only reaches the session it was issued for, never a later one that reuses the name. Handles and the attachments made through them belong to the shell or fork that issued them: when it closes, they are revoked. Their calls then fail with the reason, their pending `wait` calls reject with it, and their viewers are detached with it through the sink's `detached(reason)`. The session is unaffected: it keeps running for every other caller until it is killed or its process stops. A viewer that stops acknowledging output is detached, and its sink's optional `detached(reason)` is called; the program keeps running.

The caller passes `sink`, an `RpcTarget` with `output(bytes)` and `exit(result)`, by reference. The executor waits for each `output` acknowledgement before sending more, coalescing reads into messages of up to 64 KiB. Bun cannot pause PTY reads, so a caller that falls more than 8 MiB behind is hung up with an error. Each connection allows four unnamed PTY sessions until they are released. The daemon proxies all of these stubs between `attach` and its peers.

### Streaming commands and files

`ShellApi.exec(sink, command, options, input?)` runs a command as `run` does, with the same options and limits, but streams its output to `sink.output(stream, bytes)` (`stream` is `"stdout"` or `"stderr"`) in chunks of up to 64 KiB, without an output cap. It waits for each acknowledgement before reading more, so a slow caller slows the command instead of growing the peer's memory; a sink that throws kills the command. With `input`, an `RpcTarget` passed by reference, the command's stdin is a pipe that the peer fills by calling `input.read()`, which resolves with the next chunk of up to 64 KiB as a `Uint8Array`, or `null` at the end. The peer asks for the next chunk only once the pipe has taken the last, so input is flow-controlled the same way. An input that throws, or answers with anything else, kills the command; a command that exits without reading all of it is not an error. Without `input`, stdin is closed. It resolves with `exitCode`, `signal`, `signalNumber`, `timedOut` and `elapsedMs`.

File methods take absolute paths on the executing peer and reject with its system errors, such as `ENOENT`:

| Method | Result |
| --- | --- |
| `stat(path)` | `kind` (`file`, `directory`, `symlink` for a dangling link, or `other`), `symlink`, `size`, `mtimeMs`, `mode`; links are followed. |
| `access(path, { write })` | Resolves if the path is readable, and writable with `write: true`. |
| `readdir(path)` | Up to 10,000 entries, each `{ name, kind }`; links are not followed. |
| `mkdir(path)` | Creates the directory and missing parents. |
| `glob(pattern, cwd, { ignore, limit, directories })` | Up to 10,000 absolute paths of files and links under `cwd` whose relative path matches a glob, hidden ones included, links not followed; with `directories: true`, matching directories too, ending in a separator. Directories matched by an ignore pattern ending in `/**` are not entered. |
| `readFile(path, { offset, length })` | `{ data, size, eof }`: up to 1 MiB from `offset`; read larger files in several calls. |
| `writeFile(path, data)` | Replaces a file's contents with up to 4 MiB in place, as a local write does: links are followed and the file keeps its inode, owner and permissions. The data arrives whole before anything is written. Parent directories are not created. |
| `writeFileAt(path, data, { offset, truncate, mode })` | Writes up to 4 MiB at `offset`, creating the file if needed, so a larger file is sent in several calls: the first with `truncate: true`, the rest at increasing offsets. `mode` sets the permission bits of a file the call creates, less the umask. Links are followed and an existing file keeps its inode, owner and permissions. A broken connection between calls leaves the file partly written. |

`ShellApi.fork()` returns another `ShellApi` on the same peer, with its own limit of four commands and the same named sessions. Releasing the fork kills its commands and revokes the named-session handles it issued, so a caller can cancel a `run` without closing its connection; the named sessions themselves keep running. Each shell has up to 32 unreleased forks; closing a shell closes them. Daemon control's `runWhileConnected(id, command, options)` uses a fork so the command ends with the control connection, as `cns mcp` needs. Its `run` leaves commands running after an attached console detaches. Peers running a `cns` without `fork` fall back to `run`. Daemon control's `shell(id)` returns a fork of a connected peer's whole `ShellApi`, proxied by the daemon, and `status()` reports the daemon's listener (`url`, `bind`, `port`, `remote`), `pid`, `startedAt` and its number of peers.

Commands you run (`run`, `tty`, `cp`, `sessions`, `keys`, `screen`, `kill` and `cns mcp`) offer the other device only the handshake's `info()`; every other method is refused, whatever this device granted it. What a paired device may do through its daemon's link is set by its grants.

Grants are not a per-user authorization system inside a device. A device that has shell access can use the named sessions in that process, including through a forked shell; a session name is not a credential. Releasing a fork stops its own commands and unnamed PTYs and revokes the named-session handles and attachments it returned; the sessions keep running. Killing a named session invalidates handles to that session, even if its name is reused.

On Windows peers, programs run on a ConPTY in Windows PowerShell, with the same quoting as `run`. **This path is untested.** It compiles, and `src/shell.test.ts` has a Windows-only PTY test, but it has not been run on Windows yet. The `Windows` GitHub Actions workflow (`.github/workflows/windows.yml`), which runs every Monday and on demand, runs both test suites on `windows-latest`, including Windows versions of the named-session tests. Expected differences, from [Bun's ConPTY notes](https://bun.com/docs/runtime/child-process#platform-differences):

- Hang-up and `--timeout` kill the program's process tree; Windows has no SIGHUP for programs to handle.
- ConPTY redraws output itself, so raw output differs from what the program wrote, though rendered screens should match.
- Ctrl-C may not interrupt programs, because the system console host does not always turn it into an interrupt.
- Mouse input needs Windows 11 or Server 2022.

## Background operation

```sh
cns up
cns attach
# :peers, :use p1, then commands; :quit detaches
cns stop
```

`cns up` starts the daemon as a detached process; `cns up --install` makes it a service that starts at login and restarts if it fails. Its private local state defaults to `~/.cns/daemon.json`. To run separate daemons, use different ports and pass the same custom `--state PATH` to `up`, `attach` and `stop`. Startup prints the log location. The state file allows one daemon per path: `cns up` reports the daemon already running. If a daemon crashed, the next `cns up` removes its state once the control endpoint does not answer and its process no longer exists.

The private control endpoint uses IPv6 loopback (`::1`) when available, falling back to `127.0.0.1` when IPv6 cannot be bound. Its address and random port are recorded in version-2 daemon state; clients also read older version-1 state, which always means IPv4. `--bind` and `--port` configure the paired-device listener, not this control endpoint. Upgrade local clients (including the Pi extension) and restart the daemon together: older clients cannot read version-2 state. Pairings and the device identity are unchanged.

If `cns up` reports **Local daemon connection timed out** while the daemon is running, check local networking before deleting any state. WSL mirrored networking can leave IPv4 localhost connections timing out even when a process is listening, while IPv6 loopback still works. Installing the updated CLI alone does not move an already-running IPv4 daemon: update the service's executable and restart it through its service manager (`systemctl --user restart cns` for a systemd user service). If it was installed with `cns up --install`, install it again from the updated executable; for a Nix-managed service, update its package through Nix instead. Restarting ends the daemon's sessions. See [ADR 0003](docs/adr/0003-local-control-loopback.md) for the diagnosis, compatibility rules and regression checks.

A device in WSL usually cannot be dialed from other machines: in mirrored networking the Hyper-V firewall drops inbound connections by default, and in NAT mode its address is private to the host. Its own daemon dials out, though, and commands from other devices use that link, as above, so `cns doctor` listing its direct addresses as `unreachable` is expected and needs no firewall change. Keep the daemons running on both devices (`cns up`, or the Nix or systemd service) so the link exists; without it, commands to the device go through the relay, which costs a second or two per command and a round trip to the relay per keystroke. [The WSL latency report](docs/verification/2026-11-10-wsl-latency.md) has the measurements.

Detaching with `:quit` or Ctrl+C leaves the daemon, its links and pending commands running. `stop` shuts down the daemon and cleans up its sessions.

### Upgrading

A running daemon keeps the executable it started with, so after you install a new cns, paired devices, and the commands that use the daemon's links, still get the old one until the daemon restarts. `cns up`, `cns status` and `cns doctor` say when the daemon runs another version than the command you typed, and what to run:

- a daemon `cns up` started: `cns stop`, then `cns up`;
- a service `cns up --install` made that runs this cns: the same; one that runs another executable, as after mise installed a new version under its own directory: `cns up --install` again, which points the service at this cns and restarts it;
- a Home Manager service: `home-manager switch` to a configuration with the new cns, or `cns stop` then `cns up` when the service already names it; if it still runs the old one, `systemctl --user cat cns` shows what overrides it;
- another service manager, such as the NixOS module: update cns there and restart it (`sudo systemctl restart cns`).

Restarting ends the daemon's named sessions. A daemon that runs a newer cns than the command means an older cns comes first on `PATH`: `command -v cns` (`Get-Command cns` in PowerShell) shows which one a shell runs. Devices report their version to each other when they connect, so `cns peers`, `cns doctor NAME` and the MCP `list_peers` tool show which devices need upgrading; a release from before this reports none and shows as older. The relay and the gateway print the version they were built from at their root (`curl https://cns.nothuman.work/relay`), so one that was not redeployed after a change shows it.

## MCP server

`cns mcp` gives MCP clients such as Claude Code, Codex and Cursor tools that use a paired device the way the commands above do:

| Tool | Purpose |
| --- | --- |
| `list_peers` | Each peer's ID, hostname, OS, shell, home directory and cns version. |
| `run_command` | Run one command as `cns run` does and return its exit code, stdout and stderr. |
| `start_session` | Start a named PTY session, as `cns tty --name` does, optionally waiting for its first screen. |
| `send_keys` | Send keys and text, as `cns keys` does, optionally waiting for the screen they produce. |
| `read_screen` | Return the rendered screen, as `cns screen` does, optionally once it shows some text. |
| `list_sessions` | A peer's named sessions. |
| `kill_session` | End and remove a named session. |
| `read_file` | Read a text file's lines, 2,000 at a time by default, continuing from `nextOffset`. |
| `write_file` | Create or replace a file with UTF-8 text, up to 4 MiB, creating missing parent directories. |
| `list_directory` | A directory's entries and their kinds. |
| `glob` | Absolute paths of files matching a pattern such as `**/*.ts`, with `ignore` patterns. |

`list_peers` also gives each paired device's `name` and `fingerprint`, and `peer` accepts the name. Results include text for the agent and structured content matching each tool's output schema. A command that exits nonzero is a normal result with its exit code; an unreachable peer, a missing session or invalid arguments are tool errors. `run_command` has a default deadline of 120 seconds (`timeoutMs: 0` removes it) and returns the start and end of output longer than 30,000 characters. Peers still keep at most 1 MiB. With several devices linked to the daemon, calls must name a `peer`.

The file tools take paths in the peer's own syntax. A relative path starts from `--cwd`, else the peer user's home, and `~` means that home. `read_file` refuses binary files and returns at most 30,000 characters per call. These tools need the `files` grant (`cns peer grant NAME files` on that device); without it they fail with a permission error, while `run_command` only needs `shell`.

By default the client starts `cns mcp` and talks to it over stdin and stdout. With a device's name, `cns mcp studio`, the tools use that paired device, reaching it for each call as `cns run` does: over the local daemon's link to it, or a connection of their own. Without one (`--state PATH` names another daemon) they use the devices linked to this device's daemon, chosen by name in each call, which suits devices that only link out to yours. `--cwd PATH` (or `CNS_CWD`) sets the working directory for calls that do not pass `cwd`.

```sh
claude mcp add cns -- /absolute/path/to/cns mcp build-box
codex mcp add cns -- /absolute/path/to/cns mcp
```

Cursor reads `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "cns": { "command": "/absolute/path/to/cns", "args": ["mcp"] } } }
```

`--http PORT` serves Streamable HTTP at `http://127.0.0.1:PORT/mcp` instead. Every request must carry `Authorization: Bearer TOKEN`, where `TOKEN` is `CNS_MCP_TOKEN` (32 or more characters). Without `CNS_MCP_TOKEN`, a random token is printed at startup and changes on each start. Requests from browsers (any `Origin` header) and loopback requests naming another host are refused. `--http-bind ADDRESS --allow-remote` serves beyond loopback over unencrypted HTTP; use it only on a trusted LAN or VPN.

```sh
export CNS_MCP_TOKEN=$(openssl rand -hex 32)
cns mcp studio --http 47382 &
claude mcp add -t http -H "Authorization: Bearer $CNS_MCP_TOKEN" cns http://127.0.0.1:47382/mcp
codex mcp add cns --url http://127.0.0.1:47382/mcp --bearer-token-env-var CNS_MCP_TOKEN
```

The server speaks MCP 2026-07-28 and serves 2025-era clients too. Over HTTP, a 2025-era client gets a protocol session so that its cancellations reach its calls; the server keeps no events for it to resume from, so a dropped response also cancels its call. Up to 64 sessions can be open; past that the longest-idle one is closed, and a session idle for an hour is closed too. The server connects to the device or daemon for each call and closes the connection when the call ends. Cancelling a call, or a client disconnecting, therefore kills its command and ends its screen wait; named sessions keep running. Through a daemon, cancelling a command needs the daemon and the peer to run a `cns` with this server; with older ones the command runs until it ends. While a long call runs, the server reports elapsed time to clients that ask for progress. Clients impose their own tool-call time limits, for example Codex's 300-second default `tool_timeout_sec`, so pass `until` and `waitMs` rather than waiting indefinitely. A device sees each call as a short-lived connection, but the MCP server refuses its requests: it never gives a device a shell on the MCP server's machine.

### Remote agents: the gateway

For agents in a remote environment, such as Claude on the web, Claude Desktop or Claude Code in the cloud, deploy the gateway in `gateway/` to your Cloudflare account and add `https://gateway.cns.nothuman.work/mcp` as a custom connector. The gateway is itself a paired device: each device pairs with it (`cns pair` there, `cns gateway pair CODE` on a device you own) and grants it what it chooses, and the gateway reaches it through the relay over an end-to-end link, so no device is exposed. Connectors sign in with OAuth; the sign-in page shows a code, and nothing is granted until you run `cns gateway approve CODE` on one of your devices, choosing the devices and tools (`--tools read` for tools that change nothing). `cns gateway grants`, `revoke` and `log` list connectors, stop one at once, and show the calls they made. Setup and the security model are in [gateway/README.md](gateway/README.md).

## Pi extension

The Pi extension in `pi/` runs [Pi](https://pi.dev)'s own tools on a cns host: while Pi is attached, `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and `!` commands work on that host's files and shell. `/cns attach HOST` sends the tools to a paired device, reached over its encrypted link within its grants, and `/cns up` (or `CNS_UP=1`) starts Pi's machine's daemon so paired devices can link to it. Nothing falls back to Pi's machine when a host goes away. [pi/README.md](pi/README.md) documents its use; it is also the npm package's README.

```sh
pi install npm:@nothumanwork/pi-cns
```

The npm package is self-contained: the extension bundled for Pi on Node.js or Bun, cns bundled as `cns.js`, and Bun for each platform as an optional dependency, of which npm installs only this machine's. Bun runs `cns.js` without reading `.env` or `bunfig.toml` from Pi's working directory.

```sh
bun run build:pi                  # dist/pi-package
cd dist/pi-package && npm publish
pi -e ./pi/index.ts               # or run the extension from this checkout, with cns or bun on PATH
```

## Build and distribute

The compiled executable contains its JavaScript runtime and dependencies. Copy the executable built for the destination OS and architecture to that machine; **Bun, Node.js, source files and `node_modules` are not needed at runtime**. Linux/macOS need Bash and the platform's normal system libraries; Windows uses its built-in Windows PowerShell.

To build from source, install Bun 1.4.4 and run:

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
nix run . -- up
nix develop
nix flake check
```

To install it from GitHub without a checkout:

```sh
nix profile install github:thehumanworks/capnshell
nix run github:thehumanworks/capnshell -- up
```

In a flake configuration, add `inputs.capnshell.url = "github:thehumanworks/capnshell";` and use the package (`capnshell.packages.${system}.default`, or `pkgs.cns` with `capnshell.overlays.default`), or a module that also runs the daemon as a service:

```nix
# Home Manager: a systemd user service on Linux, a launchd agent on macOS
imports = [ inputs.capnshell.homeModules.default ];
services.cns.enable = true;

# NixOS: a system service, started at boot, running as one user
imports = [ inputs.capnshell.nixosModules.default ];
services.cns = { enable = true; user = "alice"; };
```

Both modules install `cns` and take `bind`, `port`, `stateFile` and `environment` like `cns up --install`; the NixOS one also takes `openFirewall` and `path`. They create the device's identity on first start; pair as usual with `cns pair`. Commands paired devices run get the service's `PATH`, which lists the user's Nix profiles and the system's packages, not a login shell's. The built-in relay requires no configuration. Do not put secrets in `environment`, which ends up readable in the Nix store. The Home Manager service has the name and state file `cns up --install` uses, so `cns up` starts it after `cns stop`, and Home Manager keeps it at the current package's path across upgrades; don't also run `cns up --install`. The NixOS service is managed with `systemctl` (`systemctl restart cns`, `journalctl -u cns`): `cns stop` stops it until it restarts, and `cns up` would then start a second daemon outside it.

The default package/app is also available as `cns` (and the legacy flake attribute `capnweb-shell`). The package contains the executable with an absolute Nix-provided Bash path; it does not require or install a source checkout. Distribute Nix builds through Nix because their runtime libraries may reference the Nix store.

### Relay TLS trust in services

If direct connections cannot reach a device, pairing and commands automatically try its relay. The target daemon must first register there: `cns status` should say `Relay: ... (registered)`. Merely listing a relay address in an invite does not prove registration succeeded.

A service can fail to register even when the same executable works in a terminal: systemd and launchd do not read the login shell's environment. This matters on networks that use a private CA or TLS inspection. Check `journalctl --user -u cns` (NixOS system service: `journalctl -u cns`; macOS: `~/.cns/service.log`). Registration failures now include the underlying TLS/network error; identical errors are suppressed until the reason changes or registration succeeds. `unable to get local issuer certificate` means the runtime could not verify the certificate chain—not that direct-address fallback needs disabling.

- `cns up --install` preserves `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR` when set. Reinstall from the updated executable to apply this to an existing service.
- The **NixOS module** defaults `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` to `security.pki.caBundle`, including configured system roots.
- The **Home Manager module** copies those three CA variables from `home.sessionVariables` when declared. `services.cns.environment` overrides them; for example, `services.cns.environment.NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";` uses an existing Linux system bundle for this service only.

Use an existing trusted CA bundle, keep certificate verification enabled, and scope any extra configuration to cns. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. After updating and restarting the service, wait for `registered`, then generate a **fresh** `cns pair` invite: a restart invalidates outstanding invites. [The relay verification report](docs/verification/2026-11-09-relay-trust.md) records the reproduced failure and end-to-end tests.

### Releases

Pushing a tag `vX.Y.Z` that matches `package.json`'s version runs `.github/workflows/release.yml`: it builds `cns` on each platform it ships for, runs it there, and publishes the release with one archive per platform and `SHA256SUMS`. Run the workflow from the Actions tab with an existing tag to rebuild that release's assets.

`flake.lock` pins nixpkgs; `bun.lock` pins JavaScript dependencies. Nix fetches production dependencies in a fixed-output derivation and builds/tests offline. When production dependencies change, update the hash in `nix/package.nix` using `lib.fakeHash` and the hash reported by Nix; then rerun `nix flake check`.

## Security

A paired device can do on this one what it was granted, as the user running the daemon: `shell` and `sessions:create` amount to running any command. Grant only what a device needs, and revoke it with `cns peer revoke`. Only paired devices that authenticate with their identities can connect, and every link is encrypted end to end (see [Paired devices](#paired-devices)), so the daemon listens on every interface by default; `--bind` narrows it. Browser-origin WebSocket requests are rejected.

Daemon control uses authenticated Cap’n Web RPC on a separate loopback endpoint, with its token in private local state. Keep the state directory private. Peer selection prevents accidental routing; it is not an authorization boundary or sandbox.

`cns mcp` gives every MCP client that can reach it shell access as the peers' users. Its tool annotations mark commands and keys as destructive, which some clients use to ask for approval, but annotations are hints, not a sandbox. Over stdio, the client that starts it is trusted. Over HTTP, the bearer token is the only authentication; loopback binding is not an authentication boundary, because any local process can connect. Keep the token secret, and do not combine `--allow-remote` with untrusted networks: plain HTTP sends the token in the clear. It is a static token, not MCP's OAuth authorization.

## Verification

```sh
bun run typecheck
bun run test
bun run test:compiled
```

Tests bind the IPv6 loopback address where the machine has one and `127.0.0.1` otherwise, so they also run in containers without IPv6. The Bun version is pinned, and a pre-commit hook rejects changes that break the pin. Run this once in a checkout to install it, with the tools in `mise.toml`:

```sh
mise install
lefthook install
```

The hook runs `ast-grep scan . .github`. The rules in `lint/rules` check that every file stating Bun's version agrees, that Nix builds with `nix/bun.nix` and that CI reads the version from `package.json`.

Tests exercise pairing, grants and links between devices, target selection, disconnect isolation, reverse calls during one-shot commands and PTY sessions, output/exit-status handling, PTY input, sizing, hang-up, timeouts and flow control, rendered screens and scrollback, named sessions across connections and CLI calls (keys, waits, attach redraws, detach, kill and limits), PTY proxying through the daemon, streaming commands with flow control and cancellation (also through the daemon), file operations and their validation, commands refusing every reverse call, process cleanup, connection limits, daemon attachment, startup races and stale-state recovery. MCP tests drive `cns mcp` with the official SDK client over stdio and HTTP, in both protocol eras: every tool, tool errors, cancellation and disconnects killing commands and freeing screen waits, 2025-era session limits, HTTP authentication, origin and host checks, calls beyond Bun's idle timeout with progress, daemon peer selection and the refusal of reverse calls. The Pi extension tests run Pi's agent sessions with a scripted model against paired devices and the daemon: each tool and `!` on a host, results matching Pi's local tools for `grep`, `find`, `ls` and `read`, images, aborts and timeouts stopping the host's command, long commands, sessions sharing one daemon and attaching to its peers, `CNS_UP`, `/cns stop`, lost hosts and failed startup attachments blocking every tool, and continued sessions attaching again. The package tests build the npm package, install it beside a Bun package, and drive it in Pi processes in RPC mode, on Node and with the installed `pi` when there is one, with neither `bun` nor `cns` on `PATH` and hostile `.env` and `bunfig.toml` files where the daemon would read them. The compiled suite additionally tests the executable outside its checkout without a JavaScript runtime on `PATH`.
