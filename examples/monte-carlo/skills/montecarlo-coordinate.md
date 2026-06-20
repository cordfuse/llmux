# Skill: monte-carlo coordinate

How to run a Monte Carlo π estimation across N workers via the llmux
orchestration bus. The coordinator owns the **method** (this skill);
workers only follow the recipe that arrives in each task.

## Dispatch

For each worker, send a task message via `llmux orch send --to <worker>`
with this body (substitute the dart count for `<N>`):

```
throw <N> darts. Use this exact Python script (real RNG — LLM-generated
randomness is unusable for Monte Carlo):

  python3 -c "import random; n=<N>; h=sum(1 for _ in range(n) if random.random()**2+random.random()**2<=1); print(h)"

Reply with strict JSON on one line:

  {"alias":"<your-alias>","hits":H,"throws":<N>}
```

## Wait for replies

Poll `llmux orch inbox --alias claude-coord --json` every ~10 seconds.
Each worker reply has `re:` pointing at one of your dispatch msg-ids
and `from:` set to the worker's alias. Stop polling when you have
replies from every worker you dispatched to.

If a worker hasn't replied after ~3 minutes, surface that as a partial
result and proceed; don't block forever.

## Aggregate

```
pi_estimate = 4 * sum(hits) / sum(throws)
```

Print a markdown table with one row per worker (`alias | hits | throws`),
a total row, and a final line:

```
π ≈ <pi_estimate>    (error vs math.pi: <delta>)
```

## Cleanup (optional)

After aggregation, ack each reply to clear your inbox without polluting
the bus with terminal "ack" messages:

```
llmux orch ack <reply-msg-id> --alias claude-coord
```
