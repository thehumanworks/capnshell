---
name: cns-remote
description: Run commands, copy files and drive terminal programs on the user's other devices with cns (cns run, cns cp, cns shell -d, cns screen, cns keys). Use when a task needs another machine, such as building or testing on another OS, reading a server's logs or using a GPU box, or when the user names one of their devices.
---

# Working on another device with cns

cns reaches the user's paired devices by name. Every command runs as the user who runs cns
on that device, within what that device grants this one.

## First look

```sh
cns peers               # NAME, STATUS (online/offline), VERSION, ACCESS, ...
cns doctor studio       # each address: ok (hostname, linux/Bash, cns 2.2.0, encrypted)
```

`ACCESS` is what this device may use there: `shell` (commands), `files` (cp, file tools),
`sessions` (named terminals), `skills`. `cns doctor DEVICE` shows the device's OS and shell.
Commands use that shell's syntax: Bash on Linux and macOS, Windows PowerShell on Windows.

## One command: cns run

```sh
cns run studio -n -- 'cd /srv/app && git status'
cns run studio -n --cwd /srv/app --timeout 600000 -- 'make test'
tar czf - src | cns run studio -- 'tar xzf - -C /srv/app'
```

- Put the whole command in single quotes after `--`, so your local shell expands nothing.
- Each call starts a fresh non-interactive shell in the remote home: `cd` and variables do not
  carry over. Use `--cwd ABSOLUTE_PATH` or `cd DIR && ...` in the same call.
- Pass `-n` unless you pipe input in. Without it, a command that reads stdin waits on yours.
- There is no deadline by default. Pass `--timeout MS` for anything that could hang (exit 124).
- stdout and stderr stream back unchanged, with no size limit, and the exit status is the
  command's. Filter big output on the device (`| tail -50` inside the quotes).

## Files: cns cp

```sh
cns cp ./build.tar.gz studio:/tmp/
cns cp studio:logs/app.log ./app.log      # relative or ~/ remote paths start at the remote home
cns cp -r ./site studio:/srv/
cns cp -r studio:~/photos nas:~/backup/   # device to device, through this one
```

`cp` needs the `files` grant on each device it uses. A destination that is a directory, or
ends in `/`, gets the source under its own name. Existing files are overwritten.

## State that persists: a shell that stays

When later commands depend on earlier ones (a virtualenv, `cd`, exported variables, a
background job), type them into one login shell that keeps running on the device:

```sh
cns shell studio -d -s work -p --cwd /srv/app -- 'source .venv/bin/activate'
cns shell studio -d -s work -p -- 'pytest -x; echo "exit=$?"'
cns kill studio work                      # when done
```

`-d` types the command and returns; `-p` (`--screen`) waits for it to end and prints what it
showed. cns exits 0 whatever the command's status, so append `echo "exit=$?"` when it matters.
`--cwd`, `--timeout` and `--secret` apply only to the first call, which starts the session.

## Interactive programs: named sessions

For REPLs, TUIs, servers and watchers:

```sh
cns shell studio --name repl -- 'python3 -q'
cns screen studio repl --until '>>>' --timeout 30000
cns keys studio repl 'print(6*7)' Enter
cns screen studio repl --until '42'
cns keys studio repl C-c
cns kill studio repl
```

- Wait with `cns screen --until TEXT`, never with `sleep`. It exits 0 when the text shows,
  1 if the program ended first and 124 on timeout, and prints the screen each time.
- `keys` takes tmux key names (`Enter`, `Tab`, `Escape`, `Up`, `C-c`, `M-x`, `F1`) and types
  other arguments as text. Put `--` before text that starts with `-`.
- `cns screen DEVICE NAME --history 200` adds scrollback.
- `cns sessions [DEVICE]` lists sessions; `--json` shows each one's `owner` fingerprint.
  Kill only sessions you started. Others may belong to the user's open terminals.
- A device holds 16 sessions. They end when killed, when their program exits or the device
  reboots; they keep running when its daemon restarts (except on Windows).

Do not run bare `cns shell DEVICE`, `cns shell --attach` or `cns ui` yourself: they are for
a person at a terminal.

## MCP tools

If your tools include cns MCP tools (from `cns mcp` or the gateway connector), they do the
same work: `list_peers`, `run_command` (120 s default deadline), `start_session`,
`send_keys`, `read_screen`, `list_sessions`, `kill_session`, and `read_file`, `write_file`,
`list_directory`, `glob`, which need the `files` grant. Pass `peer` when several are linked.
`list_skills`, `read_skill` and `search_skills` work like `cns skills` (see the cns-skills
skill). `list_secrets` and the `secrets` argument of `run_command` and `start_session` give
a program mesh secrets by name (see the cns-secrets skill). An `env` argument appears only
when the user started `cns mcp --env NAMES`, and passes those variables of the `cns mcp`
process.

## Exit statuses

| Status | Meaning |
| --- | --- |
| 0 / other | The remote command's own status (`run`) |
| 1 | cns error, or `screen --until` saw the program end |
| 3 | The device's identity changed or it no longer accepts this one: stop, see cns-troubleshoot |
| 4 | Permission denied: the message names the grant and the command to run on the device |
| 5 | `cns doctor`: no address answered |
| 124 | `--timeout` passed |
| 141 | The local reader closed early, as with `| head` |

For a denial (4), tell the user the command the message names; see cns-access. For a
device that is offline, slow or refusing, see cns-troubleshoot. For API keys, see
cns-secrets.
