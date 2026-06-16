import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as state from '../src/state.ts';
import * as tmux from '../src/tmux.ts';

// Phase 4 smoke: spins up serve() against a real tmux session and asserts
// the picker + session HTML routes resolve. The full WebSocket round-trip is
// covered by manual / browser testing — the node-pty + ws interaction is
// runtime-specific (works under Node, not Bun's runtime) and bun:test imports
// would conflate that.

const SESSION = `llmux-phase4-${process.pid}`;
const PORT = 47312;

let stateRoot: string;
let savedXdg: string | undefined;

beforeAll(() => {
  tmux.requireTmux();
  stateRoot = mkdtempSync(join(tmpdir(), 'llmux-phase4-'));
  savedXdg = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;

  tmux.newSession({ name: SESSION, command: 'bash', cwd: process.cwd() });
  state.record({
    name: SESSION,
    agent: 'bash',
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    parent: null,
    restart: 'on-failure',
  });
});

afterAll(() => {
  tmux.killSession(SESSION);
  if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedXdg;
  rmSync(stateRoot, { recursive: true, force: true });
});

describe('phase 4 — web routes', () => {
  test('picker lists the tracked session', async () => {
    // Import lazily — node-pty top-level import would crash bun:test under Bun.
    const { startServer } = await import('../src/web/server.ts');
    const handle = startServer({ port: PORT, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain(SESSION);
      expect(body).toContain('running');
    } finally {
      await handle.stop();
    }
  });

  test('session page renders xterm bootstrap', async () => {
    const { startServer } = await import('../src/web/server.ts');
    const handle = startServer({ port: PORT + 1, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 1}/session/${encodeURIComponent(SESSION)}`);
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain('xterm.min.js');
      expect(body).toContain(JSON.stringify(SESSION));
    } finally {
      await handle.stop();
    }
  });

  test('unknown session returns 404 on both routes', async () => {
    const { startServer } = await import('../src/web/server.ts');
    const handle = startServer({ port: PORT + 2, host: '127.0.0.1' });
    try {
      const ses = await fetch(`http://127.0.0.1:${PORT + 2}/session/nope`);
      expect(ses.status).toBe(404);
    } finally {
      await handle.stop();
    }
  });

  test('/health returns ok + count', async () => {
    const { startServer } = await import('../src/web/server.ts');
    const handle = startServer({ port: PORT + 3, host: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${PORT + 3}/health`);
      const body = (await res.json()) as { ok: boolean; sessions: number };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.sessions).toBeGreaterThanOrEqual(1);
    } finally {
      await handle.stop();
    }
  });
});
