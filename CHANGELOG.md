# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
