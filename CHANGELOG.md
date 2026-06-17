# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.3] — 2026-06-16

### Documentation

- Tighter README opener — dropped the "you have N terminals" narrative
  set-up and the agent-name laundry list (already in the catalog table
  later). Lead now states what llmux is in two sentences.
- Screenshot caption now surfaces `llmux session attach` as the parallel
  to the browser surface, so terminal-first readers see the path that
  fits their workflow without scrolling.
- Scrubbed a leaked tailnet IP in the remote-operation example. Replaced
  with `192.0.2.10` (RFC 5737 TEST-NET-1, reserved for documentation —
  unambiguously a placeholder) plus a `<host>.tailnet.ts.net` HTTPS
  alternative.

## [0.12.2] — 2026-06-16

### Documentation

- README hero strip: three real phone screenshots of the mobile picker, edit
  form, and attached xterm chat — taken on Android over the Tailscale HTTPS
  frontend. Shows what the surface actually looks like instead of asking
  readers to imagine it. Files live at `docs/screenshots/{sessions,edit,
  chat}.jpg`; embedded via absolute `raw.githubusercontent.com` URLs so the
  npm README page renders the same as GitHub. Status callout bumped to
  v0.12.2.

## [0.12.1] — 2026-06-16

### Documentation

- Full README rewrite to match the consolidated single-package, noun-prefix
  surface (`@cordfuse/llmux`, one binary, `llmux session …` / `llmux server
  …` / `llmux token …` / `llmux agent …`). 15-agent catalog table refreshed
  with danger-mode flags. Remote-mode (`--server` / `LLMUX_SERVER`) and
  Tailscale-HTTPS sections added. Phase status block dropped.
- CHANGELOG backfilled with every release between 0.3.0 and 0.12.0 (entries
  had stalled at 0.2.14, leaving 50+ versions undocumented).
- Operator-visible strings scrubbed of `llmuxd` references: daemon banner,
  footer, picker empty-state hint, chat page title, gate page strings, auth
  banner, and error/help text in `cli.ts`, `handlers.ts`, and `client.ts`.
  Cookie name (`llmuxd_token`), state directory path (`~/.local/state/
  llmuxd/`), and a single historical breadcrumb in `index.ts` help text
  intentionally preserved for backward compatibility.

## [0.12.0] — 2026-06-16

### Changed — **package consolidation**

- **Single package, single binary, noun-prefix CLI.** Daemon + client merged
  into one `@cordfuse/llmux` package shipping one bin (`llmux`). The
  `@cordfuse/llmuxd` package and the `llmuxd` binary are gone; `npm deprecate`
  marks every published `llmuxd` version with a tombstone pointing at
  `@cordfuse/llmux`. Code lives under
  `packages/llmux/src/{daemon,client,shared}/`.
- **Noun-prefix CLI surface.** `llmux session list/start/stop/restart/attach/
  prompt/broadcast/resume/history`, `llmux server start`,
  `llmux token create/list/revoke`, `llmux agent list`. Backward-compat shims
  (`llmux serve`, `llmux ls`, `llmux status`, and the flat verb fallthrough)
  kept one release.
- **`--server <url>` flag** per-command routes session/agent verbs over HTTP
  to a remote daemon. `LLMUX_SERVER`/`LLMUX_TOKEN` env vars work as
  fallbacks. No environment-mode-switching — you can mix local and remote
  invocations from the same shell.

### Fixed

- `handleRespawn` now kills the running tmux session first if alive (matches
  the web API's `respawnSession` behavior so `session restart` works whether
  the row is running or exited).
- `handleTokenRevoke` accepts the id at `positional[0]` (new dispatcher) OR
  `positional[1]` (legacy `token revoke <id>` form).
- Daemon banner reads version from `@cordfuse/llmux` package.json.

## [0.11.0] — 2026-06-16

### Added — **headless CLI client**

- Complete `llmux` client implementation. Commands: `ls`/`status`, `send`,
  `spawn`, `kill`, `restart`, `resume`, `conversations`, `agents`, `attach`.
  All accept `--json` for scripting. Bearer auth via `LLMUX_TOKEN` env, base
  URL via `LLMUX_SERVER`.
- New `POST /api/sessions/:name/send` server endpoint — body
  `{prompt, enter?}`. Routes through `tmux.sendKeys`. 404 on unknown name,
  409 if tmux session isn't running.
- `llmux attach` — raw-TTY WebSocket pass-through. Ctrl+] to detach.
  SIGWINCH forwards window resize. Hand-rolled WS client (no `ws` runtime
  dep on the client side); ws:// only, wss:// not yet supported.

### Notes

- `broadcast` deferred until needed.

## [0.10.5] — 2026-06-16

### Changed

- UI transitions across modals + form + buttons. Modals fade in/out with
  150–220ms easing; form drawer slides via `max-height`; row buttons get a
  subtle scale-pulse on `:active` (the missing `:hover` on mobile).

## [0.10.4] — 2026-06-16

### Fixed

- Mobile row actions no longer overflow the viewport on rows with 4 buttons
  (resume + restart + edit + kill). Body padding tightened, action button
  min-width 32→28px, name-block clamped to 42vw; `overflow-x:hidden` as a
  safety net.

## [0.10.3] — 2026-06-16

### Fixed

- Kill icon vertical alignment: `×` (U+00D7 multiplication sign) sits high
  in most monospace fonts; swapped to `✕` (U+2715) — the conventional close
  glyph that centers properly. All action icons share a single
  `vertical-align:middle` rule.

## [0.10.2] — 2026-06-16

### Fixed

- Conversations modal: tapping a conversation now dismisses the picker
  before showing the confirm dialog. `#confirm-modal` z-index bumped to 60
  so it never renders behind another overlay.
- "close" → "cancel" on the conversations picker for clearer affordance.

## [0.10.1] — 2026-06-16

### Changed

- Resume button glyph 📜 → ☰ (monochrome, matches the other action icons).
  Placed before respawn/restart in the row.

## [0.10.0] — 2026-06-16

### Added — **session resume**

- `AgentDefinition.history?: AgentHistoryAdapter` with
  `listConversations(cwd)` + `resumeFlag(id)`.
- **Claude Code history adapter** — reads
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; titles parsed from the
  first real user message; conversations sorted newest-first.
- `SessionState.resumeFrom?` — persisted; respawn honors the binding.
- `SessionView` adds `hasHistory`, `conversationCount`, `resumeFrom`.
- API: `GET /api/sessions/:name/conversations`,
  `POST /api/sessions/:name/resume` body `{conversationId}`.
- Picker UI: `📜 N` row button (later `☰ N`); bottom-sheet modal listing
  conversations newest-first; tap to confirm + relaunch with `--resume <id>`.
- `buildAgentCommand(agent, flagsOverride?, resumeFrom?)` — single source of
  truth for the launch command.

## [0.9.3] — 2026-06-16

### Fixed

- Editing cwd on a running session auto kills + respawns it so the new
  working directory takes effect immediately (was: silently persisted
  metadata, no behavior change until manual respawn).

## [0.9.2] — 2026-06-16

### Fixed

- OpenCode default model flag cleared. Earlier `-m ollama/qwen2.5-coder:14b`
  override forced a slow CPU-bound path on operators with OpenRouter or
  Anthropic configured. OpenCode now honours its own
  `~/.config/opencode/opencode.json` default.

## [0.9.1] — 2026-06-16

### Changed

- OpenCode default `-m ollama/qwen2.5-coder:14b` (later reverted in 0.9.2).

## [0.9.0] — 2026-06-16

### Added — **per-session env vars**

- `SessionState.env?: Record<string, string>` + `AgentDefinition.envDefaults`.
- `parseEnvText` / `serializeEnv` helpers (KEY=VALUE lines, `#` comments,
  blanks ignored).
- Spawn merge order: `agent.envDefaults < session.env < LLMUX_*` (internals
  always win).
- Spawn/edit form: new env textarea below flags. Pre-fills with the agent's
  defaults on `+ new` and on agent-change; pre-fills with the session's
  persisted override on edit.
- OpenCode: `envDefaults: { OPENCODE_YOLO: '1' }` (TUI rejects the
  `--dangerously-skip-permissions` flag).
- Goose: `envDefaults: { GOOSE_MODE: 'auto' }`.

## [0.8.6] — 2026-06-16

### Fixed

- OpenCode flags cleared — `--dangerously-skip-permissions` is on
  `opencode run` (one-shot), not the default TUI; passing it made opencode
  print help and exit.

## [0.8.5] — 2026-06-16

### Added

- Agent help modal: `?` icon next to the AGENT label in the spawn form opens
  a modal listing all 15 supported agents with installed/not-installed badges,
  one-liner install commands, and docs links.
- `AgentDefinition.installHint` + `docsUrl` fields. New `GET /api/agents/all`
  endpoint returns the full catalog (not filtered by `isAgentInstalled`).

## [0.8.4] — 2026-06-16

### Changed

- Picker header `llmuxd — sessions` → `LLMUX: Sessions` (matches chat top
  navbar branding).

## [0.8.3] — 2026-06-16

### Added

- Confirmation modal before kill/remove. Different copy for running
  ("terminate the agent process — cannot be undone") vs exited
  ("just removes the state record").

## [0.8.2] — 2026-06-16

### Fixed

- `~` in cwd is now expanded before existsSync check. Spawn from the form
  with `cwd=~/Repos` now resolves to `/home/<user>/Repos` instead of erroring
  "cwd does not exist".

## [0.8.1] — 2026-06-16

### Changed

- Row action buttons collapse to icons on mobile (<600px). Tab-index +
  aria-label so the action surface stays accessible; long-press surfaces
  the `title=` for label discovery.

## [0.8.0] — 2026-06-16

### Added — **agent catalog expansion**

- Five new CLI agents: `amp`, `continue` (`cn`), `kiro` (`kiro-cli`),
  `cursor` (`cursor-agent`), `plandex` — with per-agent danger-mode flags
  verified via local `--help` or web search.
- Copilot detection updated for the gh 2.92+ built-in (was checking the
  deprecated `gh extension list`).

## [0.7.4] — 2026-06-16

### Fixed

- Canonical danger-mode flags per agent: `codex` →
  `--dangerously-bypass-approvals-and-sandbox`; `opencode` →
  `--dangerously-skip-permissions`; `grok` → `--always-approve`; `aider`
  combines `--yes-always` with the existing model flag.

## [0.7.3] — 2026-06-16

### Changed

- Flags input is the canonical value. Pre-fills with the agent default on
  new + on agent change; pre-fills with the session's override (or default)
  on edit. Clear to spawn with no flags.

## [0.7.2] — 2026-06-16

### Added

- Restart/respawn button always visible on every row. Running sessions get
  `↻ restart` (kills + respawns with persisted config); exited get
  `↻ respawn`.

## [0.7.1] — 2026-06-16

### Changed

- gemini + qwen `envDefault` flag: `''` → `--yolo`.

## [0.7.0] — 2026-06-16

### Added — **flags override per session**

- `SessionState.flags?: string` (override) + `defaultFlags` exposed in
  `SessionView`. Spawn/edit form gets a `flags` text input pre-filled from
  the agent default.

## [0.6.1] — 2026-06-16

### Changed

- Picker cwd column truncated with `~` shorthand + left-side ellipsis
  (`direction:rtl` trick). `title=` carries the full path.

## [0.6.0] — 2026-06-16

### Added

- Row edit button (`✎`) — opens the spawn form pre-filled, dispatches to
  `PATCH /api/sessions/:name`. Agent is read-only on edit. Live tmux rename
  via `tmux rename-session -t`.
- `AgentDefinition.displayName` field — picker dropdown renders human-readable
  names ("Claude Code") instead of bare keys.

## [0.5.2] — 2026-06-16

### Fixed

- Picker footer reflects actual `authStore.authEnabled()` state instead of
  the hardcoded "no auth" warning.

## [0.5.1] — 2026-06-16

### Changed

- DEFAULT_AGENTS order: claude / codex / agy / gemini / qwen / opencode
  (canonical 6 first).

## [0.5.0] — 2026-06-16

### Added — **spawn-from-web**

- `GET /api/agents` returns installed list. `POST /api/sessions` accepts
  `{agent, name?, cwd?}` body. Picker gets `+ new session` button → inline
  form (agent dropdown, name input, cwd input). Picker is now fully
  self-sufficient for session lifecycle.

## [0.4.3] — 2026-06-16

### Fixed

- `?token=` in URL is canonical for the request — invalid query token
  clears the cookie + serves the gate. Prevents stale-cookie masquerade.

## [0.4.2] — 2026-06-16

### Added

- `llmuxd token create --qr [--qr-endpoint <selector>]` — QR-code deep-link
  for one-tap phone login. Interactive picker selects which endpoint URL to
  encode; non-interactive form via label (`tailscale-https`, `local`, …).
- Server endpoint accepts `?token=` on any HTML route. Valid → 302 +
  Set-Cookie + clean redirect. Invalid → 401 gate.
- Tailscale endpoint slot consolidation: one HTTP-tailscale row (hostname
  via `tailscale serve` when configured, else IP+port direct).

## [0.4.1] — 2026-06-16

### Added

- Banner surfaces `tailscale serve --http=80` URL too (had only `--https`).

## [0.4.0] — 2026-06-16

### Added — **SAS-token auth**

- `llmuxd token create --name <X> --expiry <ISO>` mints
  `sas_<43-char-base64url>`. Stored at `~/.local/state/llmuxd/auth.json`
  (0600).
- HTTP middleware enforces Bearer header or `llmuxd_token` cookie. WS
  upgrade also accepts `?token=` query. Localhost (`127.0.0.1`/`::1`) always
  bypasses.
- Unauthorized HTML requests get an LLMUX-branded gate page; API requests
  get 401 JSON.
- `/health` JSON gains `authEnabled` field.

## [0.3.4] — 2026-06-16

### Added

- CLI `--version` / `--help` read from package.json (was hardcoded
  `VERSION='0.0.0'`).
- Inline-SVG favicon on picker + chat pages.
- Picker rows sort by `createdAt` desc + show `started Xm ago`.
- Chat page: "Reset terminal" action button in the All Keys overlay.
- Banner: surfaces `tailscale serve --https=443` URL when configured.
- Banner: label column width computed from the widest label.

## [0.3.3] — 2026-06-16

### Fixed

- Visible bottom padding below row 2 of the keyboard bar. `--bar-h` 74 → 92px
  portrait, 54 → 64px landscape.

## [0.3.2] — 2026-06-16

### Added

- `LLMUX` brand label in chat top navbar.

## [0.3.1] — 2026-06-16

### Added — **chat top navbar**

- Back / status dot / session name / version split out of the bottom toolbar
  into a fixed top navbar. Bottom bar is now keyboard-only.

## [0.3.0] — 2026-06-16

### Added — **iron-clad picker + chat**

- Picker auto-polls `/api/sessions` every 3s (paused when tab hidden). Per-row
  `↻ respawn` + `× kill/remove` actions. Mobile-responsive (cwd collapses
  under name).
- Chat: WS reconnect with exponential backoff. `4040` close code distinguishes
  pty-exit from transient drops; pty-exit shows "session ended" overlay with
  respawn CTA.
- Dead-session page at `/session/<name>` when state has the record but tmux
  doesn't. Respawn / remove buttons.
- API: `POST /api/sessions/:name/respawn`, `POST /api/sessions/:name/kill`,
  `GET /api/sessions`, `GET /api/version`.
- `llmuxd respawn <session>` command actually implemented (was
  `notImplemented`).

## [0.2.14] — 2026-06-16

### Changed

- Shift button moved from row 2 to row 1, leftmost position next to
  cursor-movement keys it chords with most often.

## [0.2.13] — 2026-06-16

### Fixed

- WebSocket auto-reconnects on return from background (Android Chrome
  closes idle backgrounded sockets without firing `onclose`).

### Changed

- Shift modifier renders as text `Shift` instead of `⇧`.

## [0.2.12] — 2026-06-16

### Changed

- Toolbar polish: vertical padding around rows, Tab as text, filled-triangle
  arrows, Home/End added to top row.

## [0.2.11] — 2026-06-16

### Changed

- Toolbar is two rows: arrows on top, chrome + modifiers on bottom.

### Fixed

- Android tab-switch focus loss (one-shot capture-phase `touchstart`/
  `mousedown` re-focuses xterm).

## [0.2.10] — 2026-06-16

### Changed

- Toolbar arrows reduced to `← →`; full `↑ ↓ ← →` group moves to "All keys"
  overlay.

## [0.2.9] — 2026-06-16

### Changed

- Toolbar moved to the bottom of the viewport (matches Termux/Blink
  convention). Shell chars (` ~ / \ | - _ \`) moved out of the toolbar into
  a new `SHELL` section in the "All keys" overlay.

### Fixed

- Android tab-switch dead-key bug. Banner version is real (was hardcoded
  `llmuxd v0.2.0`).

## [0.2.8] — 2026-06-16

### Changed

- Mobile "All keys" overlay breathes. Back-to-sessions glyph `←` → `⌂`.
  `llmuxd attach` is the canonical verb; `chat` deprecated.

## [0.2.7] — 2026-06-16

### Fixed

- Drop `child_process` + `shell:true` for agent PATH detection. Pure-Node
  PATH walk via `accessSync(join(dir, cmd), X_OK)`.

## [0.2.6] — 2026-06-16

### Changed

- CI debug instrumentation removed. Root cause of every prior failed
  Release: `NPM_TOKEN` repo secret was set via stdin pipe under fish shell;
  pipe arrived empty. v0.2.5 was the first successful CI publish.

## [0.2.5] — 2026-06-16

### Changed (CI debug-only)

- Release workflow has a debug job (later reverted in 0.2.6).

## [0.2.4] — 2026-06-16

### Fixed

- CI publish runs lifecycle scripts (was using `--ignore-scripts`).

## [0.2.3] — 2026-06-16

### Fixed

- Published tarballs include README + LICENSE via per-package
  `prepublishOnly` copying from repo root.

## [0.2.2] — 2026-06-16

### Changed

- README restructured problem-first. Status line corrected to
  `v0.2.2 — Phases 0/1/4 shipped`.

## [0.2.1] — 2026-06-16

### Added — Phase 4 mobile UX

- Floating top toolbar on `/session/<name>` (Esc / Tab / Ctrl / Alt / Shift
  modifiers, arrows, shell chars, `⋯ All keys`).
- Modifier toggles (tap = pending, double-tap = locked).
- "All keys" drop-down panel.
- Status indicator (single colored dot in the toolbar).
- Viewport responsiveness: `interactive-widget=resizes-content`,
  `height:100dvh`, `visualViewport.resize` → `fit.fit()`.

### Fixed

- Touch responsiveness, soft-keyboard drop, mask-image dimming, redundant
  title text.

## [0.2.0] — 2026-06-16

### Added

- Phase 4 MVP: `llmuxd serve` boots HTTP + WebSocket server. Session picker
  at `/`, xterm.js terminal at `/session/<name>`, WS bridge at `/ws/<name>`
  through node-pty.
- Network discovery banner. `/health` JSON endpoint.

### Changed

- HTTP + WS switched from `Bun.serve` to `node:http` + `ws` package
  (`node-pty` prebuilds target Node, not Bun).

## [0.1.0] — 2026-06-15

### Added — Phase 1

- Real tmux integration. `spawn`, `send`, `broadcast`, `chat`, `kill`,
  `status` drive actual tmux sessions.
- Session state file at `~/.local/state/llmuxd/sessions.json` (0600).
- `LLMUX_SESSION` env injected; `kill --cascade` walks parent → children.

## [0.0.1] — 2026-06-15

### Added

- Initial monorepo scaffold. CLI dispatchers stubbed. MIT license.
- GitHub Actions CI (typecheck + build + smoke) and tag-driven npm publish.
