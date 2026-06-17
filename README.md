# llmux

[![npm version](https://img.shields.io/npm/v/@cordfuse/llmux.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@cordfuse/llmux)
[![npm downloads](https://img.shields.io/npm/dm/@cordfuse/llmux.svg?label=downloads)](https://www.npmjs.com/package/@cordfuse/llmux)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@cordfuse/llmux.svg?label=node)](./packages/llmux/package.json)

Run every AI agent CLI under a single daemon. Each spawn is its own named
tmux session — own cwd, own flags, own conversation. Run three claude
sessions across three different repos side-by-side, or one each of claude
/ codex / gemini, or fifteen of each — there's no per-agent cap and no
shared state. Drive any of them from a terminal (`llmux session attach`),
a REST or WebSocket API, or a phone browser over Tailscale. Sessions
survive daemon restarts; attach is raw-TTY (`Ctrl+]` to detach).

### Headless ≠ `claude -p`

The obvious way to script Claude Code is `claude -p "prompt"` (and similar
non-interactive modes in codex, gemini, etc.). Each call spawns a fresh
short-lived child — no shared conversation, no in-session OAuth, no
`/commands`, no persistent tool state, no MCP context.

llmux drives the **interactive** agent process — the same TUI a human
launches — over `tmux send-keys`. Spawn `claude` once, fire prompts at the
same live agent forever from any client (CLI, REST, WebSocket, web).
The agent runs unmodified and doesn't know it's being driven headlessly.
Tool state persists across prompts. Conversations are resumable from any
client.

### OAuth from your phone, on a headless box

A consequence of driving real interactive agents: **OAuth works even when
the daemon host has no browser.** Spawn `claude` (or `codex`, `gemini`,
`agy`) on a headless server, open the picker on your phone over Tailscale
HTTPS, tap the row to attach, complete the browser OAuth flow on your
phone, detach. The session stays authed forever. Same trick for re-auth
when a token expires — phone in, click through, phone out.

That's the same surface you get for everyday driving: pick an agent on
your phone over LTE, type a prompt into a real xterm with a soft-keyboard
toolbar (Esc / Tab / Ctrl / arrows / shell chars), watch tool calls
stream in. No "mobile app" — it's the same daemon serving a real
terminal over a WebSocket.

> **Status:** v0.13.6 — daemon + CLI client consolidated into one binary
> (`llmux`). Auth, tokens, mobile picker, conversation resume, Claude Code
> history adapter shipped. See [CHANGELOG.md](./CHANGELOG.md).

<p align="center">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/sessions.jpg" width="32%" alt="mobile sessions picker — 5 agents running, respawn/edit/kill per row">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/edit.jpg" width="32%" alt="edit session form — agent, name, cwd, flags, env vars">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/chat.jpg" width="32%" alt="phone chat — xterm.js with soft-keyboard toolbar attached to an OpenCode session">
</p>

> Above: picker, edit form, and attached terminal — phone, over Tailscale
> HTTPS. The same surfaces are available from any terminal via
> **`llmux session attach <name>`** (raw TTY pass-through over WebSocket;
> Ctrl+] to detach). Pick whichever fits the task — the browser is for
> drive-by phone use, the terminal is for everything else.

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

If `tailscale serve --https=443 http://localhost:<port>` is configured on the
host, the server-start banner surfaces the HTTPS hostname URL above the
http endpoints. The browser picker is a clean TLS surface; CLI `attach`
currently speaks ws:// only.

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
