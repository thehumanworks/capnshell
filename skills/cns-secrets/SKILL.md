---
name: cns-secrets
description: Give commands API keys and other credentials kept as cns mesh secrets, here or on another device, without printing their values (cns secret run, cns run --secret, cns secret list). Use when a command needs a token the user keeps in cns, when a variable such as OPENAI_API_KEY is missing, or when the user asks to set, share or rotate a secret.
---

# Mesh secrets with cns

Members of a cns mesh share secrets such as API keys. Each device keeps encrypted copies,
so they work offline. A secret is written `NAME`, or `MESH:NAME` when two meshes hold the name.

## Rules

- Never print a value. Do not run `cns secret get`, `echo $NAME`, `env` or `printenv` where
  the output reaches your transcript or logs, unless the user asks for the value itself.
- Name exactly the secrets a command needs (`--only` here, `--secret` remotely). Do not hand
  a command every secret.
- Do not put a value in a command line. `curl -H "Authorization: Bearer $TOKEN"` puts it in
  `ps` on the device; prefer programs that read the variable themselves.

## Which secrets exist

```sh
cns secret list            # MESH, NAME, READ BY, SET BY, SET (UTC): names only, never values
cns secret list --json     # [{ mesh, name, for, setBy, version, setAt }]
```

## Run a command with secrets

On this device:

```sh
cns secret run --only OPENAI_API_KEY -- 'python agent.py'
cns secret run --only home:NPM_TOKEN -- 'npm publish'
```

On another device, from here. This device opens the secrets, and the values travel beside
the command over the encrypted link, never inside it:

```sh
cns run studio -n --secret OPENAI_API_KEY -- 'python agent.py'
cns shell studio -d -s work --secret NPM_TOKEN -- 'npm publish'
```

- Single-quote the command so `$NAME` expands on the target, not in your shell.
- Each secret becomes an environment variable of its own name for that program only.
- `--secret` on `cns shell -d` applies only when the call starts the session.
- The target needs cns 2.0.0 or later. It can read whatever it is given, so pass secrets only
  to devices the user would trust with them.
- A name that two meshes hold stops the command: write `MESH:NAME`.
- Without `--only`, `cns secret run` refuses variables such as `PATH`, `NODE_OPTIONS` or
  `HTTPS_PROXY` that another device set. Use `--only` and this never comes up.

## Set or remove a secret (only when the user asks)

The value comes from a hidden prompt or from stdin, never from an argument:

```sh
cns secret set home:OPENAI_API_KEY                         # the user types it
op read op://dev/openai/key | cns secret set home:OPENAI_API_KEY
cns secret set home:DEPLOY_KEY --device ci < key.txt       # only ci and this device read it
cns secret rm home:OPENAI_API_KEY
```

Only the device that set a secret changes or removes it; elsewhere the refusal says where to
run it. A member removed from the mesh keeps the values it already read: after losing a
device, rotate the secret at its source, then set it again.
