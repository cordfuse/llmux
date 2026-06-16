# llmux

You have Claude Code in one terminal, Codex in another, aider in a third, and
opencode in a fourth. They're all live, all mid-conversation, all costing
nothing to keep open. But to fire a prompt at one of them you have to find the
right window, click in, and type. To fire the same prompt at two of them — you
just don't. And if you're on the couch with your phone? Forget it.

llmux turns every agent CLI into a named tmux session you can drive from
anywhere. Spawn `claude`, `agy`, `codex`, `qwen`, `opencode`, `grok`, `aider`,
`goose`, and `gh copilot` once. Then fire prompts at any of them — by name,
broadcast to several at once, from a REST call, a curl one-liner, or a browser
terminal on your phone over Tailscale.

The agents keep running. You stop window-hopping.

> **Status:** v0.2.1 — Phases 0, 1, and 4 shipped. Phases 2, 3, 5, 6, 7 pending.
> See [CHANGELOG.md](./CHANGELOG.md).

## Install

```bash
# On the machine with tmux + your agent CLIs
npm install -g @cordfuse/llmuxd

# Anywhere you want to send prompts from (laptop, phone, CI)
npm install -g @cordfuse/llmux
```

## 30-second quickstart

```bash
# Spawn an agent in a named tmux session
llmuxd spawn claude --name main --cwd ~/projects/myapp

# Fire a prompt at it — fire-and-forget
llmuxd send main "what does src/index.ts do?"

# Or attach interactively (switch-client if you're already in tmux)
llmuxd attach main

# Or expose a browser-terminal — opens the session in any browser
llmuxd serve
```

`llmuxd serve` prints reachable URLs (Local, LAN, Tailscale). Open one, pick a
session, and you get a full-screen xterm.js terminal wired to your live tmux
session over WebSocket. Multiple browsers can attach to the same session — tmux
handles the multiplexing. On mobile, the floating toolbar gives you arrow keys,
modifiers, and shell chars `gboard` hides.

> **Auth:** `serve` runs without authentication today. Phase 3 lands SAS tokens.
> Until then, bind to `127.0.0.1` (default) or expose only over Tailscale.

## How it works

Two packages:

| Package | Where it runs | What it does |
|---|---|---|
| `@cordfuse/llmuxd` | The machine with tmux | Daemon: session management, REST API, web terminal |
| `@cordfuse/llmux` | Anywhere | Thin HTTP client — no tmux dependency |

Each spawned agent is a real tmux session, not a wrapped PTY. llmuxd dispatches
input via `tmux send-keys` and reads output by attaching xterm.js over a
WebSocket bridge. That keeps the agent CLIs unmodified — Claude Code is still
running Claude Code; llmuxd just coordinates input and exposes the surface.

Session metadata lives at `$XDG_STATE_HOME/llmuxd/sessions.json` (default
`~/.local/state/llmuxd/sessions.json`, `0600` perms, versioned schema).
Reconciliation is on demand — sessions can die outside llmuxd, and `status`
reports live tmux state.

The daemon runs on Node (not Bun) because `node-pty`'s native prebuilds target
Node; Bun caused immediate SIGHUP on the PTY child.

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

Only installed agents are spawnable. llmuxd uses `command -v` (and
`gh extension list` for copilot) to detect availability.

## Config (`.llmux.yaml`)

llmuxd looks for config in this order (highest priority first):

1. `--config <path>` flag
2. `./.llmux.yaml` (project-level, auto-discovered in cwd)
3. `~/.config/llmux/config.yaml` (global default)
4. `LLMUX_CONFIG=<path>` env var

All config has sensible defaults — llmuxd runs without any YAML file.

See [docs/config.md](./docs/config.md) (forthcoming) for the full schema.

## Build phases

- [x] **Phase 0** — scaffold, CLI stubs *(v0.0.1)*
- [x] **Phase 1** — spawn / send / broadcast / chat / kill / status *(v0.1.0)*
- [ ] **Phase 2** — `.llmux.yaml` config + `llmuxd init`
- [ ] **Phase 3** — REST API + `llmux` HTTP client + SAS tokens
- [x] **Phase 4** — web terminal (xterm.js + node-pty + WebSocket) + mobile UX *(v0.2.0–v0.2.1)*
- [ ] **Phase 5** — QR codes + serve UX + service templates (systemd/launchd)
- [ ] **Phase 6** — agent-initiated spawning (`LLMUX_SERVER` / `LLMUX_TOKEN` auto-inject)
- [ ] **Phase 7** — polish + npm publish

## License

MIT. See [LICENSE](./LICENSE).

---

llmux is part of the [Cordfuse](https://github.com/cordfuse) AI agent toolchain.
