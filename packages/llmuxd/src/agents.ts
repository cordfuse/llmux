import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';

export interface AgentDefinition {
  /** Key under `agents:` in .llmux.yaml; default tmux-session name. */
  key: string;
  /** Human-readable name shown in UI surfaces (picker dropdown, etc.). */
  displayName: string;
  /** Executable to launch in the tmux pane. */
  cmd: string;
  /** Default args appended after `cmd`. */
  flags?: string;
  /** Regex matched against the bottom of the pane to detect "ready for input". */
  readyPrompt: string;
  /** Custom install detection (overrides the default PATH lookup). */
  detectInstalled?: () => boolean;
}

const which = (cmd: string): boolean => {
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // not in this dir
    }
  }
  return false;
};

const copilotInstalled = (): boolean => {
  const r = spawnSync('gh', ['extension', 'list'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return r.stdout.toString().includes('copilot');
};

export const DEFAULT_AGENTS: Record<string, AgentDefinition> = {
  claude:   { key: 'claude',   displayName: 'Claude Code',     cmd: 'claude',     flags: '--dangerously-skip-permissions', readyPrompt: '^>' },
  codex:    { key: 'codex',    displayName: 'Codex CLI',       cmd: 'codex',                                              readyPrompt: '^>' },
  agy:      { key: 'agy',      displayName: 'Antigravity CLI', cmd: 'agy',        flags: '--dangerously-skip-permissions', readyPrompt: '^agy>' },
  gemini:   { key: 'gemini',   displayName: 'Gemini CLI',      cmd: 'gemini',     flags: '--yolo',                         readyPrompt: '^>' },
  qwen:     { key: 'qwen',     displayName: 'Qwen Code',       cmd: 'qwen',       flags: '--yolo',                         readyPrompt: '^>' },
  opencode: { key: 'opencode', displayName: 'OpenCode',        cmd: 'opencode',                                           readyPrompt: '^>' },
  grok:     { key: 'grok',     displayName: 'Grok CLI',        cmd: 'grok',                                               readyPrompt: '^grok>' },
  aider:    { key: 'aider',    displayName: 'Aider',           cmd: 'aider',      flags: '--model claude-opus-4-6',        readyPrompt: '^> $' },
  goose:    { key: 'goose',    displayName: 'Goose',           cmd: 'goose',                                              readyPrompt: 'Goose❯' },
  copilot:  { key: 'copilot',  displayName: 'GitHub Copilot',  cmd: 'gh copilot',                                         readyPrompt: '●', detectInstalled: copilotInstalled },
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
