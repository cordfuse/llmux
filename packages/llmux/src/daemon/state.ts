import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SessionState {
  name: string;
  agent: string;
  cwd: string;
  /** Override of the agent definition's default flags. undefined = use default. */
  flags?: string;
  /** Per-session environment variable overrides (merged over agent envDefaults). */
  env?: Record<string, string>;
  /** ID of the agent's prior conversation this session resumed from (if any). */
  resumeFrom?: string;
  /**
   * Per-session initialization prompts. Fired into the agent after the
   * readyPrompt regex matches (or a fallback 2s sleep). Re-fired on
   * `session restart` (a respawn restores the context); NOT fired on
   * `session resume` (the prompts are already in the conversation
   * history). Composed with the daemon-wide `initPrompts` from
   * `.llmux.yaml` at spawn time, with the daemon prompts firing first.
   */
  initPrompts?: string[];
  /**
   * Per-session turnq turn-marker (random hex suffix). Generated at spawn
   * when turnq is enabled. The agent is instructed via a built-in init
   * prompt to emit `<<LLMUX_DONE_xxxxxxxx>>` as the last line of every
   * response; sendWithTurn polls the pane for this marker before
   * releasing the turn.
   */
  turnqMarker?: string;
  createdAt: string;
  parent: string | null;
  restart: 'always' | 'on-failure' | 'never';
}

export interface State {
  version: 1;
  sessions: Record<string, SessionState>;
}

const EMPTY: State = { version: 1, sessions: {} };

export function stateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg ? join(xdg, 'llmuxd') : join(homedir(), '.local', 'state', 'llmuxd');
}

export function statePath(): string {
  return join(stateDir(), 'sessions.json');
}

export function load(): State {
  const path = statePath();
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<State>;
    if (parsed.version !== 1 || typeof parsed.sessions !== 'object' || parsed.sessions === null) {
      return structuredClone(EMPTY);
    }
    return { version: 1, sessions: parsed.sessions as Record<string, SessionState> };
  } catch {
    return structuredClone(EMPTY);
  }
}

export function save(state: State): void {
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function record(session: SessionState): void {
  const state = load();
  state.sessions[session.name] = session;
  save(state);
}

export function forget(name: string): void {
  const state = load();
  delete state.sessions[name];
  save(state);
}

export function get(name: string): SessionState | undefined {
  return load().sessions[name];
}

export function list(): SessionState[] {
  return Object.values(load().sessions);
}

export function children(parent: string): SessionState[] {
  return list().filter((s) => s.parent === parent);
}
