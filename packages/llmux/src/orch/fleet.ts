// Fleet: a declarative bundle of sessions + their bootstraps. Replaces
// hand-written shell scripts (run.sh) for spawning + booting multi-agent
// orchestrations. Fleet config is YAML; one file = one orchestration shape.
//
// Schema (minimal; extends naturally):
//
//   sessions:
//     - name: claude-coord                    # tmux session name
//       agent: claude                          # llmux agent CLI
//       orch_alias: claude-coord               # sets $LLMUX_ORCH_ALIAS in spawn env
//       cwd: ~/Repos                           # optional, defaults to $HOME
//       bootstrap: |                           # optional, llmux session prompt after spawn
//         Start a Monte Carlo run with N=10000 per worker.
//     - name: gemini
//       agent: gemini
//       orch_alias: gemini
//       bootstrap: |
//         You are an llmux orch worker. Poll your inbox and follow recipes.

import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { parse as parseYaml } from 'yaml';
import * as tmux from '../daemon/tmux.ts';

/**
 * Resolve the `llmux` binary to invoke for child commands. When the user
 * is running this code via tsx (e.g., `npx tsx packages/llmux/src/index.ts
 * orch fleet start`), we want session-start to ALSO go through the same
 * tsx + source path so any local fixes apply. Falls back to the globally-
 * installed `llmux` binary otherwise.
 *
 * Detection: process.argv[1] is the entry file. If it ends in .ts and
 * tsx is on PATH, build a `npx tsx <entry>` invocation. Otherwise use
 * plain `llmux`.
 */
function resolveLlmuxCmd(): { cmd: string; prefix: string[] } {
  const entry = process.argv[1] ?? '';
  if (entry.endsWith('.ts') && existsSync(entry)) {
    return { cmd: 'npx', prefix: ['tsx', entry] };
  }
  return { cmd: 'llmux', prefix: [] };
}

export interface FleetSession {
  name: string;
  agent: string;
  orchAlias: string;
  cwd?: string;
  bootstrap?: string;
}

export interface Fleet {
  sessions: FleetSession[];
}

export function loadFleet(path: string): Fleet {
  if (!existsSync(path)) {
    throw new Error(`fleet config not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as { sessions?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sessions)) {
    throw new Error(`fleet config at ${path} must have a top-level \`sessions:\` array`);
  }
  const sessions: FleetSession[] = parsed.sessions.map((s: unknown, i: number) => {
    if (!s || typeof s !== 'object') throw new Error(`fleet sessions[${i}] is not an object`);
    const obj = s as Record<string, unknown>;
    const name = String(obj['name'] ?? '');
    const agent = String(obj['agent'] ?? '');
    const orchAlias = String(obj['orch_alias'] ?? obj['orchAlias'] ?? '');
    if (!name) throw new Error(`fleet sessions[${i}] missing \`name\``);
    if (!agent) throw new Error(`fleet sessions[${i}] missing \`agent\``);
    if (!orchAlias) throw new Error(`fleet sessions[${i}] missing \`orch_alias\``);
    const out: FleetSession = { name, agent, orchAlias };
    if (typeof obj['cwd'] === 'string') out.cwd = obj['cwd'] as string;
    if (typeof obj['bootstrap'] === 'string') out.bootstrap = obj['bootstrap'] as string;
    return out;
  });
  return { sessions };
}

export interface FleetStartReport {
  spawned: string[];
  skipped: string[];     // already existed
  bootstrapped: string[];
  errors: { name: string; phase: 'spawn' | 'bootstrap'; error: string }[];
}

/**
 * Spawn every session in the fleet (skipping those that already exist),
 * then send each session's bootstrap prompt. Uses subprocess calls to
 * `llmux session start` and `tmux send-keys` rather than importing
 * daemon internals — keeps the fleet runner decoupled from the daemon's
 * own session-spawn shape, and matches the proven-working bootstrap
 * path from the Monte Carlo smoke (direct tmux is more deterministic
 * than `llmux session prompt` against older daemons with turnq).
 *
 * Bootstrap timing: a small delay between spawn-loop and prompt-loop
 * lets agent CLIs come up before they receive their first prompt. A
 * longer delay between bootstraps prevents multi-line prompts from
 * stomping on each other (a Claude Code TUI quirk).
 */
export function startFleet(fleet: Fleet, opts: { settleSec?: number; perPromptSec?: number } = {}): FleetStartReport {
  const settleSec = opts.settleSec ?? 5;
  const perPromptSec = opts.perPromptSec ?? 1;
  const report: FleetStartReport = { spawned: [], skipped: [], bootstrapped: [], errors: [] };

  // Phase 1: spawn missing sessions
  const existing = listSessionNames();
  for (const s of fleet.sessions) {
    if (existing.has(s.name)) {
      report.skipped.push(s.name);
      continue;
    }
    const { cmd, prefix } = resolveLlmuxCmd();
    const args = [
      ...prefix,
      'session', 'start', s.agent,
      '--name', s.name,
      '--orch-alias', s.orchAlias,
    ];
    if (s.cwd) args.push('--cwd', s.cwd);
    const r = spawnSync(cmd, args, { encoding: 'utf-8' });
    if (r.status !== 0) {
      report.errors.push({ name: s.name, phase: 'spawn', error: (r.stderr || r.stdout).trim().slice(0, 300) });
      continue;
    }
    report.spawned.push(s.name);
  }

  // Phase 2: let agents settle before sending prompts
  if (report.spawned.length > 0 && settleSec > 0) {
    sleepSec(settleSec);
  }

  // Phase 3: send bootstrap prompts (only to sessions that exist now)
  for (const s of fleet.sessions) {
    if (!s.bootstrap) continue;
    const exists = listSessionNames().has(s.name);
    if (!exists) continue;
    // Use tmux.sendKeys (paste-mode-aware: 250ms pause between text and
    // Enter) instead of raw `tmux send-keys text Enter` — ink-based TUIs
    // (Claude Code, OpenCode, agy) detect fast Enter as a paste-mode
    // newline rather than submit, so bootstraps end up sitting in the
    // input box unsubmitted. Without this, the MC fleet workers all hung
    // on their first prompt.
    try {
      tmux.sendKeys(s.name, s.bootstrap, { enter: true });
    } catch (err) {
      report.errors.push({ name: s.name, phase: 'bootstrap', error: (err as Error).message.slice(0, 300) });
      continue;
    }
    report.bootstrapped.push(s.name);
    if (perPromptSec > 0) sleepSec(perPromptSec);
  }

  return report;
}

export interface FleetStopReport {
  stopped: string[];
  notFound: string[];
  errors: { name: string; error: string }[];
}

/**
 * Kill every session named in the fleet (silent skip if not running).
 * Does NOT touch the orch transport — messages persist for audit.
 */
export function stopFleet(fleet: Fleet): FleetStopReport {
  const report: FleetStopReport = { stopped: [], notFound: [], errors: [] };
  const existing = listSessionNames();
  for (const s of fleet.sessions) {
    if (!existing.has(s.name)) {
      report.notFound.push(s.name);
      continue;
    }
    const r = spawnSync('llmux', ['session', 'stop', s.name], { encoding: 'utf-8' });
    if (r.status !== 0) {
      report.errors.push({ name: s.name, error: (r.stderr || r.stdout).trim().slice(0, 300) });
      continue;
    }
    report.stopped.push(s.name);
  }
  return report;
}

function listSessionNames(): Set<string> {
  const r = spawnSync('llmux', ['session', 'list'], { encoding: 'utf-8' });
  if (r.status !== 0) return new Set();
  // Output: header row + rows; first whitespace-delimited field is the name
  const names = new Set<string>();
  const lines = r.stdout.split('\n').slice(1); // drop header
  for (const line of lines) {
    const name = line.trim().split(/\s+/)[0];
    if (name) names.add(name);
  }
  return names;
}

function sleepSec(s: number): void {
  spawnSync('sleep', [String(s)]);
}

