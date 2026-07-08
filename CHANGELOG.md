# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.41.0] — 2026-07-08

### Added

- **GitHub Copilot CLI is now the 7th fully-supported agent** — spawn,
  Chat GUI, conversation history/resume, and New Chat all work
  identically to the other six. The catalog previously pointed at
  `gh copilot` (a thin launcher bundled with the `gh` CLI that
  downloads and runs a *different* copy of the binary) instead of the
  real, standalone `copilot` binary (`npm install -g @github/copilot`)
  — confirmed live these are genuinely different install paths, and
  the wrong one was never going to detect a real install correctly.
  History adapter reads `~/.copilot/session-store.db` (sqlite, indexed
  by cwd — real-time updated, verified) for the picker's conversation
  list/titles/counts, and tails
  `~/.copilot/session-state/<uuid>/events.jsonl` for the live
  transcript (confirmed NOT reflected in the sqlite `turns` table
  during an active session, unlike the `sessions` table). `--yolo` is
  the danger-mode default; `--session-id`/`--resume` match Claude
  Code's pinning pattern almost exactly.

  One known limitation, documented rather than silently shipped: the
  CLI gates every spawn in a git repo with a folder-trust prompt that
  no flag suppresses. llmux pre-populates its `trustedFolders` setting
  before spawn, which reliably skips the prompt for plain directories
  but — confirmed with a controlled A/B test, not assumed — does NOT
  for git repos specifically, which is most real usage. Diffed a full
  hash tree of `~/.copilot` before/after manually answering "yes, and
  remember this folder" and found no persisted marker this could
  target instead; undocumented internal behavior in a CLI that's
  explicitly still in preview. First spawn in a given repo needs one
  manual answer via the Terminal view.

## [0.40.4] — 2026-07-08

### Fixed

- **`server start` minted a brand new, non-expiring pairing token on
  every single boot**, unconditionally. Fine for a genuine first boot;
  actively wrong for every restart after — a dev iterating on the
  daemon (or systemd/crash-restarting it in production) accumulates
  one permanent credential per restart with no cleanup, ever (this is
  where the 34 accumulated `server-start-*` tokens found live came
  from — one dev session, ~30 restarts). Root cause: token minting was
  tied to "process start," not "new device pairing intent" — those are
  very different events the code couldn't distinguish. `server start`
  now checks for an existing live (non-expired) token for the resolved
  owner first and skips minting if one exists, printing a short status
  line instead of a QR. Pairing a genuinely new device is unaffected —
  `llmux token create --qr` is a separate code path this doesn't
  touch — as is passing `--qr-name` or `--qr-expiry` explicitly, which
  signals deliberate intent to mint a specific token and bypasses the
  skip.

## [0.40.3] — 2026-07-08

### Fixed

- **The session list's `↻ <title>` "resumed from" badge could show a
  completely different conversation than the session's own Chat GUI**
  — reported live, confirmed with Playwright by comparing the two
  directly. Root cause: the badge was built from `resumeFrom` alone,
  while the Chat view resolves the current conversation via
  `externalSessionId ?? resumeFrom` (externalSessionId wins — see the
  v0.40.0 New Chat fixes for why). A session that has done New Chat
  since it was last resumed has both fields set to different
  conversations, and the badge was reading the stale one. Same
  mismatch existed in the past-conversations picker modal's
  "currently bound" highlight. Both now use the same
  `externalSessionId ?? resumeFrom` id the Chat view itself uses.

## [0.40.2] — 2026-07-08

### Fixed

- **Selecting a past conversation from a session's history could land on
  the wrong conversation** — reported live on Claude specifically,
  likely affecting any agent. The Chat view's transcript lookup prefers
  a freshly-detected New Chat id (`externalSessionId`) over the
  session's `resumeFrom`, which is correct for New Chat but meant a
  session that had EVER done New Chat kept that old id around
  afterward — so explicitly resuming a *different* past conversation
  updated `resumeFrom` correctly but the stale `externalSessionId`
  still won the lookup, silently overriding the operator's actual
  choice. Both the resume action and unrelated session edits now
  correctly drop or preserve `externalSessionId` based on whether
  `resumeFrom` is actually changing.

## [0.40.1] — 2026-07-08

### Changed

- **Removed the agent name from the Chat/Terminal topbar** — the
  session name alone is now the title; the colored agent label next
  to it (e.g. "Codex CLI", "Antigravity CLI") is gone.

### Fixed

- **Selecting a past conversation from a session's history (the ☰
  button in the session list) now takes you to that session's Chat
  view.** Previously it resumed the conversation on the backend but
  left you on the session list with just a toast — you had to notice
  the row and go find it yourself.

## [0.40.0] — 2026-07-08

### Added

- **"+ New" button in the Chat GUI's topbar (all 6 CLIs)** — starts a
  fresh conversation on the underlying agent without leaving llmux or
  dropping to the Terminal view. Confirms first, clears the composer,
  sends the agent's own new-chat command (`/clear` or `/new`,
  whichever the agent actually uses), and resets the Chat view
  immediately so there's no wait or extra step to see it worked.

### Fixed

- **New Chat could concatenate garbage into the composer** if it
  already had unsent text sitting in it (e.g. `/clearnew`, `//clear`)
  — the command is now typed into a freshly-cleared composer instead
  of on top of whatever was already there.
- **New Chat's command could silently fail to register at all** on
  real, long-running sessions — confirmed live that a too-fast
  clear→type→Enter sequence (~150-300ms gaps) could be swallowed
  entirely, the same class of ink paste-mode-debounce issue already
  known elsewhere in this codebase. Re-paced with ~1s gaps between
  steps, which resolved it reliably.
- **Chat view could keep showing the pre-New-Chat conversation
  indefinitely** on Codex, agy, and OpenCode specifically (Gemini and
  Claude were unaffected) — root-caused to four stacked bugs: a
  persist guard that discarded detection results for any session
  originally spawned via resume; a pinned-id priority order that
  preferred the session's original (and by then stale) resume id over
  the freshly detected one; an already-open Chat tab never re-reading
  session state after connecting, so even a correctly persisted id
  went unnoticed without a full page reload; and OpenCode's
  poll-only transcript branch (its SQLite store can't be tailed like a
  growing file) never had any concept of "the conversation changed" at
  all, so switching conversations just appended the new one's turns
  after the old one's instead of clearing first.
- **The real fix for the above: Chat view no longer waits on any of
  that background detection just to give visible feedback.** All four
  bugs above are legitimate fixes for background id-detection, which
  still matters for correctness on a future page reload — but
  detection itself can't even start until the operator's next real
  message on some agents, so relying on it for the *visible* reset
  meant clicking "+ New" alone changed nothing on screen. Confirmed
  with matching before/after screenshots. The button now clears the
  Chat view the moment its command send succeeds, independent of
  whenever (or whether) detection completes.
- **Fresh-session-id detection's background timeout raised from 60s to
  10 minutes** — confirmed live that a real person's pace (reading,
  composing a reply on a phone keyboard) can exceed even a generous
  60s window. Fire-and-forget either way, so there's no cost to being
  more patient.
- **Composer's squircle background/border was invisible** against the
  page's pure-black background, left fully transparent/borderless by
  an earlier styling pass. Restored a visible dark-card fill and
  subtle border, matching the tone already used for tool cards
  elsewhere in this view.

## [0.39.1] — 2026-07-07

### Added

- **Circular +/- zoom buttons in the Terminal view's key-helper bar** —
  a tap-driven alternative to pinch/trackpad-zoom, for anyone who'd
  rather not do a two-finger gesture.

### Fixed

- **Pinch-to-zoom on the Terminal view could jitter without the font
  size actually changing**, reported specifically on OpenCode's
  session. If the starting font size or touch distance was ever
  invalid, every subsequent frame computed `NaN` — and `NaN !== NaN` in
  JS defeats the "already applied" guard forever, so every touchmove
  frame re-ran the clear+redraw+resize sequence with an invalid size.
  Both the gesture-start and per-frame paths now guard against this.
- **Both pinch and trackpad-wheel zoom stayed visually garbled until a
  full browser refresh.** Every intermediate frame of a zoom gesture
  was resizing the backend pty, and the server force-redraws (Ctrl+L)
  ~100ms after each resize to fix partial-redraw TUIs — so a
  continuous gesture queued dozens of staggered redraws, most landing
  after a later resize had already superseded them. The backend is now
  only resized once a gesture actually settles (touchend for pinch; a
  150ms pause for wheel, which has no natural end event) — live visual
  feedback during the gesture is unchanged.
- **The new zoom buttons were dismissing the Android on-screen
  keyboard on tap** — they were missing the pointerdown-preventDefault
  + post-click refocus pattern every other button in the key-helper bar
  already uses to avoid stealing focus from xterm's hidden input (what
  the on-screen keyboard is actually anchored to).

## [0.39.0] — 2026-07-07

### Added — Chat GUI: a mobile-friendly second view alongside Terminal

A new `/chat/<name>` view renders a normalized, per-agent-agnostic
conversation feed (text/tool_use/tool_result turns) instead of a raw
PTY passthrough — built for checking in on a running session from a
phone without needing full terminal control.

- **Live chat-view adapters for all 6 canonical CLIs**: Claude Code,
  Codex, Gemini CLI, Antigravity CLI (agy), Qwen Code, and OpenCode.
  Each normalizes that CLI's own on-disk conversation storage (JSONL
  for most; OpenCode uses SQLite in WAL mode, which can't be
  byte-tailed like a growing text file, so it's handled with a
  poll-and-resend fallback instead) into the same turn shape, streamed
  live over SSE.
- **Pending interactive prompts now surface in chat, not just
  Terminal.** Confirmations, option lists, and slash-command menus
  never reach a CLI's structured transcript until after they're
  resolved — previously invisible in chat until the operator switched
  to Terminal to answer. Four real UI shapes are now detected directly
  off the raw pane (Gemini's `ask_user` tool and its own `/model`
  picker; agy's `/model` picker; Codex's and Claude Code's own
  `/model` pickers; OpenCode's shared "Select X" picker used by both
  `/model` and `/agent`) and rendered as tappable cards — answering
  computes the arrow-key delta and sends it through a new, narrowly
  allowlisted `POST /api/sessions/:name/key` endpoint. Every card also
  gets a Cancel button (sends Escape) regardless of shape or agent.
  OpenCode's `/model` picker can exceed one viewport with no reliable
  way to detect a scrolled slice from a complete list, so that shape
  always attaches an advisory note instead of guessing.
- Slash-command execution and other system notices (compact boundary,
  scheduled-task fire, etc.) surface as their own turns in chat for
  Claude Code, Gemini, and Qwen — the CLIs confirmed to log them at all.
- Image output (e.g. a generated picture) renders as a tappable
  thumbnail + lightbox instead of full-size inline.
- Copy buttons on message bubbles, code blocks, and tool_use/
  tool_result cards.
- Composer restyled to match chatframe's pill input, with attach/MCP/
  model-picker controls, a Stop button during inference, and bouncing
  typing-dots while an agent is working.

### Fixed

- **Claude Code chat sessions could silently render a different,
  unrelated Claude Code session's content** when two sessions shared a
  cwd — `currentTranscript`'s mtime-based file-picking had no actual
  correlation to which tmux session it was for. Fixed by generating and
  pinning a `--session-id` at spawn time (Claude Code only), persisted
  in session state and threaded through transcript lookups instead of
  guessing by file modification time.
- agy's chat view could resolve to a stale, weeks-old conversation
  instead of the live one — its `history.jsonl` cwd→conversationId join
  is unreliable for recent prompts. Now picks the globally-newest
  transcript file instead of filtering by cwd.
- The typing-dots indicator could get stuck forever (until a page
  reload) after a pending-prompt was answered — `endInference()` was
  only ever armed by real transcript turns, and a resolved prompt
  doesn't produce one.
- Removed the session-list's per-row quick-send button — redundant
  with the two existing chat modes (Terminal passthrough and the new
  Chat GUI); it served no distinct purpose.

## [0.38.0] — 2026-07-01

### Security

- **Removed a loopback-trust auth bypass.** `isAuthorized()`/`isWsAuthorized()` treated any request whose `remoteAddress` looked like `127.0.0.1` as fully authenticated. `tailscale serve` (and any local reverse proxy) connects to the daemon via loopback, so every tailnet visitor's request looked exactly like a trusted local one — confirmed exploitable: unauthenticated `GET /api/sessions`/`/api/settings` returned real data, and session-spawn/WS-attach sat behind the same bypass. Auth is now always a real v1 token or v2 session/bearer, regardless of address. Local CLI usage (no `--server`) is unaffected — it never made an HTTP request in the first place.
- **`FileTokenStore`/`FileUserStore` no longer cache JSON files in memory.** The cache meant a token minted or revoked via a separate CLI process wasn't recognized by an already-running daemon until restart — the opposite of what revocation is supposed to guarantee. `load()` now always re-reads the file.
- The browser UI now redirects to `/login` on any `401` instead of showing a silent "offline" status forever (a new, previously-unreachable failure mode created by the fix above).
- The startup banner, page footer, and `/health`'s `authEnabled` field only checked legacy v1 tokens, so a v2-only install (the current default) could falsely report "running without auth" while every route was actually gated. All three now check both v1 and v2. The banner also no longer claims "(localhost bypasses)" — that bypass is what was just removed.

### Added

- **`llmux user create/list/delete/reset-passphrase`** — the sign-in page has told locked-out operators to run `llmux user reset-passphrase <username>` since v2 auth shipped; the command never existed. There was no CLI recovery path at all for a locked-out sole admin. `delete` refuses to remove the last admin; `reset-passphrase` and `delete` both revoke the target's existing tokens.
- **`llmux logs list`/`logs tail` now work with `--server <url>`.** Previously both only read the CLI's own (always-empty, in a fresh process) in-memory buffer — silently useless against an already-running daemon, the normal deployment shape. Local mode now also detects a separately-running daemon and points at `--server` instead of printing nothing or hanging.

### Fixed

- README and a couple of in-app hints (the legacy gate page, the sign-in footer, a CLI help string) described the removed loopback bypass, or a `sudo` prefix that would silently point at the wrong `$HOME`, as current/correct behavior. Corrected.
- `llmux auth login` on a failed attempt printed the raw JSON error body instead of the parsed message.

## [0.37.0] — 2026-06-26

### Changed — tokens are now user-owned (v1 SAS tokens become read-only legacy)

The Tokens page in the web UI used to mint anonymous v1 SAS tokens
(`{ id, hash, name?, createdAt, expiresAt? }`) — anyone holding the
token got bearer-equivalent daemon access with no user attribution.
The Users page (added in v0.35.0 for v2 auth) managed a parallel
identity-bound system that the Tokens page didn't touch.

Two doors with mismatched audit characteristics. Collapsed into one:

- **Every token now has an owning `username`.** Mints route through
  the v2 `FileTokenStore`. The on-disk shape is `IdentityToken`
  (already shipped — see `v2/auth/tokens.ts`); only the call sites
  changed.
- **Web UI: Tokens page gains an Owner column and an Owner picker on
  create.** Admins see every token + can mint for any user; non-admins
  see only their own + are pinned to themselves (server rewrites the
  payload defense-in-depth, so a stale browser tab can't 403). The
  page now requires v2 login.
- **CLI: `llmux token create --username <name>` is required.** No
  default — token ownership is explicit. New `--user <name>` flag on
  `list` and `revoke --all` filters to one owner. `token rename` and
  `token revoke <id>` are unchanged at the call site (the CLI runs
  with disk access; ownership is enforced server-side, not CLI-side).
- **Boot QR pairing: now mints a v2 token for the first admin user.**
  New `--qr-owner <username>` flag overrides. If no admin exists yet
  (fresh install), the QR is skipped and the `/setup?token=…` URL
  printed by `initV2Routes` becomes the operator's only entry point.
- **`isAuthorized` (HTTP and WS) now accepts either a valid v1 SAS
  token OR a valid v2 session/identity token.** The old "no v1
  tokens = auth disabled" escape hatch is gone; after this release,
  v2 users are the canonical auth source.

### Backwards compatibility

- **Existing v1 SAS tokens continue to validate.** `validateAuthToken`
  still reads `auth.json`. Operators don't need to rotate tokens to
  keep their phones / CI / scripts working.
- **No new v1 SAS tokens can be minted.** `authStore.createAuthToken`
  has zero call sites in the codebase post-PR. The next release after
  this one will likely delete the v1 store entirely.
- **`/api/tokens` response shape changed.** GET now returns
  `{ me, tokens, users? }` (was a bare `[Token, ...]` array). POST
  accepts a new optional `username` field. Token rows include
  `username` and `lastUsedAt`.
- **`llmux token create` without `--username` now errors.** Scripts
  that minted nameless v1 tokens need the flag added; usually
  `--username <whoever-the-bot-is>` against a user you've created
  via the setup wizard or `/admin/users`.

### Removed — orch bus + Channels nav (refocus on tmux sessions)

The `llmux orch` bus, `llmux fleet` declarations, the `/orch` web page
("Channels" nav), every `/api/orch/*` endpoint, the actor/species
model, and the entire `packages/llmux/src/orch/` source tree are gone.
Net: about 2,000 lines removed.

**Why now.** The orch primitive was cherry-picked from
`@cordfuse/crosstalk`'s v7 transport in v0.35.0 (2026-06-22). A
follow-on workflow port (opened as PR #71, closed without merge on
2026-06-26) made it clear that workflows-on-orch use `claude --print`
style headless subprocess invocations — which bypass every llmux
USP (named tmux sessions, send-keys, conversation persistence, browser
attach, mobile UX). Workflows-in-llmux ran crosstalk's model inside
llmux's daemon. The same architectural mismatch applied to orch
itself: bus-style multi-agent coordination doesn't compose with a
substrate built around long-lived attached agents.

Per the "stabilise the flagship before porting to siblings" rule,
the right home for orch + workflows is `@cordfuse/crosstalk`, which
already ships them. Llmux returns to its tight original mission:
agent CLIs in named tmux sessions, addressable from CLI / REST / web
picker / phone xterm.

**What went:**

- `packages/llmux/src/orch/` — all 11 source files (acks, activation,
  actors, claims, filenames, fleet, frontmatter, init, orch, state,
  transport).
- `daemon/web/server.ts` — `handleOrchApi`, `orchPage`, the
  `/api/orch/*` dispatch block, the `/orch` route handler, the `orch`
  nav drawer item, all orch imports.
- `index.ts` — `dispatchOrch`, the `formatTo` helper, the
  `case 'orch'` in the noun dispatcher, all orch imports.
- `v2/web/layout.ts` — `orch` entry in `V2_NAV`.
- README — the entire "Orch — multi-agent message bus" section and
  the `orch` row in the noun-prefix surface table.

**What stayed:**

- Sessions / picker / xterm / init prompts / turnq / v2 auth /
  conversation resume — every USP feature, unchanged.
- The `auth` CLI surface (login / logout / whoami / list / use) — that
  came in alongside orch in v0.35.0 but is its own concern.
- Tailscale-fronting docs, port conventions, `.llmux.yaml`, runtime
  overlay file.

**Operator impact** (hard cut, no migration shim):

- Anyone using `llmux orch`, `llmux fleet`, the `/orch` page, the
  `/api/orch/*` endpoints, or the `LLMUX_ORCH_ALIAS` env var should
  move to `@cordfuse/crosstalk` — same primitive, same on-disk
  message format, fuller surface.
- Existing transport repos under `$XDG_DATA_HOME/llmux/orchestration/`
  are left on disk. Llmux no longer reads them; safe to copy/move into
  crosstalk's transport location or delete.

## [0.36.5] — 2026-06-25

### Fixed — web terminal artifacts after viewport resize / phone rotation

The previous resize handler (v0.36.4) erased scrollback but left the
visible area alone, banking on tmux's SIGWINCH-triggered redraw to
repaint. Partial-redraw TUIs (claude / codex / gemini / agy / qwen /
opencode and shells at a prompt) only re-emit cells they think changed,
so pre-resize rows persisted next to post-resize content — visible on
the phone's chat page after rotation. Two coordinated changes:

- **Web client** — on resize, also write `\x1b[2J\x1b[H` (clear viewport
  + home cursor) alongside the existing `\x1b[3J` scrollback erase, so
  the daemon's forced redraw paints onto a blank canvas.
- **Daemon WS handler** — after `term.resize(cols, rows)`, schedule a
  100ms-deferred `\x0c` (Ctrl-L) into the pty so the inner TUI redraws
  into the new geometry. 100ms lets tmux deliver SIGWINCH first.

Self-heals on next keypress without the fix — purely cosmetic — but
the rotation case was bad enough on phone.

## [0.35.0] — 2026-06-22

Major release — bundles months of branch work (v2 auth + orch bus +
MC stability) plus today's vocabulary alignment with sibling
`@cordfuse/crosstalk`. Wholly additive: no breaking changes to the
existing v1 surface; new capabilities sit alongside.

### Added — v2 auth system

App-level authentication for the daemon, mirroring the pattern that
shipped today in `@cordfuse/crosstalk`. New install gets a one-time
web setup wizard at `/setup?token=<minted>` (URL printed at boot)
that creates the first admin user. Subsequent flows:

- **Web UI** — cookie auth via `/login`; admin pages for user
  management (`/admin/users` — create / delete / toggle-admin,
  self-protected) and per-user account (`/account` — sign out + change
  passphrase).
- **CLI** — `llmux auth login` stores a bearer token at
  `~/.config/llmux/credentials.json`; subsequent CLI calls send
  `Authorization: Bearer <token>` automatically.
- **Storage** — `FileUserStore` (scrypt N=2^17 passphrase hashes) +
  `FileTokenStore` (SHA-256 hashed `sas_<id>.<secret>` form). Records
  live under `<base>/llmux-state/auth/` (mode 0600; never pushed
  upstream).
- **System mode** — daemon runs as the `llmux` service user under
  systemd; privilege-drop on boot. User mode (`LLMUX_USER_MODE=1`)
  preserves the v1 single-operator flow for solo dev / no service
  user. Daemon never touches `/home/*` in system mode.
- **Orch identity binding** — once auth is enabled, the operator's
  orch alias is the authenticated user; can't impersonate.

The v1 no-auth user-mode path is preserved — fresh installs default
to system-mode-with-auth, but existing user-mode setups continue to
work unchanged.

### Added — `llmux orch` bus (multi-agent message bus, transport-backed)

A first-class message bus for coordinating multiple agents:

- **Transport** — local-git transport cherry-picked + trimmed from
  crosstalk; supports DR-only remote sync.
- **Actor model** — actors live in the transport (`data/actors/`);
  `species: machine|human` field; default operator (human) seeded at
  init.
- **CLI verbs** — `llmux orch init`, `orch send`, `orch inbox`,
  `orch next`, `orch reply`, `orch release`, `orch status`,
  `orch backup`, `llmux fleet` (replaces the prior `examples/
  monte-carlo/run.sh` script).
- **REST API + web inbox console** — `/orch` HTML + `/api/orch/*`
  endpoints; threaded message view, alias chips, replied-set ack to
  prevent re-surfacing processed messages.
- **At-least-once cursor on inbox** — borrowed from the crosstalk
  pattern; `since=<relPath>` query param + `nextCursor` in response.

### Added — Monte Carlo stability + UI follow-ups

Fixes uncovered during repeated MC runs:

- env injection from daemon to pty spawns (so agent CLIs see
  intended `ANTHROPIC_API_KEY` etc.).
- Paste-mode submit + source-mode version + `--body` flag for
  `llmux session send`.
- Codex preSpawn (preflight check before tmux session creation).
- Orch threading correctness, channel picker UX, mobile session
  cards.

### Changed — web nav labels align with `@cordfuse/crosstalk`

- **Sessions** → **Chat**  (the interactive agent attach surface)
- **Orchestration** → **Channels**  (the message bus surface)

Label-only — CLI subcommands (`llmux session …`) and routes
(`/session/<name>`, `/orch`) unchanged. Operators of both Cordfuse
products see the same word for the same concept; scripts + API are
fully backwards-compatible.

Back-button tooltip on the live terminal page: "Back to sessions" →
"Back to chat list".

### Migration

- Fresh installs trigger the v2 setup wizard at first daemon boot.
- Existing v1 user-mode operators upgrading from 0.34.x see no
  behavior change unless `LLMUX_USER_MODE` is unset (in which case
  the daemon enters system mode + setup wizard).
- Pre-0.35.0 CLI scripts continue to work in user mode; in system
  mode they need `llmux auth login` once per OS user (token at
  `~/.config/llmux/credentials.json`).
- v0.34.0 → v0.35.0 is a minor bump — additive, no breaking changes.

## [0.33.7] — 2026-06-20

### Fixed — default listen port now actually resolves to 3001

The sequential-port reorg (0.33.6, #60) moved the `?? 3001` fallbacks in
`handlers.ts` but left `DEFAULT_CONFIG.server.port = 3000` in `config.ts`.
`loadConfig()` always populates `cfg.server.port` from that default, so the
fallback was dead code and a bare `llmux server start` still bound **3000**,
not 3001. Set the default to `3001` so the precedence chain
(`--port` > `LLMUXD_PORT` > `LLMUX_PORT` > `config.server.port` > `3001`)
lands on 3001 as intended. Verified on WSL2: bare start now binds `:3001`.

## [0.33.6] — 2026-06-19

### Docs — Install prerequisites (tmux + C toolchain), the common WSL2/Linux first-run snag

The Install section jumped straight to `npm install -g @cordfuse/llmux` with no
prerequisites. On a fresh Ubuntu / WSL2 — a very common daemon host — that fails:
`node-pty` is a native module with no matching prebuild there, so the global
install compiles from source and errors out without `build-essential`; and
`tmux` (which every agent session needs) was never called out as a dependency.

New **Prerequisites (daemon host)** block under Install: Node ≥ 20 (not Bun),
`tmux`, and a C toolchain on Linux/WSL2, with the one-liner
`sudo apt install -y tmux build-essential` up front. Complements the existing
"On WSL2" Tailscale section — that covered remote access; this covers getting
the daemon to install at all.

## [0.33.5] — 2026-06-19

### Docs — Tailscale-on-WSL2 is the recommended path for phone access

Documents what bit during WSL2 dogfooding: a daemon in WSL2 is behind a NAT'd
virtual network, so its `localhost` / LAN URLs are **not reachable from a
phone** — `localhost` only forwards from the Windows host, and the WSL `172.x`
address is internal. The LAN workaround (elevated `netsh interface portproxy`
+ firewall rule) is fragile because WSL's internal IP changes on every
`wsl --shutdown` / reboot.

New `### On WSL2` subsection under **Tailscale serve fronting** plus a pointer
from **Mobile, by design**: install Tailscale **inside the WSL distro** (the
Windows-host node doesn't expose WSL's ports) so the WSL instance joins the
tailnet as its own node with a stable IP + MagicDNS name — no admin, no
`netsh`, survives reboots, works over LTE. Notes `/dev/net/tun` (normal mode,
no userspace-networking), `systemd=true` in `/etc/wsl.conf`, and
`--hostname=<host>-wsl` to avoid colliding with the Windows host's node.

## [0.33.4] — 2026-06-19

### Fixed — WSL2 no longer false-detects Windows-only agents on `/mnt`

Under WSL2 the Windows filesystem is mounted at `/mnt` (`C:` → `/mnt/c`, …)
and every file there is marked world-executable. The agent-detection PATH
scan (`which`) therefore reported Windows-only installs — e.g. an npm-global
`codex` / `opencode` shim under `/mnt/c/Users/.../.npm-global` — as installed
Linux agents. That is a false positive: a Windows binary cannot drive a Linux
pty, so the picker offered the agent and the spawn produced a broken tmux
pane, with no signal to a first-time operator as to why.

`which` now detects WSL once (via `/proc/version`) and skips PATH entries
under the Windows mount root. Detection stays honest with **zero config** — a
beginner just installs the Linux build of the agent and it works; Windows
leftovers are silently ignored. Completely no-op off WSL (native Linux, macOS,
CachyOS unaffected — no per-distro behavior).

### Fixed — Claude Code detected from both install shapes (node + native)

Claude Code ships two ways and detection now covers both explicitly:

1. **Node / npm-global** — `npm install -g @anthropic-ai/claude-code` puts a
   `claude` on PATH (found via the WSL-aware `which`).
2. **Native installer** — `claude.ai/install.sh` symlinks
   `~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`; a direct
   check of the native versions dir is used as a fallback so a native install
   is found even when `~/.local/bin` isn't on the daemon's PATH (login vs
   non-login shell).

## [0.33.3] — 2026-06-19

### Changed — OpenCode adapter swapped from `node:sqlite` to `better-sqlite3`

Per code-review feedback and product direction. Two reasons the prior `node:sqlite` choice
needed fixing:

1. **Silent feature gap.** `engines.node` is `>=20` but `node:sqlite`
   is stable from `>=22.5` only. On node 20.x and 22.0-22.4 the prior
   `createRequire('node:sqlite')` try/catch swallowed the failure and
   opencode just had no resume picker with no signal to the operator.
   A capability gap with zero signal is the worst outcome.
2. **Experimental API warning leak.** `node:sqlite` emits an
   `ExperimentalWarning: SQLite is an experimental feature and might
   change at any time` on module load. Mac confirmed at 14:31Z that
   this leaked into the operator's interactive CLI output on
   `llmux session resume`:

   ```
   ocval resumed from ses_1b02…
   (node:85372) ExperimentalWarning: SQLite is an experimental feature …
   ```

### Why better-sqlite3 specifically (not better-sqlite3-was-too-broad-an-objection)

Mac's earlier F6 reasoning ("avoid another native dep like node-pty")
was reconsidered: node-pty's F6 bug was a *separately-exec'd*
`spawn-helper` binary losing its `+x` bit. **better-sqlite3 has no
exec'd helper** — it's a single `dlopen`'d `.node` addon. So it is
NOT exposed to the F6 failure mode. Its only real risk is "no
prebuild for the operator's node-ABI/arch + no build toolchain", and
`prebuild-install` ships prebuilds for all common targets. It's also
synchronous, which fits the existing adapter interface.

### Implementation diff (localized to opencode — the other five
adapters are filesystem/jsonl, no change)

- Removed `loadNodeSqlite()` cache + `createRequire('node:sqlite')`
  try/catch + `nodeRequire` import
- Added `import Database from 'better-sqlite3'`
- New helper `openOpencodeDb()` opens with `{ readonly: true,
  fileMustExist: true }` — `readonly` keeps us off opencode's WAL
  writer, `fileMustExist` avoids creating an empty DB on a typo path
- Added `better-sqlite3` to `dependencies`,
  `@types/better-sqlite3` to `devDependencies`
- Added `--external better-sqlite3` to the tsup build so the native
  binary isn't bundled into `dist/index.js`

`engines.node` stays `>=20`.

### Verification

- Build green, typecheck clean
- Daemon log: **no ExperimentalWarning** anywhere
- CLI `llmux session history opencode`: returns 74 rows for the
  `~/Repos` cwd, matches v0.32.2's numbers exactly, **no warning leak**
- `/api/conversations?agent=opencode&cwd=...` returns the same count
  + sample title as before

## [0.33.2] — 2026-06-19

### Docs — README sync to the v0.32.x / v0.33.x surface

Three updates against the v0.31.6 README baseline:

- **Status line** no longer says "Claude Code history adapter" —
  describes resume across all six Cordfuse-supported agents (claude,
  codex, gemini, agy, opencode, qwen) plus the bound-conversation
  indicator and in-form resume picker
- **Conversation resume section** rewritten with a per-agent storage
  + resume-flag table covering all six adapters, documents the
  per-row `↻ <title>` badge + picker highlight + `RESUME FROM`
  form field, lists the CLI verbs (`session resume`,
  `session history`, `session start --resume-from`)
- **Tailscale serve banner example** bumped `v0.31.4` → `v0.33.1`

No code changes; published to refresh the README in the npm tarball.

## [0.33.1] — 2026-06-19

### Fixed — `killSession` reaps the full process tree, not just the tmux pane

`tmux kill-session` only terminates processes still attached to the
pane's process group. Some agent CLIs — confirmed for **gemini**,
mechanism shared with its forks **qwen** and **agy** — re-exec
themselves with `node --max-old-space-size=...` and call `setsid()`
to detach from the pane's pgrp. Result: `tmux kill-session` couldn't
reach them, and they survived as orphans reparented to init/launchd.

v0.33.0's auto-respawn on `resumeFrom` change compounded the leak —
every form-picker rebind orphaned the previous gemini node tree.
Operators using the new RESUME FROM dropdown to rebind would
accumulate orphans rapidly.

Fix in `daemon/tmux.ts::killSession`:

1. **Before** calling `tmux kill-session`, snapshot the pane's
   descendant tree via `tmux list-panes -t <name> -F '#{pane_pid}'`
   plus a `ps -A -o pid=,ppid=` walk (cross-platform — same syntax
   works on Linux + macOS, no per-platform branch needed).
2. Call `tmux kill-session` to reap the pane and anything still in
   its pgrp.
3. `SIGKILL` every descendant we captured that's still alive
   (iterating child-first so intermediate shells don't keep
   grandchildren reparented). Also SIGKILL the root in case some
   wrappers forked early and the original is no longer tmux's
   direct child.

Guard against ever killing the daemon's own pid (defense-in-depth
— the parent-walk shouldn't reach us, but cheap insurance).

**Reported on macOS** arm64 / node 22.22.1 in
isolated repro. Verified on Linux with a rebind loop: spawn gemini
→ 3 procs, PATCH `resumeFrom` (auto-respawn) → 3 procs, stop →
0 gemini procs. No accumulation across rebinds.

## [0.33.0] — 2026-06-19

### Added — "Resume from" picker inside the add/edit session form

Resume binding was previously only reachable via the per-row `☰`
picker on an existing session. v0.33.0 adds the same picker as a
field inside the new-session form AND the edit form, so operators
can:

- Spawn a brand-new session pre-bound to a past conversation (with
  no in-between "spawn, then open picker, then resume" sequence)
- Change the bound conversation from inside the edit form (next to
  the other respawn-on-change fields like cwd)
- See the current binding pre-selected as `↻ <title> · <ago> · N msgs`
  when opening edit on a bound session

The select shows `(N past conversations)` in the field's label suffix
when conversations exist, or `(no past conversations for this agent
+ cwd)` when none — so an empty dropdown reads as expected, not
broken.

### Added — `GET /api/conversations?agent=<key>&cwd=<path>`

New endpoint for listing past conversations of an arbitrary
(agent, cwd) combo — used by the +new form which doesn't have a
session record yet. The existing `/api/sessions/<name>/conversations`
endpoint stays for session-scoped lookups; this one is the
agent-scoped equivalent.

### Changed — `editSession()` and `PATCH /api/sessions/<name>` accept `resumeFrom`

The patch type for `editSession` gained `resumeFrom?: string | null`.
Semantics:

- `undefined` → no change (preserves existing binding)
- `string` → sets the binding to that conversation id
- `null` or `""` → explicit clear (no binding, fresh start on next
  respawn)

When `resumeFrom` changes on a running session, llmux auto kill +
respawns the agent so the new binding takes effect immediately —
mirroring the existing auto-respawn behavior on cwd changes.

### Changed — `/api/agents` now reports `hasHistory`

So the JS form knows whether to skip the `(no past conversations)`
fetch entirely for adapter-less agents. Same field shape as
`SessionView.hasHistory`.

### Bug fix — edit button's `data-resume` attribute

The per-row Edit button's `data-` attributes didn't carry
`resumeFrom`, so `openEditForm` was always receiving
`row.resumeFrom === undefined` and the pre-select never fired even
on bound sessions. Added `data-resume="<id>"` to the button + read
it in the click delegator.

## [0.32.3] — 2026-06-19

### Added — Bound-conversation indicator on the row + picker

The `session.resumeFrom` state record was already persistent (each
`respawnSession` rebuilds the launch command with the resume flag), but
nothing in the UI told the operator which conversation was currently
bound. Adding two visual surfaces:

**Per-row indicator**. When a session is bound to a conversation, a
small purple `↻ <title>` line appears under the session name. Title
comes from a new optional `lookupTitle(cwd, id)` method on
`AgentHistoryAdapter`, falling back to the truncated id when the
adapter can't find the conversation (deleted / archived / never
existed).

`lookupTitle` is a fast single-record fetch — each adapter implements
the most direct lookup it can rather than walking the full set:

- **claude** — opens `~/.claude/projects/<encoded-cwd>/<id>.jsonl`
  directly (one file)
- **codex** — finds the file with the matching uuid suffix
  (`rollout-<ts>-<uuid>.jsonl`), then walks for the first non-synthetic
  user message
- **gemini / qwen** — walks the same `chats/` tree, stops at the first
  session whose `sessionId` matches
- **agy** — single-file scan for the first display matching
  `conversationId`
- **opencode** — `SELECT title FROM session WHERE id = ? LIMIT 1`

The full `listConversations` parse is reserved for the deliberate
"open the Resume picker" action; `lookupTitle` is what fires on every
session-list poll when a session has a `resumeFrom` set.

**Picker highlight**. The Resume picker modal was already prepending
`↻` to the bound conversation's title (with class `conv-current` =
purple bold). This release also adds a left-border accent + subtle
background tint on the same row via a new `has-current` class on the
conv button, so the bound row is unmistakable in a long list (the
operator's opencode picker had 408 rows in a busy cwd).

### API addition — `SessionView.resumeFromTitle`

`/api/sessions` now returns `resumeFromTitle` alongside `resumeFrom`
when the session is bound and the adapter resolved a title.

## [0.32.2] — 2026-06-19

### Added — OpenCode history adapter (sqlite-backed, completes the official 6)

Wires the last of the Cordfuse official 6. Validated the schema
against a real populated `opencode.db` with a verified spec;
this release implements it.

**Storage:** `~/.local/share/opencode/opencode.db` (XDG-data-home
respecting; same path on macOS + Linux). Sqlite, WAL mode. Two tables:

- `session(id, project_id, parent_id, slug, directory, title,
  time_created, time_updated, time_archived, agent, model, …)`
- `message(id, session_id, time_created, time_updated, data)`

The `directory` column matches llmux's session cwd as an exact string
(no path encoding, unlike claude's adapter which encodes cwd into a
dir name). Timestamps are epoch-milliseconds.

**Filter (from mac's CR):**
- `s.directory = ?` — cwd match
- `s.time_archived IS NULL` — skip archived
- `s.parent_id IS NULL` — keep only top-level (skip forks)

**Resume flag:** `--session <id>`. Verified opencode accepts an unknown
id with `Error: Session not found: <id>` — i.e. the flag parses and
loads by id, the syntax is correct.

### sqlite dependency — `node:sqlite` built-in, graceful degradation

Used node's built-in `node:sqlite` rather than `better-sqlite3` to
avoid another native build + prebuilds class (we just shipped the
node-pty postinstall chmod fix for the same class of issue).
`node:sqlite` is stable from node 22.5 — but llmux's `engines.node`
stays at `>=20` for backward compatibility. The adapter loads the
module via `createRequire(...)('node:sqlite')` inside a try/catch:

- node 22.5+: works as expected, opencode shows the Resume picker
- node 20.x or 22.0-22.4: try/catch returns undefined, adapter
  silently no-ops, the opencode row simply has no `☰ N` icon

OpenCode itself runs fine on older node; only the conversation
picker is feature-gated on the runtime sqlite availability.

Open + close per call (DB-level WAL handles concurrent reads with
opencode's writer). Read-only mode (`{ readOnly: true }`) so we
never touch opencode's transactions.

### State of the official 6 after v0.32.2

| Agent | History adapter | Notes |
| --- | --- | --- |
| `claude` | yes | v0.20.x |
| `codex` | yes | v0.32.0 |
| `gemini` | yes | v0.32.1 |
| `agy` | yes | v0.32.0 |
| `opencode` | yes | this release |
| `qwen` | yes | v0.32.1 |

6/6. All Cordfuse official 6 agents now have conversation history
adapters wired.

## [0.32.1] — 2026-06-19

### Added — Conversation history adapters for `gemini` and `qwen`

v0.32.0 wired codex + agy but deferred gemini ("inconsistent project
key mapping") and qwen ("no filesystem-visible log"). Both were
wrong-by-haste.

Re-investigation found that:

- Gemini's `~/.gemini/tmp/<dir>/chats/session-*.jsonl` directory name
  is a UI nicety only — the source-of-truth project identifier is
  the `projectHash` field inside each session's first event
  (`session_meta`), which equals `sha256(cwd)`. Verified:
  `sha256("/home/user/Repos/myproject")` ==
  `046b934ec7c94dead2d1f5df3c18512f2b8a927bdf103420a45569e365fae860`,
  which is the `projectHash` in that cwd's session files.
- Qwen Code is a Gemini CLI fork (Alibaba). It uses the same
  `<root>/tmp/<dir>/chats/session-*.jsonl` storage layout but at
  `~/.qwen/` instead of `~/.gemini/`. `chats/` subdirs are created
  on first chat — operators who haven't chatted yet have only the
  bare project marker dirs.

A shared `makeGeminiLikeAdapter` factory builds both adapters from
the same walker, parser, and title-extractor. They diverge only on
the tmp root path and the resume flag form.

**Resume flag divergence**:

- Gemini's `--resume <n>` takes a numeric index from
  `--list-sessions`, NOT a session id — indexes shift when sessions
  are added/deleted, so they're not stable for llmux's id-based
  picker. The adapter uses `--session-file <fpath>` (Gemini accepts
  any jsonl path), which composes as
  `gemini --yolo --session-file ~/.gemini/tmp/<dir>/chats/session-*.jsonl`.
- Qwen's fork extended `--resume` to also accept a session id
  directly, so the qwen adapter uses the clean `--resume <id>` form.

Title extraction handles both string and array-of-`{text}` content
shapes, since Gemini events carry the latter (`[{"text": "hello"}]`)
while some events use the former.

### State of the official 6 after v0.32.1

| Agent | History adapter | Notes |
| --- | --- | --- |
| `claude` | yes | v0.20.x — original |
| `codex` | yes | v0.32.0 |
| `gemini` | yes | v0.32.1 — this release |
| `agy` | yes | v0.32.0 |
| `opencode` | no | sessions in SQLite (`opencode.db`); sqlite3 dep declined |
| `qwen` | yes | v0.32.1 — this release; zero conversations until operator chats |

## [0.32.0] — 2026-06-19

### Added — Conversation history adapters for `codex` and `agy`

The Resume button (☰ N) and `llmux session resume <name> --latest |
--conversation <id>` previously worked only for Claude Code. v0.32.0
wires two more agents to the same picker + CLI flow.

**Codex (`codex`).** Sessions stored at
`~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. The
adapter walks the dated subtree, identifies each session's cwd from
the leading `session_meta` event, and filters by the operator's
session cwd. Title extraction skips Codex's synthetic
"user-role" messages (`# AGENTS.md instructions ...`, the
`<environment_context>` / `<permissions>` / `<user_instructions>` /
`<turn_aborted>` blocks) and surfaces the first real prompt.

`countConversations` opens just the first line of each .jsonl
(chunked read up to 256KB — the leading `session_meta` event itself
can be 20-35KB on disk) so the session-list view's badge doesn't
parse full transcripts on every poll.

Resume flag: `resume <id>` — Codex uses sub-command-style resume,
not a `--resume` flag. The agent's default global flag
(`--dangerously-bypass-approvals-and-sandbox`) is verified to accept
trailing sub-commands, so the resulting command is
`codex --dangerously-bypass-approvals-and-sandbox resume <id>`.

**Antigravity (`agy`).** Stores every interactive prompt as a single
line in `~/.gemini/antigravity-cli/history.jsonl`:
`{display, timestamp, workspace, conversationId?}`. The adapter
reads the file, filters by `workspace == cwd`, and groups by
`conversationId` to reconstruct conversations. First `display` is
the title; first/last timestamps frame `startedAt` /
`lastMessageAt`; `messageCount` is the count of prompts in the
group.

Resume flag: `--conversation <id>`. Composes as
`agy --dangerously-skip-permissions --conversation <id>`.

### Not yet wired

- **`gemini`** — stores sessions at `~/.gemini/tmp/<projectKey>/chats/
  session-*.jsonl` but the mapping between cwd and `<projectKey>`
  is inconsistent across local installs (some are project basenames,
  some are SHA-256 hashes of the absolute cwd). Needs more research
  before shipping.
- **`opencode`** — sessions live in `~/.local/share/opencode/opencode.db`
  (SQLite). Pulling in a sqlite3 dependency for one adapter is
  heavier than warranted; deferred until there's a JS-only need.
- **`qwen`** — no filesystem-visible conversation log we could find
  (only empty `tmp/<projectHash>/logs.json` placeholders).
- **`amp` / `grok` / `aider` / `continue` / `kiro` / `cursor` /
  `plandex` / `goose` / `copilot`** — these aren't part of the
  Cordfuse "official 6" set and weren't priorities for this sprint.
  Adapters can be added per-agent as those agents see real usage.

## [0.31.6] — 2026-06-19

### Docs — README PWA wording removed

llmux's PWA install support was dropped back in v0.17.4 — Chrome bundles
each installed PWA into a WebAPK whose package name is derived from the
hostname only (port ignored), so two Cordfuse PWAs on the same tailnet
host collide on install. Despite the removal, four PWA mentions
lingered in the README (alt text, "PWA-style surface" wording, and the
"Cordfuse PWA" port-conventions section). Replaced:

- `alt="Mobile PWA picker, …"` → `alt="Mobile picker, …"`
- "Chrome's 'Add to Home Screen' creates a quick-launch shortcut for
  it" → bookmark / pin-the-tab framing (no installable home-screen icon)
- "On mobile the picker is a real PWA-style surface" → "phone-tailored
  web UI"
- "Cordfuse PWA" → "Cordfuse app" in three port-convention sentences

CHANGELOG entries that mention PWA stay as historical record (the
v0.17.4 removal entry, the v0.18.x brand-alignment entries) — those
describe what was true at the time.

No code changes.

## [0.31.5] — 2026-06-18

### Docs — README sync to current surface

Status line dropped its stale `v0.30.0` pin and now describes the
shipped feature set (auth + tokens, mobile picker with per-row
destructive actions, conversation resume, init prompts, optional
turnq, editable Settings + runtime overlay, in-process log tailing)
without a version pin so it stops going stale on every patch.

Noun-prefix surface section expanded to match `llmux --help`:

- `session edit` (was missing)
- `token rename` + `revoke --all` (were missing)
- `logs list` + `logs tail` (whole verb was missing)
- `settings show` (whole verb was missing)

Added two new sections:

- **Runtime overlay** — documents `~/.config/llmux/overrides.yaml`,
  the file the web UI's Settings page writes to. Explains the base +
  overlay merge semantics, atomic write guarantee, and the
  "delete-to-revert" workflow.
- **Settings + logs from the CLI** — documents `llmux settings show`
  and `llmux logs list / tail` for headless use, noting that logs
  are local-only by design (no `--server` mode).

Bumped the Tailscale serve banner example from `v0.30.0` to `v0.31.4`.

No code changes; published to refresh the README in the npm tarball.

## [0.31.4] — 2026-06-18

### Changed — Mobile column-drop choice swapped: STATE hides instead of AGENT

v0.31.3 hid the AGENT column on mobile to free room for the per-row
Kill icon. Feedback: AGENT is the column that should stay visible
on the phone. v0.31.4 reverts that and instead hides the STATE
column, surfacing status as a small colored dot (`●`) prefixed onto
the session name inside the name-block:

- `●` green with a soft glow — `running`
- `○` hollow gray — `exited`

The dot is `aria-label` + `title` annotated so screen readers and
hover/long-press still surface the textual status. On desktop the
dot is `display:none` and the STATE column shows the textual status
as before.

### Why this works geometrically

The state text ("running" / "exited") consumes ~55-70px of column
width with padding. A 14px-wide colored dot inline with the name
consumes effectively zero column width. The AGENT column reclaims
that space; per-row Kill stays inside the viewport at 360-412px
widths.

## [0.31.3] — 2026-06-18

### Fixed — Per-row Kill icon clipped off the right edge on sub-390px viewports

v0.31.2 added the per-row Kill icon but the table row needed to grow to
accommodate the 4th icon (Conversations / Resume / Edit / Kill on
sessions-with-history). On Pixel/Galaxy portrait viewports (~360-380px
CSS width) the actions column overflowed the viewport edge, clipping
the rightmost Kill icon. Reported from a phone screenshot.

Two changes:

- **AGENT column hidden on mobile** (`@media max-width: 600px`). It's
  redundant when the session name defaults to the agent key (the
  common case — `codex` session runs `codex` agent etc.). When the
  name differs from the agent, `rowHtml()` emits an inline
  "agent: X" line inside the name-block so the agent stays visible.
- **Sub-420px viewport rule** tightens per-row button geometry
  (`padding:5px 4px`, `min-width:24px`, `margin-left:1px`,
  `icon font-size:12px`) and narrows the name-block max-width
  (`38vw` vs the prior `42vw`).

Net result on a 360px viewport: checkbox + name-block + state +
actions(4 icons) = ~340px, with margin to spare.

## [0.31.2] — 2026-06-18

### Added — Per-row Kill icon on every Sessions row

v0.31.1 moved Kill out of the bulk toolbar and into the per-session
edit form. Discoverability cost: an operator looking at the table
saw no Kill verb anywhere and had to open the edit form first to
find it. That defeated the original motivation (which was Kill's
poor discoverability when it lived off the right edge of the bulk
toolbar).

v0.31.2 adds a red `✕ kill` icon button on every row, sitting next
to the existing per-row Edit pencil + Resume + Send icons. Same
`askConfirm` gate as before. The previously-added in-form Kill button
stays — operators already mid-edit can still kill from there without
closing the form, but the discoverable home is the per-row icon.

Click → confirm modal → `POST /api/sessions/<name>/kill` → toast +
poll. Identical to the v0.31.1 flow, just visible from the table.

## [0.31.1] — 2026-06-18

### Changed — Kill moved out of the bulk toolbar into the per-session edit form

On portrait-phone viewports the bulk toolbar's six buttons (`+ new`,
`Start`, `Stop`, `Respawn`, `Broadcast`, `Kill`) didn't fit; the
horizontal swipe-scroll made `Kill` only visible when the operator
swiped, and the visual hint that anything was hidden was an eyelash
of the next button on the right edge — easy to miss.

Decision: Kill leaves the bulk toolbar. Stop already covers the
everyday "shut this thing down" case; Kill (which tears down the
tmux process and removes the state record) is destructive enough
that one-at-a-time-from-the-edit-form is the correct rhythm. The new
home for the verb is a red destructive button at the bottom-left of
the per-session edit form, only visible when the form is in edit
mode (hidden during `+ new`). The same `askConfirm` gate that
guarded the bulk Kill now guards the per-session Kill.

API: no change. `POST /api/sessions/<name>/kill` is the same endpoint
the bulk path called per-session under the hood.

CLI: no change. `llmux session kill <name> [<name>...]` still
supports variadic kill from the terminal for operators who want
batch destructive operations without the click ceremony.

## [0.31.0] — 2026-06-18

### Added — Settings page is now writable (daemon init prompts + turnq from the web UI)

Two cards on the Settings page changed from read-only displays to
inline editors:

- **DAEMON INIT PROMPTS** — textarea (one prompt per line) + Save button.
  Replaces the prior "edit `.llmux.yaml` on the daemon host" placeholder.
  Wipe semantics match the session-edit modal: leaving the textarea
  empty saves an empty list, no prompts fire on spawn.
- **TURNQ (FIFO turn coordination)** — enabled (checkbox), url (text;
  empty = local flock mode), max-hold ms (number) + Save button.
  Mode (`local` / `distributed` / `disabled`) is derived live from
  enabled + url and shown as a read-only badge.

Both cards persist edits to a new **runtime overlay file** at
`~/.config/llmux/overrides.yaml` rather than mutating the operator's
hand-edited base config. The base file (`.llmux.yaml` or
`~/.config/llmux/config.yaml`) keeps its comments + formatting
pristine. The daemon loads base + overlay at every `loadConfig()`
call; the web server reloads its in-process snapshot after every
write so the WebSocket attach path's turnq lookup picks up the new
state without a daemon restart. Delete the overlay file to revert
all UI edits to the on-disk base in one shot.

The Settings page surfaces both:
- **LOADED YAML** — the base file as it exists on disk (unchanged).
  Now shows an `overlay active` badge next to the header when the
  overlay file exists and has applied content.
- **ACTIVE OVERRIDES** — a new card (visible only when an overlay is
  applied) that shows the verbatim overlay YAML so the operator can
  see exactly what was written by the UI.

### Added — `PUT /api/settings/init-prompts` and `PUT /api/settings/turnq`

Behind the same auth as the existing `GET /api/settings`. Both bodies
are JSON; both return the updated effective values + an `overlayActive`
flag. Schemas (truncated):

```http
PUT /api/settings/init-prompts
{ "initPrompts": ["seed prompt", "another"] }

PUT /api/settings/turnq
{ "enabled": true, "url": "http://turnq.example.com:3003", "maxHoldMs": 30000 }
```

### Added — `loadOverride()` / `saveOverride()` / `overridePath()` in config.ts

Atomic writes (write-to-tmp + rename) so a partial write can't tear
the overlay file. `loadBaseConfig()` is exposed as the pre-overlay
primitive in case future callers need the on-disk base without
overlay merging.

### Fixed — Settings page bottom padding clipping under fixed footer

`.page` gained `padding-bottom:56px` so the last card on long pages
(now including the editable Settings cards) doesn't hide under the
fixed `auth required` footer.

## [0.30.1] — 2026-06-18

### Fixed — session-list page timed out on operator boxes with large Claude transcripts

`viewOf()` called `agentDef.history.listConversations(cwd).length` on
every render of the Sessions page to populate the conversation-count
badge. `listConversations` reads + parses every `.jsonl` transcript
in `~/.claude/projects/<encoded-cwd>/`. On long-running operator
boxes that directory can hold hundreds of MB (a single transcript can
exceed 50MB). `readFileSync` + `split('\n')` over all of them on
every 3s poll blocked the event loop for ~1s per render and
catastrophically longer when a session's cwd happened to map to a
densely-populated `/tmp` directory — the daemon's `/` route was
timing out at 10s with the phone unable to load any page.

Fix: new optional `countConversations(cwd)` method on
`AgentHistoryAdapter`. `claudeHistory` overrides with a
directory-only `readdirSync().filter(.jsonl).length` — no file reads.
`viewOf` prefers it when available; falls back to the old parsed
count for adapters that don't override.

`listConversations` (the full parse) still fires when the operator
opens the Resume modal on a row — that's a one-shot deliberate
action, not a background poll.

## [0.30.0] — 2026-06-18

### Added — turnq integration (FIFO turn coordination)

Opt-in via `.llmux.yaml`:

```yaml
turnq:
  enabled: true
  url: http://localhost:3003   # optional; local flock(2) when omitted
  maxHoldMs: 300000             # hard timeout (default 5 min)
```

**Marker auto-injection.** At session spawn (when `turnq.enabled`), llmux
generates a per-session random marker (`LLMUX_DONE_xxxxxxxx`) and appends
a built-in system prompt to the init batch asking the agent to emit
`<<LLMUX_DONE_xxxxxxxx>>` on its own line at the end of every response.
The marker prompt fires LAST so LLM recency bias keeps it fresh in the
agent's context.

**Send wrapper.** `daemon/turnq-integration.ts` exposes `sendWithTurn`,
called by:
- CLI `session prompt`
- CLI `session broadcast`
- HTTP `POST /api/sessions/:name/send`
- Web one-shot send + bulk Broadcast

When turnq is enabled, the wrapper acquires `turnq.withTurn(channel =
"llmux:<session>")`, fires `tmux send-keys`, then polls the pane every
400ms for the marker. Release on first match. If `maxHoldMs` elapses
without the marker (agent crashed, hung tool call, etc.), warn and
force-release.

**Web terminal strip.** The WS `term.onData` forwarder buffers per-line
and filters out any line containing the marker before pushing to the
browser. Operator's xterm view stays clean; CLI `tmux attach` still
shows the marker (would require modifying tmux output to filter that
path).

**Settings screen card.** New "turnq" card in the Settings screen shows
`enabled / mode (local|distributed|disabled) / url / max-hold`. Reads
from the extended `/api/settings` payload.

**Per-call opt-out.** `--no-turnq` flag on `session prompt` and
`session broadcast`. `{"skipTurnq": true}` in the HTTP `/send` body.

**State.** `state.SessionState` gained `turnqMarker?: string`. Set at
spawn when turnq is enabled, undefined otherwise. Pre-v0.30.0 sessions
have no marker — sendWithTurn falls back to a 1.5s fixed hold so back-
to-back sends still serialize for them, just less precisely.

### Internal

- `daemon/config.ts`: new `TurnqConfig` interface + parse path
- `daemon/turnq-integration.ts`: new module (Coordinator singleton,
  marker generation, `sendWithTurn`)
- `handleSend`, `handleBroadcast`: now async
- `@cordfuse/turnq` added to runtime deps; build externalises it

### Backwards compatibility

- Default config has no `turnq` block — turnq integration is fully
  disabled out of the box. Existing behavior unchanged.
- Sessions spawned pre-v0.30.0 have no `turnqMarker` — sendWithTurn
  falls back to a fixed 1.5s hold (sequential, just less precise).
- CLI surface: `--no-turnq` is additive. All other prompt/broadcast
  flags work unchanged.
- HTTP API: `skipTurnq` is an optional body field on /send. Existing
  callers ignored = same behavior as before.

## [0.29.0] — 2026-06-18

### Security — at-rest token hashing (mac CR closeout)

`auth.json` previously stored full plaintext SAS token values. Anyone
with read access to the file — backup snapshots, dotfile syncs,
co-tenant readers — could use the tokens directly against the daemon.
v0.29.0 drops the plaintext: only the SHA-256 hash (hex) is persisted.

- New `AuthToken` shape: `{ id, hash, name?, createdAt, expiresAt? }`
- `validateAuthToken(candidate)`: parses the candidate's display id out
  of the `sas_` prefix, finds THAT one record (avoids hashing every
  stored token per request), then `crypto.timingSafeEqual` against the
  stored hash. Generic `false` for both unknown-id and hash-mismatch
  so observers can't tell from timing which case hit.
- `createAuthToken()` return shape gained a temporary `token: string`
  field — the only place the plaintext exists post-call. Callers can
  surface it in the QR / "show once" modal then drop it. The on-disk
  record never sees the plaintext.

**Silent v1 → v2 migration on load.** Existing `auth.json` files with
`version: 1` records are read, hashed in-place, and rewritten as
`version: 2`. Operators see no churn — first daemon start under
v0.29.0 transparently upgrades. The token VALUES remain valid; only
the storage shape changes.

SHA-256 is the right choice here, not bcrypt/argon2/scrypt. Tokens are
256-bit random; brute-forcing is infeasible regardless of hash speed,
and password-hash slowness would add per-request latency for zero
security gain.

### Security — CLI WS drops `?token=` URL form, uses `Authorization: Bearer` on upgrade

Pairs with v0.22.0's URL-fragment fix for the web pairing QR. The CLI's
hand-rolled WS client (`openWs` in `client.ts`) previously appended
`?token=…` to the WebSocket URL — visible in server access logs,
reverse-proxy logs, and the daemon's own ring buffer. v0.29.0 emits
the token via an `Authorization: Bearer <token>` header on the
upgrade request instead.

Closes the URL-token surface end-to-end (web QR + WS CLI both clean
now). Daemon-side already accepted Bearer-on-upgrade via the existing
`extractToken(req)` fallback path; no server change needed.

### Backwards compatibility

- Existing tokens keep working — the migration only changes storage,
  not the token values themselves.
- Existing scripts using `--token sas_…` against `--server` URLs work
  unchanged (the HTTP Authorization header path was already there).
- CLI WS upgrades now send Bearer instead of `?token=` — the daemon
  validated both before and after, so no operator action required.
- File mode on `auth.json` stays at 0600 (defense in depth even though
  the contents are no longer directly usable).

## [0.28.0] — 2026-06-18

### Added — Init prompts (daemon-wide + per-session)

System-prompt-style context, fired automatically after every spawn.

**Daemon-wide** (`.llmux.yaml`):
```yaml
initPrompts:
  - |
    You work in a TypeScript monorepo. Never write Python.
  - |
    If the current branch is main, stop and ask before committing.
```

**Per-session** (CLI):
```bash
llmux session start claude --name sdd \
  --init "you process tickets from $REPO" \
  --init "respond in JSON {action, files, reasoning}"
```

Composed at spawn time as `daemon.initPrompts → session.initPrompts`,
persisted on the session state record so `session restart` re-fires
the same context exactly.

### Added — `readyPrompt` revival on `AgentDefinition`

Reintroduced as the optional regex-string field on every agent in the
catalog (`^>` for most, `Goose❯` for Goose, `^agy>` for Antigravity,
etc.). At spawn, the daemon polls `tmux capture-pane` every 200ms
matching the agent's `readyPrompt` against the tail of the pane; once
matched (or 10s timeout reached) it fires the composed init prompts
500ms apart. Agents without a `readyPrompt` set fall back to a 2s
sleep.

Also restored on `AgentOverrides` in the YAML schema so per-agent
`.llmux.yaml` overrides can supply a custom regex.

### Added — `--init` / `--skip-init` flags

- `session start <agent> --init "<prompt>" [--init "<prompt>"...]` —
  repeatable, accumulates into an array
- `session start --skip-init` — suppress the init-prompt firing for
  this single spawn (the persisted list still saves; --skip-init only
  affects THIS invocation)
- `session restart <name> --skip-init` — same suppression on restart
- `session edit <name> --init "..."` — replace the persisted
  init-prompt list (`--init ""` clears; combine with `--apply` to
  respawn into the new prompts)

### Changed — `string-array` flag kind in the parser

`packages/llmux/src/cli.ts` gained a third `FlagKind`: `string-array`.
A flag declared as `kind: 'string-array'` accumulates an array on
repeated occurrences instead of overwriting. `init` is the first
consumer; future repeatable string flags can opt in by changing their
kind.

### State persistence

`state.SessionState` gained an optional `initPrompts?: string[]`
field. Stored on disk so respawns re-fire the same list. Removed
sessions or upgrades from pre-v0.28.0 simply lack the field — fully
backwards compatible.

### Spawn timing rules

| Scenario | Init prompts fired? |
|---|---|
| `session start <agent>` with daemon and/or session prompts | yes — both, in order |
| `session start <agent> --skip-init` | no |
| `session restart <name>` | yes — re-fires persisted list |
| `session restart <name> --skip-init` | no |
| `session resume <name> --conversation <id>` | no — prompts already in history |
| `handleSpawn` and `handleRespawn` are now `async` | (call sites updated in index.ts) |

## [0.27.0] — 2026-06-18

### Added — CLI parity ship: `session edit`, `logs`, `settings`, variadic stop/restart

The web UI accumulated several surfaces the CLI didn't have. Closing
the gap so a script-driven workflow can do everything a phone-tapping
one can.

**`session edit <name>`** — patch a tracked session's persisted
metadata. Flags `--name`, `--cwd`, `--flags`, `--env` (KEY=VAL one per
line). `--apply` respawns afterwards to put the changes in effect.
Without `--apply`, the patch is saved but the running pane continues
under the old config until the next `session restart`. Exports the
shared `editSession()` from web/server.ts so local and remote paths
both go through the same logic.

**`session stop <name> [<name>...]`** and **`session restart <name>
[<name>...]`** are now variadic. Continues past per-target failures so
a typo or missing record in the middle doesn't abort the rest of the
batch; throws at the end if any failed. `session stop all` keyword
preserved. `--cascade` still only valid with a single target.

**`logs list [--limit N] [--json]`** — print the daemon's in-process
log ring buffer (last 500 lines). Newest at the end.

**`logs tail [--since ISO]`** — print the buffer then live-tail every
new console line until Ctrl-C. Local-mode only (subscribes to the
in-process ring; remote tailing routes through the SSE endpoint added
in v0.26.0). `--since` filters initial output to entries at/after the
given ISO-8601 timestamp.

**`settings show [--json]`** — dump the daemon's resolved config
source, state dir, tmux availability, listen port/host, env vars, and
verbatim YAML content. Same payload as the web Settings screen.

### Web UI

Unchanged in this release. The /api/sessions PATCH route is still the
backing surface; the new CLI verbs use the in-process editSession
function directly for local mode.

## [0.26.0] — 2026-06-18

### Docs — "Multiple senders, one session"

New README section documenting the shared-state nature of named sessions.
Multiple senders queue FIFO at the agent TUI; there's no lock or owner
concept. Recommended pattern: name sessions by purpose
(`claude-sdd` vs `claude-chat`) and let operators coordinate via name.

### Added — Logs screen with live daemon tail

New `Logs` nav item. Tails the daemon's own console output without shell
access to the host.

How it works:

- A new `daemon/log-buffer.ts` module wraps `console.log` / `.info` / `.warn`
  / `.error` at handler-startup time. Each call still goes to the original
  stdout/stderr (terminal output unchanged); the wrappers additionally push
  the formatted text into an in-process ring buffer (last 500 lines).
- `GET /api/logs` returns the current buffer for initial render.
- `GET /api/logs/stream` is a Server-Sent Events stream — one
  `data: { ts, level, text }` message per new console line. Heartbeats
  every 30s to keep proxies from dropping the connection.
- The Logs screen fetches /api/logs on open, then opens an EventSource
  for live tail. Auto-scroll toggle (default on), client-side level
  filter (all / warn+error / error only), and Clear button.
- Closing the page (navigating away) tears down the EventSource so we
  don't leak sockets across long browser sessions.

Multi-line messages are split per newline so each visible line gets its
own entry — keeps the timeline tidy when error stacks land.

### REST API additions

- `GET /api/logs` — returns `{ capacity, entries: LogEntry[] }`
- `GET /api/logs/stream` — text/event-stream of new LogEntries; closes
  when the client disconnects

`LogEntry = { ts: ISO8601, level: 'info' | 'warn' | 'error', text: string }`.

### Other

- `handleServe` calls `logBuffer.install()` at the top before any other
  daemon output, so banner + warnings make it into the buffer for
  first-load operators

## [0.25.0] — 2026-06-18

### Added — Agents screen + Settings screen

Two new nav items, separate Settings as requested. Both are read-only
diagnostic views.

**Agents screen** lists every agent the daemon knows about. Each row
shows display name, key, install status (✓ installed / · missing),
running session count (badge), install hint (tap to copy), and a
docs link. A "show missing" toggle hides uninstalled agents.

Running-session counts come from the Sessions page DOM so this screen
doesn't add its own poll loop — the 3s session poll keeps the badges
fresh whenever Sessions has been visited at least once.

**Settings screen** is pure read-only diagnostic data:
- Discovery: where the YAML came from (or "no .llmux.yaml found"),
  state dir path, tmux availability
- Listen: resolved port + host the daemon is bound to
- Environment: LLMUXD_PORT / LLMUXD_HOST / LLMUX_PORT / XDG_STATE_HOME
  (each shown as either the set value or `(unset)`)
- Loaded YAML: verbatim content of the discovered .llmux.yaml

### REST API addition

- `GET /api/settings` — returns the daemon's resolved config source +
  YAML text + state dir + listen port/host + env vars + version.
  Read-only diagnostic. v0.24.1 callers unaffected.
- `ServeOptions.config` is now an optional field (the loaded
  `LlmuxConfig`). When passed, `/api/settings` surfaces the source
  path + YAML content. `handleServe` in handlers.ts passes the loaded
  config through.

## [0.24.1] — 2026-06-18

### Added — One-shot send-prompt (web), Broadcast, QR for new tokens, Sessions filter

Four web-side feature pickups against the CLI surface and v0.24.0 UX gap list.

**One-shot prompt per row.** Each running Sessions row gets a new `⤴ send`
button alongside resume/edit. Click opens a shared prompt modal with a
textarea + "append Enter" toggle (default on) + Cmd/Ctrl+Enter to send.
POSTs to the existing `/api/sessions/:name/send` endpoint. Faster than
attaching xterm for one-line follow-ups on mobile. Hidden on exited rows
(can't sendKeys to a dead tmux session).

**Broadcast.** New toolbar button (purple, between Respawn and Kill).
Enabled when ≥ 1 checked row is running. Opens the same prompt modal,
sub-text reads "to N selected sessions". Fans out per-name POSTs in
parallel; exited rows are filtered out of the target set client-side.

**QR for new tokens.** Added `qrcode` package (server-side SVG render).
Token-create response now includes `pairingUrl` and `qrSvg` (200x200 SVG,
dark-theme colors, transparent background) when the client posts its
`location.origin` as `pairingOrigin`. The token-secret modal shows the
QR above the token + URL fields. SVG is wiped from the DOM when the
modal closes.

**Sessions filter.** Text input above the bulk toolbar, matches by name
OR agent (case-insensitive substring). `×` button to clear. Applied
after every poll-render so the auto-refresh doesn't blow it away. Value
is in-memory only (hard reload clears).

### REST API change

`POST /api/tokens` now accepts an optional `pairingOrigin` (string) in the
body — typically the client's `location.origin`. When present, response
includes `pairingUrl` (the `#token=…` fragment form) and `qrSvg` (SVG
markup, ready to inline). Both omitted if `pairingOrigin` is absent or
QR rendering fails. Pure addition; v0.24.0 callers unaffected.

### Build

`qrcode` added to dependencies. tsup build externalises it (along with
`node-pty`, `ws`, `yaml`, `qrcode-terminal`) so it stays as a runtime
dep rather than getting bundled into `dist/index.js`. `@types/qrcode`
added to devDependencies.

## [0.24.0] — 2026-06-18

### Added — hamburger nav + multi-page web UI scaffolding

The Sessions page is no longer the only screen. The web UI got a
slide-out hamburger drawer (top-left) with three nav targets:

- **Sessions** — the existing page, unchanged
- **Tokens** — full CRUD on auth tokens (see below)
- **About** — daemon info, version, hostname, live session + token counts

Last-viewed page persists in `localStorage` (key `llmux.page`) so a hard
reload keeps the operator on the same screen. The global "+ new session"
header button is hidden on non-Sessions screens to avoid confusion.

### Added — Tokens screen + REST API

`/api/tokens` REST surface, mirrors the CLI verbs:

- `GET    /api/tokens`        — list (id / name / createdAt / expiresAt; never the value)
- `POST   /api/tokens`        — create. Response includes the value ONCE (`{value, token}`). 201 on success.
- `PATCH  /api/tokens/:id`    — rename (body: `{name}`; empty string clears)
- `DELETE /api/tokens/:id`    — revoke a single token
- `DELETE /api/tokens`        — revoke all (returns `{removed, before}`)

The Tokens web screen wraps it:

- **+ new token** button → inline create form (name + optional ISO-8601 expiry)
- Create success → modal showing the token value (tap to copy) + the
  pairing URL with the fragment form (`https://host:port/#token=…`).
  The value is shown once; closing the modal clears it.
- **rename** (per-row) → browser `prompt()` for the new name; PATCH on submit
- **revoke** (per-row) → confirm modal → DELETE
- **revoke all** → confirm modal → DELETE on the collection

Closes the install-time blocker for the mobile-first pitch: every new
device pairing previously required SSH to the daemon host. Now any
authenticated browser session can mint a fresh pairing token + show the
URL to scan or paste on a second device.

### Added — About screen

Live daemon info: host, version, sessions count, auth status, active
token count, web client info. Polls `/health` + `/api/tokens` every 5s
while the About page is the active screen.

### CSS / layout

- New nav drawer + backdrop, slide-in from left, dim background overlay
- `.page` containers (only one `.active` at a time)
- Tokens screen styling: table + per-row action buttons, inline create
  form, token-secret reveal modal with "tap to copy" hint
- About screen: card grid (1-col mobile, 2-col desktop)

### Backwards compatibility

- Existing Sessions page rendering / behavior unchanged
- CLI surface unchanged
- New REST routes are additive; no existing route changed
- `localStorage` key `llmux.page` is the only new client-side state

## [0.23.0] — 2026-06-18

### Added — multi-select bulk toolbar on the Sessions web UI

The Sessions page (mobile-tap-from-phone path; also desktop) gained:

- **Host machine name in the header** — `LLMUX on <hostname> · Sessions` style. Reads from `os.hostname()`, so each machine shows its own real hostname. Distinguishes which daemon's UI you're on when you have multiple panes open.
- **Checkbox column on every row** + select-all checkbox in the column header (tri-state — checked / unchecked / indeterminate).
- **Bulk toolbar above the list** with four text-labelled buttons: **Start**, **Stop**, **Respawn**, **Kill**. Each fires per-name POSTs in parallel against the existing `/api/sessions/<name>/{respawn,stop,kill}` endpoints.
- **Smart enable/disable** — `Start` lights up only when the selection has at least one exited session, `Stop` only when there's at least one running. `Respawn` and `Kill` light up whenever anything's selected. Empty selection = all four toolbar buttons disabled.
- **`Kill N sessions?` confirm modal** on Kill (reuses the existing single-row askConfirm pattern). Stop / Start / Respawn don't confirm — they're recoverable.
- **Selection persists across the 3s poll** by session name. If a session disappears from the API response (killed, etc.) it's pruned from the selection set so the toolbar count + downstream fan-out stay accurate.

### Removed — per-row Start / Stop / Respawn / Kill buttons

Replaced by the bulk toolbar. Per-row **Edit** (pencil) and **Resume** (☰) stay — those are inherently one-row-at-a-time operations.

### Files changed

`packages/llmux/src/daemon/web/server.ts` only. No API changes; the bulk actions reuse the existing per-session POST endpoints.

## [0.22.1] — 2026-06-18

### Fixed — web terminal broken on every fresh macOS install (F6, BLOCKER)

node-pty's published tarball ships its macOS `spawn-helper` binaries
(`prebuilds/darwin-arm64/spawn-helper`, `prebuilds/darwin-x64/spawn-helper`)
at mode `0644` instead of `0755`. macOS uses `posix_spawnp` on this
helper to open a pty, and `posix_spawnp` on a non-executable file
fails — every WS terminal attach died with `4040 spawn failed:
posix_spawnp failed` surfaced to the user as the misleading "session
ended — The tmux session is no longer running."

Linux is unaffected (forkpty, no helper exec), so testing there
never surfaced it. Caught on macOS on a fresh `npm i -g @cordfuse/llmux`
install of v0.21.3.

Fix is a small `postinstall` script (`scripts/fix-pty-permissions.mjs`)
that `chmod 0755`'s the two darwin helpers if they exist. Runs on every
consumer install. Defensive: any failure (read-only fs, node-pty not
present, etc.) is swallowed so the postinstall hook can never break a
fresh install.

Operators on macOS already running v0.21.3 with the manual chmod
workaround can either re-install to pick up the auto-fix, or just
leave the workaround in place — both work.

### Fixed — `--flag value` rejected values starting with `-` (F1)

`llmux session start --flags "--model opus"` (the documented form)
errored with `--flags requires a value` because the parser treated any
`-`-prefixed next token as a new flag rather than the previous flag's
value. The `--flags="--model opus"` equals form worked. This
contradicted both the inline `--help` text and the v0.21.2 audit's
inert-flag fix narrative (`--flags` was wired but unreachable).

Parser now only errors on truly-missing values (`next === undefined`).
Trade-off: if you typo `--name --cwd /tmp` intending to chain two
flags, the parser silently accepts `--cwd` as the value of `--name`
and `/tmp` as a positional. Standard parser tradeoff — matches Node's
`util.parseArgs` default behavior and most modern CLIs.

`--flag=value` form continues to work identically.

## [0.22.0] — 2026-06-18

### Security — pairing QR now uses URL fragment, not query string

Pairing tokens previously rode in the URL query string (`?token=sas_…`).
TLS protects them on the wire, but the server, any reverse proxy
(Tailscale serve, Caddy, nginx), the operator's terminal scrollback,
the phone browser's history, and the `Referer` header on outbound links
all saw the credential in plaintext.

QR URLs now use the **URL fragment** (`#token=sas_…`). Browsers never
send the fragment in the HTTP request — it stays purely client-side.
The gate page reads `window.location.hash`, POSTs the token to
`/api/auth`, and `history.replaceState`s the fragment off the visible
URL before the auth POST completes. Server logs, proxy logs, browser
history, and referrer headers no longer see the token.

Same one-tap pairing UX. No CLI changes — the CLI was already clean
(`Authorization: Bearer` header from `--token` / `LLMUX_TOKEN`).

### Backwards compatibility

`?token=` URLs still work for one release so any QR already scanned or
in-flight continues to function. A one-line operator warning prints
to the daemon console whenever `?token=` is consumed:

```
[llmux] deprecated: ?token= in URL — visible in server / proxy / browser logs.
Regenerate the pairing QR with `llmux token create --qr` on v0.22.0+ to use the fragment form.
```

A future release will drop the legacy path entirely.

### Known follow-ups (NOT in this release)

The fragment fix closes the URL-token leak on the web pairing path
only. Two adjacent items mac flagged are scoped for separate work:

- **CLI WS still passes `?token=` on the WebSocket URL** (`client.ts`
  `openWs`). Browsers can't set `Authorization` on the WS upgrade
  directly, but the CLI's hand-rolled WS client can. Same operator-log
  exposure, less severe (CLI is operator-machine local). Backlog.
- **At-rest token hashing.** Tokens are stored plaintext in `auth.json`
  (0600). Mac's CR proposes SHA-256 hash + `crypto.timingSafeEqual` +
  silent `version 1 → 2` migration. Worth doing, separate change.

## [0.21.3] — 2026-06-17

### Fixed — `token create --qr` produced wrong URL on non-default ports

`endpointPort()` always returned `LLMUX_PORT || 3030`, ignoring the
daemon's actual resolved port. Operators on `--port 9999` got a QR
encoding `…:3030/…` that didn't reach the running daemon. Now mirrors
`handleServe`'s precedence: `--port` flag > `LLMUXD_PORT` >
`LLMUX_PORT` > `config.server.port` > `3030`. Added matching `--port`
flag to `token create` for explicit override.

### Fixed — `session resume` dropped per-session flags / env / resumeFrom

Same bug class as `handleRespawn` (fixed in v0.21.2), different code
path: the in-line `session resume` case in `index.ts` rebuilt the
launch command from `agent.flags` and the env from `agent.envDefaults`,
ignoring the persisted `session.flags` and `session.env`. Replaced
with the shared `buildAgentCommand` + `mergeSpawnEnv`. Resume now
preserves every override the original spawn set.

### Removed — `readyPrompt` (dead schema field)

Every `AgentDefinition` carried a `readyPrompt` regex (`'^>'`,
`'Goose❯'`, etc.) intended for spawn-confirmation detection, but
nothing in the codebase ever read it. Removed from the type, removed
from all 15 catalog entries, removed from the YAML schema
(`AgentOverrides`), removed from the README "what this YAML does NOT
do today" list. Can be re-added when there's a concrete consumer.

### Removed — four dead exports

- `installedAgents()` (`agents.ts`)
- `renderFlagHelp()` (`cli.ts`)
- `notImplemented()` (`cli.ts`)
- `_request()` (`client/client.ts`) — comment claimed "re-exported for
  tests" but no test imports it

### Changed — `@types/ws` moved to devDependencies

Was incorrectly listed under runtime `dependencies`, shipping the
types package to every operator's `node_modules` even though `ws`
itself isn't used at runtime by the CLI surface. Pure packaging fix.

### Docs — env table + stale comments

- README env table now lists `LLMUXD_PORT` (consulted by `server
  start` + QR builders) and `LLMUXD_HOST` (daemon bind host).
  `LLMUX_PORT` clarified as legacy fallback.
- `net.ts:78` comment updated: `llmuxd serve` → `llmux server start`
  (last code-comment reference to the old binary name; the legacy-shim
  `case 'serve'` in `index.ts` is intentional backcompat and stays).
- `client.ts:213` WS-client docstring rewritten — old language claimed
  `node-pty` and `ws` were "llmuxd-only" which made no sense after the
  bunectomy.

## [0.21.2] — 2026-06-17

### Fixed — four inert flags + handleRespawn dropping per-session overrides

Audit caught several declared-but-unread flags (same class as the
`--no-qr` bug v0.21.0 fixed). Each silently swallowed operator intent
locally while the remote (`--server`) path continued to honor them.
Wired all of them:

- `session start --flags "<f>"` — was declared in `sessionLocalFlags()`
  but `handleSpawn` ignored it. Now honored + persisted on the session
  record (parity with the server-side `POST /api/sessions`).
- `session start --env "K=V"` — same pattern. Parsed via the shared
  `parseEnvText` helper now exported from `web/server.ts`.
- `session start --resume-from <id>` — advertised in root `--help`
  but **not declared** anywhere, so the parser errored before the
  handler saw it. Declaration added, handler now sets `state.resumeFrom`
  and passes the agent's `history.resumeFlag(id)` fragment at spawn.
  Silently dropped on agents without a history adapter (matches the
  server-side semantics).
- `server start --config <path>` — declared in `dispatchServer` but
  `handleServe` called `loadConfig()` with no opts so auto-discovery
  always won. Now passes `{ explicit: <path> }` through.
- `session prompt --no-enter` — declared, advertised, but `handleSend`
  hardcoded `{ enter: true }`. Now honored. The remote client path
  already did the right thing.

Also fixed a related bug found while consolidating: **`handleRespawn`
dropped per-session `flags` / `env` / `resumeFrom` overrides on local
restart.** Sessions originally spawned with `--flags "..."` would lose
the override on `session restart`. The server-side `respawnSession`
already preserved them; local now does too, via the shared
`buildAgentCommand` + `mergeSpawnEnv` helpers.

### Changed — `buildAgentCommand`, `parseEnvText`, `mergeSpawnEnv` are now exported

The three spawn-composition helpers in `web/server.ts` are now exported
so `handlers.ts` can share them instead of duplicating logic. Internal
refactor; no runtime semantics change for HTTP API consumers.

### Fixed — error string referenced removed `token show` verb

`token revoke` without an id now says "shown by `token list`" instead
of the removed `token show`. One-character fix.

### Chore — dead import + stale README version strings

- Removed unused `import * as authStore` from `index.ts`.
- README banner sample now shows `llmux v0.21.2` (was `v0.16.x`).
- README "What this YAML does NOT do today" no longer pins to `v0.13.x`.

## [0.21.1] — 2026-06-17

### Added — `token revoke --all` to wipe the auth store

New flag on the existing `revoke` verb. Lists how many tokens will be
removed and prompts `Revoke ALL N tokens? [y/N]` on an interactive
terminal. Pass `--yes` to skip the confirm for scripted use; non-TTY
without `--yes` errors out.

Also exposed via the in-process `auth-store.revokeAllAuthTokens()` API,
returning the count removed.

Useful when the token list accumulates pairing tokens (e.g. from
repeated `server start` runs on v0.21.0+) and you want a clean reset
before re-pairing fresh.

## [0.21.0] — 2026-06-17

### Added — `server start` prints a pairing QR by default

`llmux server start` now auto-creates a pairing token and prints a scannable
QR code immediately after the address banner. Default endpoint priority is
**tailscale-https → tailscale-http → lan → local**, so the QR Just Works on
the phone-on-tailnet path most operators want. Token is named
`server-start-<ISO date>` unless overridden.

New flags:

- `--no-qr` — suppress the pairing QR (banner only, no token mutation)
- `--qr-endpoint <label>` — override auto-select (e.g. `lan`, `tailscale-http`)
- `--qr-name <label>` — name the pairing token
- `--qr-expiry <ISO-8601>` — give the pairing token a TTL

The `--no-qr` flag was previously declared but inert — this release wires it
to actual behavior.

### Added — `token rename <id> --name <label>`

New verb to relabel an existing token without revoke + recreate. Closes the
gap operators hit when they forget `--name` on the original `token create`.
Pass `--name ""` to clear an existing name. Also exposed via the in-process
`auth-store.renameAuthToken(idPrefix, newName)` API.

## [0.20.4] — 2026-06-17

### Fixed — pinch-to-zoom still broken after v0.20.3 (onSelectionChange regression)

v0.20.3's `touch-action:none` was necessary but not sufficient. The
pinch handler was firing and computing the new font size, but the
resize wasn't taking effect.

Two changes (cause and renderer-safety):

1. **Guard `onSelectionChange` against active pinch.** The desktop
   auto-copy listener added in v0.20.0 was the regression vector. On
   Android, xterm fires spurious selection-change events during a
   2-finger touch; the synchronous `navigator.clipboard.writeText()`
   call inside the callback was clobbering the pinch resize in the
   same frame. Skip the listener body entirely while `pinchState` is
   non-null. Desktop mouse-drag selection still auto-copies as before.

2. **Explicit `term.refresh(0, term.rows - 1)` after `fit.fit()`.**
   Belt-and-suspenders: forces an xterm redraw after the fontSize
   property is set + fit recalculates dimensions. Cheap on both touch
   and wheel zoom paths.

xterm's keyboard input, the wheel-with-ctrlKey desktop pinch path, and
Copy/All buttons are unaffected.

## [0.20.3] — 2026-06-17

### Fixed — pinch-to-zoom font sizing broken on mobile

Pinch-to-zoom on the terminal stopped working after the v0.20.x copy
work; the touchstart's preventDefault was firing but Android intercepted
the 2-finger gesture for native page-zoom *before* our handler got the
chance to claim the event. Added touch-action:none to #term so the
browser knows our JS owns all touch gestures on the terminal area.

xterm's keyboard input + wheel-with-ctrlKey (desktop pinch) paths are
unaffected; only the touch-event-handling defaults change.

## [0.20.2] — 2026-06-17

### Fixed — copy buttons rendered as ugly glyph boxes on Android

v0.20.0/v0.20.1 used Unicode `⎘` (U+2398 NEXT PAGE) for the copy
buttons. The glyph rendered as a broken outlined box on Android Chrome
(no system font ships a matching shape; the browser falls back to a
generic placeholder). Replaced with text labels:

  - **Copy** — visible viewport
  - **All**  — full scrollback

Text reads at any size, doesn't depend on glyph availability, and the
buttons remain small enough to fit the top bar without crowding. The
title attributes (Copy visible / Copy full scrollback) clarify intent
on hover.

## [0.20.1] — 2026-06-17

### Added — second Copy button for full scrollback

Two buttons on the top bar now:

  - **⎘**   — Copy visible viewport (what's on screen). Mobile-primary.
  - **⎘⎘**  — Copy full scrollback (entire xterm buffer, up to the
    configured scrollback limit of 5000 lines). Useful for grabbing a
    whole conversation or a long log dump.

Both flash green on success and emit the same "✓ copied" toast.
Shared `_readBufferRange(start, end)` helper backs both — the per-button
handler just supplies the row range. Trailing blank lines are trimmed
in both modes so the copy ends on real content.

## [0.20.0] — 2026-06-17

### Added — Copy button + desktop auto-copy

After multiple failed attempts at Termux-style mobile selection (see
v0.18.x history and the feat/termux-selection branch for the trail of
debugging), we landed on the pragmatic answer:

  - **Top-bar Copy button** (⎘) — one tap copies the visible viewport
    of the terminal to the clipboard. Brief "✓ copied" toast confirms;
    the button itself flashes green for 600 ms. Trims trailing blank
    lines so the copy ends on real content.
  - **Desktop auto-copy** — xterm's onSelectionChange fires when the
    user mouse-drags a selection. We write the selected text to the
    clipboard automatically (ttyd's well-known pattern,
    tsl0922/ttyd ~12k stars). No keyboard shortcut needed; just drag
    and the selection is already in the clipboard.

### Removed — granular mobile selection

We're not going to ship granular long-press + drag-handle selection
in the web picker. The browser-over-xterm.js stack fights the platform
at every layer (z-index, hit-testing, Android's WebApk text-selection
model, xterm's helper-textarea catching touches) and 10+ iterations
didn't land it. Per the project's framing — the web picker is for
drive-by phone use; deep terminal work is `llmux session attach` in a
real terminal where native shell selection works.

The full failed-attempt code stays preserved on the
`feat/termux-selection` branch as the architectural-lessons record. If
a future iteration finds a clean implementation path it has the prior
work as a reference.

### Bump

Minor (0.19 → 0.20). New user-visible Copy button surface;
backwards-compatible.

## [0.19.0] — 2026-06-17

### Removed — mobile text-selection / long-press copy

Reverted the entire v0.18.x text-selection feature (long-press + drag
handles + copy toast). The browser-over-xterm.js implementation kept
hitting fundamental architectural mismatches: handles attached as
children of the term element have their touch events bubble through
the parent's listener (breaking handle-owned drag), and custom overlay
highlights fight xterm's internal z-index stack. After studying
Termux's source (cordfuse/termux-app reference) we confirmed the right
model is (a) handles in their own touch-event scope with
stopPropagation + setPointerCapture, and (b) selection highlight drawn
by the terminal renderer itself (not a separate overlay) — both of
which require a proper rewrite, not another patch.

Reverted `packages/llmux/src/daemon/web/server.ts` to the state at
v0.17.3 — pinch-to-zoom, desktop soft-keyboard hide, and the PWA
removal all stay. The v0.18.x work is preserved on branch
`feat/termux-selection` for the second swing.

Bumped to v0.19.0 to signal the deliberate feature removal at minor
granularity (npm doesn't allow republishing prior versions).

## [0.18.0] — 2026-06-17

### Added — long-press + drag to copy on mobile

On the chat screen, single-finger long-press (450 ms hold, ≤ 8 px
movement) anchors a text-selection. Dragging extends the selection;
releasing copies the selected text to the clipboard and flashes a
brief "✓ copied" toast in the middle of the screen.

  - Pre-trigger move > 8 px cancels the timer, so swipe-to-scroll
    stays intact.
  - A second touch arriving cancels the timer too, so the existing
    2-finger pinch-to-zoom keeps working without conflict.
  - Visual feedback: a quick 15 ms haptic vibration on devices that
    support it (Android), plus xterm's native selection highlight
    on single-row selections.
  - Multi-row selections work — the text is walked from
    `term.buffer.active.getLine(r).translateToString()` for each
    row in the range and joined with newlines. xterm's visual
    highlight only renders single-row; multi-row selections release
    cleanly to clipboard regardless.
  - Clipboard write uses `navigator.clipboard.writeText` first with
    an `execCommand('copy')` fallback for older Android Chrome.
  - Desktop unchanged — xterm's existing mouse-drag selection still
    works; the long-press path only fires on `touch*` events.

### Bump

Minor (0.17 → 0.18). New user-visible interaction surface on the
chat page.

## [0.17.3] — 2026-06-17

### Re-ship of 0.17.2 (release CI rejected the broken tag)

Same fixes as 0.17.2 — the dark strip under the desktop terminal
(`Number.isFinite(_bar)` instead of `parseInt('0px',10) || 42`) plus
desktop trackpad pinch via `wheel` + `ctrlKey`. The 0.17.2 commit
landed two raw backticks inside a comment that already lived inside
a backtick-template literal, terminating the outer string mid-flight
and breaking the tsc build. CI caught it before npm publish; 0.17.3
is the same intent with the comment backticks stripped.

## [0.17.2] — 2026-06-17

### Fixed

- **Dark strip under terminal on desktop** — `applyLayout()` used
  `parseInt('0px', 10) || 42`, which treats a legitimate `0` (the
  hidden-bar value set by v0.17.1's desktop media query) as falsy and
  falls back to 42. The terminal reserved 42 px for the absent bar.
  Swapped to `Number.isFinite(parsed) ? parsed : 42` — 0 is honored.
- **Pinch-to-zoom on desktop** — v0.17.0 only listened for `touch*`
  events. Desktop trackpads emit `wheel` events with `ctrlKey: true`
  for pinch gestures (the browser synthesizes the flag — the operator
  isn't actually pressing Ctrl). Added a `wheel` listener gated on
  `ctrlKey`, rAF-throttled, that steps the font size up/down per
  scroll direction. Same clamp range (8–32 px), same localStorage
  persistence as the touch path. Mouse-wheel-plus-real-Ctrl also
  works (conventional zoom gesture).

## [0.17.1] — 2026-06-17

### Changed

- Soft-keyboard bar (the bottom toolbar with Esc / Tab / Ctrl /
  arrows / more-keys panel) now hides on desktop browsers. Detected
  via `@media (pointer: fine) and (hover: hover)` — the standard CSS
  test for "operator has a mouse and a real keyboard." When the bar
  is hidden the `--bar-h` and `--allkeys-h` CSS vars collapse to 0
  so the xterm viewport claims the full vertical space.
- Mobile / touch-primary devices keep the bar exactly as before. No
  JS changes — the layout JS already reads `--bar-h` from
  `getComputedStyle()` so the media-query swap flows through to
  fit/resize calls automatically.

## [0.17.0] — 2026-06-17

### Added — pinch-to-zoom font size in the web terminal

Two-finger pinch / spread gestures on the xterm canvas now scale the
terminal's font size live, with the viewport re-fitting and the
backend pty receiving the new cols/rows immediately. Clamped to 8–32
px so the gesture can't shrink the terminal to nothing or blow up
past readability.

The chosen size persists in `localStorage` under
`llmux.term.fontSize` — reload the chat page and your last zoom
level comes back.

Implementation:

  - `touchstart` with 2 touches captures the initial finger distance
    and current font size; preventDefault stops the browser from
    page-zooming the entire viewport.
  - `touchmove` rAF-throttles the update so font changes only run
    once per frame instead of once per touch event.
  - On each frame the new distance / start distance ratio scales the
    starting font size; the result is clamped and applied via
    `term.options.fontSize`, then `fit.fit()` recomputes cols/rows
    and a `resize` JSON message is sent over the WebSocket so the
    underlying pty matches.
  - `touchend` / `touchcancel` snapshot the final size to
    localStorage.

Desktop browsers / single-touch interactions are untouched. Existing
keyboard shortcuts and toolbar buttons unchanged.

## [0.16.3] — 2026-06-17

### Removed — PWA install surface

Dropped llmux's PWA install support. Chrome on Android bundles each
installed PWA into a WebAPK whose package name is derived from the
hostname only — port is ignored. Multiple Cordfuse PWAs hosted on the
same tailnet machine can't coexist as installs; the second one always
fails with "Open <other-app>" instead of an Install prompt. Rather
than spend infrastructure on per-app subdomains to dodge this, the
Cordfuse pattern is to ship llmux + vyzr as plain web apps over
Tailscale HTTPS. Chrome's "Add to Home Screen" still gives you a
quick-launch shortcut; it just opens in a tab instead of standalone.

### What was removed

- `/manifest.webmanifest` endpoint
- `/sw.js` service worker endpoint
- `/icon-192.svg` and `/icon-512.svg` endpoints
- `<link rel="manifest">`, `<meta name="apple-mobile-web-app-*">`,
  `<meta name="application-name">`, and the inline service-worker
  registration `<script>` in the picker head

### What survived

- `BRAND_SVG` still serves as the browser-tab favicon (`<link rel="icon">`,
  `<link rel="apple-touch-icon">`)
- `<meta name="theme-color" content="#0b0c10">` kept so the browser
  chrome still picks up the dark navy on Android

### README

"installable PWA" / "Add to Home Screen launches standalone" copy
replaced with "reachable over Tailscale HTTPS from any browser." The
Cordfuse port-convention table now says "App" instead of "PWA."

(mighty-ai-qr-web's PWA stays as-is — it's publicly hosted on its own
dedicated origin so the hostname-collision doesn't apply.)

## [0.16.2] — 2026-06-17

### Documentation

- Added a "Tailscale serve fronting" section to the README documenting
  the canonical Cordfuse port convention for multi-PWA hosts: each PWA
  uses its OWN custom HTTP/HTTPS port pair (llmux on `3080` / `3443`,
  vyzr on `4080` / `4443`, etc.) instead of competing for the standard
  80 / 443 — `tailscale serve` only allows one mapping per `host:port`
  and adding a second app on 443 silently kicks the first off.
- Added a port-conventions table parallel to vyzr's, so operators of
  both apps see the same mapping in either README.
- No code change. The address-detection logic in `daemon/net.ts`
  already handles arbitrary ports correctly.

## [0.16.1] — 2026-06-17

### Fixed

- Visual weight mismatch on the new stop/start toggle button. v0.16.0
  used the filled glyphs `⏹` (stop) and `▶` (start), which Android
  Chrome rendered noticeably larger and heavier than the line-stroke
  icons next to them (`☰ ↻ ✎ ✕`). Swapped to outline equivalents
  `□` (stop) and `▷` (start) — visually consistent with the rest of
  the row.

## [0.16.0] — 2026-06-17

### Added — stop/start toggle button per session row

New per-row action in the web picker that lets an operator stop and
restart an agent's tmux session **without losing the config**. Where
the existing buttons fit:

  - `↻ restart` (running) / `↻ respawn` (exited) — kill + relaunch,
    end state always running.
  - `✕ kill` (running) / `✕ remove` (exited) — kill tmux AND remove
    the state record entirely. Terminal action.
  - **New** `⏹ stop` (running) / `▶ start` (exited) — pause/resume.
    Stop kills the tmux session but keeps the state record so the
    same config (cwd, flags, env, resumeFrom) can be re-launched at
    any time. Start re-creates the tmux session from the stored
    record.

### Added — `POST /api/sessions/:name/stop`

Backs the new toggle. Idempotent — calling stop on an already-stopped
session returns ok. Differs from `/kill` in that the state record
survives, so the session can be started again from the same config.
The toggle's "start" side reuses the existing `/respawn` endpoint
(respawn-from-exited and start-from-stopped are mechanically the
same: re-create tmux from stored state).

### Visual

Toggle button uses amber on the running side (warning — destructive of
running process state) and green on the exited side (positive — start
an idle agent). Distinct from the existing button palette so it reads
clearly even at icon-only widths.

### Bump

Minor (0.15 → 0.16) because the stop endpoint is a new user-visible
surface, not a fix or doc patch. Backwards-compatible — existing
`/kill` and `/respawn` endpoints unchanged.

## [0.15.6] — 2026-06-17

### Changed

- Normalised the `BRAND_SVG` font-family string to match vyzr's canonical
  format (`'Noto Sans Mono', 'Courier New', monospace` — spaces after
  commas). No visual change — browsers ignore whitespace in CSS
  font-family lists — just keeps the Cordfuse PWA family source-level
  consistent so future cross-repo audits don't flag a false positive.

## [0.15.5] — 2026-06-17

### Fixed — PWA identity collision with vyzr (and any other Cordfuse PWA)

Operators with vyzr (or any other Cordfuse PWA) already installed from
the same tailnet origin couldn't install llmux as a separate PWA —
Chrome's "Add to Home Screen" handler treated the second install as a
reopen of the first app. Cause: neither manifest declared an explicit
`id` field, so both fell back to the derived `id = start_url = "/"`,
which collides at the (origin, id) level Chrome uses for app identity.

Fix: add `id: "/?app=llmux"` to the manifest. Distinct from any
other Cordfuse PWA's derived `/` id, doesn't change routing (the
query is unused by the daemon), and the manifest is otherwise
unchanged.

Operators will need to **re-attempt the install** after the daemon
upgrade — the browser caches the manifest mapping for already-failed
installs.

(Worth noting: vyzr's manifest also doesn't ship an `id`. Adding one
there too — separate repo, separate change — would prevent future
collisions with any *next* Cordfuse PWA. Out of scope for this
patch.)

## [0.15.4] — 2026-06-17

### Changed — brand mark aligned to Cordfuse PWA family

Replaced the multiplex-fan geometric mark (favicon + PWA icon) with a
bracketed monogram `{Lm}` rendered in monospace bold, matching the
visual language of the Cordfuse PWA family (e.g. vyzr's `{Vz}`). Same
512×512 rounded-square template, ~17.6% corner radius, subtle
sky-blue border at 22% opacity.

Color scheme stays with llmux's existing palette so the brand identity
holds across the rest of the UI: dark-navy backplate (#0b0c10) and
sky-blue accent (#7cc4ff) — visibly distinct from vyzr's cyan/navy
pairing (#22d3ee on #131c2e).

Both `FAVICON_SVG` and `PWA_ICON_SVG` collapsed to a single shared
`BRAND_SVG` constant — the same vector source scales cleanly from
16×16 browser-tab favicon to 512×512 home-screen icon. Verified
rendering at 32 / 192 / 512 via `rsvg-convert`.

## [0.15.3] — 2026-06-17

### Documentation

- Cropped the grey letterbox out of the mobile gif. Pixel 7 emulation
  reported a 412×915 viewport but the bottom ~78px past y=839 was
  outside the rendered viewport (system-nav-area placeholder, mid-grey
  `#7F7F82`). Trimmed to 412×836 so the gif ends on the soft-keyboard
  toolbar instead of an empty grey strip. ~2.2 MB still.

## [0.15.2] — 2026-06-17

### Documentation

- Corrected the Problem section. v0.15.1 said "There's no way to attach
  remotely" — false. SSH + tmux works fine, Claude has cowork and
  remote-control, etc. The actual gap llmux fills is **the unified
  addressable layer above the agent CLIs**, not remote access itself.
- New problem framing: each agent CLI is reachable but on its own terms,
  with a CLI-specific surface. There's no unified place a spec-driven
  pipeline, a scheduled job, or a multi-agent chain can talk to that
  treats every agent the same way. Llmux's contribution is the surface,
  not the access.
- Added a closing parenthetical noting that the sessions are real tmux
  and existing SSH + tmux flows still work as-is — llmux *adds* a
  surface, doesn't replace what was there.

## [0.15.1] — 2026-06-17

### Documentation

- **Problem / Solution opener.** Replaced the dense lede paragraph with
  an explicit `## Problem` / `## Solution` pair, framed entirely around
  operational pain (multi-terminal alt-tabbing, no phone access, no
  remote attach, OAuth on headless servers) and operational fix (named
  tmux sessions exposed over REST/WS/PWA, phone as first-class client,
  attach-from-phone OAuth). Zero billing / `-p` references.
- **CLI gif now includes a real attach demo.** The vhs tape was
  extended with a final `llmux session attach codex` segment that
  shows the Codex TUI taking over the screen (banner, model picker,
  prompt buffer) and then a clean `Ctrl-b d` detach back to the
  shell prompt. ~30 s total. Needed a `unset TMUX TMUX_PANE` in the
  hidden setup block because vhs itself runs inside tmux and the
  inherited `TMUX` env had been pushing the local handler into
  `switch-client` mode instead of `attach-session`.
- **Mobile gif now shows tap markers.** Pulsing blue rings appear at
  each tap location to signal user intent (mobile-emulated browsers
  have no cursor). Markers are burned in via `ffmpeg overlay` filter
  in post — in-browser CSS markers rendered fine in Playwright
  screenshots but were eaten by Chromium's video-recording pipeline.

## [0.15.0] — 2026-06-17

### Documentation — README pivot

Dropped the explicit `claude -p` comparison subsection from the README
opener and the orchestration paragraph that framed llmux as a scriptable
alternative to the upstream agents' headless modes. The new structure
leads with operational benefits — multi-session driving, mobile PWA,
OAuth-on-headless, addressable surface for higher-level patterns —
without naming or implicitly contrasting against any provider's
programmatic billing surface.

Why: comparing against `-p`-style modes invites the kind of pedantic
"this is just X with extra steps" pushback that derails the substance,
and any framing that reads as "use llmux to avoid provider billing" is
needless reputational/abuse-team risk. The peer project in this niche
(ccmux) walks the same operational-only path and the category appears
stable under that framing. No code paths changed — just framing.

### Documentation — gif hero

Replaced the three static phone screenshots with two real gif
recordings against the live daemon:

- `docs/demo/cli.gif` — 23 s CLI tour (version, agent catalog,
  session list, no-LLM prompt, JSON surface). Recorded via `vhs`
  against `localhost:3030`.
- `docs/demo/mobile.gif` — 14 s mobile PWA flow (picker → tap row
  → attached xterm with soft-keyboard toolbar). Recorded via Playwright
  driving Chromium with Pixel 7 device emulation against the live
  picker (auth via SAS deep-link).

Both embedded via absolute `raw.githubusercontent.com` URLs so the npm
package README page renders the same as GitHub. Old static screenshots
left in `docs/screenshots/` for now — no harm, may be repurposed.

## [0.14.1] — 2026-06-17

### Changed — proper brand mark

Replaced the placeholder 2×2 blue-grid icon (favicon + PWA) with the
**multiplex fan** mark: one larger anchor circle at top (the daemon)
diverging into three lines to three smaller endpoint circles (the
agents). Reads as "one dispatcher → many agents" — the product
proposition in one glance.

Both `FAVICON_SVG` and `PWA_ICON_SVG` updated. Geometry holds inside
the central 80% of the viewBox so Android's adaptive-icon masks
(circle, squircle) don't crop the anchor or endpoints. Same dark-navy
backplate (#0b0c10) and sky-blue accent (#7cc4ff) as before, so
nothing else in the UI needed to change.

Verified by rendering both at 32×32 (favicon native) and 192×192
(home-screen icon) via `rsvg-convert` — mark stays legible at both
ends of the size range.

## [0.14.0] — 2026-06-16

### Added — picker is now a PWA

The browser picker is installable as a Progressive Web App. "Add to
Home Screen" in Chrome (Android) or Safari (iOS) and llmux launches
standalone — no browser chrome, splash screen, OS task-switcher entry,
status-bar theming.

**Endpoints added** (all unauthenticated so the browser can discover
them before the auth gate):

- `GET /manifest.webmanifest` — full PWA manifest (name, scope,
  start_url, theme/background colors, icons array with `any` and
  `maskable` purposes).
- `GET /sw.js` — minimal service worker. Network-first for everything,
  caches the picker shell + manifest for offline-fallback shell loads.
  Skips `/api/*` and `/ws/*` paths so live daemon state never gets
  served stale.
- `GET /icon-192.svg`, `GET /icon-512.svg` — vector icons (same 2×2
  grid as the favicon, repainted for adaptive-icon padding so Android's
  squircle/circle masks don't crop).

**HTML head tags added** to the picker page only (chat / gate pages
don't need them — they're sub-routes of the installed app):

- `<link rel="manifest">`
- `<meta name="theme-color">`, `application-name`, `mobile-web-app-capable`
- Apple-specific: `apple-mobile-web-app-capable`,
  `-status-bar-style`, `-title`
- Inline SW registration `<script>` (load event, no-op on failure)

No code changes outside `web/server.ts`. All existing flows
(authentication, WebSocket attach, REST API, deep-link auth) unchanged.

## [0.13.7] — 2026-06-16

### Documentation

- Added an orchestration paragraph at the bottom of the "Headless ≠
  `claude -p`" section. Calls out spec-driven development (SDD)
  pipelines, multi-agent chains, scheduled jobs, and evals as the
  natural higher-level patterns llmux enables — all reducing to plain
  `llmux session prompt` calls against live agents. Frames llmux as the
  substrate orchestration layers sit on top of, not as an orchestration
  framework in itself.

## [0.13.6] — 2026-06-16

### Documentation

- Reverted the v0.13.5 cost-framing of the "Headless ≠ `claude -p`"
  section. Making cross-provider billing claims in the README invites
  pedantic correction and dates fast — Anthropic's OAuth-vs-API
  boundary has shifted multiple times, ChatGPT Plus and the OpenAI API
  are already separate products, etc. Better to stick to mechanically
  verifiable claims (state behavior, OAuth flow) than make claims about
  someone else's billing model.
- Restored the state-and-mechanics framing from v0.13.3, but dropped
  the "Each call starts cold" line per the earlier objection — same
  facts, less editorialised.

## [0.13.5] — 2026-06-16

### Documentation

- Rewrote the "Headless ≠ claude -p" section to lead with the **real**
  differentiator: cost. v0.13.3 framed it as a state-and-mechanics
  story ("each call starts cold, no /commands, no MCP context"). The
  actual reason llmux exists is billing: even OAuth-authed `-p`-style
  calls now route to the metered API bucket on every major provider
  (Claude Pro/Max, ChatGPT Plus, Gemini Advanced, …), so scripting
  with `-p` tacks per-token dollars onto your flat subscription.
  Interactive use stays on the subscription billing path; llmux is the
  bridge that lets you script the interactive process. The state
  benefits are now a one-line addendum rather than the headline.
- Section title swapped to a direct claim ("`claude -p` is metered.
  llmux isn't.") instead of a vague comparison.

## [0.13.4] — 2026-06-16

### Documentation

- Fixed wrong claim in README opener. v0.13.3 said "One named tmux
  session per agent" — implying a 1:1 mapping. The truth is each
  spawn becomes its own named tmux session and you can run as many of
  any agent as you want — three `claude` sessions in three different
  repos, fifteen of each, no cap and no shared state across them.
  Verified by spawning three claude sessions side-by-side and confirming
  they live as independent tmux sessions with separate cwd / flags /
  conversation.

## [0.13.3] — 2026-06-16

### Documentation

- README opener now spells out the two real differentiators that the
  previous "what is llmux" pitch glossed over:
  - **Headless driving of the interactive agent process** vs `claude -p`
    (or codex/gemini equivalents). Calls out that `-p`-style modes
    spawn cold short-lived children — no shared conversation, no
    in-session OAuth, no `/commands`, no persistent tool state, no MCP
    context. llmux sends keystrokes to a live interactive agent in
    tmux so state carries across prompts.
  - **OAuth on a headless host using your phone.** Spawn an
    OAuth-requiring agent (claude / codex / gemini / agy) on a
    browserless server, attach from the phone picker over Tailscale
    HTTPS, complete the browser flow on the phone, detach. Session
    stays authed forever. Same trick for token refresh.
  - **Phone-as-primary-driver** angle hardened — same surface for OAuth
    and everyday use, no "mobile app," just a WebSocket-served xterm
    with the soft-keyboard toolbar.

## [0.13.2] — 2026-06-16

### Fixed

- License badge in README header. The dynamic `shields.io/npm/l/...`
  endpoint was returning 504 through GitHub's camo image proxy
  (shields.io's npm-registry license lookup is intermittently flaky),
  so the badge rendered as a broken image. Swapped for the static
  `shields.io/badge/license-MIT-blue` URL — no npm call, no flaky
  dependency. The other three badges (version / downloads / node) keep
  reading npm registry data and were unaffected.

## [0.13.1] — 2026-06-16

### Documentation

- Added shield badges to the README header: npm version, monthly
  downloads, license, minimum node engine. All four read directly from
  the npm registry / package metadata via shields.io — no VERSION file
  to maintain, no drift risk, single source of truth stays in
  `packages/llmux/package.json` (mirrored to npm on publish).

## [0.13.0] — 2026-06-16

### Added — `.llmux.yaml` actually does something

The YAML config has been *defined* in `config.ts` since the original
scaffolding but was never read by any code path. The README quietly
promised it overrode per-agent defaults; it didn't. This release wires
the subset that's coherent today.

**Now wired:**

- `agents.<key>.cmd` — replaces the agent's binary at spawn time
- `agents.<key>.flags` — replaces the agent's default launch flags
- `server.port` — fallback when no `--port` flag and no `LLMUXD_PORT`
  env (precedence: flag > env > YAML > 3000 schema default)

**Discovery order unchanged:** `--config <path>` flag → `./.llmux.yaml`
in cwd → `~/.config/llmux/config.yaml` → `LLMUX_CONFIG=<path>` env.

**Reserved but still inert** (documented as such in the README so
operators don't waste time setting them): `agents.<key>.readyPrompt`,
`server.{token,tokenExpiry,noQr}`, `sessions[]` auto-spawn list. These
have no consumers; the schema is preserved so future wiring won't break
existing configs.

### Added — `tests/` directory

Three test scripts persisted from this session's verification work:

- **`tests/cli-read.sh`** — ~46 read-only CLI assertions
- **`tests/cli-write.sh`** — ~28 write-op assertions in both local and
  remote mode, runs against an isolated daemon on :13030 with its own
  `XDG_STATE_HOME` (operator's :3030 daemon untouched). $0 — uses
  `claude --cwd /tmp` and `--no-enter` so no LLM calls.
- **`tests/attach-smoke.py`** — WebSocket attach + Ctrl+] detach
  regression check (catches the v0.12.4 hang regression).

Not wired into CI yet — needs a real `claude` binary and a graphical
tmux host; appropriate for local-dev runs and pre-release smoke. See
`tests/README.md`.

## [0.12.4] — 2026-06-16

### Fixed

- `llmux session attach <name>` over `--server` no longer hangs after
  Ctrl+]. The detach handler closed the WS and reset raw mode but didn't
  pause or unref stdin, so Node's event loop stayed alive on a TTY that
  was still actively listening — operator would see `[detached]` and
  then have to Ctrl+C to get their shell back. `teardown()` now calls
  `stdin.pause()` + `stdin.unref()` after closing the socket; detach lag
  measured 0.01 s post-fix versus the prior ~5 s hang.

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
