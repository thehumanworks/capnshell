# Cap’n Shell for Pi

This [Pi](https://pi.dev) extension runs Pi's own tools on another machine with [Cap’n Shell](https://github.com/thehumanworks/capnshell) (`cns`). While Pi is attached to a host, `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` and your `!`/`!!` commands work on that host's files and shell instead of Pi's machine. It replaces those tools under their own names, so prompts, rendering and the session's active tools stay as they are, and it adds no command-running tool of its own.

```sh
pi install npm:@nothumanwork/pi-cns
```

The package contains the extension and cns. It also depends on Bun, which runs cns, for this platform: npm installs only this machine's Bun package, a download of about 40–50 MB. Pi's machine needs nothing else, with Pi on Node.js or Pi's own executable. The hosts run `cns`; see [Build and distribute](https://github.com/thehumanworks/capnshell#build-and-distribute).

## Reaching a host

The host connects to Pi, which works from behind NAT:

```sh
# Pi's machine: CNS_LISTEN=1 pi, or /cns listen in Pi
cns connect ws://PI_MACHINE:47381    # on the host
# then in Pi: /cns attach p1
```

Or Pi connects to a host's listener:

```sh
cns listen --bind 0.0.0.0 --allow-remote    # on the host
# then in Pi: /cns attach HOST
```

| Command | Purpose |
| --- | --- |
| `/cns listen` | Start this machine's cns daemon, or use the one running, so hosts can connect. |
| `/cns status` | The daemon, its peers and where the tools run. |
| `/cns attach HOST [DIRECTORY]` | Run the tools on `HOST`: a daemon peer (`p1`), a listener (`host[:port]`) or a `ws://`/`wss://` URL. `DIRECTORY` is absolute or relative to the host's home, which is the default. |
| `/cns detach` | Run the tools on Pi's machine again. |
| `/cns run HOST COMMAND` | Run one command on `HOST` and add its output, fenced and labelled with the host and directory, to the conversation. |
| `/cns stop` | Stop the daemon, for every Pi session and `cns attach` console using it. |

The model gets a `cns` tool with `status`, `attach` and `detach`, to attach to a host you name. While attached, the footer shows the host and its directory. The system prompt tells the model where the tools run and that `~` is the host's home. Commands get the host's environment: nothing from Pi's, such as its `PI_*` session variables, is forwarded.

## Configuration

Nothing needs configuring. These environment variables change the defaults:

| Variable | Effect |
| --- | --- |
| `CNS_LISTEN` | `1` (or `true`, `yes`, `on`): listen when Pi starts, as `/cns listen` does. `0`, `false`, `no`, `off` or unset: do not. Pi reports any other value and does not listen. |
| `CNS_BIND` | The address to listen on, a numeric IP. Default `0.0.0.0`, every interface. |
| `CNS_PORT` | The port to listen on, and the port `/cns attach HOST` uses when `HOST` names none. Default 47381. |
| `CNS_BIN` | A `cns` executable to run the daemon instead of the package's own. |

```sh
export CNS_LISTEN=1 CNS_BIND=100.64.0.7 CNS_PORT=47381   # every Pi session listens on this VPN address
```

Flags do the same for one run of Pi: `--cns-listen`; `--cns-attach HOST`, with `--cns-cwd DIRECTORY`; and `--cns-bin PATH`.

## Behaviour

- **No fallback to Pi's machine.** When the host's connection breaks, every tool call and `!` command fails until `/cns attach` or `/cns detach`. So does a failed `--cns-attach` at startup.
- **Sessions remember their host.** A resumed, forked or reloaded session attaches to its host again. It checks by hostname that the host is still the same machine; if not, nothing runs until you choose.
- **One daemon per machine.** Every Pi session and `cns attach` console share it (`~/.cns/daemon.json`); concurrent starts start only one. The daemon keeps running after Pi exits, until `/cns stop` or `cns stop`. A daemon already running with other settings is used as it is, with a note.
- **Bun settings stay out of the daemon.** Bun runs the bundled cns without reading a `.env` or `bunfig.toml` from the directory Pi runs in.

The tools keep Pi's behaviour, with these differences on a host:

- `grep` runs the host's ripgrep with the arguments Pi uses, and fails if the host has no `rg`.
- `find` skips `node_modules` and `.git` instead of following `.gitignore`, as Pi does whenever `find` uses custom operations.
- `read` and `edit` read files of up to 32 MiB, and `write` and `edit` write up to 4 MiB, in place. The edit preview is not shown before an edit runs; its result shows the diff.
- `bash` keeps a long command's full output on Pi's machine, and `read` opens that file there. Commands longer than 8,192 characters are uploaded to `~/.cns/scripts`, readable only by the host's user, and remove themselves as they start.

## Requirements and limits

- Pi 1.4, on macOS or Linux (glibc or musl), x64 or arm64. Hosts must be Linux or macOS. Pi on Windows cannot attach, and is otherwise untested.
- On an x64 CPU without AVX2, the bundled Bun does not run: set `CNS_BIN` to a `cns` built for a `baseline` target.
- Pi uses the first extension's tool of each name, so cns refuses to attach when another extension that provides these tools, such as pi-remote, loads before it. `!` commands go to whichever extension claims them first.

## Security

The listener has **no authentication**. By default it listens on every interface, so anyone who can reach its port can run commands and read and write files on Pi's machine as you. Set `CNS_BIND=127.0.0.1`, or listen only on a trusted LAN or VPN address. Pi's own connections to listeners are one-way: a listener Pi attaches to cannot run commands on Pi's machine.
