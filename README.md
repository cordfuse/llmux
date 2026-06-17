# llmux

[![npm version](https://img.shields.io/npm/v/@cordfuse/llmux.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@cordfuse/llmux)
[![npm downloads](https://img.shields.io/npm/dm/@cordfuse/llmux.svg?label=downloads)](https://www.npmjs.com/package/@cordfuse/llmux)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@cordfuse/llmux.svg?label=node)](./packages/llmux/package.json)

## Problem

You're running Claude Code, Codex, Gemini, OpenCode, and a handful of
other agent CLIs at the same time. Each lives in its own terminal. You
can SSH and `tmux attach`; Claude has cowork and remote-control — but
each agent is on its own terms, and the surface differs per CLI. There's
no unified, addressable layer a spec-driven development pipeline, a
scheduled job, or a multi-agent chain can talk to that treats every
agent CLI the same way.

## Solution

llmux is that layer. One daemon, each agent CLI in its own named tmux
session, every session reachable by name from a CLI, a REST/WebSocket
API, or a browser picker reachable over Tailscale HTTPS.
SDD pipelines, multi-agent chains, scheduled jobs, and evals all reduce
to plain `llmux session prompt <name> "..."` calls — the same surface
drives the human terminal and the script.

Each spawn is its own named tmux session — own cwd, own flags, own
conversation. Run three `claude` sessions across three different repos
side-by-side, or one each of `claude` / `codex` / `gemini`, or fifteen
of each — there's no per-agent cap and no shared state.

First-run OAuth on a headless box works by attaching from a phone (or
any browser), clicking through the flow there, and detaching. Same
trick for token refresh.

(The sessions are real tmux. If you already have an SSH + tmux flow you
like, `tmux attach -t <name>` still works exactly as you'd expect —
llmux just adds the unified surface on top.)

> **Status:** v0.18.2 — daemon + CLI client consolidated into one binary
> (`llmux`). Auth, tokens, mobile picker, conversation resume, Claude
> Code history adapter shipped. See [CHANGELOG.md](./CHANGELOG.md).

<p align="center">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/demo/cli.gif" width="85%" alt="CLI tour — version, installed agents, session list, JSON output">
</p>

<p align="center"><em>CLI tour against a live daemon — version, agent catalog, session list, JSON surface, then a real tmux attach into a running Codex session and a clean detach.</em></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/demo/mobile.gif" width="30%" alt="Mobile PWA picker, attach into an opencode session, soft-keyboard toolbar visible">
</p>

<p align="center"><em>Phone — picker → tap session → attached xterm with soft-keyboard toolbar (Esc / Tab / Ctrl / arrows / shell chars). Blue rings mark each tap. Pixel 7 emulation.</em></p>

### One persistent process per agent

Each `llmux session start <agent>` launches the agent's interactive TUI
inside a named tmux session and keeps it running. Tool state,
conversation, `/commands`, and MCP context all persist across prompts
and across clients. Spawn once, send keystrokes from a CLI, a REST call,
a WebSocket attach, or the browser picker — the live process is the
source of truth and every client sees the same state.

### Mobile, by design

The web picker is reachable over Tailscale HTTPS from any browser.
Open it from your phone — including over LTE — and you get the same
xterm.js terminal a desktop browser shows, with a soft-keyboard toolbar
that surfaces the chars gboard hides (Esc / Tab / Ctrl / arrows /
shell chars). Chrome's "Add to Home Screen" creates a quick-launch
shortcut for it.

A consequence: **first-run OAuth on a headless box just works.** Spawn
an agent on a browserless server, attach from your phone, click through
the browser OAuth flow there, detach. The session stays authed for
re-attaches forever.

### One addressable surface, many use cases

Because each session is reachable by name from any client, llmux is the
substrate higher-level patterns sit on — spec-driven development (SDD)
pipelines, multi-agent chains, scheduled jobs, evals harnessed against
live agents.

## Install

```bash
# One package, one binary — installs on the daemon host AND any client machine
npm install -g @cordfuse/llmux
```

If you used the now-deprecated `@cordfuse/llmuxd` package: uninstall it and
install `@cordfuse/llmux` instead. The `llmuxd` binary is gone; the `llmux`
binary covers both daemon and client roles.

## 30-second quickstart

```bash
# 1. Start the daemon (binds REST + WebSocket + browser picker)
llmux server start --port 3030

# 2. Spawn an agent into a named tmux session
llmux session start claude --name main --cwd ~/projects/myapp

# 3. Fire a prompt — fire-and-forget
llmux session prompt main "what does src/index.ts do?"

# 4. Or attach interactively (raw TTY pass-through)
llmux session attach main

# 5. Or open the browser picker (URL is in the server start banner)
#    Pick a session, get a full-screen xterm.js terminal wired over WebSocket.
```

On mobile the picker is a real PWA-style surface — spawn / restart / kill /
edit / resume past conversations, with a confirmation modal on destructive
actions. The chat page is a phone-friendly xterm with a custom soft-keyboard
toolbar that surfaces Esc / Tab / Ctrl / Alt / arrows / shell chars that
gboard hides.

## Remote operation

The same binary is the client. Set `--server` (or `LLMUX_SERVER` env) on any
session/agent verb and it routes over HTTP instead of operating locally:

```bash
export LLMUX_SERVER=http://192.0.2.10:3030  # or https://<host>.tailnet.ts.net
export LLMUX_TOKEN=sas_…                    # mint with `llmux token create`

llmux session list
llmux session prompt main "tomorrow's plan?"
llmux session attach main                   # raw TTY pass-through over WS
llmux session resume main --latest          # rebind to the most recent claude convo
```

Localhost requests bypass auth; remote requests require a Bearer token.
`--token <sas>` per-command works too.

## Noun-prefix surface

```
session   list / start / stop / restart / attach / prompt / broadcast
          / resume / history
server    start
token     create / list / revoke
agent     list  [--all] [--installed] [--json]
```

Global flags: `--server <url>`, `--token <sas>`, `--help`, `--version`.

Backward-compat shims (kept one release): `llmux serve`, `llmux ls`,
`llmux status`, and the legacy flat verbs (`llmux send`, `llmux spawn`,
`llmux kill`, etc.) still work; they fall through to the noun-prefix
dispatcher.

## How it works

Each spawned agent is a real tmux session, not a wrapped PTY. The daemon
dispatches input via `tmux send-keys` and exposes the surface over a REST API
plus a WebSocket bridge to xterm.js (via node-pty attached to
`tmux attach -t <name>`). That keeps the agent CLIs unmodified — Claude Code
is still running Claude Code; llmux just coordinates input and exposes the
surface.

State lives at `~/.local/state/llmuxd/sessions.json` (or
`$XDG_STATE_HOME/llmuxd/sessions.json`) with `0600` perms and a versioned
schema. Auth tokens live in the sibling `auth.json`. The state directory keeps
its `llmuxd/` name across the v0.12.0 package consolidation so existing
operators don't need to migrate anything.

The daemon runs on Node (not Bun) — `node-pty`'s native prebuilds target
Node, and attaching to tmux through node-pty under Bun caused immediate SIGHUP.

## Supported agents

| Key | CLI | Danger-mode default |
|---|---|---|
| `claude`   | [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) | `--dangerously-skip-permissions` |
| `codex`    | [OpenAI Codex CLI](https://github.com/openai/codex) | `--dangerously-bypass-approvals-and-sandbox` |
| `agy`      | [Antigravity CLI](https://antigravity.google) | `--dangerously-skip-permissions` |
| `gemini`   | [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `--yolo` |
| `qwen`     | [Qwen Code](https://github.com/QwenLM/qwen-code) | `--yolo` |
| `opencode` | [OpenCode](https://opencode.ai) | env: `OPENCODE_YOLO=1` (TUI lacks a flag) |
| `amp`      | [Sourcegraph Amp](https://ampcode.com) | `--dangerously-allow-all` |
| `grok`     | [Grok Build CLI](https://x.ai/cli) | `--always-approve` |
| `aider`    | [Aider](https://aider.chat) | `--yes-always` |
| `continue` | [Continue CLI](https://docs.continue.dev/guides/cli) (`cn`) | `--auto` |
| `kiro`     | [Kiro CLI](https://kiro.dev/cli/) | `--trust-all-tools` |
| `cursor`   | [Cursor CLI](https://cursor.com/docs/cli/installation) (`cursor-agent`) | (config-based) |
| `plandex`  | [Plandex](https://plandex.ai) | (interactive `set-auto`) |
| `goose`    | [Goose](https://block.github.io/goose) | env: `GOOSE_MODE=auto` |
| `copilot`  | [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/use-copilot-in-the-cli) (`gh copilot`) | n/a |

Only installed agents appear in `llmux agent list` and the picker dropdown.
Detection uses a pure-Node PATH walk for most; `copilot` checks the gh-managed
binary directory.

Per-session overrides via `llmux session start <agent>`:
- `--name <X>` — tmux session name (defaults to the agent key)
- `--cwd <path>` — working directory (accepts `~/…` shorthand)
- `--flags "<f>"` — replace the agent's default flags entirely
- `--env "KEY=VAL"` — extra env vars (newline-separated for multiple)

Editing any of these on a running session via the web picker auto-respawns
the tmux session so changes take effect immediately.

## Conversation resume

For agents with a history adapter (Claude Code today; codex/gemini/etc.
coming), the row gets a `☰ N` button. Tap it to see past conversations in the
session's cwd; pick one to relaunch the agent with its `--resume <id>` flag.
State preserves the binding across restarts so respawn keeps you on the
same conversation. Use `llmux session resume <name> --latest` from the CLI
for the same flow.

## Auth

`llmux server start` runs without auth until you create a token:

```bash
llmux token create --name phone
# prints sas_…<43-char-base64url> once; copy it.
# pass --qr-endpoint tailscale-https for a QR-code deep-link that logs you
# in on first scan from a phone.

llmux token list
llmux token revoke <8-char-id>
```

After the first token exists, all non-localhost HTTP/WS requests require
either `Authorization: Bearer <sas>` (CLI / curl) or the `llmuxd_token`
cookie set by the browser gate. Localhost stays open so local CLI use needs
no token.

## Tailscale serve fronting

To reach llmux's web picker from another tailnet device (phone, laptop, …)
over HTTPS, front the daemon with `tailscale serve`. Tailscale terminates
TLS at the tailnet edge; llmux stays plain HTTP behind it.

**Why a custom port, not 443?** Tailscale serve allows exactly one mapping
per `host:port`. If you run more than one Cordfuse PWA on the same machine
(llmux + vyzr + …), they can't all claim port 443 — adding a second app on
443 silently kicks the first one off. The Cordfuse convention is to give
each PWA its own custom HTTP/HTTPS port pair so they coexist without
collision. **llmux's convention is `3080` (HTTP) / `3443` (HTTPS).**

```bash
tailscale serve --bg --https=3443 http://localhost:3030
tailscale serve --bg --http=3080  http://localhost:3030
```

The server-start banner picks up the mapping automatically (any port, not
just 3443/3080) and surfaces the resulting URLs:

```
llmux v0.16.x

  ▸ Tailscale HTTPS  https://<host>.tailnet.ts.net:3443
  ▸ Tailscale HTTP   http://<host>.tailnet.ts.net:3080
  ▸ Local            http://localhost:3030
  ▸ LAN              http://192.168.x.x:3030
```

The browser picker is a clean TLS surface — open it in Chrome / Safari
on any tailnet device. CLI `attach` currently speaks `ws://` only —
point it at the LAN or local HTTP URL.

**Cordfuse port conventions** (each app fronted on its own pair so
multiple tools can share one tailnet host):

| App | HTTP port | HTTPS port |
|---|---|---|
| llmux | `3080` | `3443` |
| vyzr  | `4080` | `4443` |

(Pick non-overlapping ports for any additional Cordfuse PWA you front.)

## Config (`.llmux.yaml`)

Optional YAML config file. llmux runs without it — defaults are baked into
`agents.ts`. Use the YAML to override per-agent launch behavior or change
the daemon's default port without baking a flag into every shell alias.

### Discovery order (first hit wins)

1. `--config <path>` flag
2. `./.llmux.yaml` — auto-discovered in the cwd you invoke from
3. `~/.config/llmux/config.yaml` — global default
4. `LLMUX_CONFIG=<path>` env var

### Schema

```yaml
# Server defaults — used when `llmux server start` runs with no overriding
# flag / env. Precedence: --port flag > LLMUXD_PORT env > server.port here.
server:
  port: 3030          # daemon listen port (default 3000 when key omitted)

# Per-agent overrides. Key matches the agent's `key` in the catalog
# (claude, codex, agy, gemini, qwen, opencode, amp, grok, aider, continue,
# kiro, cursor, plandex, goose, copilot). Only the keys you list override;
# everything else falls through to the catalog default.
agents:
  claude:
    cmd: claude       # binary path or PATH-lookup name (default: agent's catalog cmd)
    flags: ""         # launch flags appended after cmd (default: catalog default,
                      # e.g. "--dangerously-skip-permissions" for claude).
                      # Empty string disables the default flags entirely.
  codex:
    flags: "--model gpt-5"  # keep `codex` as the binary, override flags
```

### Worked examples

**Strip danger-mode flags from claude on a shared machine:**

```yaml
agents:
  claude:
    flags: ""        # claude launches with no flags — full permission prompts
```

**Point gemini at a wrapper script (logging, rate-limiting, whatever):**

```yaml
agents:
  gemini:
    cmd: /usr/local/bin/gemini-wrapped
```

**Run the daemon on a non-default port project-wide:**

```yaml
server:
  port: 8080
```

A bare `llmux server start` from any cwd containing this file binds to
`:8080`. `--port 3030` still wins per-invocation.

### What this YAML does NOT do today

The schema includes `agents.<key>.readyPrompt`, `server.token`,
`server.tokenExpiry`, `server.noQr`, and `sessions[]` (auto-spawn list).
These are reserved for future wiring — setting them has no effect in
v0.13.x. If you need any of these surfaces, file an issue and they can be
prioritised.

## Environment

| Variable | Purpose |
|---|---|
| `LLMUX_SERVER` | Default `--server` URL for session/agent verbs |
| `LLMUX_TOKEN`  | Default `--token` SAS auth |
| `LLMUX_PORT`   | Default port resolution for QR-endpoint helpers |
| `XDG_STATE_HOME` | Override for the state directory parent |
| `OPENCODE_YOLO`, `GOOSE_MODE`, … | Forwarded by `envDefaults` per-agent |

## License

MIT. See [LICENSE](./LICENSE).

---

llmux is part of the [Cordfuse](https://github.com/cordfuse) AI agent toolchain.
