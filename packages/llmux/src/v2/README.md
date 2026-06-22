# llmux v2 — system-mode + full user auth (scaffold)

> This directory is the **architectural scaffold** for v2. No real logic
> lives here yet — just types, interfaces, and stub functions that mark
> the module boundaries. Each phase of [V2-SYSTEM-AUTH-DESIGN.md](../../../../V2-SYSTEM-AUTH-DESIGN.md)
> fills in one or more of these stubs.
>
> Version stays on the current v1.x track until the v2 sprint completes
> and we cut the v2.0 release.

## Layout

```
packages/llmux/src/v2/
  system/
    config.ts        — /etc/llmux/config.yaml schema + loader
    paths.ts         — system-mode path constants
    privilege.ts     — drop from root to llmux service user on startup
  auth/
    users.ts         — user store (CRUD, scrypt hashing)
    tokens.ts        — identity-bound token store
    setup.ts         — first-run setup wizard
  web/
    README.md        — DESIGN-CONSISTENCY REQUIREMENT for v2 web pages
    setup.ts         — first-run wizard page
    login.ts         — username + passphrase login form
    account.ts       — operator's own name/passphrase/tokens
    admin-users.ts   — admin-only user CRUD
```

Plus `deploy/`:

```
deploy/
  llmuxd.service   — systemd unit template (system service)
  install.sh       — system-mode install script (root + service user setup)
```

## How to read the scaffold

Each file:
- Declares the public **interfaces and types** the rest of v2 will consume
- Stubs **function signatures** with `// TODO(phase N): implement` markers
- References the phase number in `V2-SYSTEM-AUTH-DESIGN.md` that fills it in
- Includes module-level docstring explaining its role and trust boundary
  (which process owner runs this code: root, `llmux` service user, or a per-user worker)

## Trust boundaries (read these before implementing anything)

v2 spans two privilege contexts. Every function in this tree runs in
exactly one of them.

| Context | Runs as | Code that runs here |
|---|---|---|
| **Boot** | `root` (briefly, before privilege drop) | `system/privilege.ts` `dropToService()` + initial config load |
| **Service** | `llmux:llmux` (everything after the drop) | Auth, routing, user/token CRUD, setup wizard, tmux sessions, agent CLIs — all owned by the service user |

The **`$HOME` principle** (load-bearing): production v2 daemon NEVER reads
or writes any `/home/*` path. All daemon state lives in `/etc/llmux/`,
`/var/lib/llmux/`, `/var/log/llmux/`, `/var/run/llmux/`. Agent CLI
credentials live in `~llmux/.claude/`, `~llmux/.gemini/`, etc. — the
service user's own home, operator-managed centrally. Multi-user
isolation is at the application layer (Grafana / Postgres model), not
per-OS-user. The ONE exception: each operator's own `~/.config/llmux/
credentials.json` on their own machine — but that's read by their llmux
CLI, not by the daemon.

User mode (`LLMUX_USER_MODE=1`) is the ONLY context in which v2 code
touches $HOME, and it does so because the daemon IS the operator in
user mode. Two intended use cases: (a) dev/test without sudo, (b) a
solo operator who doesn't want a system service and just runs llmux
as themselves, like v1.x.

## When this scaffold becomes implementation

Triggers in `V2-SYSTEM-AUTH-DESIGN.md`:
- Real multi-tenant demand surfaces (team sharing one llmuxd)
- Deployment context requires system-mode (shared dev box, lab, CI host)

Until then: the scaffold sits dormant; v1.x ships from `feat/orchestration`
on the user-mode + single-operator track.
