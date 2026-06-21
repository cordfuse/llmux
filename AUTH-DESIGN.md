# llmux Authentication — Design

> Status: **design draft**, branch `feat/auth`. Target release: **v1.1** (after orch v1.0 ships). Captures the auth-model design conversation 2026-06-20, post-orch-MVP. No code in this commit — this is the architecture write-up that implementation will follow.

## Why this design exists

After shipping orch v1.0 (human + machine actors on a shared bus, `species: machine|human` frontmatter, `operator` as a default human participant), the UX guardrail of "filter `you:` chips to species=human only" became the obvious next gap: **a chip filter isn't real security**. Once humans are first-class participants, "I'm Steve" needs to be enforceable, not just asserted.

This document is the result of thinking through *how* to add real identity enforcement to llmux without grafting auth where it doesn't fit.

## What we considered and rejected

### Rejected: in-app multi-user auth in user-mode llmuxd

Initial gut reaction was "add user accounts + passwords inside llmuxd." This is the **anti-pattern**:

- llmuxd runs as **one OS user**. Identity is already enforced at the OS level.
- Adding "user accounts" inside the daemon creates fake isolation — every "user" shares the same filesystem, same env, same processes
- Compromise the OS account → bypass every in-app user
- Worst-of-both: complexity of multi-user auth without any of its benefits (no isolation)

Real-world examples confirm this is rare in well-designed systems. Either:
- **User-mode + single-operator** (Jupyter, code-server, PM2, VS Code Remote) — identity == OS user, auth gates network access only
- **System-mode + real multi-tenant** (Postgres, sshd, Grafana, Plex) — service user + real user DB + real isolation

The hybrid "user-mode daemon + in-app users" is the bad pattern almost no well-designed tool uses.

### Rejected: system-mode rewrite for v1.x

Going system-mode (llmuxd runs as a service user, spawns user-owned tmux sessions via `setuid` / `systemd-run --uid`) is the *correct* architecture for true multi-tenant auth. But:

- It's a JupyterHub-scale architecture rewrite (hub + per-user spawners + privilege boundaries + credential pass-through to agent CLIs)
- Compromises llmux's portability ("install via npm, run as your user")
- Solo + small-team use case (the current llmux audience) doesn't need it
- Multi-human collaboration already works via the **multi-daemon pattern**: each operator runs their own llmuxd; they share a bus via the orch transport's DR remote

→ Defer system-mode to a hypothetical v2. v1.x stays user-mode.

## What we adopted

### The JupyterHub-lite pattern (user-mode + delegated identity tokens)

Single OS user owns the daemon, but tokens the daemon mints carry **bounded delegated identities** for the people and devices it's shared with. This is the JupyterHub model from before it went full multi-tenant; it's also docker's, gh's, and kubectl's auth shape.

**Key properties:**

- Daemon trust boundary == OS account (unchanged from today)
- Each authenticated token carries an identity (owning user)
- Operations enforce identity per-token (e.g., orch `from:` field must match the token's owning user)
- Single OS user can mint many tokens for many people / devices
- Each token is revocable; operations after revocation 401
- The CLI on each operator's machine holds one token in a credentials file

## Data plane

| Store | Path | Owner | Permissions | Contents |
|---|---|---|---|---|
| User store | `~/.config/llmux/users.json` | OS user | `0600` | `[{username, name, passphraseHash, createdAt}]` |
| Token store | `~/.config/llmux/tokens.json` | OS user | `0600` | `[{tokenId, secretHash, username, name, createdAt, expiresAt?, lastUsedAt}]` |
| Operator credentials | `~/.config/llmux/credentials.json` | OS user (per-operator-machine) | `0600` | `{server, username, name, token}` |

Token *plaintext* in `credentials.json` is fine because the OS account is the trust boundary — anyone reading that file can already do anything on the machine. Passphrase plaintext is **never** written to disk (only `scrypt`-hashed in `users.json`).

## Setup wizard — first-run flow

### What invokes it

A boot-time check in the daemon, gated by a one-time setup token:

1. **On `llmux server start`**, daemon reads `users.json`.
2. **If empty (or missing)** → mint a one-time setup token, print to terminal:
   ```
   ┌─────────────────────────────────────────────────────────────┐
   │ llmux first-run setup needed.                               │
   │ Visit: http://localhost:3001/setup?token=stp_a8f3e7d2…      │
   │ Don't share this URL — it grants admin to whoever uses it.  │
   └─────────────────────────────────────────────────────────────┘
   ```
3. **On every incoming request, before the existing auth gate:**
   - If no users exist AND path is `/setup` or `/api/setup` AND setup token is valid → serve the wizard
   - If no users exist AND it's anything else → 503 / "setup needed" landing page
   - If users exist → normal auth flow

### Why a token gate

llmuxd listens on `0.0.0.0` by default (tailscale-friendly). Without a token, anyone on the tailnet could race the operator to complete setup and become admin. The token gate forces "you must have terminal access to the daemon to bootstrap" — same trust model as JupyterHub's initial token, `wg genkey`, `code-server --auth password` first-run, VS Code Tunnels.

Token is short (URL-safe), printed once, never persisted. Daemon restart re-mints it if setup is still incomplete.

### The wizard itself

```
Name:        Steve Krisjanovs
Username:    steve              ← becomes your orch alias too
Passphrase:  ******
Passphrase:  ****** (confirm)
```

Three fields:
- **Name** — display name ("Steve Krisjanovs"). Used in UI, in token labels, in audit log.
- **Username** — stable identifier ("steve"). Becomes the user's orch alias. Format constraint: `[a-z0-9_-]+`, no spaces, alias-shaped.
- **Passphrase** — `scrypt`-hashed for storage. Used for login on new devices + sensitive admin actions.

### What the wizard does on submit

1. Creates user record in `users.json`
2. Mints a bootstrap token bound to the new user (admin-class)
3. Persists the token in `tokens.json` (server side) AND issues a session cookie (web client)
4. **Auto-creates `data/actors/<username>.md`** in the orch transport with `species: human` and a default persona body
5. Setup token destroyed (memory-only)
6. Redirects to `/`

Why username = orch alias: collapses two concepts. Pre-existing `operator.md` (shipped by `orch init`) is the placeholder; the wizard upgrades it to the real operator's identity.

### Non-interactive bootstrap (headless / Docker / CI)

```sh
LLMUX_INIT_USERNAME=steve \
LLMUX_INIT_NAME="Steve Krisjanovs" \
LLMUX_INIT_PASSPHRASE=<from-stdin-or-secrets> \
llmux server start
```

Daemon detects the env vars on first start, creates the user, mints the bootstrap token, prints it ONCE for the operator to save. No setup-token gate (there's no interactive operator).

If `LLMUX_INIT_PASSPHRASE` is the literal `-` or unset and stdin is attached, prompt via stdin. Same shape as `docker login --password-stdin`.

## Token lifecycle

| Aspect | Decision |
|---|---|
| Default expiry | **None** (long-lived). Operator opt-in to expiry per-token. Matches docker/gh model. |
| Identity binding | Each token has exactly one owning user. Daemon enforces `from:` matches owning user. |
| Token holder cannot impersonate other users | **Enforced server-side** on every API call that has a `from:` field |
| Revocation | Web UI + `llmux token revoke <id>` (existing). On revoke, next CLI call 401s. |
| `LLMUX_TOKEN` env var | Always overrides the credentials file. For CI, headless agents, one-off impersonation. |
| Bootstrap token | Not special. Regular token. If revoked and no others, re-auth via passphrase. |
| Audit log | Each action records `tokenId` + the resolved username. Enables "who did this?" forensics. |

## Operator workflows

### Subsequent CLI calls (the happy path)

Token loaded from `credentials.json`, sent as bearer. **No prompt.** Same shape as `docker`, `gh`, `kubectl`.

### Subsequent web visits

Cookie persists across browser sessions and daemon restarts. **No prompt.**

### Pairing a new device

```
$ llmux auth login
Server URL [http://localhost:3001]: ...
Username: steve
Passphrase: ******
Logged in as Steve Krisjanovs (steve).
```

Stores `credentials.json` on the new device. Same shape as `gh auth login`, `docker login`. **Prompted exactly once per machine, ever.**

Alternative: **QR-pair** (existing pattern extended). Operator on existing machine runs `llmux token create --qr`; daemon mints a token + emits a QR code; scan from phone → browser stores cookie. Zero passphrase typing on a phone keyboard.

### Switching identity on a shared machine

```
$ llmux auth login          # different username
```

Overwrites `credentials.json`. Previous user's tokens stay valid (anyone still holding them can use them; revocation is the way to actually kill them).

### One-off identity override

```
LLMUX_TOKEN=<other-token> llmux orch send --to alice "hi"
```

Env var beats credentials file. For scripts, CI, occasional impersonation. No nag.

### Forgot passphrase

No SMTP, no password reset emails. Recovery requires shell access to the daemon machine:

```sh
llmux user reset-passphrase steve     # prompts new passphrase, writes new hash
```

Document this clearly. **Lost passphrase + lost shell access = lost identity.** Same as losing an SSH key without a backup — accept the asymmetry.

### Token revoked mid-use

CLI call returns 401. CLI prints:
```
Error: your token was revoked or expired. Run `llmux auth login` to re-authenticate.
```
Doesn't pop an interactive prompt mid-flow (script-friendly).

### Adding a second user

```
$ llmux user create alice --name "Alice Example"
Passphrase for alice: ******
Created user alice. Tell Alice to run `llmux auth login` from her machine.
```

Admin-only. Auto-creates `data/actors/alice.md` (species: human). Alice receives the passphrase out-of-band (over Signal, in person, etc.), runs `auth login`, gets her own token.

**No self-registration** — only admins create users. Matches Steve's stated requirement.

## Sensitive actions — when re-prompting is OK

The "never nag" guarantee covers normal operation. These intentional moments DO re-prompt the passphrase as defense-in-depth:

- `llmux token create` (minting a new credential)
- `llmux user create <other-user>` (admin action)
- `llmux user delete <username>` (admin action; also requires explicit confirmation)
- Changing your own passphrase (`llmux auth passwd` — prompts old + new)
- Web wizard's "Account → Change passphrase" form

In normal use, the operator types their passphrase **twice in their lifetime per machine**: once at setup, once at `auth login`. Sensitive admin actions add a third time per action — that's the right ratio.

## What's NOT in this design

Explicit non-goals to lock in:

- **No SMTP, no email delivery, no password-reset emails.** Username (not email) as identifier. Lost passphrase = shell-access recovery.
- **No system-mode in v1.x.** Daemon stays user-mode. Identity is delegated via tokens within the OS trust boundary.
- **No multi-alias-per-user in v1.0.** Each user owns exactly one orch alias (matching their username). Want multiple personas? Create multiple users. (v1.1+ could add multi-alias if real demand surfaces.)
- **No self-registration.** Admin-only user creation. Matches Steve's brief.
- **No federation, no SSO, no OAuth.** Out of scope. llmux is single-machine; identity stays local.
- **No password complexity requirements.** Operator's call; we won't reject "12345" in v1.x. Document it as their problem.
- **No 2FA / TOTP.** Out of scope. The OS account + passphrase + token are the layers. Future v1.x could add WebAuthn for the web wizard if there's demand.

## What gets enforced server-side (the actual security claims)

The token model is only as good as where it's enforced. v1.1 enforcement:

| API endpoint | Enforcement |
|---|---|
| `POST /api/orch/send` | `from:` must match the calling token's owning user (the user's username or any alias they own). Reject 403 otherwise. |
| `POST /api/orch/reply` | Same as send (`alias` param == token's owning user). |
| `POST /api/orch/next` | `alias` param must == token's owning user. |
| `POST /api/orch/release` | Same. |
| `POST /api/orch/ack` | Same. |
| `POST /api/sessions` | Any authenticated token may spawn sessions (no per-session identity claim; sessions are owned by the daemon's OS user regardless). |
| `POST /api/orch/fleet/...` | Admin token required (a single flag on the user record: `admin: true`). |
| `POST /api/users` | Admin token required. |
| Token CRUD | A user can manage only their own tokens. Admins can manage anyone's. |

**Direct-filesystem orch CLI calls (offline / no daemon) bypass enforcement.** Documented honestly: identity is enforced through the daemon; bypassing the daemon trusts the OS. Per-machine token holders who have shell access to the daemon machine are already past the trust boundary.

## CLI surface (new + changed)

| Verb | Status | Purpose |
|---|---|---|
| `llmux auth login` | **New** | Interactive: server URL + username + passphrase → mint token → write `credentials.json` |
| `llmux auth logout` | **New** | Deletes `credentials.json` (token stays valid until revoked) |
| `llmux auth status` | **New** | Prints current user, server, token id, expiry if any |
| `llmux auth passwd` | **New** | Change your own passphrase (re-prompts old) |
| `llmux user create <username>` | **New** | Admin: create a user. Prompts passphrase. |
| `llmux user list` | **New** | List users (admin sees all; non-admin sees self) |
| `llmux user delete <username>` | **New** | Admin: delete user + revoke their tokens + remove their actor file |
| `llmux user reset-passphrase <username>` | **New** | Admin: reset another user's passphrase. Shell-access recovery path. |
| `llmux token create` | Extend | Add `--user <username>` (admin-only). Default = current user. |
| `llmux token list` | Extend | Show owning user + admin flag |
| `llmux token revoke` | Unchanged | (still per-token-id) |

## Web UI additions

- `/setup` — the wizard (first-run only)
- `/login` — interactive login form (when cookie missing or revoked)
- `/account` — name + passphrase change form for the logged-in user
- `/admin/users` — admin-only user CRUD page

The existing token-management UI (`/` Tokens tab) stays; tokens just gain an owning-user column.

## Open design questions (to resolve when implementing)

1. **Should the bootstrap user auto-be admin?** Yes (first user always admin). A non-admin first user can't create others, so the system would deadlock.

2. **What if a user is deleted while they have live orch claims?** Either reap their claims on delete, or leave them as ghost claims that TTL out. Cleanest: reap on delete.

3. **Should the daemon refuse to start if the user store is corrupted/unparseable?** Yes. Print the error, exit. Don't silently fall back to "no auth."

4. **What happens to existing pre-auth tokens on upgrade?** Auto-claim by the bootstrap user (whoever completes the wizard first). Pre-existing pairings stay valid; they're now "owned by" the bootstrap user.

5. **Cookie lifetime?** Long (90 days?) with sliding expiry on activity. Match the "no nag" promise. Operators can force re-login by revoking cookies via `/admin/sessions` (v1.2 feature).

6. **Passphrase quality enforcement?** None in v1.x. Operator's call.

## Build plan (v1.1 sprint)

| Phase | Deliverable |
|---|---|
| 1 | This design doc (you're reading it) |
| 2 | User store + passphrase hashing (`crypto.scrypt`, `users.json`, CRUD) |
| 3 | Token-bound identity (extend token record with `username`, enforce in token middleware) |
| 4 | Setup wizard (boot-time check + setup token gate + `/setup` page + `/api/setup` endpoint) |
| 5 | `llmux auth login` + credentials file persistence |
| 6 | API-level `from:` enforcement on orch endpoints (the actual security claim) |
| 7 | `/login` + `/account` + `/admin/users` web pages |
| 8 | `llmux user create / list / delete / reset-passphrase` CLI verbs |
| 9 | Smoke test: bootstrap → user creation → token minting → identity enforcement → revocation |
| 10 | Release as v1.1, document migration for existing installs |

Net: probably 1500–2000 LoC + UI work. Significant but bounded. Sprint-shaped, not multi-month.

— cachy, 2026-06-20
