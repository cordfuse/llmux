# llmux v2 — System-Mode + Full User Authentication

> Status: **design draft**, branch `feat/auth`. Target release: **v2** (long-horizon, after v1.x stabilises).
>
> This document describes the system-mode rewrite of llmux that brings real multi-tenant authentication.

## TL;DR — what v1.x has vs what v2 brings

| Concern | v1.x (current direction) | v2 (this doc) |
|---|---|---|
| Daemon process owner | OS user (single operator) | System service user (`llmux`), spawns per-user workers |
| User accounts | None | Real: username + passphrase + scrypt hash |
| Network auth | Existing SAS tokens (gates access, no identity claim) | Identity-bound tokens (every action knows the user) |
| Human actors on the bus | Exactly one (`data/actors/operator.md`, shipped by `orch init`) | One per user, auto-derived from the user record |
| Machine actors | Hand-authored `data/actors/<alias>.md` | Same (machines don't need user accounts) |
| Identity enforcement | None — operator can send as anyone | Server-side: `from:` must match the token's owning user |
| File locations | `~/.config/llmux/`, `~/.local/share/llmux/` (XDG) | `/var/lib/llmux/`, `/etc/llmux/` (system) + `~/.config/llmux/credentials.json` (per-operator) |
| Spawning agents | As the OS user (whoever owns the daemon) | As the **authenticated** user (via `systemd-run --uid`, PAM, etc.) |
| Bootstrap | None | First-run setup wizard (one-time setup token printed to terminal) |

**v1.x deliberately has no new auth code.** The existing SAS token system is network-gating only; identity is the OS user. This document is exclusively about v2.

## Why v2

v1.x's compromise — user-mode daemon + a single operator identity — works for solo developers and small-team collaboration via the multi-daemon pattern (each operator runs their own llmuxd; they share a bus via the orch transport's DR remote). But it doesn't scale to:

- Multiple humans sharing one machine's llmuxd
- Shared workstations / lab machines / dev hosts
- Per-user agent CLI credentials (Claude/Gemini auth tokens live in each user's `~/.claude/`, `~/.gemini/`, etc.)
- Real audit trails — "Alice spawned this session, Bob sent that orch message"
- Real privilege isolation — Alice's tmux sessions shouldn't appear in Bob's `session list`

These are real demands once llmux moves beyond solo use. v2 is the architectural answer.

## What's the right shape — JupyterHub, specifically

The clean Camp B examples (system daemon + real multi-tenant) are narrower than they first appear:

- **sshd** — runs as root, authenticates against OS users, **spawns shells AS the authenticated user**. Real privilege separation per connection.
- **PostgreSQL** — runs as `postgres`, has its own user/role DB, but **doesn't spawn user-owned processes**. The per-user isolation question doesn't arise for Postgres because it just owns data.
- **JupyterHub** — runs as a service, but the actual notebook servers are spawned **AS the authenticated user** via PAM / sudo / `systemd-run --uid` / Docker. The hub does auth + routing; the user-owned server does the work.

Most "system daemon + multiple users" products you might think of (Plex, Jellyfin, Emby) actually adopt the anti-pattern: one OS user owns everything, "users" are labels in a cloud-federated auth backend, no real isolation. They get away with it because they serve content rather than spawn user-owned processes per session. **llmux can't get away with it** — agent CLIs need per-user credentials (`~/.claude/credentials.json`, `~/.gemini/auth.json`), per-user `PATH`, per-user cwd. The hub-and-spoke JupyterHub shape is the only architecture that fits.

## v2 architecture (the system-mode shape)

```
┌────────────────────────────────────────────────────────────────────┐
│ llmuxd (system service, runs as user `llmux`)                      │
│                                                                    │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │ Auth + routing layer                                     │    │
│   │   - HTTPS listener (port 3001 by default)                │    │
│   │   - User store (/var/lib/llmux/users.json)               │    │
│   │   - Token store (/var/lib/llmux/tokens.json)             │    │
│   │   - Setup wizard, login, session cookies                 │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                    │
│   For each authenticated request: spawn / route to user worker     │
│           │                              │                         │
│           ▼                              ▼                         │
│   ┌──────────────────┐         ┌──────────────────┐                │
│   │ Worker (uid=alice)         │ Worker (uid=bob)                  │
│   │   - tmux sessions belong to alice                              │
│   │   - agent CLIs read ~alice/.claude/ etc.                       │
│   │   - cwd = alice's homedir or wherever                          │
│   │   - per-user state in ~alice/.local/share/llmux/               │
│   └──────────────────┘         └──────────────────┘                │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

The hub IS llmuxd-the-service. Per-user workers are spawned via one of:

- `systemd-run --uid=<uid> --gid=<gid> --pty -- <command>` (Linux, systemd hosts)
- `sudo -u <user> -i -- <command>` (POSIX fallback)
- `runuser -u <user> -- <command>` (RHEL family)

Workers either talk back to the hub over a Unix socket, OR they ARE short-lived helpers spawned per-action. v2 design decision deferred to implementation pass: long-lived per-user worker vs spawn-per-action.

## Data plane (v2)

| Store | Path | Owner | Permissions | Contents |
|---|---|---|---|---|
| Daemon config | `/etc/llmux/config.yaml` | `root:llmux` | `0640` | Listen port, TLS cert paths, transport location, user-store path |
| User store | `/var/lib/llmux/users.json` | `llmux:llmux` | `0600` | `[{username, name, passphraseHash, admin, createdAt}]` |
| Token store | `/var/lib/llmux/tokens.json` | `llmux:llmux` | `0600` | `[{tokenId, secretHash, username, name, createdAt, expiresAt?, lastUsedAt}]` |
| Orch transport (default location) | `/var/lib/llmux/orchestration/` | `llmux:llmux` | `0750` | Shared git repo; actor files contributed by all users |
| Per-user runtime state | `~/.local/state/llmux/` | each OS user | `0700` | Tmux sessions, claims, cursors — owned by the worker's uid |
| Operator credentials (per machine) | `~/.config/llmux/credentials.json` | each OS user | `0600` | `{server, username, name, token}` |
| Daemon logs | `/var/log/llmux/` or journald | `llmux` | journald gates by group | Audit log: every action records tokenId + resolved username |

**Why the transport is shared (single `/var/lib/llmux/orchestration/`):** the whole point of orch is multi-actor collaboration. If each user had their own transport, you'd lose the shared bus. Per-user opt-out is possible (user can `llmux orch use --path ~/private-transport` for a per-user private bus), but the system default is the shared one.

## User model (v2)

A **user** is the canonical identity:
- `username` — stable identifier (and orch alias)
- `name` — display label
- `passphraseHash` — `scrypt`-hashed, never plaintext on disk
- `admin: bool` — admin can create / delete other users
- One user owns exactly one orch alias (matching their username) **in v2.0**; multi-alias-per-user is a v2.1+ extension if real demand surfaces

**Human actor markdown files retire.** v1.x's `data/actors/<alias>.md` with `species: human` was a placeholder for what v2 calls "users." On migration, those files are auto-derived from the user record (or deleted entirely, depending on the migration path chosen at implementation time). **Machine actor markdowns stay** — bots don't have user accounts.

This collapses two concepts in v1.x into one in v2: "human actor on the bus" == "user of the daemon." Cleaner.

## Token lifecycle (v2)

| Aspect | Decision |
|---|---|
| Default expiry | None (long-lived). Operator opt-in to expiry per-token. |
| Identity binding | Every token has exactly one owning user. Daemon enforces `from:` matches owning user. |
| Token holder can't impersonate other users | **Enforced server-side** on every API call with a `from:` field |
| Revocation | Web UI + `llmux token revoke <id>`. Next CLI call 401s. |
| `LLMUX_TOKEN` env var | Always overrides the credentials file. For CI / headless / one-off. |
| Audit log | Every action records `tokenId` + the resolved username. |

## Setup wizard — what invokes it (v2)

A boot-time check in llmuxd, gated by a one-time setup token:

1. On `systemctl start llmux`, daemon reads `users.json`.
2. If empty (or missing) → mint a one-time setup token; write to a path readable only by `root` and the operator group:
   ```
   /var/run/llmux/setup-token         (owner root:llmux, mode 0640)
   ```
   And **print the URL to stdout / journal** for operators with terminal/journal access:
   ```
   llmux: first-run setup needed.
   Visit: https://llmux.local:3001/setup?token=stp_a8f3e7d2…
   Token also readable at /var/run/llmux/setup-token by root or llmux group.
   ```
3. On every incoming request, before the auth gate:
   - If no users exist AND path is `/setup` or `/api/setup` AND setup token valid → serve the wizard
   - Else if no users exist → 503 / "setup needed" landing page
   - Else → normal auth flow

The token gate is necessary because the daemon listens on the network by default. Same pattern as JupyterHub's initial token, `wg genkey`, code-server's `--auth password` first-run.

### The wizard

```
Name:        Steve Krisjanovs
Username:    steve              ← OS account username (must exist on host)
Passphrase:  ******
Passphrase:  ****** (confirm)
```

Three fields:
- **Name** — display name
- **Username** — must match an existing OS user on the host (v2 strict requirement, because workers are spawned `--uid=<this-user>`)
- **Passphrase** — `scrypt`-hashed

On submit:
1. Validates the OS user exists (`getpwnam`)
2. Creates user record in `users.json`
3. Mints bootstrap token (admin-class)
4. Issues session cookie
5. **No human actor file created** — the user IS the identity
6. Setup token destroyed
7. Redirect to `/`

### Non-interactive bootstrap

```sh
LLMUX_INIT_USERNAME=steve \
LLMUX_INIT_NAME="Steve Krisjanovs" \
LLMUX_INIT_PASSPHRASE=<from-secret-store> \
systemctl start llmux
```

For containers, kickstart installs, CI environments.

## CLI surface (v2)

| Verb | Purpose |
|---|---|
| `llmux auth login` | Interactive: server URL + username + passphrase → mint token → write credentials.json |
| `llmux auth logout` | Delete credentials.json (token stays valid until revoked) |
| `llmux auth status` | Print current user, server, token id |
| `llmux auth passwd` | Change own passphrase (re-prompts old) |
| `llmux user create <username>` | Admin: create a user (must be existing OS user). Prompts passphrase. |
| `llmux user list` | List users (admin sees all; non-admin sees self) |
| `llmux user delete <username>` | Admin: delete user + revoke tokens |
| `llmux user reset-passphrase <username>` | Admin: reset another user's passphrase |
| `llmux token create [--user <u>]` | `--user` admin-only; otherwise mints for the calling user |
| `llmux token list` | Show owning user + admin flag |
| `llmux token revoke <id>` | Revoke a specific token |

All session/orch verbs inherit identity from the credentials file; no per-verb change.

## Web UI (v2)

- `/setup` — first-run wizard (token-gated)
- `/login` — username + passphrase form
- `/account` — name + passphrase change
- `/admin/users` — admin-only user CRUD
- Existing `/` (sessions), `/orch`, etc. — unchanged surface, but every action now resolves to a user identity

## Operator workflows (v2)

| Flow | Prompt? | What happens |
|---|---|---|
| First-run web visit | Yes, one-time | `/setup` wizard with the setup-token gate |
| First `llmux auth login` after setup | Yes, one-time per machine | Stores credentials.json |
| Subsequent CLI calls | **No** | Token loaded from credentials file |
| Subsequent web visits | **No** | Cookie persists |
| Daemon restart | **No** | Tokens are persisted; cookies still valid |
| Token revoked | Deferred yes | Next CLI call 401s with a clear message |
| New device pairing | Yes | `llmux auth login` on the new device; or QR-pair from existing device |
| Switch identity | Yes | `llmux auth login` overwrites credentials.json |
| One-off identity override | **No** | `LLMUX_TOKEN=<other-token> llmux ...` |
| Mint a new token / change passphrase / admin actions | Yes | Re-prompt passphrase (defense-in-depth) |
| Forgot passphrase | Shell recovery | `sudo llmux user reset-passphrase <username>` |

The "never nag" guarantee: operator types passphrase **twice in lifetime per machine** (setup + auth login). Sensitive admin actions add a third time per action. Everything else is token-bearing.

## What's NOT in this design (v2 non-goals)

- **No SMTP / password-reset emails.** Lost passphrase = shell-access recovery.
- **No self-registration.** Admin-only user creation.
- **No federation / SSO / OAuth.** Out of scope.
- **No 2FA / TOTP** in v2.0. Could add WebAuthn in v2.x if real demand.
- **No password complexity rules.** Operator's call.
- **No multi-alias-per-user in v2.0.** One user, one alias. v2.x extension if needed.

## Migration from v1.x

When an operator upgrades from v1.x to v2:

1. v1.x state at `~/.local/share/llmux/orchestration/` and `~/.local/state/llmux/`
2. v2 install creates `/var/lib/llmux/` system tree
3. **Migration path TBD at implementation time** — likely options:
   - Auto-move the v1.x transport to `/var/lib/llmux/orchestration/`, change ownership to `llmux:llmux`, transfer the operator's `operator.md` actor → user record
   - OR keep the v1.x transport in user's home, run a per-user daemon mode for legacy installs
   - OR explicit migration verb: `llmux migrate-to-v2 --confirm`

This is the right place to make a clean break — v2 is a major version bump for good reason.

## Build plan (v2 sprint, when scheduled)

| Phase | Deliverable |
|---|---|
| 1 | This design doc + agreed scope |
| 2 | System-mode skeleton: systemd unit, `/etc/llmux/config.yaml`, `/var/lib/llmux/` layout, drop privileges on startup |
| 3 | User store + passphrase hashing (`crypto.scrypt`, CRUD) |
| 4 | Token-bound identity (every token has an owning user) |
| 5 | Per-user worker spawn (`systemd-run --uid=...` for tmux sessions, agent CLIs) |
| 6 | Setup wizard (token-gated boot-time check + `/setup` page + `/api/setup`) |
| 7 | `llmux auth login` + credentials file |
| 8 | API-level `from:` enforcement on orch endpoints |
| 9 | `/login` + `/account` + `/admin/users` web pages |
| 10 | CLI verbs: `auth`, `user`, extended `token` |
| 11 | Migration tool (v1.x → v2) |
| 12 | End-to-end smoke: install → setup → users → tokens → per-user sessions → orch enforcement → revocation |
| 13 | Release as v2.0; document migration |

Estimated effort: real multi-week sprint. JupyterHub-shape is not a v1.x add-on; it's a v2 rewrite. Trigger conditions for starting it:
- Real multi-tenant demand (a team of people wanting to collaborate via one llmuxd)
- OR a deployment context where system-mode is required (shared dev box, lab, CI host)

Until then, v1.x's user-mode + multi-daemon pattern is the answer.

— cachy, 2026-06-21
