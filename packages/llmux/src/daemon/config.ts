import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface ServerConfig {
  port: number;
  token?: string;
  tokenExpiry?: string;
  noQr: boolean;
}

export interface SessionConfig {
  name: string;
  agent: string;
  cwd?: string;
  autoSpawn: boolean;
  restart: 'always' | 'on-failure' | 'never';
}

export interface AgentOverrides {
  cmd?: string;
  flags?: string;
  readyPrompt?: string;
}

/**
 * turnq integration — FIFO turn coordination across senders (CLI + web)
 * so two clients writing into the same tmux session don't conflict.
 *
 * - When `enabled: true`, llmux auto-injects a system marker prompt as the
 *   last init prompt of every spawn, asking the agent to emit a unique
 *   per-session marker on its own line when it finishes responding.
 * - Every `tmux send-keys` wraps in `withTurn(channel = llmux:<session>)`
 *   acquired from a turnq Coordinator.
 * - The held turn releases when the daemon sees the marker in the pane
 *   tail (agent self-signals completion), OR when `maxHoldMs` elapses
 *   (hard fallback; logs a warning).
 * - If `url` is set, the Coordinator talks to a turnq server (distributed
 *   mode). If omitted, it uses turnq's local `flock(2)` mode — no server
 *   required.
 */
export interface TurnqConfig {
  enabled: boolean;
  url?: string;
  /** Hard timeout after which the turn auto-releases. Default 300_000 (5 min). */
  maxHoldMs?: number;
}

export interface LlmuxConfig {
  server: ServerConfig;
  agents: Record<string, AgentOverrides>;
  sessions: SessionConfig[];
  /**
   * Daemon-wide initialization prompts. Fired into every newly-spawned
   * session (and every respawn) before any operator interaction. Composed
   * with the per-session `initPrompts` field at spawn time, with the
   * daemon-wide prompts firing first.
   */
  initPrompts?: string[];
  turnq?: TurnqConfig;
  sourcePath?: string;
}

export const DEFAULT_CONFIG: LlmuxConfig = {
  server: { port: 3000, noQr: false },
  agents: {},
  sessions: [],
};

export interface DiscoverOptions {
  /** Path passed via `--config` (highest priority). */
  explicit?: string;
  /** Override cwd (defaults to process.cwd()). */
  cwd?: string;
  /** Override $HOME (defaults to os.homedir()). */
  home?: string;
  /** $LLMUX_CONFIG value (defaults to process.env.LLMUX_CONFIG). */
  envVar?: string;
}

/** Resolve config path per discovery rules; null = no config, use defaults. */
export function discoverConfigPath(opts: DiscoverOptions = {}): string | null {
  if (opts.explicit) return opts.explicit;
  const cwd = opts.cwd ?? process.cwd();
  const projectLocal = join(cwd, '.llmux.yaml');
  if (existsSync(projectLocal)) return projectLocal;
  const home = opts.home ?? homedir();
  const globalDefault = join(home, '.config', 'llmux', 'config.yaml');
  if (existsSync(globalDefault)) return globalDefault;
  const env = opts.envVar ?? process.env.LLMUX_CONFIG;
  if (env && existsSync(env)) return env;
  return null;
}

export function loadConfig(opts: DiscoverOptions = {}): LlmuxConfig {
  const path = discoverConfigPath(opts);
  if (!path) return DEFAULT_CONFIG;
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as Partial<LlmuxConfig> | null;
  const merged: LlmuxConfig = {
    server: { ...DEFAULT_CONFIG.server, ...(parsed?.server ?? {}) },
    agents: { ...DEFAULT_CONFIG.agents, ...(parsed?.agents ?? {}) },
    sessions: parsed?.sessions ?? [],
    ...(Array.isArray(parsed?.initPrompts) ? { initPrompts: parsed.initPrompts.filter((p): p is string => typeof p === 'string') } : {}),
    ...(parsed?.turnq && typeof parsed.turnq === 'object'
      ? {
          turnq: {
            enabled: Boolean(parsed.turnq.enabled),
            ...(typeof parsed.turnq.url === 'string' ? { url: parsed.turnq.url } : {}),
            ...(typeof parsed.turnq.maxHoldMs === 'number' ? { maxHoldMs: parsed.turnq.maxHoldMs } : {}),
          },
        }
      : {}),
    sourcePath: path,
  };
  return merged;
}
