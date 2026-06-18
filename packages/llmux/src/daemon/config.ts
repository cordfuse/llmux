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
}

export interface LlmuxConfig {
  server: ServerConfig;
  agents: Record<string, AgentOverrides>;
  sessions: SessionConfig[];
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
    sourcePath: path,
  };
  return merged;
}
