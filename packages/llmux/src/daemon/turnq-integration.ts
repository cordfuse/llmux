/**
 * turnq integration — FIFO turn coordination for tmux send-keys.
 *
 * Two responsibilities:
 *
 * 1. Singleton Coordinator initialization. `getCoordinator(cfg)` lazy-inits
 *    once per daemon process; subsequent calls return the cached instance.
 *    If `cfg.url` is set, the Coordinator talks to a turnq HTTP server
 *    (distributed mode); otherwise it falls back to turnq's local `flock(2)`
 *    mode — no server required.
 *
 * 2. `sendWithTurn(name, prompt, enter, opts)` — acquires the turn on
 *    channel `llmux:<session>`, fires send-keys, polls the pane tail for
 *    the session's marker (set at spawn time), releases when the marker
 *    appears OR after `maxHoldMs`. If turnq is disabled in config, this is
 *    a passthrough — sendKeys runs immediately and returns.
 *
 * The marker is per-session (random hex suffix at spawn) so two operators
 * can't spoof releases on each other's sessions, and quoted/discussed
 * mentions of "MARKER" in normal output don't trigger false releases.
 */

import { randomBytes } from 'node:crypto';
import type { TurnqConfig } from './config.ts';
import * as tmux from './tmux.ts';
import * as state from './state.ts';

let cachedCoordinator: { coordinator: unknown; cfg: TurnqConfig } | null = null;

/**
 * Lazy-init the turnq Coordinator. Returns null if turnq is disabled
 * (so callers don't have to check separately). Caches the instance so
 * each subsequent send-keys reuses the same Coordinator (and the same
 * lock files / HTTP keep-alive connection).
 */
export async function getCoordinator(cfg: TurnqConfig | undefined): Promise<unknown | null> {
  if (!cfg || !cfg.enabled) return null;
  if (cachedCoordinator && JSON.stringify(cachedCoordinator.cfg) === JSON.stringify(cfg)) {
    return cachedCoordinator.coordinator;
  }
  // Dynamic import so the dep stays out of the cold path when turnq is
  // disabled — bundling-friendly and avoids paying the load cost for
  // operators who never opt in.
  const mod = await import('@cordfuse/turnq/coordinator');
  const coordinator = await (mod as { createCoordinator: (opts?: { url?: string }) => Promise<unknown> }).createCoordinator(
    cfg.url ? { url: cfg.url } : {},
  );
  cachedCoordinator = { coordinator, cfg: { ...cfg } };
  return coordinator;
}

/** Generate a per-session marker suffix. 8 hex chars — collision-free for
 *  any realistic number of concurrent sessions, short enough to read. */
export function generateMarker(): string {
  return `LLMUX_DONE_${randomBytes(4).toString('hex')}`;
}

/**
 * Format the system prompt that asks the agent to emit the marker. Goes in
 * at the END of every init-prompt batch (after daemon + session prompts)
 * so the LLM's recency bias keeps it fresh when the first real prompt
 * lands.
 */
export function buildMarkerPrompt(marker: string): string {
  return [
    `[llmux turn-tracking instruction]`,
    `When you have COMPLETELY finished responding to a message (no more output coming),`,
    `emit this on its own line as your final output line:`,
    ``,
    `<<${marker}>>`,
    ``,
    `Do this at the end of EVERY response — it's how llmux knows your turn is done`,
    `and the next sender can take theirs. Do not emit it before you're truly finished.`,
  ].join('\n');
}

/**
 * Send a prompt with FIFO turn coordination. If turnq is disabled, this
 * just calls sendKeys synchronously and returns. If enabled, acquires the
 * turn on `llmux:<sessionName>`, fires send-keys, polls the pane for the
 * session's marker, releases when matched OR after maxHoldMs.
 */
export async function sendWithTurn(
  sessionName: string,
  prompt: string,
  opts: { enter?: boolean; skipTurnq?: boolean; turnqConfig?: TurnqConfig | undefined } = {},
): Promise<void> {
  const cfg = opts.turnqConfig;
  const enter = opts.enter !== false;
  if (opts.skipTurnq || !cfg || !cfg.enabled) {
    tmux.sendKeys(sessionName, prompt, { enter });
    return;
  }
  const session = state.get(sessionName);
  const marker = session?.turnqMarker;
  const coord = (await getCoordinator(cfg)) as
    | { withTurn: (ch: string, fn: () => Promise<void>) => Promise<void> }
    | null;
  if (!coord) {
    // Should not happen if cfg.enabled — defensive fallback.
    tmux.sendKeys(sessionName, prompt, { enter });
    return;
  }
  const channel = `llmux:${sessionName}`;
  const maxHoldMs = cfg.maxHoldMs ?? 300_000;
  await coord.withTurn(channel, async () => {
    tmux.sendKeys(sessionName, prompt, { enter });
    if (!marker) {
      // No marker on this session (spawned pre-v0.30.0 or turnq was off
      // at spawn). Hold the turn for a short fixed window so back-to-back
      // sends still serialize; not as accurate as marker-detection but
      // better than instant release.
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      return;
    }
    const needle = `<<${marker}>>`;
    const start = Date.now();
    while (Date.now() - start < maxHoldMs) {
      try {
        const pane = tmux.capturePane(sessionName, 25);
        if (pane.includes(needle)) return;
      } catch {
        // pane may not be available momentarily; keep polling
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    }
    console.warn(
      `[llmux] turnq: marker not seen on ${sessionName} within ${maxHoldMs}ms; releasing anyway`,
    );
  });
}
