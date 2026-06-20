# Monte Carlo demo

This is a self-contained 4-step demo of llmux orchestration: **5 AI agents
from 5 different vendors collaborate to estimate π by throwing darts**.
Run it to confirm your orch setup works end-to-end.

If you've used `git clone && ./run.sh` style demos before, this is one of
those.

## What you'll see

After ~1–3 minutes, the coordinator pane prints a final table:

```
| alias         | hits  | throws |
| ------------- | ----- | ------ |
| claude-worker | 7865  | 10000  |
| gemini        | 7825  | 10000  |
| agy           | 7853  | 10000  |
| opencode      | 7848  | 10000  |
| codex         | 7810  | 10000  |
| total         | 39201 | 50000  |

π ≈ 3.13608   (error vs math.pi: 0.005)
```

Your numbers will differ (real RNG, that's the point), but π should land
within ±0.02 of `math.pi`.

## Prerequisites

Run this and fix anything marked `MISSING:`:

```sh
for c in claude gemini agy opencode codex python3 tmux llmux; do
  command -v "$c" >/dev/null || echo "MISSING: $c"
done
```

`llmux` must be **v1.0 or newer** (orch support):

```sh
llmux orch || npm i -g @cordfuse/llmux@latest
```

llmuxd daemon must be running (`llmux server start` in another shell if
it isn't already).

## Run it

```sh
git clone https://github.com/cordfuse/llmux.git
cd llmux/examples/monte-carlo
./run.sh
```

That's it. The script:
1. Initialises the orch transport at `~/.local/share/llmux/orchestration/`
2. Copies the actor files + skill into the transport
3. Spawns 6 tmux sessions (one per agent, each with its `--orch-alias`)
4. Sends a short bootstrap prompt to each — workers start polling their
   inbox, the coordinator dispatches recipes to all 5 workers

## Watch it run

```sh
# Live: the coordinator's pane (final result lands here)
tmux attach -t claude-coord            # Ctrl-b d to detach

# Live: bus message count growing (expect 10 = 5 dispatches + 5 replies)
watch -n 2 'find ~/.local/share/llmux/orchestration/data/channels -name "*.md" | wc -l'

# After: cumulative audit log (git is the persistence layer)
git -C ~/.local/share/llmux/orchestration log --oneline
```

## Reset between runs

```sh
./reset.sh
```

Kills the 6 sessions + wipes the local transport + wipes the local
state. Safe to run any time. Doesn't touch the DR remote if you've
configured one.

## How it works (one screen)

- The **coordinator** (`claude-coord`) owns the **method**. Its actor file
  includes `montecarlo-coordinate.md` — a skill that documents the dart
  recipe + JSON reply shape + aggregation formula.
- The **5 workers** (`claude-worker`, `gemini`, `agy`, `opencode`, `codex`)
  are generic — their actor files just say "follow the recipe in the
  message body". They don't have any Monte Carlo specific knowledge.
- When the coordinator dispatches, it inlines the full recipe into each
  `orch send` message body. Workers receive it, run it, reply.
- Aggregation runs locally on the coordinator from the 5 JSON replies.

That separation — **coordinator owns method, workers follow instructions
inline** — is the deliberate design. Workers are reusable across any task
shape; only the coordinator's skill knows what this particular run does.

## Troubleshooting

| Symptom | Cause + fix |
|---|---|
| `MISSING: llmux orch` | Old llmux — `npm i -g @cordfuse/llmux@latest` |
| Worker session is stuck on a permission prompt (opencode does this for `/tmp`) | `tmux attach -t opencode`, hit Enter to approve "Allow once" |
| Coord re-polls forever, never finishes | One worker probably never replied. `tmux attach -t <alias>` to investigate; check for permission prompts or agent errors |
| `llmux session prompt` hangs | Known footgun on older daemons (turnq integration). Workaround: `tmux send-keys -t <session> "<text>"` + Enter directly |

## More

- The full design behind orch: [ORCHESTRATION-DESIGN.md](ORCHESTRATION-DESIGN.md)
- The orch CLI verbs: `llmux --help` (look under "orch verbs")
- The transport on disk: `~/.local/share/llmux/orchestration/` (it's a
  normal git repo — `git log` it, browse the markdown messages, restore
  from clone)
