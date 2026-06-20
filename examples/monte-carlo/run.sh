#!/usr/bin/env bash
# Monte Carlo π estimation — end-to-end orch demo.
# 5 workers (5 different AI vendors) + 1 coordinator, throwing 50k darts
# total, aggregating to a π estimate. See ../../MONTECARLO.md for the
# walkthrough.
#
# This script is idempotent: re-running skips what's already there.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
transport="${XDG_DATA_HOME:-$HOME/.local/share}/llmux/orchestration"

# ── prereqs ──────────────────────────────────────────────────────────────
echo "[1/5] checking prereqs..."
for c in claude gemini agy opencode codex python3 tmux llmux; do
  command -v "$c" >/dev/null 2>&1 || { echo "  ✗ missing: $c"; exit 1; }
done
llmux orch >/dev/null 2>&1 || { echo "  ✗ llmux is too old; needs orch support (v1.0+). Run: npm i -g @cordfuse/llmux@latest"; exit 1; }
echo "  ✓ all CLIs + python3 + tmux + llmux orch available"

# ── transport ────────────────────────────────────────────────────────────
echo "[2/5] transport..."
if [ -d "$transport/.git" ]; then
  echo "  • transport exists at $transport (skipping init)"
else
  llmux orch init
  echo "  • initialised at $transport"
fi

# ── actors + skill ───────────────────────────────────────────────────────
echo "[3/5] installing actors + skill into the transport..."
mkdir -p "$transport/data/actors/skills"
cp "$here/skills/montecarlo-coordinate.md" "$transport/data/actors/skills/"
cp "$here/actors/"*.md "$transport/data/actors/"
( cd "$transport" \
  && git add -A \
  && ( git diff --cached --quiet && echo "  • no actor changes" \
       || git commit -m "actors: monte-carlo rig (from examples/monte-carlo/)" >/dev/null && echo "  • committed actor updates" ) )

# ── sessions ─────────────────────────────────────────────────────────────
echo "[4/5] spawning 6 sessions (skips ones that already exist)..."
spawn_if_missing() {
  local cli=$1 alias=$2
  if llmux session list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$alias"; then
    echo "  • $alias already running (skipping)"
  else
    llmux session start "$cli" --name "$alias" --orch-alias "$alias" >/dev/null
    echo "  • spawned $alias (cli: $cli)"
    sleep 1
  fi
}
spawn_if_missing claude   claude-coord
spawn_if_missing claude   claude-worker
spawn_if_missing gemini   gemini
spawn_if_missing agy      agy
spawn_if_missing opencode opencode
spawn_if_missing codex    codex

echo "  • waiting 5s for agents to settle..."
sleep 5

# ── kick off ────────────────────────────────────────────────────────────
echo "[5/5] bootstrapping the bus..."

# Workers get a SHORT generic prompt: poll, follow the recipe, reply.
# (The recipe itself is in the coordinator's dispatch body — workers
# don't need any Monte Carlo specific bootstrap.)
WORKER_PROMPT='You are an llmux orch worker. Poll your inbox via `llmux orch next --alias '"'"'$LLMUX_ORCH_ALIAS'"'"' --json`. The task body contains a recipe — follow it exactly. Reply via `llmux orch reply <msg-id> --alias '"'"'$LLMUX_ORCH_ALIAS'"'"' <body>`. Then stop.'
for w in claude-worker gemini agy opencode codex; do
  llmux session prompt "$w" "$WORKER_PROMPT" >/dev/null
  echo "  • $w prompted"
done

# Coord gets a SHORT prompt that points it at its skill (which contains
# the full method). It composes the dispatch bodies + does aggregation.
COORD_PROMPT='Start a Monte Carlo π estimation run NOW. You are claude-coord. Read your skill: `cat '"$transport"'/data/actors/skills/montecarlo-coordinate.md`. Follow it to completion. Use N=10000 darts per worker. The 5 workers are: claude-worker, gemini, agy, opencode, codex. Begin.'
llmux session prompt claude-coord "$COORD_PROMPT" >/dev/null
echo "  • claude-coord kicked off"

echo ""
echo "─────────────────────────────────────────────────────────"
echo "  Monte Carlo run kicked off."
echo ""
echo "  Watch the coordinator's pane (final result appears here):"
echo "    tmux attach -t claude-coord     (Ctrl-b d to detach)"
echo ""
echo "  Or watch the bus message count grow (expect 10: 5 dispatches + 5 replies):"
echo "    watch -n 2 'find $transport/data/channels -name \"*.md\" | wc -l'"
echo ""
echo "  When done, see the git history of the transport for the audit log:"
echo "    git -C $transport log --oneline"
echo "─────────────────────────────────────────────────────────"
