# llmux

You have Claude Code in one terminal, Codex in another, Aider in a third, and
OpenCode in a fourth. They're all live, all mid-conversation, all costing
nothing to keep open. But to fire a prompt at one of them you have to find the
right window, click in, and type. To do anything from your phone? Forget it.

llmux turns every agent CLI into a named tmux session you can drive from
anywhere. Spawn `claude`, `codex`, `agy`, `gemini`, `qwen`, `opencode`, `amp`,
`grok`, `aider`, `continue`, `kiro`, `cursor`, `plandex`, `goose`, or
`gh copilot` once. Then fire prompts at any of them — by name, from a CLI, from
a REST call, or from a browser on your phone over Tailscale. Past
conversations are browsable and resumable. The agents keep running.

> **Status:** v0.12.2 — daemon + CLI client consolidated into one binary
> (`llmux`). Auth, tokens, mobile picker, conversation resume, Claude Code
> history adapter shipped. See [CHANGELOG.md](./CHANGELOG.md).

<p align="center">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/sessions.jpg" width="32%" alt="mobile sessions picker — 5 agents running, respawn/edit/kill per row">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/edit.jpg" width="32%" alt="edit session form — agent, name, cwd, flags, env vars">
  <img src="https://raw.githubusercontent.com/cordfuse/llmux/main/docs/screenshots/chat.jpg" width="32%" alt="phone chat — xterm.js with soft-keyboard toolbar attached to an OpenCode session">
</p>

> Browser picker, edit form, and attached terminal — all on a phone over
> Tailscale HTTPS.

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
export LLMUX_SERVER=http://100.105.221.46:3030
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

A YAML config (project-local or global) can override per-agent defaults.
Discovery order:

1. `--config <path>` flag
2. `./.llmux.yaml` (project-local, auto-discovered in cwd)
3. `~/.config/llmux/config.yaml` (global default)
4. `LLMUX_CONFIG=<path>` env var

llmux runs without any YAML file — all defaults are baked into
`agents.ts`. The `init` command to generate a starter YAML is not yet
shipped; create one by hand if you want to override defaults today.

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
