# llmux v2 — System-Mode Daemon + Application-Layer Multi-User Auth

> Status: **design draft**, branch `feat/v2`. Target release: **v2** (when the multi-tenant trigger conditions surface — see V1.x vs V2 below).
>
> This document describes the v2 architecture: a single-service-user daemon owning all its own state, with multi-user authentication implemented at the application layer. **The daemon never touches any `/home/*` path.**

## The `$HOME` principle (load-bearing)

**Production v2 daemon NEVER reads or writes any `/home/*` path. Full stop.**

The only legitimate $HOME usage anywhere in v2 is:
1. **The operator's own CLI** reading their own `~/.config/llmux/credentials.json` to send as a bearer token. The daemon never sees this file. Same shape as `~/.aws/credentials`, `~/.kube/config`, `~/.docker/config.json` — those tools' daemons don't touch them either.
2. **Dev mode only** (`LLMUX_V2_DEV=1`) — runs the v2 daemon code AS the operator (not as a separate service user) for testing without sudo. In dev mode, the daemon writing to `~/.local/share/llmux/v2-dev/` is the operator writing to their own home, not "system daemon reaches into a user's home."

Everything else daemon-side lives in `/etc/llmux/`, `/var/lib/llmux/`, `/var/log/llmux/`, or `/var/run/llmux/`. This is the architectural commitment.

## TL;DR — what v1.x has vs what v2 brings

| Concern | v1.x (current direction) | v2 (this doc) |
|---|---|---|
| Daemon process owner | OS user (single operator) | System service user (`llmux`) |
| Multi-user | None — one operator | Application-layer auth (users.json + tokens.json, scrypt-hashed passphrases) |
| Network auth | Existing SAS tokens (gates access, no identity claim) | Identity-bound tokens (every action knows the user) |
| Filesystem reach | User's `~/.local/share/llmux/`, `~/.local/state/llmux/`, `~/.config/llmux/` (user-mode = operator owns own state) | `/etc/llmux/`, `/var/lib/llmux/`, `/var/log/llmux/`, `/var/run/llmux/` — **never `/home/*`** |
| Spawning agents | As the OS user (whoever owns the daemon) | As the `llmux` service user — agent CLI credentials live in `~llmux/.claude/`, `~llmux/.gemini/`, etc., **operator-managed centrally**, not per-llmux-user |
| Tmux | User's tmux server | Single `llmux`-owned tmux server. Sessions tagged with owning user; daemon enforces "Alice sees Alice's sessions" at the API layer |
| Bootstrap | None | First-run setup wizard (one-time setup token printed to terminal/journal) |
| Install | `npm install -g @cordfuse/llmux` | `sudo ./deploy/install.sh` |
| Run | `llmux server start` | `systemctl enable --now llmuxd` |

**v1.x deliberately has no new auth code.** The existing SAS token system is network-gating only; identity is the OS user. This document is exclusively about v2.

## What we considered and rejected

### Rejected: JupyterHub-style per-user worker spawning

Initial v2 framing pointed at JupyterHub (system service that spawns per-user processes via `systemd-run --uid`). Rejected on closer look because:

- Per-user OS isolation is an operational choice, not a requirement for llmux. Agent CLIs don't NEED to run as different OS users — they need credentials + a working directory + the right env.
- llmux's natural fit is **single-service-user + application-layer multi-tenant** — the Postgres / Grafana / Gitea model. These tools run as one OS service user, have their own user databases, and serve multi-user perfectly without ever touching `/home/*`.
- The JupyterHub model would require the daemon to reach into `/home/<authuser>/` for agent credentials — a direct violation of the `$HOME` principle above.
- It's overkill for solo + small-team use, the actual llmux audience.

### Rejected: in-app multi-user auth in user-mode llmuxd (v1.x)

The other temptation: keep llmuxd user-mode and add internal user accounts. This is the **classic anti-pattern**:

- Same OS account = same trust boundary; "users" become vanity labels
- Compromise the OS account → bypass every in-app user
- Worst-of-both: complexity of multi-user auth without any of its benefits

→ v1.x stays single-operator. v2 brings real multi-tenant via the Grafana model.

## What we adopted: the Grafana / Postgres model

Single OS service user owns the daemon. Multi-tenant is implemented entirely at the application layer:
- Users are records in `users.json` (scrypt-hashed passphrases, admin flag)
- Each user has a stable identity / orch alias
- Tokens are identity-bound (every API request knows which user)
- The daemon enforces "Alice can act as Alice" at the request layer
- Agent CLIs run under the service user with operator-managed central credentials
- Tmux sessions are daemon-owned; ownership-tagged by llmux user; daemon enforces per-user visibility

This is exactly Postgres's shape (one `postgres` OS user, internal `pg_user` table, all sessions go through the daemon), Grafana's shape (one `grafana` OS user, internal `users` table, web sessions), and Gitea's shape (one `git` OS user, internal users + per-repo ACLs).

These tools are how multi-user-on-a-shared-daemon SHOULD work. They get the security right without spawning user-owned processes.

## v2 architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ llmuxd (single system service, runs as user `llmux`)               │
│                                                                    │
│   HTTPS/HTTP listener (default :3001) — bearer auth                │
│         │                                                          │
│         ▼                                                          │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │ Per-request auth gate                                    │    │
│   │   - Extract bearer token                                 │    │
│   │   - Validate against /var/lib/llmux/tokens.json          │    │
│   │   - Resolve owning user from /var/lib/llmux/users.json   │    │
│   │   - Pass user identity to handler                        │    │
│   └────────────────────┬─────────────────────────────────────┘    │
│                        ▼                                          │
│   ┌──────────────────────────────────────────────────────────┐    │
│   │ Handlers (orch, sessions, users, tokens, settings, ...)  │    │
│   │   - All scoped to authenticated user                     │    │
│   │   - Daemon-owned tmux server: sessions tagged with user  │    │
│   │   - Agent CLIs spawn AS llmux; creds in ~llmux/.claude/  │    │
│   │   - Per-user views enforced at the SELECT layer          │    │
│   └──────────────────────────────────────────────────────────┘    │
│                                                                    │
│   State: /var/lib/llmux/  (users, tokens, transport, claims)       │
│   Config: /etc/llmux/     (operator-edited, root-owned)            │
│   Runtime: /var/run/llmux (setup-token, pid)                       │
│   Logs: /var/log/llmux/ or journald                                │
│                                                                    │
│   NEVER touches /home/*.                                           │
└────────────────────────────────────────────────────────────────────┘
```

## Data plane

| Store | Path | Owner | Permissions | Contents |
|---|---|---|---|---|
| Daemon config | `/etc/llmux/config.yaml` | `root:llmux` | `0640` | Listen port, TLS cert paths, data dir, service user, dev-mode flag |
| User store | `/var/lib/llmux/users.json` | `llmux:llmux` | `0600` | `[{username, name, passphraseHash, admin, createdAt}]` |
| Token store | `/var/lib/llmux/tokens.json` | `llmux:llmux` | `0600` | `[{tokenId, secretHash, username, name, createdAt, expiresAt?, lastUsedAt}]` |
| Orch transport | `/var/lib/llmux/orchestration/` | `llmux:llmux` | `0750` | Shared git repo; actor files + messages (multi-user contributes here) |
| Tmux server socket | `/var/run/llmux/tmux/` | `llmux:llmux` | `0700` | Single tmux server, daemon-owned |
| Daemon logs | `/var/log/llmux/` or journald | `llmux` | journald-gated | Per-action audit: `tokenId` + resolved username |
| Setup token (one-time) | `/var/run/llmux/setup-token` | `root:llmux` | `0640` | Plaintext, ephemeral, written at boot when users.json is empty |
| Operator credentials (per machine, client-side) | `~/.config/llmux/credentials.json` | each OS user | `0600` | `{server, username, name, token}` — **NEVER read by daemon** |

## User model

A **user** is a row in `users.json`:
- `username` — stable identifier (also the user's orch alias). Format: `[a-z0-9_-]+`. **Does NOT need to be an OS user on the host.**
- `name` — display name
- `passphraseHash` — `scrypt`-hashed
- `admin: bool` — admin can create/delete other users + mint tokens for them
- `createdAt`

No correspondence between llmux users and OS users. A team of 10 humans can use the daemon with 10 user records; the OS only has the one `llmux` service account.

## Token lifecycle

| Aspect | Decision |
|---|---|
| Default expiry | None (long-lived). Operator opt-in per-token. |
| Identity binding | Every token has exactly one owning user. Daemon enforces every action attributed to that user. |
| Spoofing prevention | Token-holder cannot send orch messages as another user — enforced server-side on `/api/orch/send`, `/reply`, `/next`, `/release`, `/ack`. |
| Revocation | Web UI + `llmux token revoke <id>`. Immediate. |
| `LLMUX_TOKEN` env var | Always overrides the credentials file. CI / one-off. |
| Audit log | Every action records `tokenId` + resolved username. |

## Tmux + agent CLI strategy

**One tmux server, daemon-owned.** All sessions live under `/var/run/llmux/tmux/`. The daemon enforces per-user session visibility at the API layer:

- When user Alice spawns a session, daemon records `owner: alice` in its session state
- When Alice's CLI queries `llmux session list`, daemon filters to sessions owned by alice
- Admin tokens see all sessions

**Agent CLI credentials are central and operator-managed.** The `llmux` service user has its own `~llmux/.claude/`, `~llmux/.gemini/`, etc. Operator configures these once at install time (or rotates them centrally). All sessions for all llmux users share these credentials.

This is the operationally simplest model and matches how production agent deployments typically work (centralized API key management, no per-user credential sprawl). If per-user agent credentials ever become a requirement (e.g., billing isolation), that's a v2.x extension — add per-user credential overrides to the user record.

**Trade-off honestly stated:** if Bob's tmux session has a bug that crashes Alice's session, it's possible because they share a tmux server. The daemon mitigates with naming/ownership tracking but doesn't provide OS-level isolation. For the llmux audience (developers + small teams), this trade-off is acceptable; if it ever isn't, that's the v3 conversation (or revisit JupyterHub-style spawning).

## Setup wizard — what invokes it

Boot-time check in llmuxd, gated by a one-time setup token:

1. On `systemctl start llmux`, daemon reads `/var/lib/llmux/users.json`.
2. If empty (or missing) → mint a one-time setup token, print to journal + write to `/var/run/llmux/setup-token` (perm `0640`, owner `root:llmux`):
   ```
   llmux: first-run setup needed.
   Visit: https://llmux.local:3001/setup?token=stp_a8f3e7d2…
   Token also readable at /var/run/llmux/setup-token by root or llmux group.
   ```
3. On every incoming request, before the auth gate:
   - If no users exist AND path is `/setup` or `/api/setup` AND setup token valid → serve the wizard
   - Else if no users exist → 503 / "setup needed" landing
   - Else → normal auth flow

### The wizard

```
Name:        Steve Krisjanovs
Username:    steve            ← becomes your orch alias too
Passphrase:  ******
Passphrase:  ****** (confirm)
```

On submit:
1. Validates username format (regex)
2. Hashes passphrase via scrypt
3. Creates user record with `admin: true`
4. Mints bootstrap token
5. Sets session cookie
6. Auto-creates `data/actors/<username>.md` in the transport (species: human, default operator persona)
7. Setup token destroyed
8. Redirect to `/`

### Non-interactive bootstrap

```sh
LLMUX_INIT_USERNAME=steve \
LLMUX_INIT_NAME="Steve Krisjanovs" \
LLMUX_INIT_PASSPHRASE=<from-secrets> \
systemctl start llmux
```

For containers, CI, kickstart. Daemon detects env vars on first start, creates the user, prints the bootstrap token ONCE for the operator to save.

## CLI surface (v2)

| Verb | Purpose |
|---|---|
| `llmux auth login` | Interactive: server URL + username + passphrase → mint token → write credentials.json |
| `llmux auth logout` | Delete credentials.json |
| `llmux auth status` | Print current user + server + token id |
| `llmux auth passwd` | Change own passphrase (re-prompts old) |
| `llmux user create <username>` | Admin: create user. Prompts passphrase. |
| `llmux user list` | List users (admin sees all; non-admin sees self) |
| `llmux user delete <username>` | Admin: delete + revoke tokens |
| `llmux user reset-passphrase <username>` | Admin: reset another user's passphrase |
| `llmux token create [--user <u>]` | `--user` admin-only; otherwise mints for the calling user |
| `llmux token list` | Show owning user + admin flag |
| `llmux token revoke <id>` | Revoke a specific token |

All session / orch verbs inherit identity from the credentials file.

## Web UI

- `/setup` — first-run wizard (token-gated)
- `/login` — username + passphrase form
- `/account` — name + passphrase change + own token management
- `/admin/users` — admin-only user CRUD

All visually consistent with v1.x picker/orch pages (see `packages/llmux/src/v2/web/README.md` for the design-token contract).

## Operator workflows

| Flow | Prompt? | What happens |
|---|---|---|
| First-run web visit | Yes, one-time | `/setup` wizard with setup-token gate |
| First `llmux auth login` per machine | Yes, one-time per machine | Stores credentials.json |
| Subsequent CLI calls | **No** | Token loaded from credentials file |
| Subsequent web visits | **No** | Cookie persists across sessions + daemon restarts |
| Token revoked | Deferred yes | Next CLI call 401s with a clear message |
| New device pairing | Yes (auth login from new device) OR QR-pair from existing | |
| Switch identity | Yes | `llmux auth login` overwrites credentials.json |
| One-off identity override | **No** | `LLMUX_TOKEN=<other-token> llmux ...` |
| Sensitive admin (mint token, create user, change passphrase) | Yes, defense-in-depth | Re-prompt passphrase |
| Forgot passphrase | Shell recovery | `sudo llmux user reset-passphrase <username>` |

The "never nag" guarantee: operator types passphrase **twice in lifetime per machine** (setup + auth login). Sensitive admin actions add a third time per action.

## Dev mode (`LLMUX_V2_DEV=1`)

Lets you exercise the bulk of v2 code paths without sudo, for development iteration:

- Paths flip to `~/.local/share/llmux/v2-dev/` + `~/.config/llmux/v2-dev/`
- serviceUser defaults to current OS user
- Readiness checks for `/etc/llmux`, `/var/lib/llmux`, `llmux` system user are skipped
- `dropToService` is a no-op (already true for non-root)
- Listen host defaults to `127.0.0.1`

Run via:
```sh
npx tsx packages/llmux/src/v2/bin/dev-server.ts
```

Dev mode is the ONE place where v2 code touches `$HOME`, and it does so because the daemon IS the operator in dev mode. Production deploy (`devMode: false`, default) never touches `/home/*`.

## What's NOT in this design

- **No SMTP / password-reset emails.** Username (not email) as identifier. Lost passphrase = shell-access recovery.
- **No system-mode in v1.x.** Daemon stays user-mode there.
- **No multi-alias-per-user in v2.0.** Each user owns exactly one orch alias (matching their username). v2.x extension if needed.
- **No self-registration.** Admin-only user creation.
- **No federation / SSO / OAuth.** Out of scope.
- **No 2FA / TOTP** in v2.0. WebAuthn possible in v2.x if demand.
- **No per-user OS isolation.** This is the Grafana model — explicitly. If you need per-user OS isolation, run separate llmuxd instances per OS user (the multi-daemon v1.x pattern is your friend).
- **No per-user agent CLI credentials in v2.0.** Operator-managed central credentials only. v2.x can add per-user overrides.

## Build plan (when scheduled)

| Phase | Deliverable |
|---|---|
| 1 | Design doc (this) + scaffold (done) |
| 2 | System config + privilege drop + readiness (done) + dev-mode entrypoint (done) |
| 3 | `auth/users.ts` — FileUserStore with scrypt CRUD |
| 4 | `auth/tokens.ts` — identity-bound mint/validate/revoke |
| 5 | `auth/setup.ts` — wizard handler + setup token gate + bootstrap-from-env |
| 6 | `llmux auth login` CLI + credentials file persistence |
| 7 | API-level identity enforcement on all orch endpoints |
| 8 | `/setup` + `/login` + `/account` + `/admin/users` web pages |
| 9 | `llmux user / auth / token` CLI verbs |
| 10 | Daemon-owned tmux server + per-user session ownership tagging |
| 11 | Migration tool (v1.x state → v2) |
| 12 | End-to-end smoke: install → setup → users → tokens → per-user views → revocation |
| 13 | Release as v2.0; document migration |

Estimated effort: real multi-week sprint. Trigger conditions:
- Multi-tenant demand surfaces (team sharing one daemon)
- OR deployment context where system-mode is required

Until then, v1.x's user-mode + multi-daemon pattern is the answer.

— cachy, 2026-06-21 (revised from JupyterHub framing to Grafana model)
