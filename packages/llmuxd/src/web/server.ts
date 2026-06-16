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
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<title>${escapedName} — llmuxd</title>
<link rel="stylesheet" href="${XTERM_CSS}">
<style>
  :root{--bar-h:42px;--allkeys-h:0px}
  html,body{margin:0;background:#0b0c10;color:#eee;font-family:ui-monospace,monospace;overscroll-behavior:none}
  html{height:100dvh}
  body{height:100dvh;min-height:100dvh}
  #bar{position:fixed;top:0;left:0;right:0;height:var(--bar-h);background:#11141a;border-bottom:1px solid #1f2329;display:flex;align-items:center;gap:0;padding:0;z-index:20}
  /* Pinned regions (back+title on the left, more on the right) */
  #bar #back{flex:0 0 auto;margin-left:6px}
  #title-block{flex:0 0 auto;display:inline-flex;align-items:center;padding:0 8px;color:#c9d1d9;font-size:11px}
  #title-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#9aa0a6;transition:background .2s;cursor:pointer}
  #title-dot[data-state="live"]{background:#7ee787;box-shadow:0 0 6px #7ee78766}
  #title-dot[data-state="error"],#title-dot[data-state="closed"]{background:#f85149}
  /* Scrolling middle region — no mask, just native scroll */
  #keys-scroll{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;padding:0 4px;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  #keys-scroll::-webkit-scrollbar{display:none}
  #bar #more{flex:0 0 auto;margin-right:6px}
  #bar button{min-width:34px;height:30px;padding:0 8px;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;font:13px ui-monospace,monospace;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
  #bar button:active{background:#252b34;border-color:#3a414b}
  #bar button[aria-pressed="true"]{background:#1e3a52;border-color:#2d5a85;color:#7cc4ff}
  #bar button[aria-pressed="locked"]{background:#2d5a85;border-color:#4a7fae;color:#fff}
  #bar #back{font-size:18px;line-height:1;font-family:system-ui,sans-serif}
  #bar .sep{flex:0 0 auto;width:1px;height:20px;background:#262c34;margin:0 2px}
  #all-keys{position:fixed;top:var(--bar-h);left:0;right:0;background:#0e1116;border-bottom:1px solid #1f2329;display:none;padding:8px;z-index:19;max-height:40vh;overflow-y:auto;box-sizing:border-box}
  #all-keys.open{display:block}
  #all-keys h4{margin:6px 4px 4px;font:500 10px/1 ui-monospace,monospace;color:#7a7f87;text-transform:uppercase;letter-spacing:.06em}
  #all-keys .row{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
  #all-keys button{flex:0 0 auto;min-width:36px;height:30px;padding:0 8px;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;font:12px ui-monospace,monospace;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
  #all-keys button:active{background:#252b34;border-color:#3a414b}
  #term{position:fixed;top:var(--bar-h);left:0;right:0;bottom:0}
  body.allkeys-open #term{top:calc(var(--bar-h) + var(--allkeys-h))}
  /* Landscape with limited vertical space — compress bar */
  @media (orientation: landscape) and (max-height: 500px){
    :root{--bar-h:34px}
    #bar button{height:24px;min-width:32px;padding:0 7px;font-size:11px}
    #all-keys{max-height:60vh}
    #all-keys button{height:24px;min-width:30px;padding:0 7px;font-size:11px}
    #title-name{max-width:60px}
  }
</style></head>
<body>
<div id="bar">
  <button id="back" title="Back to sessions">←</button>
  <span id="title-block"><span id="title-dot" data-state="connecting" title="${escapedName} — connecting…"></span></span>
  <div id="keys-scroll">
    <button data-key="esc" title="Escape">Esc</button>
    <button data-key="tab" title="Tab">⇥</button>
    <button data-mod="ctrl"  title="Ctrl (tap then key, double-tap to lock)">Ctrl</button>
    <button data-mod="alt"   title="Alt (tap then key, double-tap to lock)">Alt</button>
    <button data-mod="shift" title="Shift (next char uppercase)">⇧</button>
    <span class="sep"></span>
    <button data-key="up"    title="Up">↑</button>
    <button data-key="down"  title="Down">↓</button>
    <button data-key="left"  title="Left">←</button>
    <button data-key="right" title="Right">→</button>
    <span class="sep"></span>
    <button data-char="~" title="tilde">~</button>
    <button data-char="\`" title="backtick">\`</button>
    <button data-char="/" title="slash">/</button>
    <button data-char="\\\\" title="backslash">\\</button>
    <button data-char="|" title="pipe">|</button>
    <button data-char="-" title="dash">-</button>
    <button data-char="_" title="underscore">_</button>
  </div>
  <button id="more" title="All keys">⋯</button>
</div>
<div id="all-keys" aria-hidden="true">
  <h4>numbers</h4>
  <div class="row">
    <button data-char="0">0</button><button data-char="1">1</button><button data-char="2">2</button>
    <button data-char="3">3</button><button data-char="4">4</button><button data-char="5">5</button>
    <button data-char="6">6</button><button data-char="7">7</button><button data-char="8">8</button>
    <button data-char="9">9</button>
  </div>
  <h4>brackets &amp; quotes</h4>
  <div class="row">
    <button data-char="(">(</button><button data-char=")">)</button>
    <button data-char="[">[</button><button data-char="]">]</button>
    <button data-char="{">{</button><button data-char="}">}</button>
    <button data-char="&lt;">&lt;</button><button data-char="&gt;">&gt;</button>
    <button data-char="'">'</button><button data-char="&quot;">&quot;</button>
  </div>
  <h4>operators</h4>
  <div class="row">
    <button data-char="=">=</button><button data-char="+">+</button>
    <button data-char="*">*</button><button data-char="&amp;">&amp;</button>
    <button data-char="^">^</button><button data-char="%">%</button>
    <button data-char="$">$</button><button data-char="#">#</button>
    <button data-char="@">@</button><button data-char="!">!</button>
    <button data-char="?">?</button>
  </div>
  <h4>punctuation</h4>
  <div class="row">
    <button data-char=":">:</button><button data-char=";">;</button>
    <button data-char=",">,</button><button data-char=".">.</button>
  </div>
  <h4>navigation &amp; edit</h4>
  <div class="row">
    <button data-key="home">Home</button><button data-key="end">End</button>
    <button data-key="pgup">PgUp</button><button data-key="pgdn">PgDn</button>
    <button data-key="del">Del</button><button data-key="ins">Ins</button>
    <button data-key="bsp">⌫ Bsp</button><button data-key="enter">↵ Enter</button>
  </div>
  <h4>function keys</h4>
  <div class="row">
    <button data-key="f1">F1</button><button data-key="f2">F2</button>
    <button data-key="f3">F3</button><button data-key="f4">F4</button>
    <button data-key="f5">F5</button><button data-key="f6">F6</button>
    <button data-key="f7">F7</button><button data-key="f8">F8</button>
    <button data-key="f9">F9</button><button data-key="f10">F10</button>
    <button data-key="f11">F11</button><button data-key="f12">F12</button>
  </div>
</div>
<div id="term"></div>
<script src="${XTERM_JS}"></script>
<script src="${XTERM_FIT_JS}"></script>
<script>
(function(){
  const name = ${jsonName};
  const dot = document.getElementById('title-dot');
  const termEl = document.getElementById('term');
  function setStatus(state, label){
    dot.dataset.state = state;
    dot.title = name + ' — ' + label;
  }

  const term = new Terminal({fontSize:14,fontFamily:'ui-monospace,monospace',theme:{background:'#0b0c10'},cursorBlink:true,scrollback:5000});
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  // ---- WebSocket ----
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + location.host + '/ws/' + encodeURIComponent(name));
  ws.binaryType = 'arraybuffer';
  function safeSend(data){ try { ws.send(data); } catch(e){} }

  // ---- Key sequence table ----
  const KEYS = {
    esc: '\\x1b', tab: '\\t', enter: '\\r', bsp: '\\x7f',
    up: '\\x1b[A', down: '\\x1b[B', right: '\\x1b[C', left: '\\x1b[D',
    home: '\\x1b[H', end: '\\x1b[F',
    pgup: '\\x1b[5~', pgdn: '\\x1b[6~',
    del: '\\x1b[3~', ins: '\\x1b[2~',
    f1:'\\x1bOP', f2:'\\x1bOQ', f3:'\\x1bOR', f4:'\\x1bOS',
    f5:'\\x1b[15~', f6:'\\x1b[17~', f7:'\\x1b[18~', f8:'\\x1b[19~',
    f9:'\\x1b[20~', f10:'\\x1b[21~', f11:'\\x1b[23~', f12:'\\x1b[24~'
  };
  Object.keys(KEYS).forEach(function(k){ KEYS[k] = KEYS[k].replace(/\\\\x([0-9a-f]{2})/gi, function(_,h){ return String.fromCharCode(parseInt(h,16)); }); });

  // ---- Modifier state: 'off' | 'pending' | 'locked' ----
  const mods = { ctrl: 'off', alt: 'off', shift: 'off' };
  function setMod(mod, val){
    mods[mod] = val;
    const btn = document.querySelector('[data-mod="'+mod+'"]');
    if (btn){
      if (val === 'off') btn.removeAttribute('aria-pressed');
      else btn.setAttribute('aria-pressed', val === 'locked' ? 'locked' : 'true');
    }
  }
  function consumeMods(d){
    let out = d;
    if (mods.shift !== 'off' && d.length === 1){
      out = d.toUpperCase();
      if (mods.shift === 'pending') setMod('shift', 'off');
    }
    if (mods.ctrl !== 'off' && out.length === 1){
      const c = out.charCodeAt(0);
      if (c >= 0x40 && c <= 0x7f) out = String.fromCharCode(c & 0x1f);
      else if (c === 0x20) out = '\\x00';
      if (mods.ctrl === 'pending') setMod('ctrl', 'off');
    }
    if (mods.alt !== 'off'){
      out = '\\x1b' + out;
      if (mods.alt === 'pending') setMod('alt', 'off');
    }
    return out.replace(/\\\\x([0-9a-f]{2})/gi, function(_,h){ return String.fromCharCode(parseInt(h,16)); });
  }

  // ---- Layout / resize (visualViewport + dvh fallback) ----
  let resizeTimer = null;
  const allKeysEl = document.getElementById('all-keys');
  function getAllKeysH(){
    if (!allKeysEl.classList.contains('open')) return 0;
    return Math.min(allKeysEl.scrollHeight, Math.floor((window.visualViewport ? window.visualViewport.height : window.innerHeight) * 0.4));
  }
  function applyLayout(){
    const allKeysH = getAllKeysH();
    document.documentElement.style.setProperty('--allkeys-h', allKeysH + 'px');
    const cs = getComputedStyle(document.documentElement);
    const barH = parseInt(cs.getPropertyValue('--bar-h'),10) || 42;
    const vv = window.visualViewport;
    const visibleH = vv ? vv.height : window.innerHeight;
    termEl.style.top = (barH + allKeysH) + 'px';
    termEl.style.height = Math.max(60, visibleH - barH - allKeysH) + 'px';
    termEl.style.bottom = 'auto';
  }
  function scheduleResize(){
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function(){
      applyLayout();
      try { fit.fit(); } catch(e){}
      safeSend(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
    }, 60);
  }

  applyLayout();
  try { fit.fit(); } catch(e){}

  // ---- Wire toolbar ----
  // Make every bar button non-focusable so they never steal focus from xterm.
  document.querySelectorAll('#bar button, #all-keys button').forEach(function(b){ b.tabIndex = -1; });

  document.getElementById('back').addEventListener('click', function(e){ e.preventDefault(); location.href = '/'; });

  document.getElementById('more').addEventListener('click', function(e){
    e.preventDefault();
    const open = allKeysEl.classList.toggle('open');
    allKeysEl.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('allkeys-open', open);
    scheduleResize();
    term.focus();
  });

  document.querySelectorAll('[data-key]').forEach(function(btn){
    btn.addEventListener('pointerdown', function(e){ e.preventDefault(); });
    btn.addEventListener('click', function(e){
      e.preventDefault();
      const seq = KEYS[btn.dataset.key];
      if (seq != null) safeSend(consumeMods(seq));
      term.focus();
    });
  });

  document.querySelectorAll('[data-char]').forEach(function(btn){
    btn.addEventListener('pointerdown', function(e){ e.preventDefault(); });
    btn.addEventListener('click', function(e){
      e.preventDefault();
      safeSend(consumeMods(btn.dataset.char));
      term.focus();
    });
  });

  document.querySelectorAll('[data-mod]').forEach(function(btn){
    let lastTap = 0;
    btn.addEventListener('pointerdown', function(e){ e.preventDefault(); });
    btn.addEventListener('click', function(e){
      e.preventDefault();
      const mod = btn.dataset.mod;
      const now = Date.now();
      const fast = now - lastTap < 400;
      lastTap = now;
      if (mods[mod] === 'locked') setMod(mod, 'off');
      else if (fast && mods[mod] === 'pending') setMod(mod, 'locked');
      else if (mods[mod] === 'off') setMod(mod, 'pending');
      else setMod(mod, 'off');
      term.focus();
    });
  });

  // ---- WS lifecycle ----
  ws.onopen = function(){
    setStatus('live', 'live');
    term.onData(function(d){ safeSend(consumeMods(d)); });
    scheduleResize();
    term.focus();
  };
  ws.onmessage = function(ev){
    if (typeof ev.data === 'string') term.write(ev.data);
    else term.write(new Uint8Array(ev.data));
  };
  ws.onclose = function(){ setStatus('closed', 'disconnected'); };
  ws.onerror = function(){ setStatus('error', 'error'); };

  // ---- Resize triggers ----
  addEventListener('resize', function(){ scheduleResize('window-resize'); });
  addEventListener('orientationchange', function(){ scheduleResize('orientationchange'); });
  if (window.visualViewport){
    // Soft keyboard show/hide fires visualViewport.resize on iOS + recent Android.
    window.visualViewport.addEventListener('resize', function(){ scheduleResize('vv-resize'); });
    window.visualViewport.addEventListener('scroll', function(){ scheduleResize('vv-scroll'); });
  }
  // Also re-fit when the page becomes visible again (orientation change in another tab, etc.).
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) scheduleResize('visible'); });
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
