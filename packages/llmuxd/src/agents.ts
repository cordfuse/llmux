import { spawnSync } from 'node:child_process';

export interface AgentDefinition {
  /** Key under `agents:` in .llmux.yaml; default tmux-session name. */
  key: string;
  /** Executable to launch in the tmux pane. */
  cmd: string;
  /** Default args appended after `cmd`. */
  flags?: string;
  /** Regex matched against the bottom of the pane to detect "ready for input". */
  readyPrompt: string;
  /** Custom install detection (overrides the default `command -v <cmd>`). */
  detectInstalled?: () => boolean;
}

const which = (cmd: string): boolean => {
  const r = spawnSync('command', ['-v', cmd], { stdio: 'pipe', shell: true });
  return r.status === 0;
};

const copilotInstalled = (): boolean => {
  const r = spawnSync('gh', ['extension', 'list'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return r.stdout.toString().includes('copilot');
};

export const DEFAULT_AGENTS: Record<string, AgentDefinition> = {
  claude: { key: 'claude', cmd: 'claude', flags: '--dangerously-skip-permissions', readyPrompt: '^>' },
  agy: { key: 'agy', cmd: 'agy', flags: '--dangerously-skip-permissions', readyPrompt: '^agy>' },
  codex: { key: 'codex', cmd: 'codex', readyPrompt: '^>' },
  qwen: { key: 'qwen', cmd: 'qwen', readyPrompt: '^>' },
  opencode: { key: 'opencode', cmd: 'opencode', readyPrompt: '^>' },
  grok: { key: 'grok', cmd: 'grok', readyPrompt: '^grok>' },
  aider: { key: 'aider', cmd: 'aider', flags: '--model claude-opus-4-6', readyPrompt: '^> $' },
  goose: { key: 'goose', cmd: 'goose', readyPrompt: 'Goose❯' },
  copilot: { key: 'copilot', cmd: 'gh copilot', readyPrompt: '●', detectInstalled: copilotInstalled },
};

export function isAgentInstalled(agent: AgentDefinition): boolean {
  if (agent.detectInstalled) return agent.detectInstalled();
  // For multi-word commands, check only the first token.
  const head = agent.cmd.split(/\s+/)[0]!;
  return which(head);
}

export function installedAgents(defs: Record<string, AgentDefinition> = DEFAULT_AGENTS): AgentDefinition[] {
  return Object.values(defs).filter(isAgentInstalled);
}
