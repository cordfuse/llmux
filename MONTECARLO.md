# Monte Carlo demo

This is a self-contained demo of llmux orchestration: **5 AI agents from
5 different vendors collaborate to estimate π by throwing darts**. Run it
to confirm your orch setup works end-to-end.

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

```sh
for c in claude gemini agy opencode codex python3 tmux llmux; do
  command -v "$c" >/dev/null || echo "MISSING: $c"
done
```

`llmux` must be **v1.0 or newer** (orch + fleet support):

```sh
llmux orch fleet >/dev/null 2>&1 && echo "ok" || npm i -g @cordfuse/llmux@latest
```

llmuxd must be running (`llmux server start` in another shell if it isn't already).

## Run it

```sh
git clone https://github.com/cordfuse/llmux.git
cd llmux

# 1. One-time: init the orch transport
llmux orch init

# 2. One-time: install the actors + skill into the transport
cp -r examples/monte-carlo/actors/*.md     ~/.local/share/llmux/orchestration/data/actors/
cp -r examples/monte-carlo/skills/         ~/.local/share/llmux/orchestration/data/actors/
( cd ~/.local/share/llmux/orchestration && git add -A && git commit -m "actors: monte-carlo" )

# 3. Spawn the fleet (6 sessions) + kick it off
llmux orch fleet start --file examples/monte-carlo/fleet.yaml
```

That's it. The fleet config (`examples/monte-carlo/fleet.yaml`) declares
the 6 sessions, their aliases, and their bootstrap prompts. `fleet start`
spawns any session that isn't already running, then fires each session's
bootstrap.

## Watch it run

```sh
# Live: the coordinator's pane (final result lands here)
tmux attach -t claude-coord            # Ctrl-b d to detach

# Live: bus message count growing (expect 10 = 5 dispatches + 5 replies)
watch -n 2 'find ~/.local/share/llmux/orchestration/data/channels -name "*.md" | wc -l'

# After: cumulative audit log (git is the persistence layer)
git -C ~/.local/share/llmux/orchestration log --oneline
```

## Stop or reset

```sh
# Kill the 6 sessions (transport is preserved — git history is your audit log)
llmux orch fleet stop --file examples/monte-carlo/fleet.yaml

# For a fully clean slate (wipe transport + machine-local state):
rm -rf ~/.local/share/llmux/orchestration ~/.local/state/llmux/orch
```

## How it works (one screen)

- The **coordinator** (`claude-coord`) owns the **method**. Its actor file
  includes `montecarlo-coordinate.md` — a skill that documents the dart
  recipe + JSON reply shape + aggregation formula.
- The **5 workers** (`claude-worker`, `gemini`, `agy`, `opencode`, `codex`)
  are generic — their actor files just say "follow the recipe in the
  message body." They have no Monte Carlo specific knowledge.
- When the coordinator dispatches, it inlines the full recipe into each
  `orch send` message body. Workers receive it, run it, reply.
- Aggregation runs locally on the coordinator from the 5 JSON replies.

That separation — **coordinator owns method, workers follow instructions
inline** — is the deliberate design. Workers are reusable across any task
shape; only the coordinator's skill knows what this particular run does.

## Troubleshooting

| Symptom | Cause + fix |
|---|---|
| `MISSING: llmux orch fleet` | Old llmux — `npm i -g @cordfuse/llmux@latest` |
| Worker session is stuck on a permission prompt (opencode does this for `/tmp`) | `tmux attach -t opencode`, hit Enter to approve "Allow once" |
| Coord re-polls forever, never finishes | One worker probably never replied. `tmux attach -t <alias>` to investigate |
| Bootstrap prompts don't fire | Make sure `llmuxd` is running (`llmux server start`); fleet uses tmux send-keys directly, no daemon round-trip, so this is rare |

## More

- The full design behind orch: [ORCHESTRATION-DESIGN.md](ORCHESTRATION-DESIGN.md)
- The orch CLI verbs: `llmux --help` (look under "orch verbs")
- The fleet YAML schema: see comments at the top of `examples/monte-carlo/fleet.yaml`
- The transport on disk: `~/.local/share/llmux/orchestration/` — a normal
  git repo. `git log` it, read the markdown messages, restore from clone.
