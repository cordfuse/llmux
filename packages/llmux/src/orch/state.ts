// Adapted from cordfuse/crosstalk@v7.0.0-alpha.16 (engine/src/state.ts).
//
// Changes from upstream:
//   - State dir: was ~/.config/crosstalk/state/<basename>, now follows XDG
//     spec → $XDG_STATE_HOME/llmux/orch/<basename> (fallback ~/.local/state/llmux/orch/).
//   - Override env: was CROSSTALK_STATE_DIR, now LLMUX_ORCH_STATE_DIR.
//   - Wire format on disk (cursor, heartbeat, errors.log) preserved
//     byte-identical so a crosstalk dispatcher could read llmux's state if
//     pointed at it (and vice versa). Helps the cross-product optionality
//     called out in ORCHESTRATION-DESIGN.md.
//
// Machine-local dispatcher state. NONE of this lives in the transport repo —
// the repo carries conversation; each machine carries its own progress
// through it. That separation is what makes the dispatcher's git operations
// conflict-free: its commits only ever contain data/ (messages).
//
// Layout (four files, no subdirectories):
//   dispatcher.pid    — PID of the running dispatcher process
//   cursor            — last-scanned git commit hash (single global cursor)
//   heartbeat         — last tick timestamp + pid + version (JSON)
//   wake.signal       — touched to wake the dispatch loop
//   errors.log        — infra failures, JSONL, append-only (best-effort)

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  appendFileSync,
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

const resolved = new Map<string, string>();

export function stateDir(transportRoot: string): string {
  const cached = resolved.get(transportRoot);
  if (cached) return cached;
  let dir = process.env['LLMUX_ORCH_STATE_DIR'];
  if (!dir) {
    const xdgState = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
    dir = join(xdgState, 'llmux', 'orch', basename(transportRoot));
  }
  mkdirSync(dir, { recursive: true });
  resolved.set(transportRoot, dir);
  return dir;
}

// ── cursor (single, machine-global) ──
//
// A cursor is the git commit hash the transport was last scanned at. NOT a
// message relPath: filenames order by sender timestamp, but messages reach
// origin in PUSH order — a message that loses a push race can land on
// origin with a timestamp earlier than one already processed, and a
// relPath cursor would skip it forever. Commit-based cursors can't.
//
// llmux single-host context: there is no remote push race (single writer),
// but the commit-based cursor is preserved verbatim for wire compatibility
// and so the same semantics carry over if the DR remote ever feeds back in.

const VALID_CURSOR = /^[0-9a-f]{40}$/;

export function cursorPath(transportRoot: string): string {
  return join(stateDir(transportRoot), 'cursor');
}

export function readCursor(transportRoot: string): string | null {
  const p = cursorPath(transportRoot);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8').trim();
  } catch (err) {
    logError(transportRoot, `cursor read failed: ${(err as Error).message}`);
    return null;
  }
  if (raw.length === 0) return null;
  if (!VALID_CURSOR.test(raw)) {
    logError(transportRoot, `invalid cursor '${raw.slice(0, 80)}' — re-scanning from origin`);
    return null;
  }
  return raw;
}

export function writeCursor(transportRoot: string, commit: string): void {
  writeFileSync(cursorPath(transportRoot), commit + '\n');
}

// ── pidfile ──

export function pidfilePath(transportRoot: string): string {
  return join(stateDir(transportRoot), 'dispatcher.pid');
}

export function writePidfile(transportRoot: string): void {
  try {
    writeFileSync(pidfilePath(transportRoot), `${process.pid}\n`);
  } catch { /* best-effort */ }
}

export function removePidfile(transportRoot: string): void {
  try {
    unlinkSync(pidfilePath(transportRoot));
  } catch { /* already gone */ }
}

export function readPidfile(transportRoot: string): number | null {
  try {
    const raw = readFileSync(pidfilePath(transportRoot), 'utf-8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ── heartbeat + wake ──

export function writeHeartbeat(transportRoot: string, version: string, alias?: string): void {
  try {
    const data: Record<string, unknown> = { ts: new Date().toISOString(), pid: process.pid, version };
    if (alias) data['alias'] = alias;
    writeFileSync(join(stateDir(transportRoot), 'heartbeat'), JSON.stringify(data) + '\n');
  } catch { /* best-effort */ }
}

export function readHeartbeat(
  transportRoot: string,
): { ts: string; pid: number; version: string; alias?: string } | null {
  try {
    return JSON.parse(readFileSync(join(stateDir(transportRoot), 'heartbeat'), 'utf-8'));
  } catch {
    return null;
  }
}

export function wakeSignalPath(transportRoot: string): string {
  return join(stateDir(transportRoot), 'wake.signal');
}

export function sendWakeSignal(transportRoot: string): void {
  try {
    writeFileSync(wakeSignalPath(transportRoot), `${Date.now()}\n`);
  } catch { /* best-effort */ }
}

// ── error log — infra failures, JSONL append, best-effort ──

export function logError(transportRoot: string, message: string): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), message: message.slice(0, 500) });
    appendFileSync(join(stateDir(transportRoot), 'errors.log'), line + '\n');
  } catch { /* best-effort */ }
}

export function countErrors(transportRoot: string): number {
  try {
    const raw = readFileSync(join(stateDir(transportRoot), 'errors.log'), 'utf-8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
