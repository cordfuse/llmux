import { spawnSync } from 'node:child_process';
import { notImplemented } from './cli.ts';

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  created: Date;
}

/** Verify tmux is installed; throws if not. */
export function requireTmux(): void {
  const r = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error('tmux is required but was not found on PATH');
  }
}

export function listSessions(): TmuxSession[] {
  notImplemented('tmux.listSessions');
}

export function hasSession(_name: string): boolean {
  notImplemented('tmux.hasSession');
}

export function newSession(_name: string, _cmd: string, _cwd?: string): void {
  notImplemented('tmux.newSession');
}

export function sendKeys(_name: string, _text: string): void {
  notImplemented('tmux.sendKeys');
}

export function killSession(_name: string): void {
  notImplemented('tmux.killSession');
}

export function attachOrSwitch(_name: string): void {
  // tmux switch-client if inside tmux, else attach.
  notImplemented('tmux.attachOrSwitch');
}
