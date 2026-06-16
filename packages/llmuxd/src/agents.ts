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
  /** One-line install command (shell). Shown in the agent-help modal. */
  installHint?: string;
  /** Homepage / docs URL. Shown alongside installHint as a fallback. */
  docsUrl?: string;
  /** Environment variables baked in at spawn time. Per-session env overrides win. */
  envDefaults?: Record<string, string>;
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
  claude:   { key: 'claude',   displayName: 'Claude Code',         cmd: 'claude',       flags: '--dangerously-skip-permissions',             readyPrompt: '^>',     installHint: 'curl -fsSL https://claude.ai/install.sh | bash', docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview' },
  codex:    { key: 'codex',    displayName: 'Codex CLI',           cmd: 'codex',        flags: '--dangerously-bypass-approvals-and-sandbox', readyPrompt: '^>',     installHint: 'npm install -g @openai/codex',                    docsUrl: 'https://github.com/openai/codex' },
  agy:      { key: 'agy',      displayName: 'Antigravity CLI',     cmd: 'agy',          flags: '--dangerously-skip-permissions',             readyPrompt: '^agy>',  installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', docsUrl: 'https://antigravity.google/docs/cli-install' },
  gemini:   { key: 'gemini',   displayName: 'Gemini CLI',          cmd: 'gemini',       flags: '--yolo',                                     readyPrompt: '^>',     installHint: 'npm install -g @google/gemini-cli',               docsUrl: 'https://github.com/google-gemini/gemini-cli' },
  qwen:     { key: 'qwen',     displayName: 'Qwen Code',           cmd: 'qwen',         flags: '--yolo',                                     readyPrompt: '^>',     installHint: 'npm install -g @qwen-code/qwen-code',             docsUrl: 'https://github.com/QwenLM/qwen-code' },
  // OpenCode's --dangerously-skip-permissions only applies to `opencode run`
  // (one-shot). The TUI default mode rejects it and exits — danger mode in
  // the TUI is controlled via OPENCODE_YOLO=1 instead.
  // No model flag set — OpenCode honors the operator's own config at
  // ~/.config/opencode/opencode.json (provider + default model). Operator
  // overrides per-spawn via the flags field if they want a specific model
  // (e.g. `-m openrouter/anthropic/claude-sonnet-4.6` or
  // `-m ollama/qwen2.5-coder:14b`).
  opencode: { key: 'opencode', displayName: 'OpenCode',            cmd: 'opencode',                                                          readyPrompt: '^>',     installHint: 'curl -fsSL https://opencode.ai/install | bash',   docsUrl: 'https://opencode.ai',          envDefaults: { OPENCODE_YOLO: '1' } },
  amp:      { key: 'amp',      displayName: 'Sourcegraph Amp',     cmd: 'amp',          flags: '--dangerously-allow-all',                    readyPrompt: '^>',     installHint: 'npm install -g @sourcegraph/amp',                 docsUrl: 'https://ampcode.com/manual' },
  grok:     { key: 'grok',     displayName: 'Grok Build CLI',      cmd: 'grok',         flags: '--always-approve',                           readyPrompt: '^grok>', installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',   docsUrl: 'https://x.ai/cli' },
  aider:    { key: 'aider',    displayName: 'Aider',               cmd: 'aider',        flags: '--yes-always --model claude-opus-4-6',       readyPrompt: '^> $',   installHint: 'python -m pip install aider-chat',                docsUrl: 'https://aider.chat' },
  continue: { key: 'continue', displayName: 'Continue CLI',        cmd: 'cn',           flags: '--auto',                                     readyPrompt: '^>',     installHint: 'npm install -g @continuedev/cli',                 docsUrl: 'https://docs.continue.dev/guides/cli' },
  kiro:     { key: 'kiro',     displayName: 'Kiro CLI',            cmd: 'kiro-cli',     flags: '--trust-all-tools',                          readyPrompt: '^>',     installHint: 'brew install kiro  # or see docs for Linux/Windows', docsUrl: 'https://kiro.dev/docs/cli/installation/' },
  cursor:   { key: 'cursor',   displayName: 'Cursor CLI',          cmd: 'cursor-agent',                                                      readyPrompt: '^>',     installHint: 'curl https://cursor.com/install -fsSL | bash',    docsUrl: 'https://cursor.com/docs/cli/installation' },
  plandex:  { key: 'plandex',  displayName: 'Plandex',             cmd: 'plandex',                                                           readyPrompt: '^>',     installHint: 'curl -fsSL https://plandex.ai/install.sh | bash', docsUrl: 'https://docs.plandex.ai' },
  // goose has no launch flag — auto-approve is controlled via GOOSE_MODE=auto.
  goose:    { key: 'goose',    displayName: 'Goose',               cmd: 'goose',                                                             readyPrompt: 'Goose❯', installHint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', docsUrl: 'https://block.github.io/goose', envDefaults: { GOOSE_MODE: 'auto' } },
  copilot:  { key: 'copilot',  displayName: 'GitHub Copilot CLI',  cmd: 'gh copilot',                                                        readyPrompt: '●',      detectInstalled: copilotInstalled, installHint: 'gh copilot suggest "hi"  # gh prerequisite; first run downloads', docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-in-the-cli' },
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
