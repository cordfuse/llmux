// Local-git transport. Adapted from cordfuse/crosstalk@v7.0.0-alpha.16
// (engine/src/transport.ts), heavily trimmed for the single-host case.
//
// What's gone (vs upstream):
//   - gitPull (no incoming sync — single writer, no remote pull)
//   - push-rejection rebase-retry loop in gitCommitAndPush
//   - push retry / jitter logic
//
// What's added:
//   - gitInit — bootstrap a transport repo
//   - gitAddRemote — wire up the DR backup remote (phase 4 uses this)
//   - asyncBackupPush — fire-and-forget push to remote, never blocks
//
// What's preserved verbatim (for wire-compat with crosstalk):
//   - ChannelMessage shape, on-disk frontmatter contract
//   - cursorBaseline, newFilesSince — same commit-based cursor model
//   - discoverChannels, listChannelMessages — same file layout
//   - isValidMessageFrontmatter — same validation rules (catches v6 muscle
//     memory: `type: text` is invalid in v7+)
//   - recoverInterruptedGit — kept as a safety net for operators who
//     manually `git rebase` inside the transport and abort
//
// Layout assumption: $XDG_DATA_HOME/llmux/orchestration/ (transport root)
// holds data/ subtree only. Machine-local state (cursor, heartbeat, etc.)
// lives outside the transport in $XDG_STATE_HOME/llmux/orch/ — see state.ts.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { parseFrontmatter } from './frontmatter.ts';
import { logError } from './state.ts';

export interface ChannelMessage {
  relPath: string;
  fullPath: string;
  data: Record<string, unknown>;
  body: string;
}

export interface GitResult {
  ok: boolean;
  error?: string;
}

export interface GitCommitResult {
  ok: boolean;
  committed: boolean;
  error?: string;
}

function captureGit(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Detect and abort an interrupted rebase/merge left by a killed process or
// manual operator action. Single-host single-writer normally never hits
// this — included as a safety net.
export function recoverInterruptedGit(transportRoot: string): boolean {
  const halfStates: { dir: string; abortArgs: string[] }[] = [
    { dir: '.git/rebase-merge', abortArgs: ['rebase', '--abort'] },
    { dir: '.git/rebase-apply', abortArgs: ['rebase', '--abort'] },
    { dir: '.git/MERGE_HEAD', abortArgs: ['merge', '--abort'] },
    { dir: '.git/CHERRY_PICK_HEAD', abortArgs: ['cherry-pick', '--abort'] },
  ];
  for (const { dir, abortArgs } of halfStates) {
    if (existsSync(join(transportRoot, dir))) {
      const r = captureGit(transportRoot, abortArgs);
      logError(
        transportRoot,
        `recovered from interrupted git state at ${dir} via 'git ${abortArgs.join(' ')}' (exit=${r.status})`,
      );
      return true;
    }
  }
  return false;
}

// The commit cursors anchor to. Single-host has no remote to fetch, so
// HEAD is the truth. The origin/HEAD / origin/main fallbacks are kept for
// the rare DR-restore case where the operator cloned from the remote and
// llmuxd boots before any new local commits land.
export function cursorBaseline(transportRoot: string): string | null {
  for (const ref of ['HEAD', 'origin/HEAD', 'origin/main']) {
    const r = captureGit(transportRoot, ['rev-parse', ref]);
    if (r.status === 0) return r.stdout.trim();
  }
  return null;
}

// Repo-relative paths of message files added between `sinceCommit` and
// HEAD. Returns null when the commit is unknown to this clone — caller
// falls back to a full channel scan.
export function newFilesSince(transportRoot: string, sinceCommit: string): string[] | null {
  const r = captureGit(transportRoot, [
    'diff', '--name-only', '--diff-filter=A', `${sinceCommit}..HEAD`, '--', 'data/channels/',
  ]);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean);
}

// Stage data/, commit. NO push — single-host has no concurrent writers, so
// the upstream push-rejection-retry-loop is gone. Async backup-push to the
// DR remote (if configured) is handled by asyncBackupPush() — fire and
// forget, never blocks the dispatcher.
export function gitCommit(transportRoot: string, message: string): GitCommitResult {
  const status = captureGit(transportRoot, ['status', '--porcelain', '--', 'data/']);
  if (status.status !== 0) {
    return { ok: false, committed: false, error: status.stderr.trim().slice(0, 500) };
  }
  if (!status.stdout.trim()) {
    return { ok: true, committed: false };
  }

  const add = captureGit(transportRoot, ['add', '--', 'data/']);
  if (add.status !== 0) {
    return { ok: false, committed: false, error: add.stderr.trim().slice(0, 500) };
  }

  const commit = captureGit(transportRoot, ['commit', '-m', message, '--', 'data/']);
  if (commit.status !== 0) {
    const noop = commit.stdout.includes('nothing to commit') ||
                 commit.stderr.includes('nothing to commit');
    if (noop) return { ok: true, committed: false };
    return { ok: false, committed: false, error: commit.stderr.trim().slice(0, 500) };
  }
  return { ok: true, committed: true };
}

// Fire-and-forget push to the DR backup remote. Returns immediately —
// the actual push runs detached. Failures are logged but never surface to
// the caller, since the local repo is the source of truth and the remote
// is a snapshot.
export function asyncBackupPush(transportRoot: string): void {
  const hasRemote = captureGit(transportRoot, ['remote']).stdout.trim().includes('origin');
  if (!hasRemote) return;

  const child = spawn('git', ['push', '--quiet', 'origin', 'HEAD:main'], {
    cwd: transportRoot,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  child.on('exit', (code) => {
    if (code !== 0) {
      logError(transportRoot, `asyncBackupPush exit=${code}: ${stderr.trim().slice(0, 300)}`);
    }
  });
  child.unref();
}

// Synchronous push — waits and returns the result. Used by the explicit
// `llmux orch backup` verb when an operator wants confirmation that the
// push landed (e.g., flush before shutdown, after manual actor edits).
// Returns ok:false if no remote is configured; caller can decide whether
// that's an error to surface.
export function syncBackupPush(transportRoot: string): GitResult {
  const hasRemote = captureGit(transportRoot, ['remote']).stdout.trim().includes('origin');
  if (!hasRemote) return { ok: false, error: 'no remote configured' };
  const r = captureGit(transportRoot, ['push', '--quiet', 'origin', 'HEAD:main']);
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout).trim().slice(0, 500) };
  }
  return { ok: true };
}

// Initialize a fresh transport repo at `path`. Creates the directory, runs
// `git init`, lays down the minimal data/ skeleton, and commits a single
// initialization commit. Throws if the path is non-empty.
export interface InitOptions {
  /** Initial protocol-version stamp to write (single integer). */
  protocolVersion: number;
  /** Markdown body for the README. */
  readme: string;
  /** Markdown body for PROTOCOL.md. */
  protocol: string;
}

export function gitInit(path: string, opts: InitOptions): GitResult {
  mkdirSync(path, { recursive: true });
  if (readdirSync(path).length > 0) {
    return { ok: false, error: `transport path ${path} is not empty — refusing to clobber` };
  }
  const init = captureGit(path, ['init', '--initial-branch=main']);
  if (init.status !== 0) {
    return { ok: false, error: init.stderr.trim().slice(0, 500) };
  }
  // Lay down the minimal skeleton.
  mkdirSync(join(path, 'data', 'channels', 'main'), { recursive: true });
  mkdirSync(join(path, 'data', 'actors'), { recursive: true });
  writeFileSync(join(path, 'data', 'channels', 'main', '.gitkeep'), '');
  writeFileSync(join(path, 'data', 'actors', '.gitkeep'), '');
  writeFileSync(join(path, 'LLMUX-TRANSPORT-VERSION'), `${opts.protocolVersion}\n`);
  writeFileSync(join(path, 'README.md'), opts.readme);
  writeFileSync(join(path, 'PROTOCOL.md'), opts.protocol);
  // Initial commit.
  captureGit(path, ['add', '-A']);
  const commit = captureGit(path, ['commit', '-m', 'llmux orch init: transport bootstrap']);
  if (commit.status !== 0) {
    return { ok: false, error: commit.stderr.trim().slice(0, 500) };
  }
  return { ok: true };
}

// Clone an existing remote transport into `path` — the DR-restore path
// when an operator runs `llmux orch init --remote <url>` against a remote
// that already has content. Throws if `path` already exists and is non-empty.
export function gitClone(path: string, remoteUrl: string): GitResult {
  if (existsSync(path) && readdirSync(path).length > 0) {
    return { ok: false, error: `path ${path} is not empty — refusing to clone over it` };
  }
  mkdirSync(path, { recursive: true });
  const r = captureGit(path, ['clone', '--quiet', remoteUrl, '.']);
  if (r.status !== 0) {
    return { ok: false, error: r.stderr.trim().slice(0, 500) };
  }
  return { ok: true };
}

// Add the DR remote to an already-initialized transport. Idempotent
// (`set-url` on an existing remote, `add` otherwise).
export function gitAddRemote(transportRoot: string, remoteUrl: string, name = 'origin'): GitResult {
  const existing = captureGit(transportRoot, ['remote']).stdout.split('\n').map((s) => s.trim());
  const args = existing.includes(name)
    ? ['remote', 'set-url', name, remoteUrl]
    : ['remote', 'add', name, remoteUrl];
  const r = captureGit(transportRoot, args);
  if (r.status !== 0) {
    return { ok: false, error: r.stderr.trim().slice(0, 500) };
  }
  return { ok: true };
}

// Check whether `url` resolves to an empty or populated remote. Used by
// `llmux orch init --remote <url>` to decide between "init+push" and
// "clone instead." Returns 'empty' if the remote exists but has no refs,
// 'populated' if it has at least one branch, or 'unreachable' otherwise.
export function probeRemote(remoteUrl: string): 'empty' | 'populated' | 'unreachable' {
  const r = spawnSync('git', ['ls-remote', '--heads', remoteUrl], { encoding: 'utf-8' });
  if (r.status !== 0) return 'unreachable';
  return r.stdout.trim().length > 0 ? 'populated' : 'empty';
}

export function discoverChannels(transportRoot: string): string[] {
  const channelsDir = join(transportRoot, 'data', 'channels');
  if (!existsSync(channelsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(channelsDir);
  } catch (err) {
    logError(transportRoot, `discoverChannels readdir failed on ${channelsDir}: ${(err as Error).message}`);
    return [];
  }
  return entries.filter((name) => {
    try {
      return statSync(join(channelsDir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

// v7 frontmatter contract (wire-compat with crosstalk):
//   required: from (string), to (string|string[]), timestamp (string)
//   optional: re, as, type ('workflow' only), failed, error, child_channel
// Catches LLM models that revert to v6 muscle memory (`type: text` in
// hand-crafted frontmatter) — invalid in v7+, rejected at parse time.
function isValidMessageFrontmatter(data: Record<string, unknown>): boolean {
  if (typeof data['from'] !== 'string') return false;
  if (typeof data['to'] !== 'string' && !Array.isArray(data['to'])) return false;
  if (typeof data['timestamp'] !== 'string') return false;
  if (data['type'] !== undefined && data['type'] !== 'workflow') return false;
  return true;
}

export function listChannelMessages(transportRoot: string, channel: string): ChannelMessage[] {
  const channelDir = join(transportRoot, 'data', 'channels', channel);
  if (!existsSync(channelDir)) return [];
  const results: ChannelMessage[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full, rel);
      } else if (entry.endsWith('.md') && entry !== 'CHANNEL.md') {
        const raw = readFileSync(full, 'utf-8');
        let parsed;
        try {
          parsed = parseFrontmatter(raw);
        } catch (err) {
          logError(transportRoot, `frontmatter parse failed in ${channel}/${rel}: ${(err as Error).message}`);
          continue;
        }
        if (!isValidMessageFrontmatter(parsed.data)) {
          logError(transportRoot, `invalid message frontmatter in ${channel}/${rel}: missing required field(s) (from, to, timestamp)`);
          continue;
        }
        results.push({ relPath: rel, fullPath: full, data: parsed.data, body: parsed.body });
      }
    }
  };
  walk(channelDir, '');
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
