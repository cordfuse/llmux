# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
