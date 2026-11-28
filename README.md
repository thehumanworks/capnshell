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
laptop $ cns shell studio
```

[Paired devices](#paired-devices) below covers pairing, grants and the relay. The command string must use the **remote** shell's syntax: on Linux and macOS commands execute in Bash, on Windows in Windows PowerShell, so use e.g. `'$PSVersionTable.PSVersion'` when targeting Windows.

| Command | Purpose |
| --- | --- |
| `up` | Start this device's daemon, which paired devices link to; `--install` makes it a service. |
| `pair [CODE]` | Pair with another device: show a code, or type the one the other device shows (`--long` for a pasteable invite). |
| `peers` | List paired devices, their status and the access each has. |
| `peer grant/revoke/remove/address NAME` | Change a pairing. |
| `status`, `doctor [NAME]` | Show this device's daemon and links, or check how a paired device is reached. |
| `audit` | Show what paired devices did on this device: commands, terminals, sessions, files and skills. |
| `run DEVICE -- '<command>'` | Execute one shell command and exit with its status; piped stdin is forwarded. `--secret NAME` gives it mesh secrets as variables. |
| `cp SOURCE DEST` | Copy one file to or from a paired device, with the remote side written `DEVICE:PATH`. |
| `shell DEVICE [-- '<command>']` | Open an interactive terminal (PTY): a login shell in a session of its own (`shell-1`, `shell-2`, ...), or one command. |
| `shell DEVICE --name NAME [-- '<command>']` | Start a named PTY session in the background. |
| `shell DEVICE --attach NAME` | Attach to a named session; Ctrl-] detaches. |
| `shell DEVICE -d [--session NAME] [--screen] [-- '<command>']` | Type a command into a shell that keeps running on the device, and return; the first use starts it. With `--screen`, wait for the command to end and print what it showed. |
| `sessions DEVICE` | List a device's named sessions. |
| `keys DEVICE NAME KEY...` | Send keys or text to a named session. |
| `screen DEVICE NAME` | Print a named session's screen, optionally once it shows some text. |
| `kill DEVICE NAME` | End a named session and remove it. |
| `mesh create/add/join/remove/leave/delete NAME` | Group paired devices so each reaches the others (see [Meshes](#meshes)). |
| `secret set/get/list/rm [MESH:]NAME` | Share secrets, such as API keys, with a mesh's members. |
| `secret run -- '<command>'` | Run a command on this device with those secrets as environment variables. |
| `mcp [DEVICE]` | Serve MCP tools on a paired device, or on the devices linked to the daemon. |
| `attach` | Open a console for the local daemon. |
| `stop` | Stop the local daemon and its sessions. |

Use `cns <command> --help` for options, and `cns --version` for the version of this cns. Every option has a one-letter form as well, such as `-s` for `--session` and `-D` for `--device`. A command that takes a device or a session name as an argument also takes it as an option, so `cns screen -D studio -s work` is `cns screen studio work`, and `cns ui -D studio -s work` is `cns ui studio/work`.

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
laptop $ cns shell studio                 # a login shell of its own, session shell-1, that survives disconnects
laptop $ cns sessions studio            # each terminal's session, and any other named sessions
laptop $ cns sessions                   # every paired device's sessions in one table
laptop $ cns ui                         # all of them in a switcher: Ctrl-] moves between sessions
laptop $ cns peers
NAME    STATUS  CONNECTION  VERSION  ACCESS                  FINGERPRINT
studio  online  direct      1.4.0    shell, files, sessions  k7qm-3h2x-...
```

- **`cns up`** runs this device's peer daemon. It listens on every interface by default (`--bind` narrows it; `CNS_BIND`/`CNS_PORT` apply) and accepts only paired devices: a connection must authenticate with its identity before anything is exported, and an unpaired device, or an older `cns`, is refused with a message saying so. The daemon also dials the saved addresses of paired devices and keeps those links up with backoff, so either side can initiate. Once a link is up, each daemon asks the other where it can be reached now and saves that in its record: the listening and relay addresses the other device advertises replace the ones it advertised before, while hostnames added with `cns peer address` and the address the link was just dialed at are kept. A device that moved networks or changed relays is then dialed where it is, and a device that paired with an inviter learns where to dial it back. A standing link that runs through the relay is replaced by a direct one once either daemon can dial the other directly, ten seconds or more after the link was made, so two devices on one network end up linked directly even when only one of them accepts connections, as with a device in WSL. Each also reports what it currently lets the other do, so the access `cns peers` shows follows grants changed on the other device since pairing. `attach` and `stop` work on it as on any daemon, and `cns up` recovers from the state file a crashed daemon left behind.
- **`cns up --install`** makes the daemon a service, so it survives reboots: a launchd agent (`~/Library/LaunchAgents/com.thehumanworks.cns.plist`, log in `~/.cns/service.log`) on macOS, a systemd user service (`~/.config/systemd/user/cns.service`, log in `journalctl --user -u cns`) on Linux, a Task Scheduler task named `cns-USER` (the definition cns registered in `~/.cns/service.xml`, log in `~/.cns/service.log`) on Windows. The service starts the daemon at login and restarts it if it fails. It keeps the running daemon's `--bind` and `--port` unless you pass new ones, and replaces that daemon. The service file is private (`0600`). `cns stop` stops the daemon until the next login or `cns up`, which starts it through the service. Run `cns up --install` again to change its settings or after moving `cns`, and `cns up --uninstall` to stop and remove it. On Linux, systemd stops user services at logout unless lingering is on (`loginctl enable-linger $USER`); `cns` says so when it is off. On Windows the task runs at your sign-in, as you and unelevated, so installing it needs no administrator; it runs `cns` through `conhost --headless`, so no console window opens. Task Scheduler restarts only a task it cannot start, so the task's process watches the daemon and starts it again 5 seconds after it fails, and stops with it after `cns stop`. The task gets your account's environment variables, not your shell's: set `CNS_CONFIG_DIR`, `CNS_RELAY` or a CA path for your account with `setx NAME VALUE` (`cns up --install` reminds you when your shell has them), then `cns daemon restart`. Other platforms are refused.
- **`cns pair`** on the device to be reached shows a single-use pairing code, such as `42-orbit-canyon-velvet` (five minutes by default, `--expires`), and waits; the code ends early if that `cns pair` exits. Type it on the other device: `cns pair 42-orbit-canyon-velvet`, with dashes or spaces, in any case, and the first four letters of each word are enough. A word that is not on cns's list is refused before anything is sent. The number names a room on the relay and the three words are a password the two devices check against each other there with a PAKE (CPace), so neither the relay nor anyone watching learns the words or can test guesses offline. A wrong code is reported on both devices, and three wrong ones end it. Once the words match, the inviting device sends its invite, encrypted under the key they agreed, and pairing continues as with an invite. Without the relay (offline, or for scripts), `cns pair --long` prints the invite itself, `cns1:...`, to paste with `cns pair 'cns1:...'`; it is also printed when the relay cannot give a code. [docs/adr/0004-pairing-codes.md](docs/adr/0004-pairing-codes.md) has the design and its threat model. The device with the invite connects to one of the invite's addresses, proves it knows the invite's secret, and proposes a pairing: the name it suggests for itself, what it asks to use (`--request`, default `all`) and what it lets the other device use in return (`--grant`, default none). Both people see the other device's fingerprint and confirm, and each side chooses its own alias for the other (`--name`; by default the name the other device suggests, made unique). Without `--grant`, each side asks what the other may use here: the inviting side whether to allow what was requested, the accepting side `What may studio use on this device?` (`none`, the default, `shell`, `files`, `sessions`, `all` or a comma-separated list). The inviting side grants at most what was requested. `--yes` answers every prompt for scripted setups after you have compared fingerprints yourself, and alone grants nothing. A name already in use, or a device already paired, is refused before anything is sent. Declined or refused pairings, expired or unknown invites and codes, and wrong codes exit 3.
- **Grants** are directional and enforced by the device that grants them: `shell` (run commands and open terminals), `files` (read, write and list files), `skills` (list and read the agent skills in `~/.agents/skills`, and nothing else; see [Skills](#skills)), and five session permissions, granted together as `sessions`: `sessions:list` (list them), `sessions:create` (start one), `sessions:view` (read the screen, wait for text and watch it attached), `sessions:control` (type, send keys and resize) and `sessions:kill`. A device may always view, type into and kill the sessions it started, which `cns sessions --json` shows as their `owner`, so `sessions:create` alone amounts to running commands; a viewer without `sessions:control` cannot type into, resize or answer the program's queries on a session it watches. A denied call fails with `Permission denied` and exit status 4, with no side effects; the message names the missing grant and the command to run on the other device, such as `To allow it, run on studio: cns peer grant laptop shell`. `all` is `shell`, `files` and `sessions`: it leaves out `skills`, which `files` covers, so that `all` stays readable by a cns from before skills. What a device may do on the other is shown under `ACCESS` in `cns peers`, which, for a device that grants this one nothing, says what to run there. `ACCESS` is what was granted at pairing; `cns doctor NAME` asks the device and saves what it says now.
- **The daemon's link.** When this device's daemon (at the default state path, running as this identity) has a standing link to the device a command names, `run`, `shell`, `cp`, `sessions`, `keys`, `screen`, `kill` and `mcp DEVICE` use it instead of dialing: the daemon lends the command a fork of the device's shell over the link, which the device releases, ending the command's commands, terminals and handles, when the command exits, and the command loses its connection if the link drops, as it would its own. The device's grants to this device apply as on any connection. Nothing is dialed, so a device that cannot be dialed at all, such as one in WSL behind its host's firewall, answers as quickly as any other on the network. Without such a link, or with an older daemon, the command dials the device itself.
- **Targets.** `run`, `shell`, `cp`, `sessions`, `keys`, `screen`, `kill` and `mcp` take a paired device's name as their first argument. They connect with this device's identity and require the saved identity on the other end: if the device behind the address changed, the command exits 3 and nothing runs. A name that is not a paired device is an error, never a hostname, and names never fall back to another device.
- **Reconnecting terminals.** At a terminal, `cns shell studio` starts a login shell in a named session of its own on that device, `shell-1`, `shell-2` and so on (the first name free there), so every terminal window gets its own shell; `cns shell studio --attach NAME` attaches to a named session, which others may be attached to as well. A session `cns shell studio` started belongs to its terminal: it is removed when its shell exits, and ended when `cns` is stopped or the terminal window closes while the device can be reached, as an ssh session would be. Ctrl-] detaches and leaves it running, and `cns shell studio --attach shell-1` returns to it; `--key` names another key, or none. The session is shown as ssh shows a shell, so its output scrolls into your terminal's own scrollback (see [Named sessions](#named-sessions)). When `cns` cannot end it, such as after giving up on reconnecting, it says that the session keeps running and how to return to or kill it. If the connection drops, either keeps trying to reach the device again, through any of its saved addresses, for ten minutes, and then reattaches to the same session: the screen is redrawn and `cns` reports how many bytes of output were written meanwhile. Input that was in flight is reported as possibly lost and never sent twice; keys typed while disconnected are discarded rather than typed blind, except Ctrl-C, which stops, and Ctrl-], which gives up and leaves the session running. A session that ended and was replaced while disconnected is not joined silently. If the device revoked access (exit 4), no longer accepts this one (exit 3) or the session is gone (exit 1), it says so and stops. Ctrl-] detaches; the session keeps running on the device. Piped input, `cns shell studio -- COMMAND`, and a device that does not let this one start sessions get an unnamed terminal that ends with the connection.
- **`cns status [--json]`** shows this device's fingerprint, the version of this cns and of its daemon, and its live links. **`cns doctor NAME`** tries each saved address of a paired device with this device's identity, within ten seconds each, and reports `ok`, `unreachable` or the handshake's refusal (`identity-changed`, `not-paired`, `refused`, `protocol`) per address, plus the grants in both directions (this device's access as the device reports it, saved when it changed), the version of cns it runs, with what to upgrade when it differs from this one, and whether the local daemon has a standing link; it exits 3 when an address answered as another device or refused the pairing and 5 when none answered or none is saved. **`cns doctor`** with no name checks this device instead: its identity, whether a paired daemon runs with that identity, the relay and whether the daemon is registered there, and each advertised address marked private or reachable from other networks, with a warning when every one is private or when the daemon runs another version of cns (see [Upgrading](#upgrading)); it exits 3 when the daemon runs as another identity and 5 when there is no identity, no paired daemon or no address.
- **`cns audit`** shows what paired devices did on this device, newest first: each command and terminal they ran, when it started and ended and its exit status; each named session they started, attached to or killed, and its end; each file they read or wrote and each skill file they read; and what was refused. A command or terminal gets a line as it starts and another as it ends, so one that is still running, or that was cut off when the daemon stopped, shows as `no end recorded`. The daemon appends one JSON line per action to `~/.cns/audit.log` (or `$CNS_CONFIG_DIR/audit.log`), readable only by your user, naming the device by its name here and its fingerprint. A program's entry names the mesh secrets it got here (`secrets`) and the variables the device gave it, such as a `--secret` from `cns run` or `cns shell` (`variables`), but never their values; file contents and typed keys never appear. Past 10 MB the log moves to `audit.log.1`, so the two hold at most 20 MB, and a log that cannot be written is reported once in the daemon's log and never stops what a device does. `--peer NAME` and `--since 1h` (or a date) narrow it, `--limit` sets how many (50 by default) and `--json` prints the entries. Another device's log is a command away, within the grants you have there: `cns run studio -- cns audit`.
- **Changing a pairing.** `cns peer grant NAME shell,files` widens what a paired device may do here, at once and without interrupting its links. `cns peer revoke NAME [grants]` narrows it: the running daemon drops that device's links and dials again, so commands, terminals and session handles that relied on the revoked access end. `cns peer remove NAME` unpairs it and ends its links. `cns peer address NAME URL... [--remove]` changes where it is dialed. The daemon finds a device's links by its key, so this also works after renaming its file.
- **Links.** Each device uses the other through the other's daemon, whose grants revocation reaches. A command you run (`cns run studio`, `cns shell studio`) only uses the other device and offers nothing back. When both devices run daemons and dial each other at once, exactly one link survives: the device with the smaller public key keeps the one it dialed. A daemon dials only when it has no link, so a dial arriving later replaces the link this side holds, which must have died on the other side. Each side sends a heartbeat every 15 seconds when idle, and a link that delivers nothing for 45 seconds is closed, so a device that vanished shows `offline` within a minute and the daemons redial.
- **`cns peers [--json]`** lists paired devices with status (`online` while the local daemon has a link, else `offline`), the connection path, the version of cns an online device runs (`older` for a release from before devices reported it), the access this device has there, and the fingerprint, then names the online devices that run an older cns than this one. The JSON fields are `name`, `status`, `connection`, `version` (null while offline or not reported), `fingerprint`, `access`, `grants` (what the peer may do here), `addresses` and `mesh` (the mesh the device is here for, or null for a device paired directly). `cns peer list [--json]` prints each device's name, fingerprint and first address, for scripts.
- **Storage.** A paired device is a private JSON file under `~/.cns/peers/<name>` (or `$CNS_CONFIG_DIR/peers`), keyed by its public key. Renaming the file renames the device without changing trust. A device cannot be saved twice under different names, and pairing never replaces an existing name. A file there that is not a paired-device record is reported and skipped by the daemon, and refused when named; remove it with `cns peer remove NAME`. So is a record a newer cns saved with a feature this one does not have, such as one that narrows what the device may do: update cns, then run `cns daemon restart`. The configuration directory and its entire path must be trusted and protected by the user from modification by other users; custom `CNS_CONFIG_DIR` directories must already exist. On Unix, untrusted owners and shared-writable ancestors other than root-owned sticky directories are rejected. These pathname checks are best-effort safeguards, not a filesystem security boundary or a guarantee against path races, and they do not protect against a process running as the same user. On Windows, the configuration and peers directories' ACLs must allow only your user, SYSTEM and Administrators; the error names the `icacls` command that fixes one that allows more.
- **Relay.** Devices that cannot reach each other directly meet at the relay built into cns, with nothing to set up: `cns up` registers this device there by proving its key, and its invites list the relay address after its direct ones. Other devices try the direct addresses first and the relay last, for commands, pairing, `doctor`, MCP, Pi and the daemons' standing link, including for paired devices whose saved record names no relay (`cns doctor` lists that attempt as `[built-in relay]`); `cns peers`, `cns status` and `cns doctor` say which path a link uses. The relay forwards encrypted records it cannot read and cannot impersonate either device. It accepts only cns as a client: every request carries a header made with a key built into cns, which keeps other programs off the relay but not someone who takes cns apart, so the relay is never what keeps a device safe; the end-to-end authentication below is. [docs/adr/0001-built-in-relay.md](docs/adr/0001-built-in-relay.md) records the design and its limits, and [relay/](relay/README.md) is the relay itself, a Cloudflare Worker. A daemon re-registers after the relay restarts or stops answering its pings, answers at most 32 dialers through it at once, and saved addresses are tried direct first and relays last whatever their order.
- **Security.** Links between paired devices are authenticated and encrypted end to end. Both devices prove their identities before anything is exported, and a saved identity that changes is refused. The handshake also exchanges fresh libsodium `crypto_kx` keys, covered by both signatures, so each connection has its own keys for each direction; every later message is a libsodium `secretstream` record (XChaCha20-Poly1305), which is encrypted, authenticated, kept in order and never accepted twice. A tampered, replayed or unencrypted message closes the link. The handshake itself is not encrypted: anyone on the network, or a relay, sees both devices' public keys (so the same devices can be recognized on any network), whether it is a daemon link or one command, an invite's id, refusal reasons, and the size and timing of encrypted messages, but nothing of what they carry. Close frames carry only fixed phrases. The session keys exist for one connection, so a stolen identity file does not decrypt recorded traffic; this device's own copies are wiped when the link closes, though libsodium may leave copies in its memory until reused.

## Meshes

A mesh lets a group of devices all reach each other without pairing every two of them: one device runs the mesh and lists its members, and the others join it through their pairing with that device.

```sh
hub $ cns mesh create home
hub $ cns mesh add home laptop studio              # devices paired with hub
laptop $ cns mesh join home --via hub --allow shell
studio $ cns mesh join home --via hub --allow all

laptop $ cns run studio -- hostname                # laptop and studio never paired
studio $ cns shell laptop
```

- **Members.** `cns mesh create NAME` makes this device the mesh's admin. `cns mesh add NAME DEVICE...` lists devices paired with it, and each of them runs `cns mesh join NAME --via ADMIN`, where ADMIN is its name for the admin. Joining fetches the list from the admin over their pairing, so the admin is a device that this device's person already confirmed. A member then saves every other member as a paired device marked with the mesh, under the admin's name for it (`name-2` when that name is taken here), so every command that takes a device name works with it, and `cns peers` shows the mesh under `MESH`. A device already paired directly keeps its pairing and its grants. Every member is paired with the admin directly, so nobody saves a mesh record for the admin, and the admin saves none for its members.
- **What members may use.** Each member decides what every other member may use on it: `--allow` when it joins (default none), or later `cns mesh allow NAME GRANTS`, where `none` takes everything away and ends what used it. The admin can narrow that for one member with `cns mesh add NAME DEVICE --limit GRANTS`: the most that member may use on any other, whatever they allow; adding it again without `--limit` lifts the limit. The admin can never widen what a member allows. `cns peer grant` and `cns peer revoke` refuse a mesh member, whose grants the mesh sets.
- **The member list.** The admin signs each version of the list with its identity. Daemons pass the newest list to each other over their encrypted links: a device takes a list only when the mesh's admin signed it and its version is newer than the one it has, so any member can carry a list but none can change it. A device is offered only the lists of the meshes it is in. A change spreads from the admin's daemon, and members pass it on to each other.
- **Leaving.** `cns mesh remove NAME DEVICE` takes a device out: the other members drop its record, which ends their links to it, and the device leaves the mesh when it next reaches the admin, which no longer offers it the list. `cns mesh leave NAME` forgets a mesh and its members here; the admin still lists the device until it removes it. The admin cannot leave its own mesh: `cns mesh delete NAME` ends it, and only once the admin is its last member, so take the others out first with `cns mesh remove NAME DEVICE...`; the refusal names the ones left. Deleting forgets the mesh and its secrets on the admin, and pairings made by hand stay. A mesh made later under the same name is a new one: it carries on from the deleted one's version, so no member list of the old mesh, on a device that was away when it ended, can replace the new one's. A removed member leaves when it next reaches the admin, which no longer offers it the list. `cns mesh list [NAME] [--json]` shows each mesh, its version and its members. A device makes or joins at most 8 meshes, of up to 64 devices each.
- **Bots.** A machine nobody sits at, such as a CI runner or a server, joins with a token instead of a pairing. On the admin, `cns mesh token NAME BOT --allow GRANTS` lists a new member BOT and prints a token, once, on stdout: BOT's private key, the signed member list, where to reach the admin, and what members may use on BOT (`--allow`, required; `--limit` as for `add`). The admin keeps only BOT's public key, paired with it as BOT with no grants (`cns peer grant BOT` adds some). On the bot's machine, with the token in `CNS_TOKEN`, any cns command first makes the machine BOT: it saves BOT's identity, its pairing with the admin and the mesh. `CNS_TOKEN=... cns up` runs it as a member the others reach, and `cns run DEVICE` and the other commands reach members from there. The token works again on a new machine, so a runner that is replaced comes back as the same bot; use it on one machine at a time. A machine that already has an identity of its own refuses it. Anyone with the token can act as BOT, so keep it as a secret.
- **Typing it by hand.** For a machine you can only reach at its keyboard, with no ssh or shared clipboard, add `--code`: `cns mesh token home box --allow shell --code` shows a short code such as `42-orbit-canyon-velvet` and waits. On that machine, `cns mesh join --code 42-orbit-canyon-velvet` makes it the bot, then `cns up` runs it. The code works like a pairing code: once, through the relay, three wrong tries end it, and it expires in 5 minutes (`--expires MINUTES`). Nothing is added to the mesh until the right code is typed. The machine must be new to cns, as for `CNS_TOKEN`.
- **Passing the token.** Capture only stdout from `cns mesh token`; stderr contains instructions, not part of the token. On POSIX, for example, `(umask 077; set -C; cns mesh token home ci --allow none >ci.token)` writes a new private file. After transferring it securely to the bot, run `cns up --token-file ci.token` there. This reads the file directly and takes precedence over `CNS_TOKEN`, even if a launcher such as a Mise shim sets that variable again. For other commands put the global option first, for example `cns --token-file ci.token peers`. If you set the environment directly, `CNS_TOKEN="$(cat ci.token)" cns up` also works. Do not paste a rejected token into a bug report. A valid token can still be refused if the bot's configuration directory already belongs to another identity.
- **Revoking a bot and reusing its name.** On the admin, `cns mesh remove NAME BOT --unpair` removes the member and the direct pairing that holds its name. Other members drop the old key when they receive the updated list. Without `--unpair`, membership ends but the pairing and its grants remain. If you already removed the member, check its fingerprint in `cns peer list`, then run `cns peer remove BOT` on the admin to free the name. A new token for that name has a **new key**: give the replacement bot its own private configuration directory.
- **Claude's gateway.** `cns mesh add NAME GATEWAY --gateway` on the admin lists the gateway, which must be paired with the admin, so that Claude's connectors reach every member, now and later, within what each allows members and the gateway's limit (by default what the admin lets the gateway use). Members never dial the gateway or share mesh secrets with it. A member on a cns from before 2.6.0 cannot read a list that names the gateway and leaves the mesh, so upgrade members first. See [gateway/README.md](gateway/README.md#meshes).
- **Trust.** Joining a mesh trusts its admin to choose who else may reach this device, within what `--allow` lets them do here. Someone who steals the admin's identity can add a device to every member's list, and that device then gets what each member allows members; `cns mesh allow NAME none`, or `cns mesh leave NAME`, on a member shuts it out there. Every member learns the other members' public keys and names, and the addresses the admin saved for them. [docs/adr/0005-meshes.md](docs/adr/0005-meshes.md) and [docs/adr/0006-mesh-bot-tokens.md](docs/adr/0006-mesh-bot-tokens.md) have the design.

### Mesh secrets

Members of a mesh can share secrets, such as API keys: one member sets a secret, and every member that may read it gets a copy, including members that join later and bots.

```sh
laptop $ cns secret set OPENAI_API_KEY                        # asks for the value, hidden
laptop $ op read op://dev/npm/token | cns secret set home:NPM_TOKEN --device ci
studio $ cns secret get OPENAI_API_KEY                        # prints the value
studio $ cns secret get home:OPENAI_API_KEY                   # the one in the mesh home, when two meshes hold the name
studio $ cns secret list                                      # names, never values
studio $ cns secret run --only OPENAI_API_KEY -- 'python agent.py'            # here, with the secret as a variable
studio $ cns run laptop --secret home:OPENAI_API_KEY -- 'python agent.py'     # on laptop, the same
laptop $ cns secret rm home:NPM_TOKEN --device ci
```

- **Naming one.** A secret is written `NAME`, or `MESH:NAME` to say which mesh; `MESH NAME` as two words means the same. `get` and `rm` look in every mesh this device is in, so the mesh is needed only when two hold the name, and the refusal then shows both ways to write it. `set` takes a bare `NAME` on a device that is in one mesh; in several it asks which, and never picks one.
- **Running a command with them.** `cns secret run -- COMMAND` runs the command on this device, as `cns run` does on another (words joined with spaces, run by Bash, or PowerShell on Windows), with every secret this device reads as an environment variable of its own name, and exits with the command's status. `--only NAMES` sets just those and `--exclude NAMES` all but those; names are separated by commas or the option is given again. One variable holds one value, so a name that two of the chosen meshes hold stops the command until `--only MESH:NAME` or `--exclude MESH:NAME` settles it. The variables go to that command alone: nothing is exported to your shell or written to disk. Two things to know. As the words are joined, the shell reads them again: a word with spaces or shell characters, such as a file name a script passes on, must be quoted for the shell, as over ssh. And every member of a mesh can set a secret of any name, so without `--only` a variable that tells programs what to run or where to connect (`PATH`, `BASH_ENV`, `LD_PRELOAD`, `NODE_OPTIONS`, `GIT_SSH_COMMAND`, `HTTPS_PROXY` and the like) stops the command when another device set it, until `--only` names it or `--exclude` leaves it out. That list cannot cover every program's variables: where a mesh has members you would not let run commands on this device, name what the command gets with `--only`. To stop a running command from another terminal, send `SIGTERM` (`kill PID`): at a terminal `cns` leaves Ctrl-C to the command, so it ignores a `SIGINT` sent to it alone. A signal reaches the shell that runs the command; programs a pipeline or script started may run on with their variables.
- **Giving them to a command on another device.** `cns run DEVICE --secret NAMES -- COMMAND` and `cns shell DEVICE --secret NAMES` (with `--name`, `-d` or neither) read the named secrets here and set them for the program that starts there. This device opens them, so the other device need not be in their mesh; the values cross the encrypted link beside the command and are never part of the command line, on either device. The program and whatever it starts can read them, as any environment variable, and so can the person who runs that device, so give a device only the secrets you would set for it. That holds for a secret set with `--device` too: the device it was set for can pass its copy on to any device it is paired with. A command that expands a variable into another program's arguments, as `curl -H "Authorization: Bearer $TOKEN"` does, puts the value in that program's command line, where `ps` on the device shows it; prefer programs that read the variable themselves. A session keeps the variables it started with, and `cns sessions` never shows them. The device needs cns 2.0.0 or later; an older one starts nothing and `cns` says so.

- **Who reads it.** Without `--device`, every member of the mesh, now and later. With `--device NAME`, only that member and the device that set it. On a device, `get` returns the secret set for it alone before the mesh's; `get --device NAME` returns the one set for that member, which only it and the device that set it can read.
- **Who changes it.** Only the device that set a secret changes or removes it; `set` on another member refuses the name and says where to run it.
- **Values.** `set` reads the value from a hidden prompt, or from stdin less one final line break, never from an argument, so it stays out of `ps` and shell history. `get` prints it on stdout, with a line break only at a terminal. Values hold up to 16 KiB; names are environment variable names. A value that becomes a variable must be text without a NUL byte; `run` and `--secret` refuse one that is not. A device keeps up to 64 secrets per mesh.
- **How it travels.** The value is encrypted once per version, and its key is sealed to the device key of each member that may read it. Each device keeps its copy in `secrets/` in the configuration directory as a private file that holds only ciphertext, so `get` works offline. Daemons pass secrets to each other over their encrypted links, beside the member list; the relay and the gateway see nothing they can open. A change reaches linked members within seconds, and others when they next link to any member. The setting device's daemon must run for its first copies to go out.
- **Leaving.** A member removed from the mesh, or that leaves it, deletes its copies and gets no new versions, but keeps what it read: after losing a device, change its secrets at their source and set them again. Once the admin removes a member, the others delete the secrets it set. [docs/adr/0007-mesh-secrets.md](docs/adr/0007-mesh-secrets.md) has the design.

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
| `:shell [COMMAND]` | Open an interactive terminal on it: its login shell, or `COMMAND`. Returns to the prompt when the program exits. |
| `:sessions` | List its named PTY sessions. |
| `:attach NAME` | Attach to one of them; Ctrl-] returns to the prompt and leaves it running. |
| `:help` | Show prompt help. |
| `:quit` | Exit this CLI; from `attach`, detach the console. |

## Command execution

Everything after the first `--` is the command, in the remote shell's syntax; options after it belong to the command. Several words are joined with spaces, as `ssh` does, so simple commands need no quotes. Your local shell still expands what is unquoted, such as `$HOME`, globs, `|`, `;` and `>`, before `cns` sees it: quote those to have the remote shell handle them. One quoted string reaches the remote shell unchanged. `shell` takes its command the same way.

```sh
cns run studio -- git status
cns run studio -- ls -la /tmp
cns run studio -- 'printf "hello\n"; exit 7'
cns run studio --cwd /tmp --timeout 10000 -- 'pwd; ls -la'
```

### Environment defaults

`CNS_CWD` sets the remote working directory for `run`, `shell` and `mcp` when `--cwd` is not given; by default commands start in the remote user's home. It is an absolute path on the **remote** machine, not the local one. `CNS_BIND` and `CNS_PORT` set the interface and port `cns up` listens on (default every interface, port 47381) when `--bind` and `--port` are not given. Precedence is **CLI flag > environment variable > built-in default**. `CNS_BIND` must be a numeric IPv4 or IPv6 address, and `CNS_PORT` must be an integer from 1 to 65535. Empty or invalid values are rejected unless overridden. In PowerShell, set variables with e.g. `$env:CNS_CWD = 'C:\src'`.

### Output and execution behavior

`run` streams remote stdout and stderr to the corresponding local streams as they are produced, byte for byte, without prompts or added newlines, and propagates the exit status. A timeout exits with status 124. When the local reader goes away, as with `| head`, the remote command is killed and `run` exits with 141, as a local command ends on SIGPIPE.

Every command starts a fresh noninteractive shell. Shell variables and standalone `cd` commands do not persist; use `:cwd` or combine operations in one command. For interactive programs, editors and TUIs, use [`shell`](#interactive-terminals-pty).

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

## Skills

`cns skills` treats the agent skills of this device and of every paired device as one set. Each device keeps its own in `~/.agents/skills` (`%USERPROFILE%\.agents\skills` on Windows, the Linux home in WSL): a skill is a directory there that holds a `SKILL.md`, and its name is the directory's.

```sh
cns skills list                       # every skill once, with its device and description
cns skills load pdf                   # print the newest pdf skill's SKILL.md
cns skills load studio:pdf            # studio's own copy
cns skills ls pdf                     # its files
cns skills cat pdf scripts/fill.py    # one of them
cns skills rg -i 'invoice' pdf        # lines that match, as NAME/FILE:LINE:TEXT
cns skills sync pdf                   # copy it into this device's ~/.agents/skills
cns skills sync --to studio: pdf      # or into studio's (needs the files grant there)
```

- **Which copy.** Where several devices hold a skill of the same name, the one modified last wins: the copy whose newest file has the latest modification time, compared in UTC to the second. A tie goes to this device, then to the paired device whose name sorts first. `NAME` is that copy; `DEVICE:NAME` is a paired device's own. `cns skills list` shows the others under `ALSO ON`; `--json` prints `{ skills: [{ name, device, modified, description, copies: [{ device, modified }] }], devices: [{ device, state, reason }] }`, where `device` is null for this device. The description is the one in `SKILL.md`'s YAML front matter.
- **Reaching devices.** Each paired device is asked at once, through the local daemon's link when it has one, as `cns sessions` does. A device is asked when it grants this one `skills` or `files`. One that grants neither is named on stderr; so is one that refuses or does not answer within 10 seconds, and `list` then exits 1. On a device, `cns peer grant laptop skills` lets laptop read its skills. A device that runs a cns from before 2.2.0 is named with what to install.
- **What a skill is made of.** Its regular files, and links to files inside the skill, at most 1,000. Hidden files and directories, such as `.git`, `.env` or `.python-version`, are not part of a skill: they are not listed, read or copied, so a key kept beside a skill stays on its device. A link that leads out of the skill, or to a directory, is not followed; a skill directory may itself be a link, as skill installers make. `load` prints `SKILL.md` on stdout and names the skill's other files on stderr. `rg` takes a JavaScript regular expression (`-i` ignores case), searches text files of up to 1 MiB, and exits 1 when nothing matches.
- **Sync.** `cns skills sync NAME...` copies each skill to `PATH/NAME`, where `PATH` is this device's `~/.agents/skills` unless `--to [DEVICE:]PATH` says otherwise; `--to DEVICE:` alone is that device's `~/.agents/skills`. Files replace files of the same name there, and other files there are kept. A `PATH/NAME` that is not a skill (it has no `SKILL.md`) is never copied over. Every copied file keeps its source's modification time and permission bits, so a copy ties with its source rather than looking newer, and syncing it again from this device finds it already here. A copy onto a paired device needs the `files` grant there; one within a paired device is refused.
- **Grants.** `skills` is read-only and reaches only skills: names cannot contain separators, paths cannot contain `..` or hidden parts, and every file read must resolve inside its skill's directory. `files` also lets a device read skills, since it can read those files anyway. Both are enforced by the device that holds the skills.

This repository's [skills/](skills/README.md) folder holds skills that teach agents to use cns: running commands and sessions on other devices, sharing skills, using mesh secrets without printing them, reading denials and troubleshooting. Copy them into `~/.agents/skills` on one device, then `cns skills sync --to DEVICE: NAME...` spreads them.

## Interactive terminals (PTY)

`shell` runs a program on a pseudo-terminal on the peer, so interactive CLIs and full-screen TUIs such as `vim`, `top` or Claude Code render and take keyboard input:

```sh
cns shell studio                            # a session of its own (shell-1, ...): the remote user's login shell ($SHELL -l, else Bash; PowerShell on Windows)
cns shell studio --cwd /srv/app -- 'claude' # one command, with the run quoting rules
cns shell studio -- 'htop'
```

From a console, `:shell` and `:shell COMMAND` do the same on the selected peer, on any device linked to the daemon. The console's `:cwd` and `:timeout` apply.

- A local terminal is switched to raw mode, so Ctrl-C, Ctrl-D, Esc and arrow keys go to the remote program. Its size is sent on start and on every resize. The local terminal is restored when the program exits or the connection drops.
- `shell` exits with the remote program's status (124 after `--timeout`, 128 + signal number after a signal). A timeout or `:shell` hang-up sends SIGHUP to the program, then SIGKILL after one second.
- Without a local terminal, for example from an agent, piped stdin is forwarded byte for byte and output is written raw, including escape sequences. Pass `--cols`/`--rows` for a fixed size (default 80×24) and `--term` for `TERM` (default `xterm-256color`). The end of piped input is not sent as a keystroke. Send `\x04` yourself where a program expects Ctrl-D:

  ```sh
  printf 'ls --color\nexit\n' | cns shell studio --cols 120 --rows 40
  printf 'hello\n\x04' | cns shell studio -- 'cat'
  ```

### Rendered screens

Each PTY session renders its output into a headless terminal emulator ([`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless)) on the executing peer, as tmux does for its panes. `--screen` prints what that terminal shows when the program ends, like `tmux capture-pane -p`, instead of the escape sequences that drew it. The renderer only renders; you choose when to look. A program's own exit captures its final screen, and `--timeout` captures a program that keeps running at that moment, then hangs it up:

```sh
cns shell studio --screen --cols 120 --rows 40 --timeout 5000 -- 'htop'
(sleep 1; printf 'ihello\033') | cns shell studio --screen --timeout 3000 -- 'vim notes.txt'
cns shell studio --screen --history 100 -- 'make test'   # include up to 100 scrollback lines
```

Rows are printed with trailing spaces and the blank rows below the last output removed. The remote screen answers terminal queries such as cursor-position reports, at a terminal as well as with `--screen` or without one (see [Named sessions](#named-sessions)). TUIs that wait for such answers, including Claude Code, then draw without a real terminal attached. A program that exits through the alternate screen, as vim does on `:wq`, leaves the normal screen behind; that is what a real terminal shows then, too.

### Named sessions

A named session keeps running between commands, so an agent can work with a TUI in steps, as with `tmux send-keys` and `capture-pane`:

```sh
cns shell studio --name claude --cwd /srv/app -- 'claude'  # start in the background; prints nothing
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

- **Lifetime:** sessions live in the device's daemon, not in a connection. They survive the commands and connections that use them and end when killed or when that process stops. Nothing is written to disk. Each process holds up to 16 named sessions, running or finished, including the ones `cns shell DEVICE` terminals start. A finished session keeps its final screen and exit status for an hour after its program ends, then the device removes it. When all 16 places are taken, starting a session removes the finished one that ended first; only when every session is still running, or someone is attached to it, is a new one refused. `--timeout` on `shell --name` limits the session's lifetime.
- **`keys`** takes tmux-style key names: `Enter`, `Tab`, `BTab`, `Escape`, `Space`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `Insert`, `Delete`, `F1`–`F12`, with `C-`, `M-` and `S-` prefixes such as `C-c` or `C-Left`. Other arguments are typed as text; `--literal` types every argument as text. The executing peer encodes keys, so arrow keys follow the program's cursor-key mode.
- **`screen`** prints the current screen like `shell --screen`. `--until TEXT` first waits for the screen to show TEXT, checking after every chunk of output. It exits 0 when the text appears, 1 if the program ends first and 124 after `--timeout` (default 30000 ms; 0 waits indefinitely). It prints the screen in each case. The renderer does not decide when a program is finished; `--until` is a convenience over it. To confirm that a key took effect, wait for the screen it should produce rather than sleeping.
- **`shell DEVICE` and `shell --attach NAME`** show a session on your terminal's normal screen, as ssh shows a shell. Lines that scroll off the top go to your terminal's own scrollback, so the wheel, selection and your terminal's keys for scrolling and searching work as they do in a local shell. The program's switches to the alternate screen, as vim makes, and its mouse modes reach your terminal as they are. An attachment starts with the session's current screen: what your terminal showed is scrolled into its scrollback, the screen is drawn, and live output follows with your keys going the other way. The scrollback holds what this terminal received while attached. Earlier output, and output written while detached or disconnected, stays on the device, where `cns screen DEVICE NAME --history N` prints it; after a reconnect, the screen from before the outage is in the scrollback above the redrawn one. A program that clears the scrollback, as `clear` does, clears your terminal's, as it does over ssh. Detaching, or the program's exit, leaves the session's output where it is and resets what the program set: the alternate screen, the mouse, bracketed paste. Ctrl-] detaches and leaves the program running; `--key C-b` (or `CNS_KEY`, which `cns ui` reads too) names another control key, and `--key none` sends every key to the session. When `cns` stops, by Ctrl-C while reconnecting, a signal, a closed window or an error of its own, it first gives the terminal back: the normal screen, no mouse reports. Only a `cns` killed outright (`kill -9`) cannot, and `reset` then restores the terminal. `--kitty-keys` (or `CNS_KITTY_KEYS=1`) lets the session's programs tell keys such as Shift+Enter from Enter: see Terminal queries below. Exiting the program ends the attach with its status. Attaching from a terminal resizes the session to that terminal, as in tmux. Several viewers can attach at once. Without a local terminal, `--attach` streams raw output and forwards stdin, without detach key or resize. `cns ui` and the console's `:attach` show a session on the alternate screen instead, as tmux does, and return your terminal to what it showed before.
- **Terminal queries** are answered by the session's screen, on the device that runs the program, so programs keep drawing with no one attached and never wait for an answer to cross the connection. `cns shell` and `cns ui` keep the queries from your terminal: its answer would arrive a round trip later, and one that arrives after the program has exited is typed into the shell, as `62;22c` after leaving Neovim. As in tmux, the program therefore sees the session's terminal and not yours. It is told the terminal has 24-bit colour; kitty graphics queries, in-band resize reports and queries for your terminal's colours or clipboard are not passed on, so a program that picks a light or dark theme from the background colour uses its default.
- **The kitty keyboard protocol** is not passed on by default, so keys that only it tells apart, such as Shift+Enter from Enter, reach the program as the plain key. `cns shell DEVICE --kitty-keys` and `cns shell DEVICE --attach NAME --kitty-keys` (or `CNS_KITTY_KEYS=1` in your shell's startup file) pass it on, for programs that ask for it, such as Claude Code and Neovim. `cns` asks your terminal once whether it speaks the protocol; while such a terminal is attached, the session's screen tells programs that ask that it does, and your terminal is put in the keyboard mode the program sets, on each of its screens, also when you attach after the program set it. `cns` keeps that mode in one entry of its own on your terminal's stack and takes it back when you detach, when the program exits and when `cns` stops by a signal or an error of its own, so your shell gets its keys as before. The detach key keeps working: `cns` finds it as the byte, as a kitty key event and as xterm's modifyOtherKeys reports it, which Vim turns on with or without this option. It needs a terminal that speaks the protocol (kitty, Ghostty, foot, Alacritty, iTerm2, Warp, Windows Terminal and Rex do, WezTerm with `enable_kitty_keyboard` set; Apple Terminal does not) and a `cns` on the device that knows the option (1.10.0 or later). Without either it says so and changes nothing: the session works as without the option. A terminal that takes more than a second to answer is treated as one without the protocol, and its late answer is dropped, not typed into the session. It applies to sessions shown this way, not to `cns ui`, the console, or an unnamed terminal (`cns shell DEVICE -- COMMAND`). When several terminals are attached to one session, a program that asked for the protocol also gets keys from those that do not pass it on, as plain bytes. If `cns` is killed outright (`kill -9`) while a program has set a keyboard mode, your terminal keeps it and types codes such as `9;5u` for keys with a modifier: run `reset`.

At a terminal, `cns shell studio` and `cns shell studio --attach NAME` reconnect by themselves when the connection drops (see [Paired devices](#paired-devices)). Without a terminal, run it again: the new attachment redraws the current screen and streams subsequent output. It does not replay all output missed during the outage, and input in flight when the connection failed may or may not have reached the program; inspect the session before retrying it. Unnamed PTYs end with their connection. Named sessions end when the device's daemon stops; they do not survive a daemon restart. `cns kill` with the same target and session name explicitly ends and removes a named session.

### Running commands in a shell that stays

`cns shell DEVICE -d` types a command into a login shell that keeps running on the device, and returns at once. The next command goes into the same shell, so its directory, variables and background jobs carry over:

```sh
cns shell studio -d --session work --cwd /srv/app -- 'source .venv/bin/activate'   # starts the session work, then types the command
cns shell studio -d --session work -- pytest -x                                  # the same shell, a moment later
cns shell studio -d --session work --command 'git status'                        # --command is the same as --
cns screen studio work --until passed                                            # what it printed
cns shell studio --attach work                                                   # or join it
name=$(cns shell studio -d -- 'make watch')                                      # no name: the next free shell-N, printed
cns shell -d -D studio -s work -p -- make test                                   # --screen: waits for it to end, prints what it showed
cns kill studio work
```

- **The session.** The first use of a name starts the session, and says so on stderr; without `--session` it is the next free `shell-N`, and stdout carries that name alone. It is a named session like any other: `cns sessions` lists it, `cns screen` and `cns keys` read and drive it, `cns shell --attach` joins it, and it ends with `cns kill`, when its shell exits or when the device's daemon stops.
- **The command** is typed at the prompt, followed by Enter, as a person would type it. `cns` returns once it is typed, not when it finishes, and its status stays in the shell: read the screen, or `--until` some text, to know how it went. A program still running in the session receives what is typed, as it would from a keyboard. For a session that is starting `cns` first waits for the prompt, up to five seconds; when none shows it says so and types the command anyway. Stopped while it waits, it types nothing.
- **Waiting for the result.** With `--screen` (`-p`), `cns` waits for the command to end, prints what the session shows from the line the command was typed on to the prompt after it, and returns, leaving the session running. It exits 0 whatever the command's status, which stays in the shell, as with `-d` alone. The command has ended once the shell has the terminal back and nothing new has shown for a moment, or once the shell has had it back for two seconds, so a job in the background that prints on does not keep `cns` waiting; the device's cns says which program has the terminal, from 2.1.0 on. An older device's cns, or a Windows device, cannot say, so `cns` waits until nothing new has shown for two seconds and says so: a command that pauses that long is printed before it ends. A command that waits for input, such as a question, keeps `cns` waiting; Ctrl-C stops waiting, exits 130 and leaves the command running. When the shell exits, as with `exit 3`, `cns` prints the screen, says the session ended and exits with the shell's status. It prints at most the device's 1000 lines of scrollback.
- **What only a new session takes.** `--cwd`, `--timeout`, `--term`, `--cols`, `--rows` and `--secret` describe a session being started. Given for one that already runs, the command is refused and nothing is typed, so a command meant for another directory, or one that needs a secret, never runs without it.
- **What it is not for.** A session started with a command of its own (`--name NAME -- COMMAND`) is not a shell to type into, and one that has ended takes nothing; both are refused with what to run instead. `-d` does not go with `--name`, `--attach`, `--history`, `--key` or `--kitty-keys`.

### Switching between sessions

`cns ui` shows one session at a time, with a switcher over every session on every paired device, much like tmux's session chooser:

```sh
cns ui                  # the switcher: each paired device and its sessions
cns ui studio           # the switcher, with studio selected
cns ui studio/claude    # straight into studio's session claude
cns ui --key C-b        # switch with Ctrl-B instead of Ctrl-]
```

- In a session, Ctrl-] (`--key` or `CNS_KEY` choose another control key, such as `C-b`; `CNS_KEY=none` is for `cns shell`, and `cns ui` then keeps Ctrl-]) opens the switcher over it; the session keeps running. Up and Down (or j and k) move, Enter opens the selected session, 1 to 9 open the numbered sessions, Tab opens the session before the last one, Esc returns to the one you came from, `n` (or Enter on a device) starts the next free `shell-N` there, and `x` kills the selected session after asking. When the terminal is at least 90 columns wide, the selected session's screen is shown beside the list.
- `d` or `q` detaches: `cns ui` ends and every session keeps running, including the ones started from it, as does closing the terminal. A session started in `cns ui` is kept so you can return to it, unlike the one `cns shell DEVICE` starts, which ends with its window.
- The switcher asks each device for its sessions when it opens and every three seconds while it shows, each over its own connection, so a slow or unreachable device is marked as such without holding up the others. A device whose saved grants do not include `sessions:list` is shown but not asked. The device's grants apply as everywhere else: without `sessions:control`, a session's output is shown but your keys are not sent, and the switcher says so.
- If the connection to a device drops while one of its sessions is on screen, `cns ui` returns to the switcher and says so; Esc tries again. It does not reconnect by itself as `cns shell` does.
- **Panes.** `+` in the switcher adds the selected session in a pane of its own (on a device, it starts the next `shell-N` there), so up to four sessions are on screen at once: two side by side, three or four in two rows, each under its title. Keys go to the session you came from, whose title is drawn in reverse; picking another session that is in a pane (Enter, a number, Tab or Esc) gives it the keys, and picking one that is not puts it in place of the current one. `-` closes the current session's pane, and the session keeps running. Each session is resized to its pane; one this device may only watch keeps its size and shows as much as fits. A pane whose program ends keeps its last screen until `-` closes it. While several sessions are on screen, `cns ui` draws them itself from its own copy of each screen, as tmux does: each session answers its program's terminal queries, and the mouse does not reach the programs. With one session on screen, that session has the terminal to itself.
- `cns ui` needs a terminal. Without one, use `cns sessions`, `cns screen`, `cns keys` and `cns shell --attach`.

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
| `attach(sink, { cols, rows, answers })` | Stream the session to `sink`, starting with a redraw of the screen. `cols`/`rows` resize the session first. `answers: true` means the caller's terminal answers terminal queries in place of the session's screen; `cns` itself never asks for that, because an answer that crosses a connection can arrive after the program stopped waiting. Returns a `PtyAttachment` with the same controls; releasing it detaches. |
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

Commands you run (`run`, `shell`, `cp`, `sessions`, `keys`, `screen`, `kill` and `cns mcp`) offer the other device only the handshake's `info()`; every other method is refused, whatever this device granted it. What a paired device may do through its daemon's link is set by its grants.

Grants are not a per-user authorization system inside a device. A device that has shell access can use the named sessions in that process, including through a forked shell; a session name is not a credential. Releasing a fork stops its own commands and unnamed PTYs and revokes the named-session handles and attachments it returned; the sessions keep running. Killing a named session invalidates handles to that session, even if its name is reused.

On Windows peers, programs run on a ConPTY in Windows PowerShell, with the same quoting as `run`. **This path is untested.** It compiles, and `src/shell.test.ts` has a Windows-only PTY test, but it has not been run on Windows yet. The `Windows` GitHub Actions workflow (`.github/workflows/windows.yml`), which runs every Monday and on demand, runs both test suites on `windows-latest`, including Windows versions of the named-session tests. Expected differences, from [Bun's ConPTY notes](https://bun.com/docs/runtime/child-process#platform-differences):

- Hang-up and `--timeout` kill the program's process tree; Windows has no SIGHUP for programs to handle.
- ConPTY redraws output itself, so raw output differs from what the program wrote, though rendered screens should match.
- Ctrl-C may not interrupt programs, because the system console host does not always turn it into an interrupt.
- Mouse input needs Windows 11 or Server 2022.

## Background operation

```sh
cns daemon start        # or cns up
cns attach
# :peers, :use p1, then commands; :quit detaches
cns daemon restart      # stop it and start it again as it runs now
cns daemon stop         # or cns stop
```

`cns daemon start` and `cns daemon stop` are `cns up` and `cns stop` under the `daemon` command; both names work. `cns up` starts the daemon as a detached process; `cns up --install` makes it a service that starts at login and restarts if it fails. Its private local state defaults to `~/.cns/daemon.json`. To run separate daemons, use different ports and pass the same custom `--state PATH` to `up`, `attach` and `stop`. Startup prints the log location. The state file allows one daemon per path: `cns up` reports the daemon already running. If a daemon crashed, the next `cns up` removes its state once the control endpoint does not answer and its process no longer exists.

The private control endpoint uses IPv6 loopback (`::1`) when available, falling back to `127.0.0.1` when IPv6 cannot be bound. Its address and random port are recorded in version-2 daemon state; clients also read older version-1 state, which always means IPv4. `--bind` and `--port` configure the paired-device listener, not this control endpoint. Upgrade local clients (including the Pi extension) and restart the daemon together: older clients cannot read version-2 state. Pairings and the device identity are unchanged.

If `cns up` reports **Local daemon connection timed out** while the daemon is running, check local networking before deleting any state. WSL mirrored networking can leave IPv4 localhost connections timing out even when a process is listening, while IPv6 loopback still works. Installing the updated CLI alone does not move an already-running IPv4 daemon: update the service's executable and restart it through its service manager (`systemctl --user restart cns` for a systemd user service). If it was installed with `cns up --install`, install it again from the updated executable; for a Nix-managed service, update its package through Nix instead. Restarting ends the daemon's sessions. See [ADR 0003](docs/adr/0003-local-control-loopback.md) for the diagnosis, compatibility rules and regression checks.

A device in WSL usually cannot be dialed from other machines: in mirrored networking the Hyper-V firewall drops inbound connections by default, and in NAT mode its address is private to the host. Its own daemon dials out, though, and commands from other devices use that link, as above, so `cns doctor` listing its direct addresses as `unreachable` is expected and needs no firewall change. Keep the daemons running on both devices (`cns up`, or the Nix or systemd service) so the link exists; without it, commands to the device go through the relay, which costs a second or two per command and a round trip to the relay per keystroke. [The WSL latency report](docs/verification/2026-11-10-wsl-latency.md) has the measurements.

Detaching with `:quit` or Ctrl+C leaves the daemon, its links and pending commands running. `stop` shuts down the daemon and cleans up its sessions.

`cns daemon restart` stops the daemon and starts it again the way it runs now. systemd restarts a daemon that runs as its user service, with whatever command the unit and its drop-ins give it; a launchd agent's daemon is stopped and started again by launchd, and a scheduled task's by running the task again; a daemon `cns up` started is started again detached, with the same `--bind` and `--port`, running the cns you typed. A daemon that was not running is started. A paired device can restart it too, which is how a device you are not at picks up a new cns: `cns run studio -- cns daemon restart` returns at once, the daemon restarts a second later in a process of its own that outlives the command and the daemon, and the link comes back within seconds. Its log is `~/.cns/restart.log` on that device; check with `cns run studio -- cns status`. The device runs the `cns` its daemon's `PATH` finds, which can still be the old one after an upgrade (mise keeps each version in a directory of its own, and cns 2.2.0 and older have no `daemon restart`); name the new executable by its path then, as in `cns run studio -- /path/to/new/cns daemon restart`. A daemon run by a service manager cns did not install, such as the NixOS module's system service, is refused before anything stops, since only that manager can start it again (`sudo systemctl restart cns`). Restarting ends the named sessions the daemon holds.

### Upgrading

A running daemon keeps the executable it started with, so after you install a new cns, paired devices, and the commands that use the daemon's links, still get the old one until the daemon restarts. `cns up`, `cns status` and `cns doctor` say when the daemon runs another version than the command you typed, and what to run:

- a daemon `cns up` started: `cns daemon restart`;
- a service `cns up --install` made that runs this cns: the same; one that runs another executable, as after mise installed a new version under its own directory: `cns up --install` again, which points the service at this cns and restarts it;
- a Home Manager service: `home-manager switch` to a configuration with the new cns, or `cns daemon restart` when the service already names it; if it still runs the old one, `systemctl --user cat cns` shows what overrides it;
- another service manager, such as the NixOS module: update cns there and restart it (`sudo systemctl restart cns`).

Restarting ends the daemon's named sessions. A daemon that runs a newer cns than the command means an older cns comes first on `PATH`: `command -v cns` (`Get-Command cns` in PowerShell) shows which one a shell runs. Devices report their version to each other when they connect, so `cns peers`, `cns doctor NAME` and the MCP `list_peers` tool show which devices need upgrading; a release from before this reports none and shows as older. The relay and the gateway print the version they were built from at their root (`curl https://cns.nothuman.work/relay`), so one that was not redeployed after a change shows it.

## MCP server

`cns mcp` gives MCP clients such as Claude Code, Codex and Cursor tools that use a paired device the way the commands above do:

| Tool | Purpose |
| --- | --- |
| `list_peers` | Each peer's ID, hostname, OS, shell, home directory and cns version. |
| `run_command` | Run one command as `cns run` does and return its exit code, stdout and stderr. `secrets` sets mesh secrets the peer holds as its variables. |
| `start_session` | Start a named PTY session, as `cns shell --name` does, optionally waiting for its first screen. Takes `secrets` too. |
| `send_keys` | Send keys and text, as `cns keys` does, optionally waiting for the screen they produce. |
| `read_screen` | Return the rendered screen, as `cns screen` does, optionally once it shows some text. |
| `list_sessions` | A peer's named sessions. |
| `kill_session` | End and remove a named session. |
| `read_file` | Read a text file's lines, 2,000 at a time by default, continuing from `nextOffset`. |
| `write_file` | Create or replace a file with UTF-8 text, up to 4 MiB, creating missing parent directories. |
| `list_directory` | A directory's entries and their kinds. |
| `glob` | Absolute paths of files matching a pattern such as `**/*.ts`, with `ignore` patterns. |
| `list_skills` | The agent skills on every peer, or one, as `cns skills list` shows them: each once, from the newest copy. |
| `read_skill` | A skill's `SKILL.md`, or another of its files, and the list of its files, as `cns skills load` and `cat` do. |
| `search_skills` | Lines of skills that match a regular expression, as `cns skills rg` finds them. |
| `list_secrets` | The mesh secrets a peer holds, by name, as `cns secret list` shows them there; never their values. |

`list_peers` also gives each paired device's `name` and `fingerprint`, and `peer` accepts the name. Results include text for the agent and structured content matching each tool's output schema. A command that exits nonzero is a normal result with its exit code; an unreachable peer, a missing session or invalid arguments are tool errors. `run_command` has a default deadline of 120 seconds (`timeoutMs: 0` removes it) and returns the start and end of output longer than 30,000 characters. Peers still keep at most 1 MiB. With several devices linked to the daemon, calls must name a `peer`.

The file tools take paths in the peer's own syntax. A relative path starts from `--cwd`, else the peer user's home, and `~` means that home. `read_file` refuses binary files and returns at most 30,000 characters per call. These tools need the `files` grant (`cns peer grant NAME files` on that device); without it they fail with a permission error, while `run_command` only needs `shell`. The skill tools need `skills` or `files`.

`secrets: ["API_KEY", "work:TOKEN"]` on `run_command` or `start_session` names mesh secrets that the peer itself holds, as a member of their mesh. The peer opens its own copies and sets them as the program's variables, as `cns secret run --only` does there, so the values never pass through `cns mcp`, the gateway or the agent's results, unless the program prints them. It needs what the call needs anyway (`shell`, or `sessions:create` for a session), with which a program could read the secrets on that device already, so no grant changes. `list_secrets` needs `shell`. The peer needs cns 2.3.0 or later; an older one refuses before starting anything. There are no tools to print, set or remove a secret: keep a secret off devices agents use with `cns secret set --device`.

`cns mcp --env GITHUB_TOKEN,NPM_TOKEN` (or `CNS_MCP_ENV`) offers variables of the `cns mcp` process itself, such as ones the MCP client's configuration sets, to the same tools: `env: ["GITHUB_TOKEN"]` sets it, with its value there, for the program on the device, and the agent never sees the value unless the program prints it. Only the names listed are offered, and the tool's schema lists them; without `--env`, there is no `env` argument. The gateway has no environment of its own to pass on, so it offers `secrets` only.

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

For agents in a remote environment, such as Claude on the web, Claude Desktop or Claude Code in the cloud, deploy the gateway in `gateway/` to your Cloudflare account and add `https://gateway.cns.nothuman.work/mcp` as a custom connector. The gateway is itself a paired device: each device pairs with it (`cns pair` there, `cns gateway pair CODE` on a device you own) and grants it what it chooses, and the gateway reaches it through the relay over an end-to-end link, so no device is exposed. Connectors sign in with OAuth; the sign-in page shows a code, and nothing is granted until you run `cns gateway approve CODE` on one of your devices, choosing the devices (all by default, which includes devices paired with the gateway later) and tools (`--tools read` for tools that change nothing). `cns gateway grants`, `revoke` and `log` list connectors, stop one at once, and show the calls they made. Setup and the security model are in [gateway/README.md](gateway/README.md).

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

Both modules install `cns` and take `bind`, `port`, `stateFile` and `environment` like `cns up --install`; the NixOS one also takes `openFirewall` and `path`. They create the device's identity on first start; pair as usual with `cns pair`. Commands paired devices run get the service's `PATH`, which lists the user's Nix profiles and the system's packages, not a login shell's. The built-in relay requires no configuration. Do not put secrets in `environment`, which ends up readable in the Nix store. The Home Manager service has the name and state file `cns up --install` uses, so `cns up` starts it after `cns stop`, and Home Manager keeps it at the current package's path across upgrades; don't also run `cns up --install`. `cns daemon restart` restarts the Home Manager service through systemd. The NixOS service is managed with `systemctl` (`systemctl restart cns`, `journalctl -u cns`): `cns stop` stops it until it restarts, `cns up` would then start a second daemon outside it, and `cns daemon restart` refuses it.

The default package/app is also available as `cns` (and the legacy flake attribute `capnweb-shell`). The package contains the executable with an absolute Nix-provided Bash path; it does not require or install a source checkout. Distribute Nix builds through Nix because their runtime libraries may reference the Nix store.

### Relay TLS trust in services

If direct connections cannot reach a device, pairing and commands automatically try its relay. The target daemon must first register there: `cns status` should say `Relay: ... (registered)`. Merely listing a relay address in an invite does not prove registration succeeded.

A service can fail to register even when the same executable works in a terminal: systemd, launchd and Task Scheduler do not read the login shell's environment. This matters on networks that use a private CA or TLS inspection. Check `journalctl --user -u cns` (NixOS system service: `journalctl -u cns`; macOS and Windows: `~/.cns/service.log`). Registration failures now include the underlying TLS/network error; identical errors are suppressed until the reason changes or registration succeeds. `unable to get local issuer certificate` means the runtime could not verify the certificate chain—not that direct-address fallback needs disabling.

- `cns up --install` preserves `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR` when set. Reinstall from the updated executable to apply this to an existing service. A Windows scheduled task takes no environment from the shell: set them for your account with `setx`, then `cns daemon restart`.
- The **NixOS module** defaults `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE` to `security.pki.caBundle`, including configured system roots.
- The **Home Manager module** copies those three CA variables from `home.sessionVariables` when declared. `services.cns.environment` overrides them; for example, `services.cns.environment.NODE_EXTRA_CA_CERTS = "/etc/ssl/certs/ca-certificates.crt";` uses an existing Linux system bundle for this service only.

Use an existing trusted CA bundle, keep certificate verification enabled, and scope any extra configuration to cns. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. After updating and restarting the service, wait for `registered`, then generate a **fresh** `cns pair` invite: a restart invalidates outstanding invites. [The relay verification report](docs/verification/2026-11-09-relay-trust.md) records the reproduced failure and end-to-end tests.

### Releases

Pushing a tag `vX.Y.Z` that matches `package.json`'s version runs `.github/workflows/release.yml`: it builds `cns` on each platform it ships for, runs it there, and publishes the release with one archive per platform and `SHA256SUMS`. Run the workflow from the Actions tab with an existing tag to rebuild that release's assets.

`flake.lock` pins nixpkgs; `bun.lock` pins JavaScript dependencies. Nix fetches production dependencies in a fixed-output derivation and builds/tests offline. When production dependencies change, update the hash in `nix/package.nix` using `lib.fakeHash` and the hash reported by Nix; then rerun `nix flake check`.

## Security

A paired device can do on this one what it was granted, as the user running the daemon: `shell` and `sessions:create` amount to running any command, and `skills` reads only `~/.agents/skills`, without its hidden files. Grant only what a device needs, and revoke it with `cns peer revoke`. A member of a mesh this device joined can do what `cns mesh allow` lets members do here (see [Meshes](#meshes)), and can read the secrets set for every member of that mesh (see [Mesh secrets](#mesh-secrets)). Only paired devices that authenticate with their identities can connect, and every link is encrypted end to end (see [Paired devices](#paired-devices)), so the daemon listens on every interface by default; `--bind` narrows it. Browser-origin WebSocket requests are rejected.

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

The hook runs `ast-grep scan . .github`. The rules in `lint/rules` check that every file stating Bun's version agrees, that Nix builds with `nix/bun.nix` and that CI reads the version from `package.json`, and that no `cns` command lets its terminal answer a session's terminal queries. The Tests workflow runs the type check and the tests on Linux for pull requests that change code; the terminal tests run only on POSIX systems, so the weekly Windows run does not cover them.

Tests exercise pairing, grants and links between devices, target selection, disconnect isolation, reverse calls during one-shot commands and PTY sessions, output/exit-status handling, PTY input, sizing, hang-up, timeouts and flow control, rendered screens and scrollback, named sessions across connections and CLI calls (keys, waits, attach redraws, detach, kill and limits), PTY proxying through the daemon, streaming commands with flow control and cancellation (also through the daemon), file operations and their validation, commands refusing every reverse call, process cleanup, connection limits, daemon attachment, startup races and stale-state recovery. MCP tests drive `cns mcp` with the official SDK client over stdio and HTTP, in both protocol eras: every tool, tool errors, cancellation and disconnects killing commands and freeing screen waits, 2025-era session limits, HTTP authentication, origin and host checks, calls beyond Bun's idle timeout with progress, daemon peer selection and the refusal of reverse calls. The Pi extension tests run Pi's agent sessions with a scripted model against paired devices and the daemon: each tool and `!` on a host, results matching Pi's local tools for `grep`, `find`, `ls` and `read`, images, aborts and timeouts stopping the host's command, long commands, sessions sharing one daemon and attaching to its peers, `CNS_UP`, `/cns stop`, lost hosts and failed startup attachments blocking every tool, and continued sessions attaching again. The package tests build the npm package, install it beside a Bun package, and drive it in Pi processes in RPC mode, on Node and with the installed `pi` when there is one, with neither `bun` nor `cns` on `PATH` and hostile `.env` and `bunfig.toml` files where the daemon would read them. The compiled suite additionally tests the executable outside its checkout without a JavaScript runtime on `PATH`.
