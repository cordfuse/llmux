#!/usr/bin/env bash
# Reset the Monte Carlo demo — kill the 6 sessions + wipe the local
# transport + wipe the machine-local state dir. Safe to re-run before
# every `./run.sh` for a clean slate.
#
# Does NOT touch the DR remote (if configured). To wipe that, do it
# manually on the git host.

set -euo pipefail

transport="${XDG_DATA_HOME:-$HOME/.local/share}/llmux/orchestration"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/llmux/orch"

echo "[reset] killing sessions..."
for s in claude-coord claude-worker gemini agy opencode codex; do
  if llmux session list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$s"; then
    llmux session stop "$s" >/dev/null && echo "  • stopped $s"
  fi
done

echo "[reset] wiping local transport at $transport ..."
rm -rf "$transport"

echo "[reset] wiping orch state dir at $state_dir ..."
rm -rf "$state_dir"

echo "[reset] done. ./run.sh for a clean run."
