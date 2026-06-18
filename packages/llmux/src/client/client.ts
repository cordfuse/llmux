import { createConnection } from 'node:net';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

export interface ClientCommand {
  summary: string;
  usage: string;
  help: () => string;
  run: (argv: readonly string[]) => Promise<void>;
}

function help(name: string, summary: string, usage: string): () => string {
  return () =>
    [
      `llmux ${name} — ${summary}`,
      '',
      'Usage:',
      `  ${usage}`,
      '',
      'Environment:',
      '  LLMUX_SERVER  base URL of the llmux daemon (e.g. http://localhost:3030)',
      '  LLMUX_TOKEN   auth token (sas_…); not required for localhost',
      '',
    ].join('\n');
}

interface ClientContext {
  baseUrl: string;
  token: string | undefined;
}

export function resolveContext(): ClientContext {
  const baseUrl = process.env.LLMUX_SERVER;
  if (!baseUrl) {
    throw new Error('LLMUX_SERVER is not set. Point it at your llmux daemon (e.g. http://localhost:3030).');
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), token: process.env.LLMUX_TOKEN };
}

interface ServerError {
  ok?: false;
  error?: string;
}

async function request<T = unknown>(
  ctx: ClientContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = ctx.baseUrl + path;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ctx.token) headers['authorization'] = `Bearer ${ctx.token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (err) {
    throw new Error(`network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (r.status === 401) {
    throw new Error(
      'unauthorized — set LLMUX_TOKEN (use `llmux token create` on the daemon host to mint one)',
    );
  }
  if (r.status === 404) {
    throw new Error('not found — check the session name (try `llmux ls`)');
  }
  const text = await r.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`unexpected non-JSON response (${r.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!r.ok) {
    const msg = (parsed as ServerError | undefined)?.error ?? `http ${r.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

// ---------- argv parsing ----------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i++;
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === 'string' ? v : undefined;
}

function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

// ---------- session-shape types (mirror server views) ----------

interface SessionView {
  name: string;
  agent: string;
  cwd: string;
  cwdDisplay: string;
  flags?: string;
  defaultFlags: string;
  env?: Record<string, string>;
  defaultEnv: Record<string, string>;
  resumeFrom?: string;
  hasHistory: boolean;
  conversationCount: number;
  createdAt: string;
  parent: string | null;
  status: 'running' | 'exited';
}

interface AgentView {
  key: string;
  displayName: string;
  cmd: string;
  flags: string;
  envDefaults: Record<string, string>;
}

interface ConversationView {
  id: string;
  title: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
}

// ---------- printers ----------

function maybeJson<T>(args: ParsedArgs, data: T, fallback: () => void): void {
  if (boolFlag(args, 'json')) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    fallback();
  }
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return iso;
  if (ms < 60_000) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const lines = [headers.map((h, i) => h.padEnd(widths[i]!)).join('  ')];
  for (const r of rows) lines.push(r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  '));
  return lines.join('\n');
}

// ---------- WebSocket client (hand-rolled, no deps) ----------

interface WsHandle {
  send: (data: string | Buffer) => void;
  close: () => void;
}

/**
 * Minimal RFC 6455 client for the daemon's /ws/<name> endpoint. Returned
 * handle gives raw send/close. Hand-rolled to keep the client-side WS path
 * usable without pulling the `ws` runtime — the daemon already needs `ws`
 * for its server-side, but standalone CLI invocations (e.g. `session attach`
 * over a remote daemon) don't.
 */
function openWs(opts: {
  url: string;
  token?: string;
  onMessage: (data: Buffer | string) => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
}): WsHandle {
  const u = new URL(opts.url);
  if (opts.token && !u.searchParams.has('token')) u.searchParams.set('token', opts.token);
  const isSecure = u.protocol === 'wss:';
  if (isSecure) throw new Error('wss:// not supported by the built-in client yet — use ws:// (tailscale serve terminates TLS for browsers)');
  const port = u.port ? Number(u.port) : 80;
  const host = u.hostname;
  const path = u.pathname + u.search;
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

  const socket = createConnection({ host, port });
  let handshakeDone = false;
  let recvBuf: Buffer = Buffer.alloc(0);

  socket.on('connect', () => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.host}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      ``,
      ``,
    ];
    socket.write(lines.join('\r\n'));
  });

  function parseHandshake(buf: Buffer): { ok: boolean; offset: number; err?: string } {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return { ok: false, offset: 0 };
    const head = buf.slice(0, headerEnd).toString('utf8');
    const lines = head.split('\r\n');
    const statusLine = lines[0] ?? '';
    const m = statusLine.match(/^HTTP\/1\.[01] (\d+) /);
    if (!m || m[1] !== '101') {
      return { ok: false, offset: 0, err: `expected 101 Switching Protocols, got: ${statusLine}` };
    }
    let acceptOk = false;
    for (const ln of lines.slice(1)) {
      const idx = ln.indexOf(':');
      if (idx < 0) continue;
      const k = ln.slice(0, idx).trim().toLowerCase();
      const v = ln.slice(idx + 1).trim();
      if (k === 'sec-websocket-accept' && v === expectedAccept) acceptOk = true;
    }
    if (!acceptOk) return { ok: false, offset: 0, err: 'Sec-WebSocket-Accept mismatch' };
    return { ok: true, offset: headerEnd + 4 };
  }

  function parseFrame(buf: Buffer): { frame: { opcode: number; payload: Buffer } | null; rest: Buffer } {
    if (buf.length < 2) return { frame: null, rest: buf };
    const b0 = buf[0]!;
    const b1 = buf[1]!;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return { frame: null, rest: buf };
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return { frame: null, rest: buf };
      const big = buf.readBigUInt64BE(offset);
      len = Number(big);
      offset += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length < offset + 4) return { frame: null, rest: buf };
      maskKey = buf.slice(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return { frame: null, rest: buf };
    const payload = buf.slice(offset, offset + len);
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i]! ^= maskKey[i % 4]!;
    }
    return { frame: { opcode, payload }, rest: buf.slice(offset + len) };
  }

  socket.on('data', (chunk: Buffer) => {
    recvBuf = Buffer.concat([recvBuf, chunk]);
    if (!handshakeDone) {
      const r = parseHandshake(recvBuf);
      if (r.err) {
        opts.onError(new Error(r.err));
        socket.destroy();
        return;
      }
      if (!r.ok) return; // wait for more
      handshakeDone = true;
      recvBuf = recvBuf.slice(r.offset);
    }
    // frame parsing
    while (recvBuf.length >= 2) {
      const { frame, rest } = parseFrame(recvBuf);
      if (!frame) break;
      recvBuf = rest;
      if (frame.opcode === 0x1) opts.onMessage(frame.payload.toString('utf8'));
      else if (frame.opcode === 0x2) opts.onMessage(frame.payload);
      else if (frame.opcode === 0x8) {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
        const reason = frame.payload.length > 2 ? frame.payload.slice(2).toString('utf8') : '';
        opts.onClose(code, reason);
        socket.end();
        return;
      } else if (frame.opcode === 0x9) {
        // ping — respond with pong
        sendFrame(0xa, frame.payload);
      }
    }
  });
  socket.on('error', (err) => opts.onError(err));
  socket.on('close', () => opts.onClose(1006, 'socket closed'));

  function sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2 + 4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(2 + 2 + 4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(2 + 8 + 4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    const out = Buffer.allocUnsafe(header.length + masked.length);
    header.copy(out, 0);
    masked.copy(out, header.length);
    socket.write(out);
  }

  return {
    send(data) {
      if (!handshakeDone) return;
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      sendFrame(typeof data === 'string' ? 0x1 : 0x2, buf);
    },
    close() {
      try {
        sendFrame(0x8, Buffer.alloc(0));
      } catch {}
      socket.end();
    },
  };
}

// ---------- commands ----------

function pushIf<T extends Record<string, unknown>>(o: T, k: string, v: unknown): T {
  if (v !== undefined && v !== null && v !== '') (o as Record<string, unknown>)[k] = v;
  return o;
}

const ls: ClientCommand = {
  summary: 'List sessions on the daemon',
  usage: 'llmux ls [--json]',
  help: help('ls', 'List sessions on the daemon', 'llmux ls [--json]'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const sessions = await request<SessionView[]>(ctx, 'GET', '/api/sessions');
    maybeJson(args, sessions, () => {
      if (sessions.length === 0) {
        console.log('no sessions');
        return;
      }
      const rows = sessions.map((s) => [
        s.name,
        s.agent,
        s.status,
        relTime(s.createdAt),
        s.cwdDisplay,
        s.resumeFrom ? `↻ ${s.resumeFrom.slice(0, 8)}…` : '',
      ]);
      console.log(table(['NAME', 'AGENT', 'STATE', 'STARTED', 'CWD', 'RESUMED'], rows));
    });
  },
};

const sendCmd: ClientCommand = {
  summary: 'Send a prompt to a session (fire-and-forget)',
  usage: 'llmux send <session> "<prompt>" [--no-enter]',
  help: help('send', 'Send a prompt to a session (fire-and-forget)', 'llmux send <session> "<prompt>" [--no-enter]'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    const prompt = args.positional[1];
    if (!session || !prompt) throw new Error('send requires <session> and "<prompt>"');
    const enter = !boolFlag(args, 'no-enter');
    await request(ctx, 'POST', `/api/sessions/${encodeURIComponent(session)}/send`, { prompt, enter });
    if (!boolFlag(args, 'json')) console.log(`sent to ${session}`);
    else console.log(JSON.stringify({ ok: true }));
  },
};

const spawn: ClientCommand = {
  summary: 'Spawn a new session on the daemon',
  usage: 'llmux spawn <agent> [--name <n>] [--cwd <path>] [--flags "<f>"] [--env "K=V" ...]',
  help: help('spawn', 'Spawn a new session on the daemon', 'llmux spawn <agent> [--name <n>] [--cwd <path>] [--flags "<f>"] [--env "K=V" ...]'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const agent = args.positional[0];
    if (!agent) throw new Error('spawn requires an <agent>');
    // --env may be provided multiple times (concatenated by repeated flag).
    // Simple parser supports single --env value; for multiple, pass as a
    // newline-separated value: --env "K1=V1\nK2=V2"
    const env = flag(args, 'env');
    const body: Record<string, unknown> = { agent };
    pushIf(body, 'name', flag(args, 'name'));
    pushIf(body, 'cwd', flag(args, 'cwd'));
    pushIf(body, 'flags', flag(args, 'flags'));
    pushIf(body, 'env', env);
    const r = await request<{ ok: boolean; session: SessionView; error?: string }>(ctx, 'POST', '/api/sessions', body);
    maybeJson(args, r.session, () => console.log(`spawned ${r.session.name} (agent: ${r.session.agent})`));
  },
};

const kill: ClientCommand = {
  summary: 'Kill a session',
  usage: 'llmux kill <session>',
  help: help('kill', 'Kill a session', 'llmux kill <session>'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    if (!session) throw new Error('kill requires <session>');
    await request(ctx, 'POST', `/api/sessions/${encodeURIComponent(session)}/kill`);
    if (!boolFlag(args, 'json')) console.log(`killed ${session}`);
    else console.log(JSON.stringify({ ok: true }));
  },
};

const restart: ClientCommand = {
  summary: 'Restart a session (kill + respawn with persisted config)',
  usage: 'llmux restart <session>',
  help: help('restart', 'Restart a session', 'llmux restart <session>'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    if (!session) throw new Error('restart requires <session>');
    const r = await request<{ ok: boolean; session: SessionView }>(ctx, 'POST', `/api/sessions/${encodeURIComponent(session)}/respawn`);
    maybeJson(args, r.session, () => console.log(`restarted ${r.session.name}`));
  },
};

const resume: ClientCommand = {
  summary: "Resume one of the agent's past conversations on this session",
  usage: 'llmux resume <session> (--conversation <id> | --latest) [--json]',
  help: help('resume', 'Resume a past conversation', 'llmux resume <session> (--conversation <id> | --latest)'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    if (!session) throw new Error('resume requires <session>');
    let conversationId = flag(args, 'conversation');
    if (!conversationId) {
      if (!boolFlag(args, 'latest')) {
        throw new Error('resume requires --conversation <id> or --latest');
      }
      const convs = await request<ConversationView[]>(ctx, 'GET', `/api/sessions/${encodeURIComponent(session)}/conversations`);
      if (convs.length === 0) throw new Error(`no past conversations for ${session}`);
      conversationId = convs[0]!.id;
    }
    const r = await request<{ ok: boolean; session: SessionView }>(
      ctx,
      'POST',
      `/api/sessions/${encodeURIComponent(session)}/resume`,
      { conversationId },
    );
    maybeJson(args, r.session, () => console.log(`${r.session.name} resumed from ${conversationId!.slice(0, 8)}…`));
  },
};

const conversations: ClientCommand = {
  summary: "List the agent's past conversations for this session's cwd",
  usage: 'llmux conversations <session> [--json]',
  help: help('conversations', "List past conversations for this session's agent + cwd", 'llmux conversations <session> [--json]'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    if (!session) throw new Error('conversations requires <session>');
    const convs = await request<ConversationView[]>(ctx, 'GET', `/api/sessions/${encodeURIComponent(session)}/conversations`);
    maybeJson(args, convs, () => {
      if (convs.length === 0) {
        console.log('no past conversations');
        return;
      }
      const rows = convs.map((c) => [
        c.id.slice(0, 8) + '…',
        relTime(c.lastMessageAt),
        String(c.messageCount),
        c.title.slice(0, 80),
      ]);
      console.log(table(['ID', 'LAST', 'MSGS', 'TITLE'], rows));
    });
  },
};

const agents: ClientCommand = {
  summary: 'List agents (installed by default; --all for the full catalog)',
  usage: 'llmux agents [--all] [--json]',
  help: help('agents', 'List agents', 'llmux agents [--all] [--json]'),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const path = boolFlag(args, 'all') ? '/api/agents/all' : '/api/agents';
    const list = await request<Array<AgentView & { installed?: boolean; installHint?: string; docsUrl?: string }>>(ctx, 'GET', path);
    maybeJson(args, list, () => {
      const rows = list.map((a) => [
        a.key,
        a.displayName,
        a.cmd,
        a.flags || '-',
        'installed' in a ? (a.installed ? 'yes' : 'no') : 'yes',
      ]);
      console.log(table(['KEY', 'NAME', 'CMD', 'FLAGS', 'INSTALLED'], rows));
    });
  },
};

const attach: ClientCommand = {
  summary: 'Attach to a session via WebSocket (raw TTY pass-through)',
  usage: 'llmux attach <session>',
  help: help(
    'attach',
    'Attach to a session via WebSocket',
    'llmux attach <session>\n\nEscape: Ctrl+] to detach.\nResize is auto-detected via SIGWINCH.\n\nNote: only http:// is supported by the built-in WS client.\nFor https:// daemons, set LLMUX_SERVER to the local http:// URL,\nor use the browser web terminal.',
  ),
  run: async (argv) => {
    const args = parseArgs(argv);
    const ctx = resolveContext();
    const session = args.positional[0];
    if (!session) throw new Error('attach requires <session>');
    const baseUrl = new URL(ctx.baseUrl);
    if (baseUrl.protocol === 'https:') {
      throw new Error('attach via wss:// is not supported by the built-in client; LLMUX_SERVER must be http://');
    }
    const wsUrl =
      (baseUrl.protocol === 'https:' ? 'wss://' : 'ws://') +
      baseUrl.host +
      '/ws/' +
      encodeURIComponent(session);

    // Raw TTY input mode
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let ws: WsHandle | null = null;
    let closed = false;

    function teardown(): void {
      if (closed) return;
      closed = true;
      try { if (stdin.isTTY) stdin.setRawMode(false); } catch {}
      stdin.removeAllListeners('data');
      process.removeAllListeners('SIGWINCH');
      ws?.close();
      // Release stdin from holding the event loop open.
      stdin.pause();
      try { stdin.unref(); } catch {}
    }

    function sendResize(): void {
      if (!stdout.isTTY) return;
      const cols = stdout.columns ?? 80;
      const rows = stdout.rows ?? 24;
      ws?.send(JSON.stringify({ type: 'resize', cols, rows }));
    }

    await new Promise<void>((resolve, reject) => {
      ws = openWs({
        url: wsUrl,
        ...(ctx.token !== undefined ? { token: ctx.token } : {}),
        onMessage: (data) => {
          if (typeof data === 'string') stdout.write(data);
          else stdout.write(data);
        },
        onClose: (code, reason) => {
          teardown();
          if (code === 4040) {
            stdout.write(`\r\n[session ended: ${reason || 'pty exited'}]\r\n`);
            resolve();
          } else if (code === 1000) {
            resolve();
          } else {
            reject(new Error(`ws closed: code=${code} reason=${reason}`));
          }
        },
        onError: (err) => {
          teardown();
          reject(err);
        },
      });

      // Pipe stdin → ws, with Ctrl+] (\x1d) as detach.
      stdin.on('data', (chunk: string) => {
        if (chunk.includes('\x1d')) {
          teardown();
          stdout.write('\r\n[detached]\r\n');
          resolve();
          return;
        }
        ws?.send(chunk);
      });

      // Initial size + react to terminal resize
      setImmediate(sendResize);
      process.on('SIGWINCH', sendResize);
    });
  },
};

const status: ClientCommand = {
  ...ls,
  summary: 'List sessions on the daemon (alias of `ls`)',
};

export const clientCommands: Record<string, ClientCommand> = {
  ls,
  status,
  send: sendCmd,
  spawn,
  kill,
  restart,
  resume,
  conversations,
  agents,
  attach,
};
