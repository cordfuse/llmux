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
  worker/
    spawner.ts       — spawn per-user worker processes via systemd-run
    registry.ts      — track which user has which worker running
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

v2 spans three distinct privilege contexts. Every function in this tree
runs in exactly one of them. Mixing them is the bug.

| Context | Runs as | Code that runs here |
|---|---|---|
| **Boot** | `root` (briefly, before privilege drop) | `system/privilege.ts` `dropToService()` + initial config load |
| **Service** | `llmux:llmux` (most of the daemon) | Auth + routing + user/token CRUD + setup wizard + spawning workers via `systemd-run` |
| **Worker** | each authenticated user's uid | Tmux sessions, agent CLIs, per-user state R/W, orch transport writes |

The hub-and-spoke shape (JupyterHub-style) means the service-context daemon
NEVER directly touches a user's home directory or runs agent CLIs.
It delegates everything that needs the user's identity to a worker spawned
with that user's uid.

## When this scaffold becomes implementation

Triggers in `V2-SYSTEM-AUTH-DESIGN.md`:
- Real multi-tenant demand surfaces (team sharing one llmuxd)
- Deployment context requires system-mode (shared dev box, lab, CI host)

Until then: the scaffold sits dormant; v1.x ships from `feat/orchestration`
on the user-mode + single-operator track.
