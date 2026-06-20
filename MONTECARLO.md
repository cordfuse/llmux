# Monte Carlo π Estimation — End-to-End Orchestration Walkthrough

This is the canonical reproduction recipe for the llmux orchestration smoke
test: **five agents from five different vendors collaborate to estimate π
via Monte Carlo dart-throwing**, with one Claude session acting as the
coordinator and a second Claude session participating as one of the five
workers.

Same `claude` CLI binary, two different orch aliases (`claude-coord` and
`claude-worker`), two different actor profiles — proves that the orch
alias is decoupled from the underlying CLI identity.

If this run completes and prints a π estimate close to `math.pi`, every
load-bearing primitive in the orchestration framework has been exercised.

## What it exercises

| Step | Primitive |
|---|---|
| Coord broadcasts `throw N darts` (5 individual sends) | `orch send` |
| Workers find their task via inbox poll | `orch inbox` |
| Workers atomically claim their task | `orch next` |
| Workers compute via real Python RNG | (skill markdown) |
| Workers commit JSON reply | `orch reply` (links via `re:`) |
| Coord polls inbox until 5 replies arrive | `orch inbox` |
| Coord aggregates and computes π = 4 · Σhits / Σthrows | (skill markdown) |
| Coord clears terminal replies after aggregation | `orch ack` (optional) |
| Every message is a git commit in the transport | `gitCommit` |
| (If a DR remote is configured) every commit auto-pushes | `asyncBackupPush` |

## Prerequisites

1. **Five agent CLIs installed and authed** on the box you'll run this on:
   ```sh
   for c in claude gemini agy opencode codex; do command -v "$c" || echo "MISSING: $c"; done
   ```
   If any are missing, install them before continuing.

2. **Python 3** on the same box (used for real RNG — LLM-generated
   randomness is bad for Monte Carlo):
   ```sh
   python3 --version
   ```

3. **llmux installed with orch support** — must be `≥ v1.0.0` (which
   introduced `llmux orch`):
   ```sh
   npm i -g @cordfuse/llmux@latest
   llmux orch     # should NOT say "unknown command"
   ```

4. **tmux running, llmuxd running** — required for spawning sessions:
   ```sh
   tmux -V
   llmux server start         # in another shell; daemon must stay up
   ```

## Step 1 — Initialize the transport

The orch transport lives at `$XDG_DATA_HOME/llmux/orchestration/`. Create
it:

```sh
llmux orch init
```

Optional: add a private git remote for disaster-recovery backup. The
remote is **push-only** (one-way mirror; never pulled from automatically).
See [ORCHESTRATION-DESIGN.md](ORCHESTRATION-DESIGN.md) for the rationale.

```sh
llmux orch init --remote git@github.com-personal:<you>/llmux-transport.git
```

Verify:

```sh
llmux orch status
# llmux orch status
#   path:   /home/.../.local/share/llmux/orchestration
#   channels: main
#   live claims: 0
```

## Step 2 — Drop the actor files into the transport

The transport carries the actor definitions (operator-owned identity:
persona + skills). One markdown per alias under `data/actors/<alias>.md`.

```sh
cd ~/.local/share/llmux/orchestration

# Shared skills (referenced by includes: in the actor files)
mkdir -p data/actors/skills
cat > data/actors/skills/dart-throw.md <<'EOF'
# Skill: dart-throw (Monte Carlo)

Estimate hits inside the unit quarter circle using **real RNG**, not your
own random guesses (LLMs produce poor entropy).

For N darts, run exactly this in your bash tool, substituting `N`:

```sh
python3 -c "
import random
n = N
hits = sum(1 for _ in range(n) if random.random()**2 + random.random()**2 <= 1)
print(hits)
"
```

The script prints a single integer = hit count. Reply with **strict JSON
on one line**:

```json
{"alias":"<your-alias>","hits":H,"throws":N}
```

Do not include any commentary outside the JSON.
EOF

cat > data/actors/skills/montecarlo-coordinate.md <<'EOF'
# Skill: montecarlo-coordinate

When you have collected all worker replies, compute:

```
pi_estimate = 4 * sum(hits) / sum(throws)
```

Print a final report with a breakdown table per worker, plus a total row,
plus `π ≈ <pi_estimate>` and the error vs `math.pi`. Wait for all expected
replies before computing.
EOF

# Coordinator actor
cat > data/actors/claude-coord.md <<'EOF'
---
alias: claude-coord
name: Claude (Coordinator)
description: Monte Carlo pi estimation orchestrator
includes:
  - ./skills/montecarlo-coordinate.md
---

# Persona

You are the coordinator for a Monte Carlo pi estimation run.
The five workers are: claude-worker, gemini, agy, opencode, codex.

When asked to start a run with N darts per worker:
1. Send each worker: "throw N darts" via `llmux orch send`.
2. Poll your inbox until all 5 replies arrive.
3. Parse the JSON in each reply body and compute pi per the skill.
4. Print the breakdown table.
EOF

# Five worker actors — same shape, different alias + CLI label
for alias in claude-worker gemini agy opencode codex; do
  cat > data/actors/$alias.md <<EOF
---
alias: $alias
name: $alias
description: Dart-throwing worker for Monte Carlo pi estimation
includes:
  - ./skills/dart-throw.md
---

# Persona

You are an llmux orch worker. When you receive a message addressed to
you asking to "throw N darts", use the dart-throw skill and reply with
the specified JSON line. You poll, claim, work, reply. You do not initiate.
EOF
done

# Commit so the actors are cumulative + DR-backable
git add -A
git commit -m "actors: monte-carlo rig"
```

## Step 3 — Spawn the six sessions

Each session is a tmux pane running its agent CLI. Spawn them with
`--orch-alias` so `llmuxd` sets `$LLMUX_ORCH_ALIAS` in each agent's env
(then the agent's `llmux orch ...` calls default to the right identity):

```sh
llmux session start claude  --name claude-coord   --orch-alias claude-coord
llmux session start claude  --name claude-worker  --orch-alias claude-worker
llmux session start gemini                          --orch-alias gemini
llmux session start agy                             --orch-alias agy
llmux session start opencode                        --orch-alias opencode
llmux session start codex                           --orch-alias codex

llmux session list
# 6 sessions, all running
```

> **Note for pre-v1.0 spawns:** if your sessions were spawned before the
> orchAlias plumbing landed, they won't have `$LLMUX_ORCH_ALIAS` set. Use
> `--alias <name>` explicitly on every `llmux orch …` call from the agent's
> bash tool, OR `session restart` to pick up the new env. Both paths work.

## Step 4 — Bootstrap the workers (they need to know to poll)

Workers are passive — they wait for instructions. Drop a one-shot
bootstrap prompt to each so they poll their inbox, claim, work, reply:

```sh
WORKER_PROMPT='You are an llmux orch worker. There is a task waiting in your inbox. Run: `llmux orch next --json` → claim it. Then run the dart-throw script (see data/actors/skills/dart-throw.md): `python3 -c "import random; random.seed(); n=N; h=sum(1 for _ in range(n) if random.random()**2 + random.random()**2 <= 1); print(h)"` substituting the N from the task. Reply with strict JSON: `llmux orch reply <msg-id> '"'"'{"alias":"<me>","hits":H,"throws":N}'"'"'`. Then stop.'

for alias in claude-worker gemini agy opencode codex; do
  llmux session prompt "$alias" "$WORKER_PROMPT"
done
```

> If `llmux session prompt` hangs (turnq integration on the running
> daemon), fall back to direct `tmux send-keys -t <session>` + manual
> Enter. The framework's orch primitives are not affected; only the
> prompt-delivery path matters.

## Step 5 — Kick off the coordinator

```sh
COORD_PROMPT='You are claude-coord. Run a Monte Carlo pi estimation: (1) for each worker in claude-worker, gemini, agy, opencode, codex, run `llmux orch send --to <worker> "throw 10000 darts"`. (2) Poll your inbox every 10 seconds via `llmux orch inbox --json` until you have replies from all 5 workers (each will have re: pointing at one of your dispatch msg-ids). (3) Parse each reply body as JSON, compute pi = 4 * sum(hits) / sum(throws), print a breakdown table + π estimate + error vs math.pi. Begin now.'

llmux session prompt claude-coord "$COORD_PROMPT"
```

## Step 6 — Watch it run

```sh
# Live message count on the bus (5 dispatches + 5 replies = 10):
watch -n 2 'find ~/.local/share/llmux/orchestration/data/channels/main -name "*.md" | wc -l'

# Coordinator's pane (final result will print here):
tmux attach -t claude-coord
# (detach with Ctrl-b d)

# Any worker's pane:
tmux attach -t gemini

# Cumulative history of the run (git is the audit log):
cd ~/.local/share/llmux/orchestration
git log --oneline
```

## Expected outcome

After ~1-3 minutes (depends on which agent finishes last — opencode often
trails due to permission prompts), the coordinator prints:

```
| alias          | hits  | throws |
| -------------- | ----- | ------ |
| claude-worker  | ~7850 | 10000  |
| gemini         | ~7850 | 10000  |
| agy            | ~7850 | 10000  |
| opencode       | ~7850 | 10000  |
| codex          | ~7850 | 10000  |
| **total**      | ~39250| 50000  |

π ≈ ~3.14    (error vs math.pi: ~0.005)
```

With N = 10,000 per worker (50,000 total throws) the estimate typically
lands within ±0.02 of `math.pi`. Larger N narrows the error
(approximately as 1/√N).

## Optional — coordinator clears its inbox

Coordinator never replies back up the chain (replies are terminal), so the
5 worker replies stay in its inbox forever unless explicitly acknowledged:

```sh
# Inside the coord's bash tool, after aggregation:
for id in <each-reply-msg-id>; do
  llmux orch ack "$id" --alias claude-coord
done
```

After acking, `llmux orch inbox --alias claude-coord` returns empty.
History is preserved (acks are machine-local, not in the transport).

## Resetting between runs

```sh
# Local cleanup
rm -rf ~/.local/share/llmux/orchestration ~/.local/state/llmux/orch

# Optional: also wipe the remote (DR mirror) if you want a clean slate there
# (only do this if you understand the consequences — the remote IS your backup):
# git -C <local-clone-of-remote> push --force origin <empty-orphan-branch>:main
```

Then start over from Step 1.

## Troubleshooting

- **`llmux orch` says unknown command** → you're on an older llmux. Upgrade: `npm i -g @cordfuse/llmux@latest`.
- **Worker never picks up its task** → check the worker pane via `tmux attach -t <alias>`. Common causes: agent CLI needs a permission prompt approval (opencode does this for filesystem access); agent rejected the prompt; bash tool failed.
- **`llmux session prompt` hangs** → known turnq-integration footgun on older daemons. Direct `tmux send-keys -t <session> "<text>"` + Enter is the deterministic workaround.
- **Coord re-processes the same replies** → you're on a pre-v1.0 build without the ack mechanism. Upgrade.
- **Workers re-process their own replied-to task** → same as above, pre-v1.0 bug fixed by the replied-set filter in `orch.inbox`.

## What this proves

If the run completes with π in the expected range, every primitive in the
orch framework has been exercised end-to-end against five real-world AI
agent CLIs on five different vendors. That's a tighter integration test
than any unit test could provide — and the cumulative git history of the
transport is itself the audit log of what happened, replayable forever.
