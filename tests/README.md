# tests/

Hand-rolled smoke + integration tests for the llmux CLI. No framework, no
dependencies — bash and python.

## What's here

- **`cli-read.sh`** — read-only CLI surface (~46 checks): global flags, agent
  list, token CRUD, server start --help, session list, env-var fallbacks,
  backward-compat shims, edge cases. Requires a running daemon at
  `http://localhost:3030` for the `--server` block; rest is hermetic.

- **`cli-write.sh`** — write-op CLI surface (~28 checks): spawn / stop /
  restart / prompt / broadcast / resume in both local mode and remote
  (`--server`) mode. Spins up an **isolated daemon on port 13030** with its
  own `XDG_STATE_HOME` so the operator's real daemon is untouched. Cleans up
  test tmux sessions on exit. Costs $0 — uses `claude` with `--cwd /tmp`
  (idle prompt) and `--no-enter` so nothing reaches the LLM.

- **`attach-smoke.py`** — `session attach` over WebSocket. Spawns the CLI
  inside a pty, streams server bytes, sends `Ctrl+]`, asserts clean exit
  within 6 s. Catches the v0.12.4-era detach-hang regression.

## Running

From the repo root:

```bash
cd packages/llmux && npm run build && cd -

# Read tests need a daemon at :3030 for the --server block
tests/cli-read.sh

# Write tests are self-contained (spawn their own daemon on :13030)
tests/cli-write.sh

# Attach smoke — needs a live session named 'codex' on a daemon at :3030
tests/attach-smoke.py codex http://localhost:3030
```

All three exit 0 on a fully-passing run; non-zero on the first failure
(failed assertion names are printed before the summary).

## Prerequisites

- `tmux` in PATH
- `node` ≥ 20 in PATH
- `python3` ≥ 3.8 for the attach test
- For tests that actually spawn `claude`: the `claude` CLI must be installed
  (`curl -fsSL https://claude.ai/install.sh | bash`). Write tests use
  `--cwd /tmp` and `--no-enter` so no LLM calls are made and no project
  context is pulled in.

## What's deliberately not tested here

- **The web picker / xterm browser surface** — covered by interactive UAT
  on a phone.
- **`--browser` flag on attach** — opens a desktop browser, can't be
  scripted cleanly.
- **Tailscale-serve HTTPS path** — depends on a healthy tailnet cert; not
  a stable target for automated runs.
- **CI integration** — these scripts need a real `claude` binary and a
  graphical tmux session host; not appropriate for GitHub Actions yet.
  When a stub-agent path lands they can move to CI.
