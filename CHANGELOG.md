# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.13] — 2026-06-16

### Fixed

- **WebSocket auto-reconnects on return from background.** Android
  Chrome closes idle backgrounded sockets without always firing
  `onclose` on the client side. Symptom: returning to the tab leaves
  the toolbar visually responsive but `safeSend` silently swallows
  send-on-closed errors — buttons do nothing, only a browser refresh
  recovers. Fix: `visibilitychange visible` and `pageshow` now call
  `ensureConnected()`, which checks `ws.readyState` and re-creates the
  WebSocket from scratch if it's not `OPEN`/`CONNECTING`. `term.onData`
  is gated by a `dataPiped` flag so the input pipe is wired exactly
  once across reconnects.

### Changed

- **Shift modifier renders as text `Shift`** instead of the `⇧`
  Unicode glyph. `⇧` (U+21E7 "UPWARDS WHITE ARROW") visually reads as
  another up-arrow; same disambiguation pattern as v0.2.12's
  `⇥` → `Tab`.

## [0.2.12] — 2026-06-16

### Changed — toolbar polish

- **Vertical padding around toolbar rows.** Bar grows 72→84px portrait,
  52→62px landscape. Rows are fixed 32/24px and centered; explicit 8px
  gap between rows. Buttons no longer touch row edges.
- **Tab key renders as text `Tab`** instead of the `⇥` Unicode glyph.
  `⇥` visually reads as a right-arrow with a bar, indistinguishable from
  `→` to a first-time user. Plain text removes the ambiguity.
- **Arrows switched to filled triangles** `▲ ▼ ◀ ▶` (Geometric Shapes
  block). Unicode arrows (`↑↓←→`) render at inconsistent weights across
  fonts — line-arrows in some glyphs, heavy in others. Triangles are
  basic geometric primitives that render identically everywhere.
- **`Home` and `End` added to the top toolbar row** alongside the
  arrows. Line-start / line-end navigation is high-frequency in terminal
  prompts; natural extension of the cursor-movement row. Row now reads:
  `Home ▲ ▼ ◀ ▶ End`.

## [0.2.11] — 2026-06-16

### Changed — mobile UX

- **Toolbar is now two rows.** Top row: full `↑ ↓ ← →` arrow cluster
  (no demoted ↓ — reverts the v0.2.10 split). Bottom row: chrome +
  `Esc Tab Ctrl Alt ⇧` modifiers + `⋯`. Bar height grows from 42 → 72px
  portrait, 34 → 52px landscape — trivial against gboard's ~250px
  footprint. Net effect: every essential key fits without horizontal
  scroll, modifiers stay next to gboard's letter row for fast chords,
  arrows get their own row above.
- **ARROWS section removed from the "All keys" overlay** (redundant
  now that all 4 arrows are in the toolbar).

### Fixed

- **Android tab-switch focus loss — real fix this time.** v0.2.9's
  `setTimeout(term.focus, 120)` was no-op'd by Android Chrome's
  user-activation policy (programmatic `focus()` blocked without a
  recent user gesture). New approach: on `visibilitychange visible`
  and `pageshow`, arm a one-shot capture-phase `touchstart`/`mousedown`
  listener. Next tap anywhere in the document re-focuses xterm, then
  unregisters itself. The optimistic immediate `term.focus()` still
  runs for browsers that don't enforce the policy.

## [0.2.10] — 2026-06-16

### Changed — mobile UX

- **Toolbar arrows reduced to `← →` only.** `↑ ↓` removed from the
  bottom toolbar. Cursor-in-prompt left/right stays one-tap; history
  scroll up/down becomes two-tap (open overlay, hit ↑ ↓ in the new
  ARROWS section). Frequency-tiered: most prompts are horizontal
  editing, history walks are intermittent.
- **New `ARROWS` section at the top of the "All keys" overlay** —
  full `↑ ↓ ← →` group. First section, so vertical nav is
  discoverable in one tap of `⋯`.

## [0.2.9] — 2026-06-16

### Changed — mobile UX, batch

- **Toolbar moved to the bottom of the viewport.** Matches Termux / Blink
  convention. Puts the back-to-sessions button, status dot, modifiers,
  arrows, and `⋯` in the same thumb zone as the soft keyboard. The
  "All keys" overlay opens *upward* from the toolbar; terminal sits at
  the top of the viewport and shrinks from the bottom as the overlay
  opens.
- **Shell chars `` ` ~ / \ | - _ `` moved out of the toolbar into a new
  `SHELL` section at the top of the "All keys" overlay.** Net effect:
  toolbar drops from ~17 hit targets to ~10 — fits without horizontal
  scroll on a normal phone. Two taps to reach shell chars is acceptable
  for a low-frequency tier.
- **Toolbar buttons no longer get squeezed below content size.** Added
  `flex: 0 0 auto` plus a `min-width` bump (34px → 40px in portrait,
  32px → 36px in landscape). The default flex-shrink was letting Ctrl /
  Esc / Alt text overflow their button borders when the row got
  crowded.

### Fixed

- **Android tab-switch dead-key bug.** When the browser tab was
  backgrounded and returned, the xterm hidden textarea stayed blurred
  and keystrokes had no input target. Now `visibilitychange` (visible)
  and `pageshow` both re-focus the terminal after the resize settles.
- **Banner version is real.** `printBanner` was hardcoded to
  `llmuxd v0.2.0` and shipped that string through every release.
  Now reads from the daemon's own `package.json` at startup
  (`@cordfuse/llmuxd` name guard, walks two directory levels to handle
  both `src/` and `dist/` runs).

## [0.2.8] — 2026-06-16

### Changed

- **Mobile "All keys" overlay breathes.** Section header `margin-top`
  bumped from 6px to 14px, inter-button `gap` 4 → 8px, row
  `margin-bottom` 4 → 8px. Sections now visually separate instead of
  butting against each other. Overlay stays capped at 40vh with internal
  scroll; the terminal beneath gets the same usable area as before.
- **Back-to-sessions button glyph** `←` → `⌂`. The previous arrow
  collided with the keyboard left-arrow that sits in the same toolbar.
  House icon reads unambiguously as "go home" with no semantic conflict.
- **`llmuxd attach <session>` is the new canonical verb** for
  interactively taking over a TTY. `llmuxd chat` is kept as a deprecated
  alias for one minor cycle and prints a deprecation warning to stderr
  on use. The verb `chat` primed users to expect a chat composer; the
  action is a TTY takeover, so `attach` is the truer name. Quickstart
  README updated to `attach`.

## [0.2.7] — 2026-06-16

### Fixed

- **Drop `child_process` + `shell: true` for agent-on-PATH detection.**
  `isAgentInstalled` was running `command -v <cmd>` via `spawnSync` with
  `shell: true`, which Node 25+ now flags with
  `DeprecationWarning DEP0190`. Replaced with a pure-Node PATH walk
  using `accessSync(join(dir, cmd), X_OK)`. No shell, no deprecation
  warning, removes the (unused-but-present) shell-injection vector
  along the path that was using a hardcoded agent name.

## [0.2.6] — 2026-06-16

### Changed

- **Debug instrumentation removed from Release workflow.** The mystery
  is solved: every CI Release run since v0.0.1 failed because the
  `NPM_TOKEN` repo secret was set via `printf '%s' '<token>' |
  gh secret set NPM_TOKEN -R cordfuse/llmux --body -` (stdin pipe).
  Under fish shell on cachy, that pipe arrives empty at `gh secret set`,
  so the stored secret value was an empty string. GitHub Actions then
  set `NODE_AUTH_TOKEN=""` and `NPM_TOKEN=""` on every Release run, and
  npm's registry returned 401 on `whoami` and 404 on `publish` (npm's
  quirk: unauthenticated PUT to a scoped package returns 404, not 403).
  The CI mystery wasn't account-2FA, IP allowlist, or token grants —
  the secret was literally empty.
- Fix: secret re-set with explicit `gh secret set NPM_TOKEN -R
  cordfuse/llmux --body '<token>'` form. v0.2.5 was the first
  successful CI publish in this repo's history.
- Debug step + `--loglevel=verbose` from v0.2.5 reverted; workflow is
  back to its clean shape.

## [0.2.5] — 2026-06-16

### Changed (CI debug-only)

- **Release workflow has a debug job** that runs `npm whoami`,
  `npm config get registry`, `npm access list packages`, and dumps the
  effective `~/.npmrc` (token masked) before the publish steps. This is
  diagnostic instrumentation for the recurring CI publish 404 — same
  `NPM_TOKEN` works for `npm whoami` from cachy as user `cordfuse` and
  for `npm publish --dry-run`, but every CI Release run returns
  `404 Not Found - PUT registry.npmjs.org/@cordfuse%2fllmuxd`. The debug
  output identifies whether the runner-side issue is auth (whoami fails)
  or write authorization (whoami succeeds, publish 404).
- `npm publish` steps now run with `--loglevel=verbose` so the full HTTP
  exchange is visible in the log if write authz is the actual issue.

No code changes. Debug steps revert after the CI mystery is solved.

## [0.2.4] — 2026-06-16

### Fixed

- **CI publish now runs lifecycle scripts.** The Release workflow's
  `npm publish` steps were running with `--ignore-scripts`, which skips
  `prepublishOnly` — meaning even with auth working, CI-published
  tarballs would not have included the README + LICENSE just wired up
  in v0.2.3. Flag dropped; lifecycle hooks now fire as designed in CI.
  No security regression — the only scripts in this repo are first-party
  `prepublishOnly`/`postpublish` defined in the package.jsons under our
  own control.

### Note

Co-shipped with a fresh `NPM_TOKEN` rotation in the
`cordfuse/llmux` repo secrets (org-wide read+write, 2FA-disabled). Prior
token had no access to the `@cordfuse/llmuxd` and `@cordfuse/llmux`
packages, which made every Release workflow run since v0.0.1 fail with
`404 Not Found` on `PUT registry.npmjs.org/@cordfuse%2fllmuxd` (npm's
quirk: tokens without access return 404, not 403). This release is the
first CI-published one if the new token takes.

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
