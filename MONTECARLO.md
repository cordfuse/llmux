# Monte Carlo fanout — step-by-step orch guide

A self-contained, fully-worked walkthrough of `llmux orch` using the
canonical fanout pattern: **one coordinator dispatches the same task
to N workers in parallel, waits for all replies, then synthesizes.**
The demo task is Monte Carlo π estimation (each worker throws darts,
the coordinator averages), but the orchestration shape — fan-out → wait
→ fan-in — generalizes to any embarrassingly-parallel multi-agent task
(survey N agents on the same question, run a benchmark across N models,
collect votes, gather alternative implementations of the same prompt).

If you only want the quickstart, jump to [Run it](#run-it). The rest of
this document walks through every moving part in detail so you can
adapt the pattern to your own task without guessing.

---

## What this demonstrates

1. **The fanout primitive.** A single agent (`claude-coord`) sends the
   same prompt to four other agent sessions, each running a different
   CLI vendor (`claude`, `agy`, `opencode`, `codex`). The four workers
   reply independently. The coordinator collects all four replies
   before producing a final answer.
2. **Method-vs-recipe separation.** The coordinator owns the **method**
   (how to aggregate). The workers are **generic** — they have no
   Monte Carlo knowledge. The recipe to execute is inlined into each
   task body so the workers just follow instructions. This means the
   same worker fleet can run *any* fanout task; only the coordinator's
   skill file changes per task type.
3. **At-least-once durable messaging.** Every message is a markdown
   file in a git repo on disk. You can `git log` the transport at any
   point during or after the run and replay exactly what happened.
4. **Reply threading.** Workers' replies carry `re: <dispatch-msg-id>`
   in frontmatter, so the coordinator knows which dispatch each reply
   answers — even though all four arrive interleaved.

---

## Architecture at a glance

```
                      ┌─────────────────────────────┐
                      │  llmuxd  (HTTP + WS daemon) │
                      │       localhost:3001        │
                      └──────────────┬──────────────┘
                                     │
                ┌────────────────────┼────────────────────┐
                │                    │                    │
       ┌────────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
       │ tmux: claude-   │  │ tmux: agy       │  │ tmux: opencode  │
       │       coord     │  │                 │  │                 │
       │  (claude CLI)   │  │  (agy CLI)      │  │ (opencode CLI)  │
       │  alias=         │  │  alias=agy      │  │  alias=opencode │
       │  claude-coord   │  │                 │  │                 │
       └─────────────────┘  └─────────────────┘  └─────────────────┘
                │                    │                    │
                │   (each agent's    │                    │
                │    bash tool runs  │                    │
                │    `llmux orch …`) │                    │
                ▼                    ▼                    ▼
       ┌────────────────────────────────────────────────────────┐
       │  Orch transport  (git repo)                             │
       │  $XDG_DATA_HOME/llmux/orchestration/                    │
       │    data/actors/*.md         ← personas + skills         │
       │    data/channels/main/     ← messages (sharded by date  │
       │      YYYY/MM/DD/*.md          dispatches + replies,     │
       │                               threaded by re:)          │
       │  .git/                      ← full audit log            │
       └────────────────────────────────────────────────────────┘

   Per-message claim locks live OUTSIDE the transport, in the
   machine-local state dir:
       $XDG_STATE_HOME/llmux/orch/orchestration/claims/<flat-id>
                                     ▲
                                     │   (web UI mirrors transport)
                ┌────────────────────┴────────────────────┐
                │   Web: http://<host>:3001/orch          │
                │   "Channels" page — threaded inbox,     │
                │   alias chips, replied-set ack          │
                └─────────────────────────────────────────┘
```

Everything is local-host, local-disk. There's no network round-trip for
message delivery — the bus is a git repo on the same filesystem as the
daemon. Replication to a remote is optional and one-way (DR mirror).

---

## Prerequisites

### 1. Required CLIs

```sh
for c in llmux tmux python3 claude agy opencode codex; do
  command -v "$c" >/dev/null && echo "[ok]  $c" || echo "[MISSING] $c"
done
```

- **`llmux`** — `v0.35.0` or newer (orch + fleet support). Install via
  `npm i -g @cordfuse/llmux@latest`. Verify with `llmux --version`.
- **`tmux`** — the session backend. v3.2+ recommended (for `-e KEY=VAL`
  env injection at session create).
- **`python3`** — used inside the worker recipe for the actual dart
  throws (real RNG; LLM-generated randomness is unusable for Monte
  Carlo, so the recipe shells out to Python's `random`).
- **Agent CLIs** — `claude`, `agy`, `opencode`, `codex`. Each must be
  installed and authenticated independently. The fleet binds one
  agent CLI per worker session, so all four need to be operational
  before `fleet start` is run.

If you don't have all four agent CLIs, you can edit `fleet.yaml`
(see [Adapting the fleet](#adapting-the-fleet)) and drop / swap
workers — the demo works with any N ≥ 1 worker.

### 2. Optional: `gemini` as a fifth worker

The shipped `fleet.yaml` does not include `gemini`. Gemini CLI's free
OAuth tier was sunset on 2026-06-18; if you have a paid API key the
CLI still works and you can add gemini back as a fifth worker — see
[Adapting the fleet](#adapting-the-fleet).

### 3. llmuxd running

```sh
# Check
curl -s http://localhost:3001/api/version
# {"version":"0.36.3"}
```

If not running:

```sh
llmux server start 3001 &
```

The daemon hosts the web UI at `http://localhost:3001/` (web nav
label **Channels** at `/orch`) and is what `llmux orch fleet` talks to
when spawning sessions.

### 4. Disk layout

After init, two directories matter:

| Path | What lives there |
|---|---|
| `~/.local/share/llmux/orchestration/` | The transport. **This is a git repo.** Actors, skills, channel messages. Authoritative for the bus. |
| `~/.local/state/llmux/orch/orchestration/` | Orch machine-local state — per-message **claim locks** + the local ack set. Not part of the git transport (a claim is a local truth, not a bus message). |
| `~/.local/state/llmuxd/` | Daemon machine-local state (sessions.json, auth tokens). Unrelated to orch. |

If `XDG_DATA_HOME` / `XDG_STATE_HOME` are set, those override
`~/.local/share` / `~/.local/state` per XDG spec.

---

## Run it

This section is the happy path with zero detail. Skip to [Phase-by-phase
walkthrough](#phase-by-phase-walkthrough) if you want to see what each
command actually does.

```sh
git clone https://github.com/cordfuse/llmux.git
cd llmux

# 1. One-time: init the transport (creates the git repo on disk)
llmux orch init

# 2. One-time: install the actors + skill into the transport
cp examples/monte-carlo/actors/*.md \
   ~/.local/share/llmux/orchestration/data/actors/
mkdir -p ~/.local/share/llmux/orchestration/data/actors/skills
cp examples/monte-carlo/skills/*.md \
   ~/.local/share/llmux/orchestration/data/actors/skills/
( cd ~/.local/share/llmux/orchestration \
  && git add -A \
  && git commit -m "actors: monte-carlo demo" )

# 3. Spawn the fleet (5 tmux sessions: 1 coordinator + 4 workers) and
#    fire the coordinator's bootstrap, which kicks off the whole run.
llmux orch fleet start --file examples/monte-carlo/fleet.yaml

# 4. Watch the coordinator pane print the final π estimate.
tmux attach -t claude-coord    # Ctrl-b d to detach
```

A successful run prints something like:

```
| alias         | hits  | throws |
| ------------- | ----- | ------ |
| claude-worker | 7865  | 10000  |
| agy           | 7853  | 10000  |
| opencode      | 7848  | 10000  |
| codex         | 7810  | 10000  |
| total         | 31376 | 40000  |

π ≈ 3.1376    (error vs math.pi: 0.004)
```

Numbers vary every run (real RNG). π should land within ±0.02 of
`math.pi` (3.14159…). End-to-end takes ~1–3 minutes depending on
which CLI is slowest to wake up.

---

## Phase-by-phase walkthrough

What each step actually does on disk and over the bus.

### Phase 1 — `llmux orch init`

Creates a fresh git repo at `~/.local/share/llmux/orchestration/`
with this layout:

```
~/.local/share/llmux/orchestration/
├── .git/                      ← full audit log
├── README.md                  ← transport-local readme
├── PROTOCOL.md                ← message format reference
└── data/
    ├── actors/                ← actor (participant) definitions
    │   └── operator.md        ← default human operator persona
    └── channels/
        └── main/              ← default channel (empty until first send)
```

If you run `--remote git@host:llmux-orch.git`, the daemon also
configures a one-way async backup push. The remote is restore-only —
there's no `git pull` semantics; the local transport is authoritative.

### Phase 2 — Install actors + skill

The fleet's six personas (one coordinator + four workers + an unused
`gemini.md` worker template) are copied into `data/actors/`. The
coordinator's skill file goes under `data/actors/skills/`. Then a
git commit records the addition.

After this step:

```
data/actors/
├── operator.md
├── claude-coord.md       ← coordinator persona (includes the skill)
├── claude-worker.md      ← worker persona
├── agy.md                ← worker persona (Antigravity CLI)
├── opencode.md           ← worker persona (OpenCode CLI)
├── codex.md              ← worker persona (Codex CLI)
├── gemini.md             ← worker persona (optional — see adapting)
└── skills/
    └── montecarlo-coordinate.md   ← the dart recipe + aggregation formula
```

The git commit is what makes them appear in the web UI's alias picker
and in `llmux orch status --json` (which reads from the working tree
but also references commit identity).

### Phase 3 — `llmux orch fleet start --file examples/monte-carlo/fleet.yaml`

Reads `fleet.yaml`, then for each session entry:

1. **Spawn** — if a tmux session with that `name` doesn't exist,
   create it via `llmux session start <name> --agent <agent> --orch-alias <alias>`.
   The `--orch-alias` flag injects `$LLMUX_ORCH_ALIAS=<alias>` into
   the agent's spawn env so the agent's own bash tool can call
   `llmux orch send / inbox / reply / ack` without ever passing
   `--alias` explicitly.
2. **Bootstrap** — if the session entry has a `bootstrap:` field,
   send that text as a one-shot prompt to the agent (via
   `llmux session send <name> --body "<prompt>"`).

The coordinator's bootstrap is the trigger:

> Start a Monte Carlo π estimation run NOW. You are claude-coord.
> Read your skill: `cat ~/.local/share/llmux/orchestration/data/actors/skills/montecarlo-coordinate.md`.
> Follow it to completion. Use N=10000 darts per worker. The 4 workers
> are: claude-worker, agy, opencode, codex. Begin.

The workers' bootstraps are all variants of:

> You are an llmux orch worker. Poll your inbox via `llmux orch next --alias <self> --json`.
> The task body contains a recipe — follow it exactly. Reply via
> `llmux orch reply <msg-id> --alias <self> <body>`. Then stop.

So after `fleet start` returns, five tmux sessions exist, all five
agents are alive, the coordinator has read its skill, and the workers
are in polling loops.

### Phase 4 — Coordinator dispatches

The coordinator's first action (per the skill) is to send four task
messages, one per worker:

```sh
llmux orch send --alias claude-coord --to claude-worker --body "throw 10000 darts. ..."
llmux orch send --alias claude-coord --to agy           --body "throw 10000 darts. ..."
llmux orch send --alias claude-coord --to opencode      --body "throw 10000 darts. ..."
llmux orch send --alias claude-coord --to codex         --body "throw 10000 darts. ..."
```

Each `orch send` writes a markdown file under
`data/channels/main/`. The filename is sortable (timestamp-derived) so
the inbox sees messages in send order.

A message on disk looks like this. The **id is the relPath itself**
(date-sharded), not a frontmatter field:

```
data/channels/main/2026/06/25/191208123Z-a1b2c3d4.md
```

```
---
from: claude-coord
to: claude-worker
timestamp: 2026-06-25T19:12:08.123Z
---

throw 10000 darts. Use this exact Python script (real RNG — LLM-generated
randomness is unusable for Monte Carlo):

  python3 -c "import random; n=10000; h=sum(1 for _ in range(n) if random.random()**2+random.random()**2<=1); print(h)"

Reply with strict JSON on one line:

  {"alias":"claude-worker","hits":H,"throws":10000}
```

Frontmatter is minimal by design: `from`, `to` (string or list), an
ISO `timestamp`, and an optional `re:` for replies. The channel is
implicit in the directory path (`data/channels/<channel>/…`). Each
`orch send` is also a git commit, so you can `git log -p` the
transport later and replay the exact prompts the workers received.

### Phase 5 — Workers claim, execute, reply

Each worker's bootstrap put it in a loop on `llmux orch next --alias
<self> --json`. `next` is the **claim** verb — it atomically picks the
oldest message addressed to the caller that no one has claimed yet,
records a claim lock in `data/claims.json`, and prints the message.
Two consumers can't double-process the same message because of the
lock.

The worker:

1. Reads the task body from `next`'s output.
2. Executes the recipe — in this demo, runs the inline `python3 -c "..."`
   to get a hit count.
3. Calls `llmux orch reply <claimed-msg-id> --alias <self> '<json>'`
   to post a reply. The reply file's frontmatter carries
   `re: <dispatch-msg-id>` so it's threaded under the original.
4. Per the bootstrap, stops.

A reply on disk (note `re:` carries the parent's relPath, and `to:`
is set to the parent's `from`):

```
data/channels/main/2026/06/25/191246789Z-7f3e1c20.md
```

```
---
from: claude-worker
to: claude-coord
re: 2026/06/25/191208123Z-a1b2c3d4.md
timestamp: 2026-06-25T19:12:46.789Z
---

{"alias":"claude-worker","hits":7865,"throws":10000}
```

### Phase 6 — Coordinator polls + aggregates

While the workers work, the coordinator polls:

```sh
llmux orch inbox --alias claude-coord --json
```

The `--json` form returns `{ messages: [...], nextCursor: "<latest-id>" }`.
The coordinator's skill says to re-poll every ~10s, passing back the
`nextCursor` as `--since` to only get *new* messages, until it has
exactly four replies (one `re:` matching each dispatch it sent).

Once all four are in, the coordinator runs the aggregation formula
from the skill:

```
pi_estimate = 4 * sum(hits) / sum(throws)
```

…and prints the markdown table + final π line into its own tmux pane.
That output is what you see when you `tmux attach -t claude-coord`.

### Phase 7 (optional) — Ack the replies

The skill suggests:

```sh
llmux orch ack <reply-msg-id> --alias claude-coord
```

…for each reply. `ack` marks a message as processed in the local
ack set so it stops showing up in subsequent `inbox` calls. It does
not delete the message from disk — `git log` still has it. Ack is
just inbox hygiene.

---

## Watching it run

Multiple useful views, pick any:

```sh
# Coordinator pane — where the final π lands
tmux attach -t claude-coord       # Ctrl-b d to detach

# Any worker — see it claim, run python, reply
tmux attach -t agy                # or claude-worker / opencode / codex

# Web UI — threaded inbox view
xdg-open http://localhost:3001/orch    # the "Channels" page

# Message count grows in real time (expect 8 = 4 dispatches + 4 replies)
watch -n 2 'find ~/.local/share/llmux/orchestration/data/channels -name "*.md" | wc -l'

# Git audit log — every send/reply is a commit
git -C ~/.local/share/llmux/orchestration log --oneline

# Inspect a specific message
ls ~/.local/share/llmux/orchestration/data/channels/main/ | tail
cat ~/.local/share/llmux/orchestration/data/channels/main/<filename>.md
```

---

## Stop, reset, clean up

```sh
# Kill the 5 tmux sessions (transport preserved — git history is your log)
llmux orch fleet stop --file examples/monte-carlo/fleet.yaml

# Fully clean slate (wipe transport + claim/ack state). Irreversible.
rm -rf ~/.local/share/llmux/orchestration ~/.local/state/llmux/orch

# Stop the daemon
llmux server stop
```

If you only want to re-run *without* nuking the transport, just
`fleet stop` then `fleet start` again — the previous run's messages
stay in the channel as history, and the coordinator's polling logic
uses `--since` so it won't re-aggregate old replies.

---

## The pieces dissected

### `fleet.yaml` (annotated)

```yaml
sessions:
  - name: claude-coord            # tmux session name (visible in tmux ls)
    agent: claude                  # which agent CLI to spawn — must be in
                                   #   llmux's agent registry (claude / agy /
                                   #   opencode / codex / gemini / qwen)
    orch_alias: claude-coord       # bus identity for this session. Sets
                                   #   $LLMUX_ORCH_ALIAS in the agent's env
                                   #   so `llmux orch …` calls default to it.
    bootstrap: |                   # optional one-shot prompt fired after spawn
      Start a Monte Carlo π estimation run NOW. ...

  - name: claude-worker
    agent: claude
    orch_alias: claude-worker
    bootstrap: |
      You are an llmux orch worker. Poll your inbox via
      `llmux orch next --alias claude-worker --json`. ...

  # ... three more worker entries with the same shape, different agent CLIs
```

Optional fields:

- `cwd:` — working directory for the agent session. Defaults to `$HOME`.

That's the full schema today (`name`, `agent`, `orch_alias`, `cwd`,
`bootstrap`). If you need extra CLI flags or env vars for an agent,
configure them at the agent-registry level (see `llmux agent list`)
rather than per-fleet-entry.

**Re-running `fleet start`** skips the spawn for sessions that already
exist with the same name, but it **does re-fire each session's
bootstrap prompt every time**. So if you only want to spawn missing
sessions without re-triggering the coordinator, kill the coordinator's
bootstrap before re-running, or comment out its `bootstrap:` block
temporarily.

### The actor files

Actor files are markdown with YAML frontmatter, stored at
`data/actors/<alias>.md`. Required frontmatter:

```yaml
---
alias: claude-coord            # unique on this bus
name: Claude (Coordinator)     # human-readable
description: Monte Carlo π estimation orchestrator
species: machine               # machine | human
includes:                      # optional — pull in skills
  - ./skills/montecarlo-coordinate.md
---
```

Body is the persona prompt the agent reads when bootstrapping. The
`includes:` field lets a persona reference one or more skill files
that get rendered inline when the agent reads its actor file. That's
how the coordinator gets the Monte Carlo recipe without it being
hardcoded into the agent CLI itself.

The workers (`claude-worker.md`, `agy.md`, `opencode.md`, `codex.md`)
have no `includes:` — they're deliberately generic. They know how to
poll/claim/reply on the bus, and they execute whatever recipe arrives
in a task body. They have zero Monte Carlo knowledge.

### The skill — `skills/montecarlo-coordinate.md`

This is the only Monte Carlo specific file in the whole setup. It
documents:

- **Dispatch** — what to put in each worker's task body (the inline
  python recipe + the JSON reply shape).
- **Wait** — how to poll for replies (`inbox --json` every ~10s,
  threading by `re:`, ~3 min hard timeout per worker).
- **Aggregate** — the `pi = 4 * hits / throws` formula and the output
  table shape.
- **Cleanup** — optional `ack` per reply.

To run a *different* fanout task, you write a new skill file and a
new coordinator actor that `includes:` it. The worker fleet is
unchanged.

---

## Adapting the fleet

### Add gemini as a fifth worker (paid API key required)

`examples/monte-carlo/actors/gemini.md` is already shipped (in case you
want it). Just add the session to `fleet.yaml`:

```yaml
  - name: gemini
    agent: gemini
    orch_alias: gemini
    bootstrap: |
      You are an llmux orch worker. Poll your inbox via `llmux orch next --alias gemini --json`. The task body contains a recipe — follow it exactly. Reply via `llmux orch reply <msg-id> --alias gemini <body>`. Then stop.
```

And update the coordinator's bootstrap to dispatch to 5 workers:
change `The 4 workers are: claude-worker, agy, opencode, codex.` to
`The 5 workers are: claude-worker, agy, opencode, codex, gemini.`

### Drop a worker you don't have installed

Delete the session entry from `fleet.yaml` and remove that alias from
the coordinator's bootstrap line. The aggregation formula has no
fixed worker count — it sums whatever replies come back.

### Use the pattern for a non-π task

The whole point of the method-vs-recipe split is that this is easy:

1. Write a new skill `data/actors/skills/<your-task>-coordinate.md`
   with three sections: **Dispatch** (what the worker recipe is),
   **Wait** (when to stop polling), **Aggregate** (how to combine
   replies).
2. Write a new coordinator actor `data/actors/<your-coord>.md` that
   `includes:` the new skill.
3. Copy `examples/monte-carlo/fleet.yaml` to a new file, point the
   coordinator session at your new actor + change the bootstrap to
   trigger the new task.
4. `llmux orch fleet start --file <your-fleet>.yaml`.

The workers don't need to change. They're a reusable fleet.

---

## Troubleshooting

| Symptom | Cause + fix |
|---|---|
| `MISSING: llmux orch fleet` from prereqs script | Old `llmux` — `npm i -g @cordfuse/llmux@latest`. Requires v0.35.0+. |
| `fleet start` fails with "agent not found" | The agent CLI for that worker isn't installed or isn't on PATH. Either install it, or remove that worker from `fleet.yaml`. |
| Worker session is stuck on a permission prompt (opencode does this for `/tmp`) | `tmux attach -t opencode`, hit Enter to approve "Allow once". Future spawns: set the CLI's "always allow" for the path. |
| Coordinator polls forever, never finishes | One or more workers never replied. `tmux attach -t <alias>` for each worker; investigate the pane. Common: worker hit a rate limit, or the agent CLI failed to invoke `python3`. |
| Coordinator's bootstrap never fires | `llmuxd` wasn't running when `fleet start` ran, or the tmux session already existed before `fleet start` and the bootstrap quietly failed. `llmux server start 3001`, then re-run `fleet start` — bootstraps re-fire for every existing session. |
| Worker claims a message but never replies | Look in `~/.local/state/llmux/orch/orchestration/claims/` for a file named after the message (with `/` → `__`). It's a JSON record `{alias, claimedAt, heartbeatAt}`. Either wait for the claim TTL (5 min) to expire, or `llmux orch release <msg-id> --alias <worker>` to drop the claim manually. |
| Aggregation runs but π is wildly off (>0.1 error) | Check whether all workers actually used real RNG. Some agents may "helpfully" estimate `hits` instead of running the python. The recipe explicitly forbids this — re-read the worker pane and adjust. |
| Web UI at `/orch` shows nothing | Check `llmux orch status` — if transport path is empty, you forgot Phase 2 (no actors installed). |
| Replies arrive but coordinator sees them as un-threaded | The worker called `orch send` instead of `orch reply <msg-id>`. `reply` is what populates the `re:` field. The skill is explicit; if a worker is going off-script, tighten the bootstrap wording. |

---

## Reference

- **Orch design** — [ORCHESTRATION-DESIGN.md](ORCHESTRATION-DESIGN.md) — full design behind the transport, claim model, and at-least-once semantics.
- **Orch CLI surface** — `llmux orch --help` and `llmux orch <verb> --help`.
- **Fleet YAML schema** — top-of-file comments at `examples/monte-carlo/fleet.yaml` and `packages/llmux/src/orch/fleet.ts`.
- **Transport on disk** — `~/.local/share/llmux/orchestration/` is a normal git repo. `git log`, `git show <commit>`, `git diff` it freely. Restore from clone with `git clone <remote> ~/.local/share/llmux/orchestration`.
- **Web UI** — `http://<host>:3001/orch` (nav label **Channels**). REST endpoints under `/api/orch/*`.
- **Crosstalk sibling** — same on-disk message format, cross-machine system-level multi-user variant: `@cordfuse/crosstalk`.
