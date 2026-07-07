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

/**
 * Verify that a live, name-matched tmux session was actually spawned by
 * llmux — not just an unrelated session the operator created by hand that
 * happens to collide with a (possibly stale) registry entry. Every session
 * llmux spawns gets `LLMUX_SESSION=<name>` injected via `new-session -e`
 * (see `newSession()` above); a foreign session never has it set, and
 * `renameSession()` keeps it in sync with the current name on rename.
 *
 * Fails closed: any lookup failure (var unset, session gone, tmux error)
 * is treated as "not owned" rather than risk attaching/sending to someone
 * else's pane.
 */
export function isOwnedSession(name: string): boolean {
  const r = spawnSync('tmux', ['show-environment', '-t', name, 'LLMUX_SESSION'], { stdio: 'pipe' });
  if (r.status !== 0) return false;
  return r.stdout.toString().trim() === `LLMUX_SESSION=${name}`;
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
  // tmux's `-e KEY=VALUE` flag (3.2+) injects env into the SESSION the
  // server creates. Without this, passing env to spawnSync() only affects
  // the `tmux` client process; the server's pane-spawn inherits the
  // server's env instead, dropping LLMUX_SESSION / LLMUX_AGENT /
  // LLMUX_ORCH_ALIAS / etc. The bug surfaced when MC's coordinator
  // hit `llmux orch send` from Claude Code's bash tool — the env var
  // wasn't visible so the CLI demanded an explicit --alias flag.
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }
  args.push(opts.command);
  const r = spawnSync('tmux', args, { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
}

/**
 * Send literal text to a session's active pane, optionally followed by Enter.
 * Uses `-l` for literal (no key-name translation), then a separate Enter to
 * actually submit when requested.
 *
 * Paste-mode mitigation: TUIs built on `ink` (Claude Code, OpenCode, agy)
 * detect fast-arriving input as a paste and treat Enter as "newline inside
 * the pasted block" rather than "submit". After typing the text we sleep
 * briefly so the TUI's paste-mode debounce expires, THEN send Enter — at
 * which point it's interpreted as submit. Without this delay, prompts get
 * typed into the input box but never submitted, leaving the agent idle.
 */
export function sendKeys(name: string, text: string, opts: { enter?: boolean } = {}): void {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  if (!isOwnedSession(name)) {
    throw new Error(`tmux session "${name}" exists but was not spawned by llmux (foreign session) — refusing to send keys`);
  }
  const literal = spawnSync('tmux', ['send-keys', '-t', name, '-l', text], { stdio: 'pipe' });
  if (literal.status !== 0) {
    throw new Error(`tmux send-keys failed: ${literal.stderr.toString().trim() || `exit ${literal.status}`}`);
  }
  if (opts.enter) {
    // Sync sleep — fireInitPrompts is already async and tolerates the
    // 250ms cost; alternatives (separate setTimeout) leak control back to
    // the event loop and complicate the contract of this function.
    const sleepMs = 250;
    const until = Date.now() + sleepMs;
    spawnSync('sleep', [(sleepMs / 1000).toFixed(3)]);
    // Defensive: spawnSync('sleep') is the cleanest cross-platform option,
    // but on edge cases (Bun runtimes, exotic PATHs) it can return early.
    // Spin until the clock catches up if so.
    while (Date.now() < until) {/* busy-wait the residual */}
    const enter = spawnSync('tmux', ['send-keys', '-t', name, 'Enter'], { stdio: 'pipe' });
    if (enter.status !== 0) {
      throw new Error(`tmux send-keys Enter failed: ${enter.stderr.toString().trim() || `exit ${enter.status}`}`);
    }
  }
}

/**
 * Send a single named tmux key (e.g. `Escape`, `C-c`) to the session — NOT
 * literal text (no `-l`), so tmux interprets the key name. Used by the chat
 * view's Stop button to interrupt an in-flight agent turn with Escape.
 */
export function sendKey(name: string, key: string): void {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  if (!isOwnedSession(name)) {
    throw new Error(`tmux session "${name}" exists but was not spawned by llmux (foreign session) — refusing to send key`);
  }
  const r = spawnSync('tmux', ['send-keys', '-t', name, key], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tmux send-keys ${key} failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
}

/**
 * Read the pane's root pid (the immediate process tmux spawned to run
 * the agent's command). For the multi-window edge case we only take the
 * first; llmux sessions are always single-window single-pane.
 */
function paneRootPid(name: string): number | undefined {
  const r = spawnSync('tmux', ['list-panes', '-t', name, '-F', '#{pane_pid}'], { stdio: 'pipe' });
  if (r.status !== 0) return undefined;
  const first = r.stdout.toString().trim().split('\n')[0];
  const pid = Number(first);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

/**
 * Walk the process table and collect every descendant of rootPid
 * (root NOT included). Cross-platform via `ps -A -o pid=,ppid=` —
 * works on both Linux and macOS without per-platform branches.
 *
 * Why we need this: some agent CLIs (gemini and its forks — qwen, agy)
 * re-exec themselves with `node --max-old-space-size=...` and call
 * setsid() / detach from the tmux pane's process group. `tmux kill-
 * session` only reaps processes still attached to the pane's pgrp,
 * so those re-execs survive and accumulate as orphans. We capture
 * the tree BEFORE killing tmux (after kill we can't query the pane
 * pid anymore) and SIGKILL the survivors AFTER tmux releases the
 * pane. v0.33.0's auto-respawn-on-resume-rebind made this acute —
 * every rebind was leaking the prior gemini tree.
 */
function descendantPids(rootPid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { stdio: 'pipe' });
  if (r.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.toString().split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const arr = children.get(ppid) ?? [];
    arr.push(pid);
    children.set(ppid, arr);
  }
  const out: number[] = [];
  const queue: number[] = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of children.get(cur) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

export function killSession(name: string): void {
  if (!hasSession(name)) return;
  // Snapshot the descendant tree BEFORE killing — after tmux kill-session
  // we can't ask tmux for the pane pid anymore.
  const root = paneRootPid(name);
  const tree = root !== undefined ? descendantPids(root) : [];
  const r = spawnSync('tmux', ['kill-session', '-t', name], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tmux kill-session failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
  // Reap any orphans tmux couldn't get to (setsid'd re-execs). SIGKILL
  // directly — these are agent processes the operator already ordered
  // killed; no shutdown protocol to honor. Iterate child-first so
  // intermediate shells don't keep grandchildren reparented to init.
  // Guard against killing our own daemon pid (can never happen via this
  // walk, but cheap belt-and-suspenders).
  const ourPid = process.pid;
  for (const pid of tree.slice().reverse()) {
    if (pid === ourPid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }
  // Also SIGKILL the root in case kill-session didn't take it down (some
  // wrappers fork early and the original is no longer tmux's direct child).
  if (root !== undefined && root !== ourPid) {
    try { process.kill(root, 'SIGKILL'); } catch { /* gone */ }
  }
}

export function renameSession(oldName: string, newName: string): void {
  if (!hasSession(oldName)) return;
  const r = spawnSync('tmux', ['rename-session', '-t', oldName, newName], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(`tmux rename-session failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
  // isOwnedSession() compares LLMUX_SESSION against the session's current
  // name, so the marker has to be refreshed here too — otherwise a
  // legitimately-renamed llmux session would carry the stale oldName value
  // and look "foreign" on the very next status/attach/send-keys check.
  const e = spawnSync('tmux', ['set-environment', '-t', newName, 'LLMUX_SESSION', newName], { stdio: 'pipe' });
  if (e.status !== 0) {
    throw new Error(`tmux set-environment failed after rename: ${e.stderr.toString().trim() || `exit ${e.status}`}`);
  }
}

/**
 * Capture the current pane contents for a session — used by the
 * init-prompts feature to poll for the agent's "ready" prompt regex
 * before firing the first scripted prompt. `lines` caps the tail
 * (cheap; we typically only need to inspect the last few lines).
 */
export function capturePane(name: string, lines = 10): string {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  const r = spawnSync(
    'tmux',
    ['capture-pane', '-t', name, '-p', '-S', `-${lines}`],
    { stdio: 'pipe' },
  );
  if (r.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${r.stderr.toString().trim() || `exit ${r.status}`}`);
  }
  return r.stdout.toString();
}

/**
 * Attach interactively. Inside a tmux client → `switch-client`. Outside → `attach`.
 * Inherits the controlling TTY so the user takes over the terminal.
 */
export function attachOrSwitch(name: string): void {
  if (!hasSession(name)) {
    throw new Error(`tmux session "${name}" not found`);
  }
  if (!isOwnedSession(name)) {
    throw new Error(`tmux session "${name}" exists but was not spawned by llmux (foreign session) — refusing to attach`);
  }
  const inTmux = Boolean(process.env.TMUX);
  const verb = inTmux ? 'switch-client' : 'attach-session';
  const r = spawnSync('tmux', [verb, '-t', name], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`tmux ${verb} exited with status ${r.status}`);
  }
}
