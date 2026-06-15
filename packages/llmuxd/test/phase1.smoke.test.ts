import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENTS } from '../src/agents.ts';
import * as state from '../src/state.ts';
import * as tmux from '../src/tmux.ts';

// Inject a `bash` test agent so we can drive the full lifecycle without
// invoking a real AI CLI. We mutate DEFAULT_AGENTS in place (module-scoped
// singleton) for the duration of the test.
const SESSION = `llmux-smoke-${process.pid}`;

let stateRoot: string;
let savedXdg: string | undefined;

beforeAll(() => {
  tmux.requireTmux();
  stateRoot = mkdtempSync(join(tmpdir(), 'llmux-smoke-'));
  savedXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;

  DEFAULT_AGENTS.smokebash = {
    key: 'smokebash',
    cmd: 'bash',
    readyPrompt: '\\$',
    detectInstalled: () => true,
  };
});

afterAll(() => {
  tmux.killSession(SESSION);
  delete DEFAULT_AGENTS.smokebash;
  if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdg;
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('phase 1 — tmux integration', () => {
  test('new-session / has-session / list', () => {
    tmux.newSession({ name: SESSION, command: 'bash', cwd: process.cwd() });
    expect(tmux.hasSession(SESSION)).toBe(true);
    expect(tmux.listSessions().some((s) => s.name === SESSION)).toBe(true);
  });

  test('send-keys delivers literal text + Enter', () => {
    // Writes a sentinel to a tmp file inside the bash session.
    const sentinel = join(stateRoot, 'sentinel.txt');
    tmux.sendKeys(SESSION, `echo hi > ${sentinel}`, { enter: true });
    // Poll briefly — tmux dispatches async to the pane.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        const buf = require('node:fs').readFileSync(sentinel, 'utf8');
        if (buf.trim() === 'hi') return;
      } catch {
        // not yet
      }
      Bun.sleepSync(50);
    }
    throw new Error('sentinel never appeared — send-keys did not reach pane');
  });

  test('state record / forget round-trip', () => {
    state.record({
      name: SESSION,
      agent: 'smokebash',
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      parent: null,
      restart: 'on-failure',
    });
    expect(state.get(SESSION)?.agent).toBe('smokebash');
    state.forget(SESSION);
    expect(state.get(SESSION)).toBeUndefined();
  });

  test('kill-session is idempotent', () => {
    tmux.killSession(SESSION);
    expect(tmux.hasSession(SESSION)).toBe(false);
    // Calling again is a no-op (no throw).
    tmux.killSession(SESSION);
    expect(tmux.hasSession(SESSION)).toBe(false);
  });
});
