# llmux Orchestration — Design

> Status: **draft**, branch `feat/orchestration`. Target release: **v1.0.0** (the "feature-complete enough to drop the leading 0" moment). Cherry-picked from `cordfuse/crosstalk` v7's engine; crosstalk continues independently as the cross-machine + headless-invocation variant.

## Problem

llmux today runs **one agent per tmux session**. Sessions are isolated — there's no first-class way for one session's agent to send a message to another and get a reply. Operators wire it up by hand (paste, send-keys, manual nudging).

We want a **single-host orchestration layer baked into llmux** so sessions can exchange messages durably, with at-least-once delivery and dedup, **without** needing to spin up a separate transport service (crosstalk) and without crossing the user/system privilege boundary.

Steve's framing — *"an instance markdown says 'run a subagent that watches for git-transport messages and acts on the ones broadcast or targeted for this llmux session.'"* The watcher = the agent's own read-act-write rhythm; the dispatcher = a small in-process loop inside llmuxd.

## How we got here

Spitballed across two design rounds (mac+Steve, then me+Steve, 2026-06-20):

1. **First round** considered SQLite-in-dotfolder. Rejected after deeper review: SQLite is mutable by default, so recovering git's "cumulative-for-free" property required adding events tables, claim TTLs with heartbeat extension, migrations, bespoke debug tooling. At human poll rates, SQLite's perf win isn't material; the schema overhead exceeded the benefit.
2. **Second round** considered bridging crosstalk (system-level) and llmux (user-level) via an adapter. Rejected: crosstalk's design is system-level (`/var/lib/crosstalk-*`, multi-user-eventually), llmux is per-user. Bridging means cross-privilege config references and a `runtime: llmux` flag in crosstalk's models.yaml that points at user-side instance config. Structural impedance.
3. **Landed:** lift the bits from crosstalk that work, drop them into llmux as a user-mode, single-host, single-dispatcher orchestration engine. Git transport in llmux's dotfolder, with an **optional remote for disaster recovery only** (one-way mirror, no pull-rebase semantics needed).

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ llmuxd (user-mode, single per-operator)                       │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ tmux sessions (interactive agents)                     │   │
│  │ ┌─────────┐ ┌─────────┐ ┌─────────┐                    │   │
│  │ │ session │ │ session │ │ session │  ← agents call     │   │
│  │ │ (alias  │ │ (alias  │ │ (caller)│    `llmux orch ...`│   │
│  │ │  bot-a) │ │  bot-b) │ │         │    from bash tool  │   │
│  │ └────┬────┘ └────┬────┘ └────┬────┘                    │   │
│  └──────│───────────│───────────│────────────────────────┘    │
│         ▼           ▼           ▼                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Orch CLI: `llmux orch <verb>`                        │    │
│  │   inbox · send · reply · release · status · init     │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       ▼                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ packages/llmux/src/orch/  (cherry-picked + refactored│    │
│  │ from crosstalk/engine/src/)                          │    │
│  │   dispatch.ts · transport.ts (local git only) ·       │    │
│  │   resolve.ts · frontmatter.ts · filenames.ts ·       │    │
│  │   replies.ts · activation.ts · state.ts              │    │
│  │   + optional async backup-push                       │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       ▼                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Git repo: $XDG_CONFIG_HOME/llmux/orchestration/      │    │
│  │   data/channels/<channel>/YYYY/MM/DD/HHMMSSmmmZ-..md │    │
│  │   data/cursors/<alias>                                │    │
│  │   (optional remote: `git remote add origin <url>` —  │    │
│  │    push-only, async, for DR only — NOT for sync)     │    │
│  └──────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────┘
```

## What gets cherry-picked from `cordfuse/crosstalk`

Source path: `cordfuse/crosstalk/engine/src/` → `cordfuse/llmux/packages/llmux/src/orch/`. **One-time fork**, not a sync. llmux owns its copy after the cherry-pick and can diverge freely.

| Source module | Take? | Refactor on landing |
|---|---|---|
| `dispatch.ts` (461 lines) | yes | drop multi-dispatcher coordination (`dispatchers.ts` collaborator); drop heartbeat-to-`/var/lib/crosstalk-state`; route logs through llmuxd's log buffer |
| `transport.ts` (236 lines) | yes — **heavy trim** | drop `gitPull`/`recoverInterruptedGit`/push-conflict-retry (no remote sync); keep `cursorBaseline` and `newFilesSince`; add `backupPushAsync` (~30 lines) |
| `resolve.ts` (100 lines) | yes | alias resolution as-is; "model" → "alias" rename for llmux semantics |
| `frontmatter.ts`, `filenames.ts`, `replies.ts`, `activation.ts`, `state.ts` | yes | rewire state paths from `/var/lib/crosstalk-state` → `$XDG_STATE_HOME/llmux/orch/` |
| `channel.ts`, `run.ts`, `stop.ts` | maybe | TBD per first-pass scope |

## What does NOT come from crosstalk

| Source module | Why not |
|---|---|
| `invoke.ts` (headless `claude --print` spawning) | llmux already runs agents in interactive sessions; agents act via their own runtime, not via dispatcher-spawned subprocesses |
| `models.ts` (yaml registry) | llmux's instance config IS the registry — each instance has an `orch_alias` field; no separate yaml |
| `workflow.ts` (state machines) | out of scope for v1.0; prompt-level concern |
| `dispatchers.ts` (multi-dispatcher coordination) | single-host = single dispatcher; no coordination needed |
| `api.ts` (HTTP server) | llmux already exposes HTTP; orch is a sub-noun of the existing API |
| `init.ts`, `status.ts`, `up.ts`, `down.ts` (operator CLI) | replaced by `llmux orch <verb>` |

## Net size estimate

Cherry-pick ~800 lines from crosstalk's ~3000-line engine, simplify to ~500-600 lines as it lands in llmux. Plus ~150 lines of new code for the optional async backup-push and the `llmux orch` CLI surface.

## Local-git semantics

The dispatcher operates on a normal git repo at `$XDG_CONFIG_HOME/llmux/orchestration/`. Single writer (llmuxd is the only process making commits); commits are atomic via git's index lock. No remote required.

### Optional remote (DR only)

```
llmux orch init [--remote git@github.com:you/llmux-orch-backup.git]
```

If a remote is configured:
- After each commit (or debounced every N seconds, configurable), llmuxd kicks an **async background `git push`**.
- Push failures are logged but never block the dispatcher. The local repo is the source of truth; the remote is a snapshot.
- **No `git pull`**, ever. The remote is write-only from llmux's perspective.
- Restore: operator manually `git clone <url> $XDG_CONFIG_HOME/llmux/orchestration` after disaster.

This means the remote uses standard SSH/HTTPS git auth (whatever the operator's git already uses) — no new auth path to invent.

## Message addressing (mirrors crosstalk's PROTOCOL)

- `to: <alias>` — addressed to a specific participant
- `to: all` — broadcast (all alive watchers see it; claim race resolves)
- `re: <msg_id>` — reply to a previous message (links into a thread)
- Filenames: `data/channels/<channel>/YYYY/MM/DD/HHMMSSmmmZ-{8hex}.md` (crosstalk's filename scheme verbatim — chronological, collision-free, sortable)
- Frontmatter: `from`, `to`, `re`, `at`, optional kind/payload fields

## Participation: how an llmux instance becomes orchestratable

1. **Instance config gets `orch_alias?: string`**. If set, the instance is addressable on the bus.
2. **System-prompt stanza** auto-injected for instances with an alias:
   ```
   You are participant `<alias>` in the llmux orchestration bus.
   Inbox poll:  llmux orch inbox --alias <alias>
   Reply:       llmux orch reply <msg_id> "<body>"
   Send:        llmux orch send --to <target_alias> "<body>"
   Poll periodically; act on messages addressed to you or broadcast.
   ```
3. **CLI invocation** via the agent's bash tool. No new IPC, no new SDK — the agent shells out to the existing `llmux` binary.

## #1845 carry-over (ephemeral-alias semantics)

First-boot cursor seeds to HEAD. Pre-boot messages to a never-booted alias are not delivered. Same rule we just locked in for crosstalk yesterday; same comment in dispatch.ts.

## Build plan

| Phase | Commit | Deliverable |
|---|---|---|
| 1 | `f...` (this commit) | this design doc + branch rename |
| 2 | next | cherry-pick + simplify the 8-9 modules into `packages/llmux/src/orch/`; local-git transport only (no remote yet); typecheck passes |
| 3 | next | optional async backup-push + `llmux orch init --remote` flag |
| 4 | next | `llmux orch <verb>` CLI surface + instance-prompt stanza wiring |
| 5 | next | smoke test (two simulated sessions + broadcast claim-race + reply round-trip) |
| 6 | release | bump to v1.0.0, PR, merge, tag, publish |

## Crosstalk stays put

`cordfuse/crosstalk` continues as the **cross-machine + headless-invocation** variant. It is NOT deprecated. The two products diverge cleanly:

- **crosstalk** — system-level, multi-host, dispatches headless agents (`claude --print`), git transport with remote sync
- **llmux orch** — user-level, single-host, agents act inside their own interactive sessions, git transport with optional DR-only remote

Cherry-pick is a **fork**, not a sync. After phase 2, llmux's copy of the dispatcher diverges as needed; crosstalk's continues to evolve for its use case. No coupling.

— cachy, 2026-06-20
