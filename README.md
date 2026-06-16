# llmux

**Interact with running AI agent CLI sessions** — a tmux-based session manager that
dispatches prompts to live, interactive agent CLIs via `tmux send-keys`.

llmux is the multi-agent generalization of the `ccmux` pattern. Spawn `claude`,
`agy`, `codex`, `qwen`, `opencode`, `grok`, `aider`, `goose`, and `gh copilot`
as named tmux sessions, fire prompts at them from anywhere over a small REST API,
attach a browser terminal when you want to look in.

> Status: **scaffold** — Phase 1 in progress. See [CHANGELOG.md](./CHANGELOG.md).

## Two binaries

| Package | Where it runs | What it does |
|---|---|---|
| `@cordfuse/llmuxd` | The machine with tmux | Daemon: tmux session management, REST API, web terminal |
| `@cordfuse/llmux` | Anywhere | Thin HTTP client — no tmux dependency |

## Install

```bash
# On the tmux machine
npm install -g @cordfuse/llmuxd

# Anywhere (laptop, phone, etc.)
npm install -g @cordfuse/llmux
```

## Quick start

```bash
# Spawn an agent session
llmuxd spawn claude --name main --cwd ~/projects/myapp

# Send a prompt to it (fire-and-forget)
llmuxd send main "what does src/index.ts do?"

# Attach interactively (tmux switch-client if you're inside tmux, else attach)
llmuxd chat main

# Or expose web terminal — opens in any browser
llmuxd serve
```

When `llmuxd serve` boots, it prints reachable URLs (Local, LAN, Tailscale).
Open one in a browser to see the session picker, click a session for a
full-screen xterm.js terminal wired to your live tmux session over
WebSocket. Multiple browser clients can attach to the same session — tmux
handles the multiplexing.

> **Auth:** `serve` runs without authentication today (Phase 3 lands
> SAS tokens). Don't bind it to a public interface until then; bind to
> `127.0.0.1` (default) or behind Tailscale.

## Supported agents

| Session key | CLI |
|---|---|
| `claude`   | [Claude Code](https://github.com/anthropics/claude-code) |
| `agy`      | [Antigravity CLI](https://antigravity.dev) |
| `codex`    | [OpenAI Codex CLI](https://github.com/openai/codex) |
| `qwen`     | [Qwen Code](https://github.com/QwenLM/qwen-code) |
| `opencode` | [opencode](https://opencode.ai) |
| `grok`     | [Grok Build CLI](https://x.ai) |
| `aider`    | [aider](https://aider.chat) |
| `goose`    | [Goose](https://block.github.io/goose/) |
| `copilot`  | [GitHub Copilot CLI](https://github.com/github/gh-copilot) (via `gh` extension) |

Only installed agents are spawned. llmuxd uses `command -v` (and `gh extension list`
for copilot) to detect availability.

## Config (`.llmux.yaml`)

llmuxd looks for config in this order (highest priority first):

1. `--config <path>` flag
2. `./.llmux.yaml` (project-level, auto-discovered in cwd)
3. `~/.config/llmux/config.yaml` (global default)
4. `LLMUX_CONFIG=<path>` env var

All config has sensible defaults — llmuxd runs without any YAML file.

See [docs/config.md](./docs/config.md) (forthcoming) for the full schema.

## Build phases

llmux ships in phases. See the execution plan for the full breakdown.

- **Phase 1** — spawn / send / broadcast / chat / kill / status (local mode)
- **Phase 2** — `.llmux.yaml` config + `llmuxd init`
- **Phase 3** — REST API + `llmux` HTTP client + SAS tokens
- **Phase 4** — web terminal (xterm.js + node-pty + WebSocket)
- **Phase 5** — QR codes + serve UX + service templates (systemd/launchd)
- **Phase 6** — agent-initiated spawning (`LLMUX_SERVER` / `LLMUX_TOKEN` auto-inject)
- **Phase 7** — polish + npm publish

## License

MIT. See [LICENSE](./LICENSE).

---

llmux is part of the [Cordfuse](https://github.com/cordfuse) AI agent toolchain.
