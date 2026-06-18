import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

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
  /** Path to the runtime overlay file (if it exists and was applied on top of sourcePath). */
  overlayPath?: string;
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

/**
 * Runtime overlay — values written by the Settings page in the web UI.
 * Always lives at `~/.config/llmux/overrides.yaml` regardless of how the
 * base config was discovered. Layered on top of the base at load time so
 * the operator's hand-edited `.llmux.yaml` stays pristine (comments +
 * formatting preserved). Delete the overlay file to revert all UI edits
 * in one shot.
 *
 * Only a strict subset of fields is overlayable — `initPrompts` and
 * `turnq`. Other fields (`server`, `agents`, `sessions`) are out of scope
 * for now (server.port + sessions[] in particular need a daemon restart
 * to take effect, so editing them from the UI is a foot-gun).
 */
export interface ConfigOverride {
  initPrompts?: string[];
  turnq?: TurnqConfig;
}

export function overridePath(home?: string): string {
  return join(home ?? homedir(), '.config', 'llmux', 'overrides.yaml');
}

export function loadOverride(home?: string): ConfigOverride {
  const path = overridePath(home);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = parseYaml(raw) as Partial<ConfigOverride> | null;
    const out: ConfigOverride = {};
    if (Array.isArray(parsed?.initPrompts)) {
      out.initPrompts = parsed!.initPrompts.filter((p): p is string => typeof p === 'string');
    }
    if (parsed?.turnq && typeof parsed.turnq === 'object') {
      out.turnq = {
        enabled: Boolean(parsed.turnq.enabled),
        ...(typeof parsed.turnq.url === 'string' && parsed.turnq.url.length > 0 ? { url: parsed.turnq.url } : {}),
        ...(typeof parsed.turnq.maxHoldMs === 'number' ? { maxHoldMs: parsed.turnq.maxHoldMs } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Patch the overlay file. Each provided field replaces wholesale (set
 * `initPrompts: []` to wipe, omit the field to leave the existing value
 * alone). For `turnq`, the entire turnq object is replaced — pass the
 * fully-resolved object you want the overlay to contain.
 *
 * Writes atomically (write-to-tmp + rename) so a partial write can't
 * leave the overlay file in a torn state.
 */
export function saveOverride(patch: Partial<ConfigOverride>, home?: string): ConfigOverride {
  const path = overridePath(home);
  const current = loadOverride(home);
  const next: ConfigOverride = { ...current };
  if (patch.initPrompts !== undefined) next.initPrompts = patch.initPrompts;
  if (patch.turnq !== undefined) next.turnq = patch.turnq;
  mkdirSync(dirname(path), { recursive: true });
  const yaml = `# llmux runtime overrides — written by the Settings page in the web UI.\n` +
               `# Layered on top of the base .llmux.yaml / config.yaml at load time.\n` +
               `# Delete this file to revert all UI edits to the on-disk base config.\n` +
               stringifyYaml(next);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, yaml, 'utf8');
  renameSync(tmp, path);
  return next;
}

export function loadBaseConfig(opts: DiscoverOptions = {}): LlmuxConfig {
  const path = discoverConfigPath(opts);
  if (!path) return DEFAULT_CONFIG;
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw) as Partial<LlmuxConfig> | null;
  return {
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
}

export function loadConfig(opts: DiscoverOptions = {}): LlmuxConfig {
  const base = loadBaseConfig(opts);
  const overlay = loadOverride(opts.home);
  const overlayApplied = overlay.initPrompts !== undefined || overlay.turnq !== undefined;
  return {
    ...base,
    ...(overlay.initPrompts !== undefined ? { initPrompts: overlay.initPrompts } : {}),
    ...(overlay.turnq !== undefined ? { turnq: overlay.turnq } : {}),
    ...(overlayApplied && existsSync(overridePath(opts.home)) ? { overlayPath: overridePath(opts.home) } : {}),
  };
}
