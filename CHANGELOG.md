# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.3] — 2026-06-16

### Fixed

- **Published tarballs now include README and LICENSE.** Both
  `@cordfuse/llmuxd` and `@cordfuse/llmux` previously shipped tarballs
  containing only `bin/`, `dist/`, `src/`, and `package.json` — npm only
  packs files that exist in the package directory, and the project's
  single README + LICENSE live at the repo root. Result: every npmjs.com
  page since v0.0.1 showed "No README found." The v0.2.2 patch release
  (intended to refresh the README on npm) silently shipped no README at
  all.

  Fix: each package's `prepublishOnly` now copies `../../README.md` and
  `../../LICENSE` into the package directory before build; a matching
  `postpublish` removes them. `packages/*/README.md` and
  `packages/*/LICENSE` are `.gitignore`d as a safety net if publish
  fails mid-flight. Symlinks deliberately not used — Windows clones
  break them.

## [0.2.2] — 2026-06-16

### Changed

- **README restructured problem-first.** Opens on the pain (window-juggling
  N agent CLIs, no broadcast, no phone access) and pays off with the outcome
  before any architecture. Install + quickstart moved above the two-binary
  table — value-before-architecture.
- **Status line corrected.** Previous wording (`scaffold — Phase 1 in
  progress`) was two minors stale. Now reads `v0.2.2 — Phases 0/1/4 shipped;
  Phases 2/3/5–7 pending` and the build-phases list uses `[x]`/`[ ]`
  checkboxes with version numbers so a first-time reader can tell what's
  real today.
- `ccmux` reference dropped from the lede — inside-baseball framing for a
  first-impression doc.

### Note

Code-equivalent to v0.2.1 — patch release exists so the npm package
listing picks up the new README. `npmjs.com` renders the README from
the published tarball, not from `main`.

## [0.2.1] — 2026-06-16

### Added — Phase 4 mobile UX

- **Floating top toolbar** on `/session/<name>`:
  - `←` (back to picker) pinned left; status dot pinned with it.
  - Esc, Tab, **Ctrl**, **Alt**, **Shift** modifier keys.
  - `↑ ↓ ← →` arrow keys.
  - Common shell/dev chars missing from Android `gboard`: `` ` ~ / \ | - _ ``
  - `⋯ All keys` button pinned right.
- **Modifier toggles** — tap once → next key gets the modifier and auto-releases (pending). Double-tap within 400ms → locked. Tap again → off. Visual states: faint blue (pending), solid blue (locked).
- **"All keys" drop-down panel** — numbers `0-9`, brackets/quotes `( ) [ ] { } < > ' "`, operators `= + * & ^ % $ # @ ! ?`, punctuation `: ; , .`, navigation (Home/End/PgUp/PgDn/Del/Ins/Bsp/Enter), F1-F12.
- **Status indicator** — single colored dot in the toolbar (green = live, amber = connecting, red = disconnected). Session name surfaces as a tooltip on the dot.

### Added — viewport responsiveness

- `<meta name="viewport" interactive-widget=resizes-content>` — Chrome Android shrinks the **layout viewport** when the soft keyboard appears (instead of overlaying it), so the terminal stays visible.
- `html, body { height: 100dvh }` — dynamic viewport units, CSS-side responsiveness with no JS round-trip.
- `visualViewport.resize` + `orientationchange` + `visibilitychange` listeners → debounced `fit.fit()` + WebSocket `resize` message to the backend; tmux reflows to the new pane dimensions in real time.
- `@media (orientation: landscape) and (max-height: 500px)` — toolbar buttons compress to fit narrow landscape viewports.

### Fixed

- Touch responsiveness on mobile — removed `touchstart preventDefault` (was blocking scroll/tap disambiguation inside the horizontally-scrollable middle band, causing dropped or random taps). Replaced with `pointerdown preventDefault` (keeps focus on the xterm without breaking scroll) and `touch-action: manipulation` on every button (kills the 300ms double-tap-zoom delay).
- Soft keyboard dropping when toolbar buttons are tapped — every toolbar button now has `tabindex="-1"` so focus stays pinned to xterm's hidden textarea.
- Mask-image gradient on the scroll container was visually dimming edge buttons (Tab, ↑) making them look disabled. Dropped the mask.
- Title text was redundant (also in URL bar and tmux's bottom status line) and either truncated awkwardly (`agyde…`) or collapsed to zero width via flex shrink. Removed the text; status dot stays.

### Changed

- Toolbar layout switched from single scrolling row to **pinned ends + scrolling middle**: `←` + status pinned left, `⋯` pinned right, all keys in between in a horizontal scroller.
- "Status badge" absolute element removed; status moved to the toolbar dot.

## [0.2.0] — 2026-06-16

### Added
- **Phase 4 (MVP)** — `llmuxd serve` boots an HTTP + WebSocket server.
  Session picker at `/`, full-screen xterm.js terminal at `/session/<name>`,
  WebSocket bridge at `/ws/<name>` pipes through `node-pty` attached to
  `tmux attach -t <name>`.
- Network discovery banner on `serve` startup: Local + LAN + Tailscale
  CGNAT-detected addresses.
- `/health` JSON endpoint (no auth) — `{ok, sessions}`.
- xterm.js + addon-fit loaded via CDN — no asset bundling.

### Changed
- HTTP + WebSocket switched from `Bun.serve` to `node:http` + `ws`
  package. Reason: `node-pty` prebuilds target Node, not Bun's V8 fork;
  attaching to tmux through node-pty under Bun caused immediate SIGHUP.
  Under Node the round-trip is rock-solid.
- Build now externalises `node-pty` so the native module loads from
  `node_modules/` at runtime (was being bundled and failing to resolve
  its `.node` binary).

### Out of scope (deferred to later phases)
- SAS token auth — currently `serve` prints a "no auth" warning. Phase 3.
- QR codes on the serve banner — Phase 5.
- `llmux chat --browser` (client-side opener) — needs Phase 3 REST.

### Notes
- Manual smoke from cachy: `llmuxd spawn bash --name demo` →
  `llmuxd serve` → browser at the printed Local URL → click `demo` →
  full bash session under xterm.js. PTY input/output and resize work.
- Headless WebSocket test (`/tmp/ws-smoke.ts`) PASS: sends
  `echo SMOKE_OK_$$` and reads it back through the pty.
- `phase4.smoke.test.ts` PASS 4/4 — picker / session page / 404 / health.

## [0.1.0] — 2026-06-15

### Added
- **Phase 1** — real tmux integration. `spawn`, `send`, `broadcast`, `chat`,
  `kill`, `status` now drive actual tmux sessions.
- Session state file at `$XDG_STATE_HOME/llmuxd/sessions.json` (default
  `~/.local/state/llmuxd/sessions.json`) with `0600` perms.
- Session ownership via `LLMUX_SESSION` env injected into spawned sessions;
  `kill --cascade` walks the parent → children tree.
- `spawn`: single agent, comma list, `all` (installed agents only),
  `--name` (single only), `--prefix`, `--cwd`. Conflicts and missing
  installs surface as clean errors.
- `send`/`chat`: target resolves session-name first, then unambiguous
  agent-type; ambiguity surfaces both candidates.
- `status`: reconciles tracked sessions against live tmux state; `--json`
  for scripting.
- `bun:test` smoke suite drives a real tmux session end-to-end (new →
  send-keys → kill).

### Notes
- CI `release.yml` first run for `v0.0.1` failed on npm `404 — package
  does not exist` (the CI `NPM_TOKEN` couldn't create the scoped packages
  from cold). Both packages were manually published from cachy to
  bootstrap the scope. Subsequent CI releases for existing packages
  publish cleanly.

## [0.0.1] — 2026-06-15

### Added
- Initial monorepo scaffold (`@cordfuse/llmuxd` + `@cordfuse/llmux`).
- CLI dispatchers with all subcommand signatures stubbed.
- Bun workspaces, strict TypeScript, MIT license.
- GitHub Actions CI (typecheck + build + smoke) and tag-driven npm publish.

### Notes
- Phase 0 placeholder release — every subcommand prints help correctly but
  exits with "not yet implemented" (exit 70) when invoked. Phase 1 lands
  real `spawn`/`send`/`broadcast`/`chat`/`kill`/`status` next.
