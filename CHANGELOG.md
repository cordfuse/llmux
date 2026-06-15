# Changelog

All notable changes to llmux follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
