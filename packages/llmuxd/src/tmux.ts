import { spawnSync } from 'node:child_process';

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: Date;
}

const TMUX_FORMAT = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}';

/** Verify tmux is installed; throws if not. */
export function requireTmux(): void {
  const r = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error('tmux is required but was not found on PATH');
  }
}

export function listSessions(): TmuxSession[] {
  const r = spawnSync('tmux', ['list-sessions', '-F', TMUX_FORMAT], { stdio: 'pipe' });
  // exit 1 with empty stderr = no server running = no sessions
  if (r.status !== 0) return [];
  return r.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, windows, attached, created] = line.split('\t');
      return {
        name: name ?? '',
        windows: Number(windows ?? '0'),
        attached: attached === '1',
        created: new Date(Number(created ?? '0') * 1000),
      };
    });
}

export function hasSession(name: string): boolean {
  const r = spawnSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'pipe' });
  return r.status === 0;
}

export interface NewSessionOptions {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export function newSession(opts: NewSessionOptions): void {
  if (hasSession(opts.name)) {
    throw new Error(`tmux session "${opts.name}" already exists`);
  }
  const args: string[] = ['new-session', '-d', '-s', opts.name];
  if (opts.cwd) args.push('-c', opts.cwd);
  args.push(opts.command);
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const r = spawnSync('tmux', args, { stdio: 'pipe', env });
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
}

/**
 * Send literal text to a session's active pane, optionally followed by Enter.
 * Uses `-l` for literal (no key-name translation), then a separate Enter to
 * actually submit when requested.
 */
export function sendKeys(name: string, text: string, opts: { enter?: boolean } = {}): void {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  const literal = spawnSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'pipe' });
  if (literal.status !== 0) {
    throw new Error(`tmux send-keys failed: ${literal.stderr.toString().trim() || `exit ${literal.status}`}`);
  }
  if (opts.enter) {
    const enter = spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'pipe' });
    if (enter.status !== 0) {
      throw new Error(`tmux send-keys Enter failed: ${enter.stderr.toString().trim() || `exit ${enter.status}`}`);
    }
  }
}

export function killSession(name: string): void {
  if (!hasSession(name)) return;
  const r = spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tmux kill-session failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
}

/**
 * Attach interactively. Inside a tmux client → `switch-client`. Outside → `attach`.
 * Inherits the controlling TTY so the user takes over the terminal.
 */
export function attachOrSwitch(name: string): void {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  const inTmux = Boolean(process.env.TMUX);
  const verb = inTmux ? 'switch-client' : 'attach-session';
  const r = spawnSync('tmux', [verb, '-t', name], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`tmux ${verb} exited with status ${r.status}`);
  }
}
