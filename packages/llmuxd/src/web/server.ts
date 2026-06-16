import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import * as state from '../state.ts';
import { listSessions } from '../tmux.ts';
import { getAddresses } from '../net.ts';

export interface ServeOptions {
  port: number;
  host: string;
}

const XTERM_CSS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css';
const XTERM_JS = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js';
const XTERM_FIT_JS = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pickerPage(): string {
  const tracked = state.list();
  const live = new Set(listSessions().map((s) => s.name));
  const rows = tracked
    .map((s) => {
      const status = live.has(s.name) ? 'running' : 'exited';
      const link = `<a href="/session/${encodeURIComponent(s.name)}">${escapeHtml(s.name)}</a>`;
      const cls = status === 'running' ? 'ok' : 'dim';
      return `<tr class="${cls}"><td>${link}</td><td>${escapeHtml(s.agent)}</td><td>${status}</td><td><code>${escapeHtml(s.cwd)}</code></td></tr>`;
    })
    .join('\n');
  const body = tracked.length
    ? `<table><thead><tr><th>name</th><th>agent</th><th>state</th><th>cwd</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="dim">no sessions — run <code>llmuxd spawn &lt;agent&gt; --name &lt;name&gt;</code> first.</p>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llmuxd — sessions</title>
<style>
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px}
  body{padding:24px;max-width:980px;margin:0 auto}
  h1{font-size:18px;margin:0 0 18px}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #1f2329}
  th{font-weight:500;color:#9aa0a6;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  a{color:#7cc4ff;text-decoration:none}
  a:hover{text-decoration:underline}
  .dim{color:#7a7f87}
  .ok td:nth-child(3){color:#7ee787}
  code{color:#c9d1d9}
</style></head>
<body><h1>llmuxd — sessions</h1>${body}</body></html>`;
}

function sessionPage(name: string): string {
  const escapedName = escapeHtml(name);
  const jsonName = JSON.stringify(name);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapedName} — llmuxd</title>
<link rel="stylesheet" href="${XTERM_CSS}">
<style>
  html,body{margin:0;height:100%;background:#0b0c10;color:#eee;font-family:ui-monospace,monospace}
  #term{position:fixed;inset:0}
  #status{position:fixed;top:6px;right:10px;font-size:11px;color:#7a7f87;z-index:10;padding:2px 8px;background:#0b0c10cc;border-radius:4px}
</style></head>
<body>
<div id="term"></div>
<div id="status">connecting…</div>
<script src="${XTERM_JS}"></script>
<script src="${XTERM_FIT_JS}"></script>
<script>
(function(){
  const name = ${jsonName};
  const status = document.getElementById('status');
  const term = new Terminal({fontSize:14,fontFamily:'ui-monospace,monospace',theme:{background:'#0b0c10'},cursorBlink:true,scrollback:5000});
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/' + encodeURIComponent(name));
  ws.binaryType = 'arraybuffer';

  ws.onopen = function(){
    status.textContent = name + ' • live';
    term.onData(function(d){ ws.send(d); });
    function sendResize(){
      fit.fit();
      try { ws.send(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows})); } catch(e){}
    }
    addEventListener('resize', sendResize);
    sendResize();
  };
  ws.onmessage = function(ev){
    if (typeof ev.data === 'string') term.write(ev.data);
    else term.write(new Uint8Array(ev.data));
  };
  ws.onclose = function(){ status.textContent = name + ' • disconnected'; };
  ws.onerror = function(){ status.textContent = name + ' • error'; };
})();
</script>
</body></html>`;
}

function sendHtml(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendText(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

export function startServer(opts: ServeOptions): ServerHandle {
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      return sendJson(res, { ok: true, sessions: state.list().length });
    }
    if (url.pathname === '/') {
      return sendHtml(res, pickerPage());
    }
    if (url.pathname.startsWith('/session/')) {
      const name = decodeURIComponent(url.pathname.slice('/session/'.length));
      if (!state.get(name)) return sendText(res, 'session not found', 404);
      return sendHtml(res, sessionPage(name));
    }
    return sendText(res, 'not found', 404);
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    const name = decodeURIComponent(url.pathname.slice('/ws/'.length));
    if (!state.get(name)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachSession(ws, name));
  });

  http.listen(opts.port, opts.host);

  return {
    port: opts.port,
    stop: () =>
      new Promise<void>((resolve) => {
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function attachSession(ws: WebSocket, sessionName: string): void {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === 'TMUX' || k === 'TMUX_PANE') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';

  let term: IPty | null = null;
  try {
    term = pty.spawn('tmux', ['attach', '-t', sessionName], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME ?? process.cwd(),
      env,
    });
  } catch (err) {
    ws.close(1011, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  term.onData((d) => {
    try {
      ws.send(d);
    } catch {
      term?.kill();
    }
  });

  term.onExit(({ exitCode, signal }) => {
    try {
      ws.close(1000, `pty exited code=${exitCode} signal=${signal ?? 'none'}`);
    } catch {
      // already closed
    }
  });

  ws.on('message', (raw: Buffer | ArrayBuffer | string, isBinary: boolean) => {
    if (!term) return;
    const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
    if (!isBinary && text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        if (parsed.type === 'resize' && typeof parsed.cols === 'number' && typeof parsed.rows === 'number') {
          term.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // fall through
      }
    }
    term.write(text);
  });

  ws.on('close', () => {
    term?.kill();
    term = null;
  });
}

export function printBanner(port: number): void {
  console.log(`llmuxd v0.2.0\n`);
  for (const addr of getAddresses(port)) {
    console.log(`  ▸ ${addr.label.padEnd(10)}${addr.url}`);
  }
  console.log(`\n  ⚠ running without auth — anyone on the network can attach to your tmux sessions\n`);
}
