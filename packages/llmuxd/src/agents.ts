import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
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
  // `gh copilot` is a built-in subcommand of gh 2.92+ (not an extension), and
  // the actual Copilot CLI binary is downloaded on first invocation to
  // ~/.local/share/gh/copilot. Treat the binary's presence as the install
  // signal — `gh extension list` no longer surfaces copilot.
  return existsSync(join(homedir(), '.local/share/gh/copilot'));
};

export const DEFAULT_AGENTS: Record<string, AgentDefinition> = {
  claude:   { key: 'claude',   displayName: 'Claude Code',         cmd: 'claude',       flags: '--dangerously-skip-permissions',             readyPrompt: '^>' },
  codex:    { key: 'codex',    displayName: 'Codex CLI',           cmd: 'codex',        flags: '--dangerously-bypass-approvals-and-sandbox', readyPrompt: '^>' },
  agy:      { key: 'agy',      displayName: 'Antigravity CLI',     cmd: 'agy',          flags: '--dangerously-skip-permissions',             readyPrompt: '^agy>' },
  gemini:   { key: 'gemini',   displayName: 'Gemini CLI',          cmd: 'gemini',       flags: '--yolo',                                     readyPrompt: '^>' },
  qwen:     { key: 'qwen',     displayName: 'Qwen Code',           cmd: 'qwen',         flags: '--yolo',                                     readyPrompt: '^>' },
  opencode: { key: 'opencode', displayName: 'OpenCode',            cmd: 'opencode',     flags: '--dangerously-skip-permissions',             readyPrompt: '^>' },
  amp:      { key: 'amp',      displayName: 'Sourcegraph Amp',     cmd: 'amp',          flags: '--dangerously-allow-all',                    readyPrompt: '^>' },
  grok:     { key: 'grok',     displayName: 'Grok Build CLI',      cmd: 'grok',         flags: '--always-approve',                           readyPrompt: '^grok>' },
  aider:    { key: 'aider',    displayName: 'Aider',               cmd: 'aider',        flags: '--yes-always --model claude-opus-4-6',       readyPrompt: '^> $' },
  continue: { key: 'continue', displayName: 'Continue CLI',        cmd: 'cn',           flags: '--auto',                                     readyPrompt: '^>' },
  kiro:     { key: 'kiro',     displayName: 'Kiro CLI',            cmd: 'kiro-cli',     flags: '--trust-all-tools',                          readyPrompt: '^>' },
  cursor:   { key: 'cursor',   displayName: 'Cursor CLI',          cmd: 'cursor-agent',                                                      readyPrompt: '^>' },
  plandex:  { key: 'plandex',  displayName: 'Plandex',             cmd: 'plandex',                                                           readyPrompt: '^>' },
  // goose has no launch flag — auto-approve is controlled via GOOSE_MODE=auto
  // env var or permission.yaml config.
  goose:    { key: 'goose',    displayName: 'Goose',               cmd: 'goose',                                                             readyPrompt: 'Goose❯' },
  copilot:  { key: 'copilot',  displayName: 'GitHub Copilot CLI',  cmd: 'gh copilot',                                                        readyPrompt: '●', detectInstalled: copilotInstalled },
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
