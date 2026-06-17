import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { DEFAULT_AGENTS, isAgentInstalled, type AgentDefinition, type Conversation } from '../agents.ts';
import * as state from '../state.ts';
import * as tmux from '../tmux.ts';
import * as authStore from '../auth-store.ts';
import { getAddresses } from '../net.ts';

function readDaemonVersion(): string {
  // Resolve package.json relative to this source file so the version stays
  // accurate whether running from src/ (bun) or dist/ (npm install -g).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      resolve(here, '../../package.json'),
      resolve(here, '../package.json'),
      resolve(here, './package.json'),
    ]){
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === '@cordfuse/llmux' && typeof pkg.version === 'string') return pkg.version;
      } catch {}
    }
  } catch {}
  return 'unknown';
}

const DAEMON_VERSION = readDaemonVersion();

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

interface SessionView {
  name: string;
  agent: string;
  cwd: string;
  cwdDisplay: string;
  /** The launch-flags override stored on this session (undefined = inherits agent default). */
  flags?: string;
  /** The agent's default flags — included so the UI can prefill the edit form. */
  defaultFlags: string;
  /** Per-session env override stored on this session (undefined = inherits agent defaults). */
  env?: Record<string, string>;
  /** Agent's default env vars — UI prefills the edit form from this when no override. */
  defaultEnv: Record<string, string>;
  /** Conversation id this session is currently resumed from (if any). */
  resumeFrom?: string;
  /** Whether the agent has a history adapter — UI shows the conversations icon. */
  hasHistory: boolean;
  /** Count of prior conversations for this agent+cwd (0 if no adapter or empty history). */
  conversationCount: number;
  createdAt: string;
  parent: string | null;
  status: 'running' | 'exited';
}

function shortenCwd(cwd: string): string {
  const home = process.env.HOME;
  if (!home) return cwd;
  if (cwd === home) return '~';
  if (cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length);
  return cwd;
}

/** Expand a leading `~` (or `~/`) to $HOME on the daemon host. No-op for absolute paths. */
function expandTilde(p: string): string {
  const home = process.env.HOME;
  if (!home) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

function listSessionViews(): SessionView[] {
  const tracked = state.list();
  const live = new Set(tmux.listSessions().map((s) => s.name));
  return tracked
    .map((s) => viewOf(s, live.has(s.name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0b0c10"/><rect x="5" y="5" width="9" height="9" fill="#7cc4ff"/><rect x="18" y="5" width="9" height="9" fill="#7cc4ff"/><rect x="5" y="18" width="9" height="9" fill="#7cc4ff"/><rect x="18" y="18" width="9" height="9" fill="#7cc4ff"/></svg>`;
const FAVICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// ---------- pages ----------

function pickerPage(): string {
  const sessions = listSessionViews();
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LLMUX: Sessions</title>
<link rel="icon" href="${FAVICON_DATA_URL}">
<link rel="apple-touch-icon" href="${FAVICON_DATA_URL}">
<style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px;overflow-x:hidden}
  body{padding:18px 16px 80px;max-width:980px;margin:0 auto;box-sizing:border-box}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  h1{font-size:18px;margin:0}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em;font-weight:600}
  #meta{color:#7a7f87;font-size:11px;display:flex;gap:10px;align-items:center}
  #refresh-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#7ee787;transition:background .25s;box-shadow:0 0 6px #7ee78766}
  #refresh-dot.stale{background:#9aa0a6;box-shadow:none}
  #refresh-dot.error{background:#f85149;box-shadow:0 0 6px #f8514966}
  table{border-collapse:collapse;width:100%}
  thead{display:table-header-group}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1f2329;vertical-align:middle}
  th{font-weight:500;color:#9aa0a6;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  a.session-link{color:#7cc4ff;text-decoration:none}
  a.session-link:hover{text-decoration:underline}
  .name{font-weight:600}
  .started{color:#7a7f87;font-size:11px;margin-top:2px;display:block}
  .state-running{color:#7ee787}
  .state-exited{color:#7a7f87}
  .cwd{color:#c9d1d9;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
  .cwd code{unicode-bidi:embed;direction:ltr}
  .cwd-col{max-width:0}
  .actions{text-align:right;white-space:nowrap}
  .actions button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:5px 9px;font:12px ui-monospace,monospace;cursor:pointer;margin-left:4px;display:inline-flex;align-items:center;gap:4px;transition:background 150ms ease,border-color 150ms ease,transform 100ms ease}
  .actions button:hover{background:#252b34;border-color:#3a414b}
  .actions button:active{transform:scale(.94)}
  .actions button.respawn{color:#7cc4ff;border-color:#2d4a66}
  .actions button.edit{color:#d29922;border-color:#574122}
  .actions button.kill{color:#f85149;border-color:#4a2329}
  .actions button.resume-btn{color:#a371f7;border-color:#3c2a59}
  .actions button .icon{font-size:13px;line-height:1;display:inline-block;vertical-align:middle}
  .actions button:disabled{opacity:.5;cursor:wait}
  .empty{color:#7a7f87;padding:18px;text-align:center;border:1px dashed #1f2329;border-radius:8px}
  .empty code{color:#c9d1d9;background:#11141a;padding:2px 6px;border-radius:4px}
  tbody tr{transition:background 150ms ease}
  tbody tr:hover{background:#0e1116}
  #new-btn{background:#1c2128;color:#7cc4ff;border:1px solid #2d4a66;border-radius:6px;padding:6px 10px;font:12px ui-monospace,monospace;cursor:pointer}
  #new-btn:hover{background:#252b34}
  #new-form{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:14px;margin-bottom:14px;max-height:0;opacity:0;overflow:hidden;padding-top:0;padding-bottom:0;border-width:0;margin-bottom:0;transition:max-height 220ms ease,opacity 180ms ease,padding-top 220ms ease,padding-bottom 220ms ease,border-width 220ms ease,margin-bottom 220ms ease}
  #new-form.open{max-height:900px;opacity:1;padding:14px;border-width:1px;margin-bottom:14px}
  #new-form .form-title{margin:0 0 12px;font-size:13px;color:#c9d1d9;font-weight:600}
  #new-form select:disabled{opacity:.6;cursor:not-allowed}
  #new-form .field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
  #new-form label{font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em}
  #new-form select,#new-form input,#new-form textarea{background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 10px;font:13px ui-monospace,monospace;outline:none;width:100%;box-sizing:border-box;resize:vertical}
  #new-form select:focus,#new-form input:focus,#new-form textarea:focus{border-color:#2d4a66}
  #new-form .actions{display:flex;gap:8px;justify-content:flex-end}
  #new-form button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:12px ui-monospace,monospace;cursor:pointer}
  #new-form button.primary{color:#7cc4ff;border-color:#2d4a66}
  #new-form button:hover{background:#252b34}
  #new-form button:disabled{opacity:.5;cursor:wait}
  #new-form .hint{font-size:11px;color:#7a7f87;margin-top:-4px;margin-bottom:10px}
  footer{position:fixed;bottom:0;left:0;right:0;background:#0b0c10;border-top:1px solid #1f2329;padding:10px 16px;font-size:11px;color:#7a7f87;display:flex;justify-content:space-between;gap:10px}
  footer .warn{color:#d29922}
  footer .ok{color:#7ee787}
  #toast{position:fixed;bottom:50px;left:50%;transform:translateX(-50%);background:#11141a;border:1px solid #1f2329;color:#e6e8eb;padding:8px 14px;border-radius:6px;font-size:12px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:30}
  #toast.show{opacity:1}
  #toast.error{border-color:#4a2329;color:#f85149}
  #confirm-modal{position:fixed;inset:0;background:rgba(11,12,16,.85);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px;opacity:0;visibility:hidden;transition:opacity 160ms ease,visibility 0s 160ms}
  #confirm-modal.open{opacity:1;visibility:visible;transition:opacity 160ms ease}
  #confirm-modal .panel{transform:translateY(8px) scale(.97);transition:transform 200ms ease}
  #confirm-modal.open .panel{transform:translateY(0) scale(1)}
  #confirm-modal .panel{background:#11141a;border:1px solid #1f2329;border-radius:10px;padding:20px;max-width:360px;width:100%}
  #confirm-modal h3{margin:0 0 8px;font-size:15px;color:#e6e8eb}
  #confirm-modal p{margin:0 0 16px;font-size:13px;color:#c9d1d9;line-height:1.5}
  #confirm-modal p code{color:#7cc4ff;background:#0b0c10;padding:2px 5px;border-radius:3px}
  #confirm-modal .actions{display:flex;gap:8px;justify-content:flex-end}
  #confirm-modal button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #confirm-modal button.danger{color:#f85149;border-color:#4a2329}
  #confirm-modal button.danger:hover{background:#2a1c1f}
  #confirm-modal button:disabled{opacity:.5;cursor:wait}
  .help-btn{background:#1c2128;color:#7cc4ff;border:1px solid #2d4a66;border-radius:50%;width:18px;height:18px;font:11px ui-monospace,monospace;cursor:pointer;padding:0;margin-left:4px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle}
  .help-btn:hover{background:#252b34}
  #agents-modal{position:fixed;inset:0;background:rgba(11,12,16,.85);display:flex;align-items:center;justify-content:center;z-index:40;padding:20px;opacity:0;visibility:hidden;transition:opacity 160ms ease,visibility 0s 160ms}
  #agents-modal.open{opacity:1;visibility:visible;transition:opacity 160ms ease}
  #agents-modal .panel{transform:translateY(8px) scale(.97);transition:transform 200ms ease}
  #agents-modal.open .panel{transform:translateY(0) scale(1)}
  #agents-modal .panel{background:#11141a;border:1px solid #1f2329;border-radius:10px;padding:18px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column}
  #agents-modal h3{margin:0 0 4px;font-size:15px;color:#e6e8eb}
  #agents-modal .sub{margin:0 0 14px;font-size:11px;color:#7a7f87}
  #agents-list{flex:1 1 auto;overflow-y:auto;margin-bottom:12px;min-height:0}
  #agents-list .agent{padding:10px 0;border-bottom:1px solid #1f2329}
  #agents-list .agent:last-child{border-bottom:none}
  #agents-list .agent-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
  #agents-list .agent-name{font-weight:600;color:#e6e8eb;font-size:13px}
  #agents-list .agent-status{font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid}
  #agents-list .agent-status.ok{color:#7ee787;border-color:#235828;background:#0d1f10}
  #agents-list .agent-status.miss{color:#7a7f87;border-color:#262c34;background:#0e1116}
  #agents-list .agent-install{font:11px ui-monospace,monospace;color:#c9d1d9;background:#0b0c10;border:1px solid #1f2329;border-radius:4px;padding:6px 8px;margin-top:4px;word-break:break-all}
  #agents-list .agent-docs{font-size:11px;color:#7cc4ff;text-decoration:none;margin-top:4px;display:inline-block}
  #agents-list .agent-docs:hover{text-decoration:underline}
  #agents-modal .actions{display:flex;justify-content:flex-end}
  #agents-modal button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #agents-modal button:hover{background:#252b34}
  #convs-modal{position:fixed;inset:0;background:rgba(11,12,16,.85);display:flex;align-items:center;justify-content:center;z-index:40;padding:20px;opacity:0;visibility:hidden;transition:opacity 160ms ease,visibility 0s 160ms}
  #convs-modal.open{opacity:1;visibility:visible;transition:opacity 160ms ease}
  #convs-modal .panel{transform:translateY(8px) scale(.97);transition:transform 200ms ease}
  #convs-modal.open .panel{transform:translateY(0) scale(1)}
  #convs-list .conv{transition:background 120ms ease}
  #convs-modal .panel{background:#11141a;border:1px solid #1f2329;border-radius:10px;padding:18px;max-width:560px;width:100%;max-height:80vh;display:flex;flex-direction:column}
  #convs-modal h3{margin:0 0 4px;font-size:15px;color:#e6e8eb}
  #convs-modal .sub{margin:0 0 14px;font-size:11px;color:#7a7f87}
  #convs-list{flex:1 1 auto;overflow-y:auto;margin-bottom:12px;min-height:0}
  #convs-list .conv{padding:10px 0;border-bottom:1px solid #1f2329;cursor:pointer;display:block;width:100%;text-align:left;background:transparent;border-left:none;border-right:none;border-top:none;color:inherit;font-family:inherit;font-size:inherit}
  #convs-list .conv:last-child{border-bottom:none}
  #convs-list .conv:hover{background:#1a1d23}
  #convs-list .conv-title{font-size:13px;color:#e6e8eb;font-weight:500;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
  #convs-list .conv-meta{font-size:11px;color:#7a7f87;margin-top:2px;display:flex;gap:8px}
  #convs-list .conv-meta .when{color:#9aa0a6}
  #convs-list .conv-meta .count{color:#7a7f87}
  #convs-list .conv-current{color:#a371f7;font-weight:600}
  #convs-modal .actions{display:flex;justify-content:flex-end}
  #convs-modal button.close-btn{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #convs-modal button.close-btn:hover{background:#252b34}
  /* Mobile: hide cwd column, show under name */
  @media (max-width: 600px){
    body{padding:14px 8px 72px}
    th.cwd-col,td.cwd-col{display:none}
    .name-block .cwd{display:block;margin-top:3px;max-width:100%}
    th,td{padding:8px 4px;font-size:13px}
    .name-block{max-width:42vw}
    td.actions{white-space:nowrap;text-align:right;padding-right:0}
    /* Buttons collapse to icon-only — long-press surfaces title= for label. */
    .actions button .label{display:none}
    .actions button{padding:5px 6px;min-width:28px;justify-content:center;margin-left:2px}
  }
  @media (min-width: 601px){
    .name-block .cwd{display:none}
  }
</style></head>
<body>
<header>
  <h1><span class="brand">LLMUX</span>: Sessions</h1>
  <div id="meta">
    <button id="new-btn" type="button">+ new session</button>
    <span id="refresh-dot" title="updates every 3s"></span>
    <span id="refresh-label">live</span>
    <span>·</span>
    <span>v${escapeHtml(DAEMON_VERSION)}</span>
  </div>
</header>
<div id="new-form" aria-hidden="true">
  <h3 id="new-title" class="form-title">new session</h3>
  <form id="new-session-form">
    <div class="field">
      <label for="new-agent">agent <button type="button" id="agent-help-btn" class="help-btn" title="Show all supported agents">?</button></label>
      <select id="new-agent" required></select>
    </div>
    <div class="field">
      <label for="new-name">name</label>
      <input id="new-name" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="(defaults to agent key)" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*">
    </div>
    <div class="field">
      <label for="new-cwd">cwd</label>
      <input id="new-cwd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="(defaults to \$HOME on the daemon host)">
    </div>
    <div id="new-cwd-hint" class="hint" hidden>cwd changes apply immediately — if the session is running, it'll be killed and respawned in the new directory</div>
    <div class="field">
      <label for="new-flags">flags</label>
      <input id="new-flags" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    </div>
    <div id="new-flags-hint" class="hint" hidden></div>
    <div class="field">
      <label for="new-env">env vars</label>
      <textarea id="new-env" rows="3" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="KEY=VALUE one per line"></textarea>
    </div>
    <div id="new-env-hint" class="hint" hidden></div>
    <div class="actions">
      <button type="button" id="new-cancel">cancel</button>
      <button type="submit" class="primary" id="new-submit">spawn</button>
    </div>
  </form>
</div>
<div id="list-container">${renderSessionTable(sessions)}</div>
<div id="toast"></div>
<div id="confirm-modal" aria-hidden="true">
  <div class="panel">
    <h3 id="confirm-title">Kill session?</h3>
    <p id="confirm-body"></p>
    <div class="actions">
      <button type="button" id="confirm-cancel">cancel</button>
      <button type="button" class="danger" id="confirm-ok">kill</button>
    </div>
  </div>
</div>
<div id="agents-modal" aria-hidden="true">
  <div class="panel">
    <h3>Supported agents</h3>
    <p class="sub">Only installed agents appear in the spawn dropdown. Install the others on the daemon host to enable them.</p>
    <div id="agents-list">loading…</div>
    <div class="actions">
      <button type="button" id="agents-close">close</button>
    </div>
  </div>
</div>
<div id="convs-modal" aria-hidden="true">
  <div class="panel">
    <h3 id="convs-title">Past conversations</h3>
    <p class="sub" id="convs-sub">Pick one to resume. The current session will be killed and respawned with the agent's resume flag.</p>
    <div id="convs-list">loading…</div>
    <div class="actions">
      <button type="button" id="convs-close">cancel</button>
    </div>
  </div>
</div>
<footer>
  <span>llmux v${escapeHtml(DAEMON_VERSION)}</span>
  ${authStore.authEnabled()
    ? `<span class="ok">✓ auth required — ${authStore.listAuthTokens().length} active token${authStore.listAuthTokens().length === 1 ? '' : 's'}</span>`
    : `<span class="warn">⚠ no auth — anyone on the network can attach</span>`}
</footer>
<script>
(function(){
  const container = document.getElementById('list-container');
  const dot = document.getElementById('refresh-dot');
  const label = document.getElementById('refresh-label');
  const toast = document.getElementById('toast');
  let pollTimer = null;
  let lastFetch = 0;

  function showToast(msg, isError){
    toast.textContent = msg;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    setTimeout(function(){ toast.classList.remove('show'); }, 2200);
  }

  function escapeHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function relativeTime(iso){
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return '';
    if (ms < 60000) return 'just now';
    const m = Math.floor(ms/60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m/60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h/24);
    return d + 'd ago';
  }
  function rowHtml(s){
    const cls = 'state-' + s.status;
    const linkOpen  = s.status === 'running' ? '<a class="session-link" href="/session/' + encodeURIComponent(s.name) + '">' : '<a class="session-link" href="/session/' + encodeURIComponent(s.name) + '" title="session is not running — click to respawn">';
    const respawnText = s.status === 'running' ? 'restart' : 'respawn';
    const respawnTitle = s.status === 'running' ? 'kill + relaunch with the persisted config (use after edit)' : 'launch the agent again with the persisted config';
    const respawnBtn = '<button class="respawn" data-action="respawn" data-name="' + escapeHtml(s.name) + '" title="' + respawnTitle + '" aria-label="' + respawnText + '"><span class="icon">↻</span><span class="label">' + respawnText + '</span></button>';
    const editBtn = '<button class="edit" data-action="edit" data-name="' + escapeHtml(s.name) + '" data-cwd="' + escapeHtml(s.cwd) + '" data-agent="' + escapeHtml(s.agent) + '" data-flags="' + escapeHtml(s.flags || '') + '" data-env="' + escapeHtml(JSON.stringify(s.env || {})) + '" title="edit name, cwd, flags, or env" aria-label="edit"><span class="icon">✎</span><span class="label">edit</span></button>';
    const resumeBtn = (s.hasHistory && s.conversationCount > 0)
      ? '<button class="resume-btn" data-action="resume" data-name="' + escapeHtml(s.name) + '" title="resume a past conversation for this agent + cwd" aria-label="resume"><span class="icon">☰</span><span class="label">' + s.conversationCount + '</span></button>'
      : '';
    const when = relativeTime(s.createdAt);
    const cwdShort = s.cwdDisplay || s.cwd;
    return '<tr data-name="' + escapeHtml(s.name) + '">' +
      '<td class="name-block"><span class="name">' + linkOpen + escapeHtml(s.name) + '</a></span>' + (when ? '<span class="started">started ' + when + '</span>' : '') + '<span class="cwd" title="' + escapeHtml(s.cwd) + '"><code>' + escapeHtml(cwdShort) + '</code></span></td>' +
      '<td>' + escapeHtml(s.agent) + '</td>' +
      '<td class="' + cls + '">' + s.status + '</td>' +
      '<td class="cwd cwd-col" title="' + escapeHtml(s.cwd) + '"><code>' + escapeHtml(cwdShort) + '</code></td>' +
      '<td class="actions">' + resumeBtn + respawnBtn + editBtn + '<button class="kill" data-action="kill" data-name="' + escapeHtml(s.name) + '" data-status="' + s.status + '" title="' + (s.status === 'running' ? 'kill the tmux session + remove the record' : 'remove the record') + '" aria-label="' + (s.status === 'running' ? 'kill' : 'remove') + '"><span class="icon">✕</span><span class="label">' + (s.status === 'running' ? 'kill' : 'remove') + '</span></button></td>' +
      '</tr>';
  }

  function render(sessions){
    if (!sessions || sessions.length === 0){
      container.innerHTML = '<div class="empty">no sessions yet — spawn one from the CLI:<br><br><code>llmux session start claude --name <em>name</em></code></div>';
      return;
    }
    const rows = sessions.map(rowHtml).join('');
    container.innerHTML = '<table><thead><tr><th>name</th><th>agent</th><th>state</th><th class="cwd-col">cwd</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  async function poll(){
    if (document.hidden) return;
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      render(data);
      dot.classList.remove('stale','error');
      label.textContent = 'live';
      lastFetch = Date.now();
    } catch(e){
      dot.classList.add('error');
      dot.classList.remove('stale');
      label.textContent = 'offline';
    }
  }

  function staleCheck(){
    if (lastFetch && Date.now() - lastFetch > 8000 && !dot.classList.contains('error')){
      dot.classList.add('stale');
      label.textContent = 'stale';
    }
  }

  async function action(name, kind, btn){
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = kind === 'respawn' ? '…' : '…';
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/' + kind, { method: 'POST' });
      const body = await r.json().catch(function(){ return {}; });
      if (!r.ok || body.ok === false) throw new Error(body.error || 'request failed');
      showToast(kind === 'respawn' ? 'respawned ' + name : (body.status === 'running' ? 'killed ' + name : 'removed ' + name));
      poll();
    } catch(e){
      showToast(kind + ' failed: ' + (e.message || e), true);
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  // ---- Agents help modal ----
  const agentsModal = document.getElementById('agents-modal');
  const agentsList = document.getElementById('agents-list');
  const agentsClose = document.getElementById('agents-close');
  const agentHelpBtn = document.getElementById('agent-help-btn');
  let agentsAllLoaded = false;

  async function loadAgentsAll(){
    if (agentsAllLoaded) return;
    try {
      const r = await fetch('/api/agents/all', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const list = await r.json();
      agentsList.innerHTML = list.map(function(a){
        const status = a.installed
          ? '<span class="agent-status ok">installed</span>'
          : '<span class="agent-status miss">not installed</span>';
        const install = a.installHint
          ? '<div class="agent-install">' + escapeHtml(a.installHint) + '</div>'
          : '';
        const docs = a.docsUrl
          ? '<a class="agent-docs" href="' + escapeHtml(a.docsUrl) + '" target="_blank" rel="noopener">docs ↗</a>'
          : '';
        return '<div class="agent">' +
          '<div class="agent-head"><span class="agent-name">' + escapeHtml(a.displayName) + '</span>' + status + '</div>' +
          install + docs +
          '</div>';
      }).join('');
      agentsAllLoaded = true;
    } catch(e){
      agentsList.innerHTML = '<div class="agent">failed to load agents: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  agentHelpBtn.addEventListener('click', async function(e){
    e.preventDefault();
    e.stopPropagation();
    agentsModal.classList.add('open');
    agentsModal.setAttribute('aria-hidden', 'false');
    await loadAgentsAll();
  });
  agentsClose.addEventListener('click', function(){
    agentsModal.classList.remove('open');
    agentsModal.setAttribute('aria-hidden', 'true');
  });
  agentsModal.addEventListener('click', function(e){
    if (e.target === agentsModal){
      agentsModal.classList.remove('open');
      agentsModal.setAttribute('aria-hidden', 'true');
    }
  });

  // ---- Conversations modal ----
  const convsModal = document.getElementById('convs-modal');
  const convsTitle = document.getElementById('convs-title');
  const convsList = document.getElementById('convs-list');
  const convsClose = document.getElementById('convs-close');
  let convsForSession = null;
  let convsCurrentResumeFrom = null;

  function relTime(iso){
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return iso;
    if (ms < 60000) return 'just now';
    const m = Math.floor(ms/60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m/60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h/24);
    return d + 'd ago';
  }

  async function openConvsModal(sessionName){
    convsForSession = sessionName;
    convsTitle.textContent = 'Past conversations · ' + sessionName;
    convsList.innerHTML = 'loading…';
    convsModal.classList.add('open');
    convsModal.setAttribute('aria-hidden', 'false');
    // Track this row's current resumeFrom so we can flag the active conversation
    convsCurrentResumeFrom = null;
    try {
      const sres = await fetch('/api/sessions', { cache: 'no-store' });
      if (sres.ok){
        const list = await sres.json();
        const row = list.find(function(s){ return s.name === sessionName; });
        if (row) convsCurrentResumeFrom = row.resumeFrom || null;
      }
    } catch(_){}
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/conversations', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0){
        convsList.innerHTML = '<div class="conv">no past conversations for this agent + cwd</div>';
        return;
      }
      convsList.innerHTML = list.map(function(c){
        const isCurrent = c.id === convsCurrentResumeFrom;
        const titleCls = isCurrent ? 'conv-title conv-current' : 'conv-title';
        return '<button class="conv" data-conv-id="' + escapeHtml(c.id) + '" data-conv-title="' + escapeHtml(c.title) + '">' +
          '<span class="' + titleCls + '">' + (isCurrent ? '↻ ' : '') + escapeHtml(c.title) + '</span>' +
          '<span class="conv-meta"><span class="when">' + escapeHtml(relTime(c.lastMessageAt)) + '</span><span class="count">' + c.messageCount + ' msgs</span></span>' +
          '</button>';
      }).join('');
    } catch(e){
      convsList.innerHTML = '<div class="conv">failed to load conversations: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  function closeConvsModal(){
    convsModal.classList.remove('open');
    convsModal.setAttribute('aria-hidden', 'true');
    convsForSession = null;
  }
  convsClose.addEventListener('click', closeConvsModal);
  convsModal.addEventListener('click', function(e){
    if (e.target === convsModal) closeConvsModal();
  });

  convsList.addEventListener('click', async function(e){
    const btn = e.target.closest('button[data-conv-id]');
    if (!btn || !convsForSession) return;
    const convId = btn.dataset.convId;
    const convTitle = btn.dataset.convTitle || '(conversation)';
    const sessionName = convsForSession;
    // Dismiss the conversations modal immediately so the confirm dialog
    // doesn't stack underneath it (was a real bug — same z-index meant the
    // confirm rendered behind the picker and tapping looked like nothing
    // happened).
    closeConvsModal();
    const ok = await askConfirm({
      title: 'Resume conversation?',
      body: 'Kill <code>' + escapeHtmlSafe(sessionName) + '</code> and relaunch the agent with <code>--resume ' + escapeHtmlSafe(convId.slice(0, 8)) + '…</code>. The current in-process state is lost; conversation history (on the agent\\'s side) is intact.<br><br><em>' + escapeHtmlSafe(convTitle) + '</em>',
      okLabel: 'resume',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(sessionName) + '/resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: convId }),
      });
      const data = await r.json().catch(function(){ return {}; });
      if (!r.ok || data.ok === false) throw new Error(data.error || 'resume failed');
      showToast('resumed ' + sessionName);
      poll();
    } catch(err){
      showToast('resume failed: ' + (err.message || err), true);
    }
  });

  // ---- Confirm modal ----
  const confirmModal = document.getElementById('confirm-modal');
  const confirmTitle = document.getElementById('confirm-title');
  const confirmBody = document.getElementById('confirm-body');
  const confirmCancel = document.getElementById('confirm-cancel');
  const confirmOk = document.getElementById('confirm-ok');
  let confirmResolve = null;

  function askConfirm(opts){
    confirmTitle.textContent = opts.title;
    confirmBody.innerHTML = opts.body;
    confirmOk.textContent = opts.okLabel || 'confirm';
    confirmOk.className = opts.destructive ? 'danger' : '';
    confirmModal.classList.add('open');
    confirmModal.setAttribute('aria-hidden', 'false');
    return new Promise(function(resolve){ confirmResolve = resolve; });
  }
  function closeConfirm(answer){
    confirmModal.classList.remove('open');
    confirmModal.setAttribute('aria-hidden', 'true');
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(answer);
  }
  confirmCancel.addEventListener('click', function(){ closeConfirm(false); });
  confirmOk.addEventListener('click', function(){ closeConfirm(true); });
  // Tapping the dim background = cancel
  confirmModal.addEventListener('click', function(e){
    if (e.target === confirmModal) closeConfirm(false);
  });

  function escapeHtmlSafe(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  container.addEventListener('click', async function(e){
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    const name = btn.dataset.name;
    const kind = btn.dataset.action;
    if (kind === 'edit'){
      let env = {};
      try { env = JSON.parse(btn.dataset.env || '{}'); } catch(_){}
      openEditForm({ name: name, agent: btn.dataset.agent, cwd: btn.dataset.cwd, flags: btn.dataset.flags, env: env });
      return;
    }
    if (kind === 'resume'){
      openConvsModal(name);
      return;
    }
    if (kind === 'kill'){
      const running = btn.dataset.status === 'running';
      const ok = await askConfirm({
        title: running ? 'Kill session?' : 'Remove session record?',
        body: running
          ? 'Terminate the tmux session <code>' + escapeHtmlSafe(name) + '</code> and remove its state record. The agent process inside will be killed. This cannot be undone.'
          : 'Remove the state record for <code>' + escapeHtmlSafe(name) + '</code>. The tmux session is already exited; this just cleans up the row.',
        okLabel: running ? 'kill' : 'remove',
        destructive: true,
      });
      if (!ok) return;
    }
    action(name, kind, btn);
  });

  // ---- New / Edit session form ----
  const newBtn = document.getElementById('new-btn');
  const newForm = document.getElementById('new-form');
  const newTitle = document.getElementById('new-title');
  const newSessionForm = document.getElementById('new-session-form');
  const newAgent = document.getElementById('new-agent');
  const newName = document.getElementById('new-name');
  const newCwd = document.getElementById('new-cwd');
  const newFlags = document.getElementById('new-flags');
  const newEnv = document.getElementById('new-env');
  const newCwdHint = document.getElementById('new-cwd-hint');
  const newFlagsHint = document.getElementById('new-flags-hint');
  const newEnvHint = document.getElementById('new-env-hint');
  const newCancel = document.getElementById('new-cancel');
  const newSubmit = document.getElementById('new-submit');
  let agentsLoaded = false;
  let agentList = [];
  // mode: null (closed) | 'new' | { edit: <original-name> }
  let formMode = null;

  function agentDefaultFlags(key){
    const a = agentList.find(function(x){ return x.key === key; });
    return (a && a.flags) || '';
  }
  function agentDefaultEnv(key){
    const a = agentList.find(function(x){ return x.key === key; });
    return (a && a.envDefaults) || {};
  }
  function envToText(envObj){
    if (!envObj) return '';
    return Object.keys(envObj).sort().map(function(k){ return k + '=' + envObj[k]; }).join('\\n');
  }

  async function loadAgents(){
    if (agentsLoaded) return;
    try {
      const r = await fetch('/api/agents', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0){
        newAgent.innerHTML = '<option value="" disabled selected>no installed agents</option>';
        agentList = [];
      } else {
        agentList = list;
        newAgent.innerHTML = list.map(function(a){
          const label = a.displayName || a.key;
          return '<option value="' + escapeHtml(a.key) + '">' + escapeHtml(label) + '</option>';
        }).join('');
      }
      agentsLoaded = true;
    } catch(e){
      showToast('couldn\\'t load agents: ' + (e.message || e), true);
    }
  }

  function closeForm(){
    newForm.classList.remove('open');
    newForm.setAttribute('aria-hidden', 'true');
    formMode = null;
    newAgent.disabled = false;
  }

  function syncFlagsHint(agentKey){
    const def = agentDefaultFlags(agentKey);
    newFlagsHint.textContent = def
      ? 'agent default: ' + def + '. Clear the input to spawn with no flags. Takes effect on next respawn.'
      : 'this agent has no default flags. Takes effect on next respawn.';
  }
  function syncEnvHint(agentKey){
    const def = agentDefaultEnv(agentKey);
    const keys = Object.keys(def);
    newEnvHint.textContent = keys.length > 0
      ? 'agent defaults: ' + keys.join(', ') + '. KEY=VALUE one per line. Stored on the daemon host (auth-gated) — keep secrets out if you prefer to inject from a shell profile.'
      : 'no defaults for this agent. KEY=VALUE one per line. Stored on the daemon host (auth-gated) — keep secrets out if you prefer to inject from a shell profile.';
  }

  async function openNewForm(){
    formMode = 'new';
    newTitle.textContent = 'new session';
    newSubmit.textContent = 'spawn';
    newName.value = '';
    newCwd.value = '';
    newAgent.disabled = false;
    newCwdHint.hidden = true;
    newFlagsHint.hidden = false;
    newEnvHint.hidden = false;
    newForm.classList.add('open');
    newForm.setAttribute('aria-hidden', 'false');
    await loadAgents();
    // Pre-fill flags + env with the selected agent's defaults so the operator
    // can edit/clear from there. Empty = spawn with no flags / no env override.
    newFlags.value = agentDefaultFlags(newAgent.value);
    newEnv.value = envToText(agentDefaultEnv(newAgent.value));
    syncFlagsHint(newAgent.value);
    syncEnvHint(newAgent.value);
    newAgent.focus();
  }

  async function openEditForm(row){
    formMode = { edit: row.name };
    newTitle.textContent = 'edit "' + row.name + '"';
    newSubmit.textContent = 'save';
    newName.value = row.name;
    newCwd.value = row.cwd || '';
    newCwdHint.hidden = false;
    newFlagsHint.hidden = false;
    newEnvHint.hidden = false;
    newForm.classList.add('open');
    newForm.setAttribute('aria-hidden', 'false');
    await loadAgents();
    // Agent of an existing session can't be changed without kill+respawn;
    // surface it as read-only so the user sees what they have.
    if (row.agent) newAgent.value = row.agent;
    newAgent.disabled = true;
    // Pre-fill with the persisted override if present, else the agent default.
    newFlags.value = row.flags !== undefined && row.flags !== ''
      ? row.flags
      : agentDefaultFlags(newAgent.value);
    newEnv.value = row.env && Object.keys(row.env).length > 0
      ? envToText(row.env)
      : envToText(agentDefaultEnv(newAgent.value));
    syncFlagsHint(newAgent.value);
    syncEnvHint(newAgent.value);
    newName.focus();
    newName.select();
  }

  newAgent.addEventListener('change', function(){
    if (formMode === 'new'){
      // Reset flags + env to the new agent's defaults so fields reflect intent.
      newFlags.value = agentDefaultFlags(newAgent.value);
      newEnv.value = envToText(agentDefaultEnv(newAgent.value));
      syncFlagsHint(newAgent.value);
      syncEnvHint(newAgent.value);
    }
  });

  newBtn.addEventListener('click', function(){
    if (newForm.classList.contains('open') && formMode === 'new'){ closeForm(); return; }
    openNewForm();
  });

  newCancel.addEventListener('click', function(){ closeForm(); });

  newSessionForm.addEventListener('submit', async function(e){
    e.preventDefault();
    const name = newName.value.trim();
    const cwd = newCwd.value.trim();
    const flags = newFlags.value;
    const env = newEnv.value;
    newSubmit.disabled = true;
    const originalLabel = newSubmit.textContent;
    try {
      if (formMode && formMode.edit){
        newSubmit.textContent = 'saving…';
        // For edit, always send flags + env so input values are canonical.
        // name/cwd still only sent if user typed (so blank = no change).
        const body = { flags: flags, env: env };
        if (name) body.name = name;
        if (cwd) body.cwd = cwd;
        const r = await fetch('/api/sessions/' + encodeURIComponent(formMode.edit), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(function(){ return {}; });
        if (!r.ok || data.ok === false) throw new Error(data.error || 'edit failed');
        showToast('updated ' + data.session.name);
      } else {
        const agent = newAgent.value;
        if (!agent){ showToast('pick an agent', true); return; }
        newSubmit.textContent = 'spawning…';
        const body = { agent };
        if (name) body.name = name;
        if (cwd) body.cwd = cwd;
        // Always send flags + env as the inputs are pre-filled with agent defaults;
        // empty values = explicit "no flags" / "no env override".
        body.flags = flags;
        body.env = env;
        const r = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await r.json().catch(function(){ return {}; });
        if (!r.ok || data.ok === false) throw new Error(data.error || 'spawn failed');
        showToast('spawned ' + data.session.name);
      }
      closeForm();
      poll();
    } catch(e){
      showToast((formMode && formMode.edit ? 'edit' : 'spawn') + ' failed: ' + (e.message || e), true);
    } finally {
      newSubmit.disabled = false;
      newSubmit.textContent = originalLabel;
    }
  });

  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) poll();
  });

  poll();
  pollTimer = setInterval(poll, 3000);
  setInterval(staleCheck, 1000);
})();
</script>
</body></html>`;
}

function renderSessionTable(sessions: SessionView[]): string {
  if (sessions.length === 0) {
    return `<div class="empty">no sessions yet — spawn one from the CLI:<br><br><code>llmux session start claude --name <em>name</em></code></div>`;
  }
  const rows = sessions
    .map((s) => {
      const cls = `state-${s.status}`;
      const linkOpen = `<a class="session-link" href="/session/${encodeURIComponent(s.name)}">`;
      const respawnText = s.status === 'running' ? 'restart' : 'respawn';
      const respawnBtn = `<button class="respawn" data-action="respawn" data-name="${escapeHtml(s.name)}" aria-label="${respawnText}"><span class="icon">↻</span><span class="label">${respawnText}</span></button>`;
      const editBtn = `<button class="edit" data-action="edit" data-name="${escapeHtml(s.name)}" data-cwd="${escapeHtml(s.cwd)}" data-agent="${escapeHtml(s.agent)}" data-flags="${escapeHtml(s.flags || '')}" data-env="${escapeHtml(JSON.stringify(s.env || {}))}" aria-label="edit"><span class="icon">✎</span><span class="label">edit</span></button>`;
      const resumeBtn = (s.hasHistory && s.conversationCount > 0)
        ? `<button class="resume-btn" data-action="resume" data-name="${escapeHtml(s.name)}" aria-label="resume"><span class="icon">☰</span><span class="label">${s.conversationCount}</span></button>`
        : '';
      const killText = s.status === 'running' ? 'kill' : 'remove';
      const killBtn = `<button class="kill" data-action="kill" data-name="${escapeHtml(s.name)}" data-status="${s.status}" aria-label="${killText}"><span class="icon">✕</span><span class="label">${killText}</span></button>`;
      const cwdShort = s.cwdDisplay || s.cwd;
      return `<tr data-name="${escapeHtml(s.name)}">
  <td class="name-block"><span class="name">${linkOpen}${escapeHtml(s.name)}</a></span><span class="cwd" title="${escapeHtml(s.cwd)}"><code>${escapeHtml(cwdShort)}</code></span></td>
  <td>${escapeHtml(s.agent)}</td>
  <td class="${cls}">${s.status}</td>
  <td class="cwd cwd-col" title="${escapeHtml(s.cwd)}"><code>${escapeHtml(cwdShort)}</code></td>
  <td class="actions">${resumeBtn}${respawnBtn}${editBtn}${killBtn}</td>
</tr>`;
    })
    .join('\n');
  return `<table><thead><tr><th>name</th><th>agent</th><th>state</th><th class="cwd-col">cwd</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function deadSessionPage(s: SessionView): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(s.name)} — exited</title>
<style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px}
  body{padding:24px;max-width:560px;margin:0 auto}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#7a7f87;font-size:12px;margin-bottom:18px}
  .card{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:18px}
  dl{margin:0;display:grid;grid-template-columns:80px 1fr;gap:6px 12px;font-size:13px}
  dt{color:#7a7f87}
  dd{margin:0;color:#c9d1d9;word-break:break-all}
  .row{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
  button{flex:1 1 auto;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:10px 14px;font:13px ui-monospace,monospace;cursor:pointer;min-width:120px}
  button:hover{background:#252b34}
  button.primary{color:#7cc4ff;border-color:#2d4a66}
  button.danger{color:#f85149;border-color:#4a2329}
  button.ghost{color:#9aa0a6}
  button:disabled{opacity:.5;cursor:wait}
  #status{margin-top:14px;font-size:12px;color:#9aa0a6;min-height:18px}
  #status.error{color:#f85149}
</style></head>
<body>
<h1>${escapeHtml(s.name)}</h1>
<div class="sub">session is not running</div>
<div class="card">
  <dl>
    <dt>agent</dt><dd>${escapeHtml(s.agent)}</dd>
    <dt>cwd</dt><dd>${escapeHtml(s.cwd)}</dd>
    <dt>created</dt><dd>${escapeHtml(s.createdAt)}</dd>
    ${s.parent ? `<dt>parent</dt><dd>${escapeHtml(s.parent)}</dd>` : ''}
  </dl>
  <div class="row">
    <button class="primary" id="btn-respawn">↻ respawn</button>
    <button class="danger" id="btn-remove">× remove</button>
    <button class="ghost" id="btn-back">← sessions</button>
  </div>
  <div id="status"></div>
</div>
<script>
(function(){
  const name = ${JSON.stringify(s.name)};
  const status = document.getElementById('status');
  function setStatus(msg, isError){
    status.textContent = msg;
    status.classList.toggle('error', !!isError);
  }
  async function call(kind){
    const btns = document.querySelectorAll('button');
    btns.forEach(function(b){ b.disabled = true; });
    setStatus(kind === 'respawn' ? 'respawning…' : 'removing…');
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/' + kind, { method: 'POST' });
      const body = await r.json().catch(function(){ return {}; });
      if (!r.ok || body.ok === false) throw new Error(body.error || 'request failed');
      if (kind === 'respawn') location.href = '/session/' + encodeURIComponent(name);
      else location.href = '/';
    } catch(e){
      setStatus(kind + ' failed: ' + (e.message || e), true);
      btns.forEach(function(b){ b.disabled = false; });
    }
  }
  document.getElementById('btn-respawn').addEventListener('click', function(){ call('respawn'); });
  document.getElementById('btn-remove').addEventListener('click', function(){ call('kill'); });
  document.getElementById('btn-back').addEventListener('click', function(){ location.href = '/'; });
})();
</script>
</body></html>`;
}

function sessionPage(name: string): string {
  const escapedName = escapeHtml(name);
  const jsonName = JSON.stringify(name);
  const jsonVersion = JSON.stringify(DAEMON_VERSION);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<title>${escapedName} — llmux</title>
<link rel="icon" href="${FAVICON_DATA_URL}">
<link rel="apple-touch-icon" href="${FAVICON_DATA_URL}">
<link rel="stylesheet" href="${XTERM_CSS}">
<style>
  :root{--topbar-h:38px;--bar-h:92px;--allkeys-h:0px;color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#eee;font-family:ui-monospace,monospace;overscroll-behavior:none}
  html{height:100dvh}
  body{height:100dvh;min-height:100dvh}
  #topbar{position:fixed;top:0;left:0;right:0;height:var(--topbar-h);background:#11141a;border-bottom:1px solid #1f2329;display:flex;align-items:center;gap:8px;padding:0 10px;z-index:21;box-sizing:border-box}
  #topbar #back{flex:0 0 auto;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;height:26px;width:36px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-family:system-ui,sans-serif;font-size:16px;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
  #topbar #back:active{background:#252b34;border-color:#3a414b}
  #title-block{flex:1 1 auto;display:flex;align-items:center;gap:8px;color:#c9d1d9;font-size:12px;min-width:0}
  #title-dot{flex:0 0 auto;width:9px;height:9px;border-radius:50%;background:#9aa0a6;transition:background .2s,box-shadow .2s;cursor:pointer}
  #title-dot[data-state="live"]{background:#7ee787;box-shadow:0 0 6px #7ee78766}
  #title-dot[data-state="error"],#title-dot[data-state="closed"],#title-dot[data-state="reconnecting"]{background:#f85149}
  #title-dot[data-state="reconnecting"]{animation:pulse 1s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #title-name{flex:0 1 auto;font-weight:600;color:#e6e8eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #title-brand{flex:0 0 auto;color:#7cc4ff;font-size:11px;font-weight:600;letter-spacing:.08em;margin-left:auto;padding-left:8px}
  #title-version{flex:0 0 auto;color:#7a7f87;font-size:10px;padding-left:6px}
  #bar{position:fixed;bottom:0;left:0;right:0;height:var(--bar-h);background:#11141a;border-top:1px solid #1f2329;display:flex;flex-direction:column;gap:8px;padding:6px 0 14px;z-index:20;box-sizing:border-box}
  #bar .row{display:flex;align-items:center;gap:6px;padding:0 6px;flex:0 0 auto;height:32px}
  #bar .row.arrows{justify-content:center}
  #bar .row.keys{justify-content:flex-start}
  #bar #more{flex:0 0 auto;margin-left:auto}
  #bar button{flex:0 0 auto;min-width:40px;height:30px;padding:0 10px;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;font:13px ui-monospace,monospace;cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none;transition:background .15s,border-color .15s}
  #bar button:active{background:#252b34;border-color:#3a414b}
  #bar button[aria-pressed="true"]{background:#1e3a52;border-color:#2d5a85;color:#7cc4ff}
  #bar button[aria-pressed="locked"]{background:#2d5a85;border-color:#4a7fae;color:#fff}
  #bar button.fail{background:#4a2329;border-color:#f85149;color:#f85149}
  #all-keys{position:fixed;bottom:var(--bar-h);left:0;right:0;background:#0e1116;border-top:1px solid #1f2329;display:none;padding:8px;z-index:19;max-height:40vh;overflow-y:auto;box-sizing:border-box}
  #all-keys.open{display:block}
  #all-keys h4{margin:14px 4px 6px;font:500 10px/1 ui-monospace,monospace;color:#7a7f87;text-transform:uppercase;letter-spacing:.06em}
  #all-keys h4:first-child{margin-top:4px}
  #all-keys .row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
  #all-keys button{flex:0 0 auto;min-width:36px;height:30px;padding:0 8px;background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;font:12px ui-monospace,monospace;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
  #all-keys button:active{background:#252b34;border-color:#3a414b}
  #term{position:fixed;top:var(--topbar-h);left:0;right:0;bottom:var(--bar-h)}
  body.allkeys-open #term{bottom:calc(var(--bar-h) + var(--allkeys-h))}
  #overlay{position:fixed;inset:0;background:rgba(11,12,16,.92);display:none;align-items:center;justify-content:center;z-index:30;padding:20px}
  #overlay.show{display:flex}
  #overlay .panel{background:#11141a;border:1px solid #1f2329;border-radius:10px;padding:20px;max-width:340px;width:100%;text-align:center}
  #overlay h3{margin:0 0 6px;font-size:15px;color:#f85149}
  #overlay p{margin:0 0 14px;font-size:13px;color:#c9d1d9;line-height:1.5}
  #overlay .actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
  #overlay button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:12px ui-monospace,monospace;cursor:pointer}
  #overlay button.primary{color:#7cc4ff;border-color:#2d4a66}
  @media (orientation: landscape) and (max-height: 500px){
    :root{--topbar-h:28px;--bar-h:64px}
    #topbar{padding:0 6px;gap:6px}
    #topbar #back{height:20px;width:30px;font-size:13px}
    #title-block{font-size:11px}
    #title-brand{font-size:10px;padding-left:6px}
    #title-version{font-size:9px;padding-left:4px}
    #bar button{height:22px;min-width:36px;padding:0 8px;font-size:11px}
    #bar{padding:4px 0 10px;gap:4px}
    #bar .row{gap:4px;height:24px}
    #all-keys{max-height:60vh}
    #all-keys button{height:24px;min-width:30px;padding:0 7px;font-size:11px}
  }
</style></head>
<body>
<div id="topbar">
  <button id="back" title="Back to sessions">⌂</button>
  <span id="title-block"><span id="title-dot" data-state="connecting" title="connecting…"></span><span id="title-name">${escapedName}</span></span>
  <span id="title-brand">LLMUX</span>
  <span id="title-version">v${escapeHtml(DAEMON_VERSION)}</span>
</div>
<div id="bar">
  <div class="row arrows">
    <button data-mod="shift" title="Shift (next char uppercase; double-tap to lock)">Shift</button>
    <button data-key="home"  title="Home">Home</button>
    <button data-key="up"    title="Up">▲</button>
    <button data-key="down"  title="Down">▼</button>
    <button data-key="left"  title="Left">◀</button>
    <button data-key="right" title="Right">▶</button>
    <button data-key="end"   title="End">End</button>
  </div>
  <div class="row keys">
    <button data-key="esc" title="Escape">Esc</button>
    <button data-key="tab" title="Tab">Tab</button>
    <button data-mod="ctrl"  title="Ctrl (tap then key, double-tap to lock)">Ctrl</button>
    <button data-mod="alt"   title="Alt (tap then key, double-tap to lock)">Alt</button>
    <button id="more" title="All keys">⋯</button>
  </div>
</div>
<div id="all-keys" aria-hidden="true">
  <h4>shell</h4>
  <div class="row">
    <button data-char="~" title="tilde">~</button>
    <button data-char="\`" title="backtick">\`</button>
    <button data-char="/" title="slash">/</button>
    <button data-char="\\\\" title="backslash">\\</button>
    <button data-char="|" title="pipe">|</button>
    <button data-char="-" title="dash">-</button>
    <button data-char="_" title="underscore">_</button>
  </div>
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
  <h4>actions</h4>
  <div class="row">
    <button id="reset-term" title="Clear xterm buffer and send Ctrl-L to redraw">Reset terminal</button>
  </div>
</div>
<div id="term"></div>
<div id="overlay" aria-hidden="true">
  <div class="panel">
    <h3 id="overlay-title">session ended</h3>
    <p id="overlay-body">The tmux session exited. You can respawn it from the picker.</p>
    <div class="actions">
      <button class="primary" id="overlay-respawn">↻ respawn</button>
      <button id="overlay-back">← sessions</button>
    </div>
  </div>
</div>
<script src="${XTERM_JS}"></script>
<script src="${XTERM_FIT_JS}"></script>
<script>
(function(){
  const name = ${jsonName};
  const version = ${jsonVersion};
  const dot = document.getElementById('title-dot');
  const titleName = document.getElementById('title-name');
  const termEl = document.getElementById('term');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlay-title');
  const overlayBody = document.getElementById('overlay-body');

  function setStatus(state, label){
    dot.dataset.state = state;
    dot.title = name + ' — ' + label;
  }

  function showOverlay(title, body, kind){
    overlayTitle.textContent = title;
    overlayBody.textContent = body;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    overlay.dataset.kind = kind || '';
  }
  function hideOverlay(){
    overlay.classList.remove('show');
    overlay.setAttribute('aria-hidden', 'true');
  }

  document.getElementById('overlay-back').addEventListener('click', function(){ location.href = '/'; });
  document.getElementById('overlay-respawn').addEventListener('click', async function(){
    const btn = this;
    btn.disabled = true;
    overlayBody.textContent = 'respawning…';
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/respawn', { method: 'POST' });
      const body = await r.json().catch(function(){ return {}; });
      if (!r.ok || body.ok === false) throw new Error(body.error || 'request failed');
      location.reload();
    } catch(e){
      overlayBody.textContent = 'respawn failed: ' + (e.message || e);
      btn.disabled = false;
    }
  });

  const term = new Terminal({fontSize:14,fontFamily:'ui-monospace,monospace',theme:{background:'#0b0c10'},cursorBlink:true,scrollback:5000});
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  // ---- WebSocket with exponential backoff ----
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = proto + '://' + location.host + '/ws/' + encodeURIComponent(name);
  let ws = null;
  let dataPiped = false;
  let reconnectTimer = null;
  let backoffMs = 1000;
  const BACKOFF_CAP = 30000;
  let everConnected = false;
  let intentionallyClosed = false;

  function safeSend(data){
    if (!ws || ws.readyState !== WebSocket.OPEN){
      return false;
    }
    try { ws.send(data); return true; }
    catch(e){ return false; }
  }

  function clearReconnect(){
    if (reconnectTimer){
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(){
    if (intentionallyClosed) return;
    clearReconnect();
    setStatus('reconnecting', 'reconnecting in ' + Math.round(backoffMs/1000) + 's…');
    reconnectTimer = setTimeout(function(){
      reconnectTimer = null;
      connect();
    }, backoffMs);
    backoffMs = Math.min(BACKOFF_CAP, backoffMs * 2);
  }

  function ensureConnected(){
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearReconnect();
    backoffMs = 1000;
    connect();
  }

  function connect(){
    setStatus('connecting', 'connecting…');
    try {
      ws = new WebSocket(wsUrl);
    } catch(e){
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    ws.onopen = function(){
      setStatus('live', 'live');
      backoffMs = 1000;
      everConnected = true;
      hideOverlay();
      if (!dataPiped){
        // term.onData must only be wired once — repeat calls would
        // double-deliver every keystroke.
        term.onData(function(d){
          if (!safeSend(consumeMods(d))) flashDot();
        });
        dataPiped = true;
      }
      scheduleResize();
      term.focus();
    };
    ws.onmessage = function(ev){
      if (typeof ev.data === 'string') term.write(ev.data);
      else term.write(new Uint8Array(ev.data));
    };
    ws.onclose = function(ev){
      // Close code 1011/4040 from the server means the tmux session is gone —
      // surface a session-ended overlay instead of reconnect-looping.
      if (ev && (ev.code === 4040 || /pty exited/.test(ev.reason || ''))){
        intentionallyClosed = true;
        setStatus('closed', 'session ended');
        showOverlay('session ended', 'The tmux session is no longer running.', 'ended');
        return;
      }
      if (everConnected) setStatus('closed', 'disconnected — reconnecting');
      scheduleReconnect();
    };
    ws.onerror = function(){
      setStatus('error', 'connection error');
    };
  }

  let flashTimer = null;
  function flashDot(){
    dot.style.boxShadow = '0 0 8px #f85149';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function(){ dot.style.boxShadow = ''; }, 250);
  }
  function flashBtnFail(btn){
    btn.classList.add('fail');
    setTimeout(function(){ btn.classList.remove('fail'); }, 250);
  }

  connect();

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

  // ---- Layout / resize ----
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
    const topbarH = parseInt(cs.getPropertyValue('--topbar-h'),10) || 0;
    const vv = window.visualViewport;
    const visibleH = vv ? vv.height : window.innerHeight;
    termEl.style.top = topbarH + 'px';
    termEl.style.bottom = (barH + allKeysH) + 'px';
    termEl.style.height = Math.max(60, visibleH - topbarH - barH - allKeysH) + 'px';
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
  document.querySelectorAll('#topbar button, #bar button, #all-keys button').forEach(function(b){ b.tabIndex = -1; });

  document.getElementById('back').addEventListener('click', function(e){ e.preventDefault(); location.href = '/'; });

  document.getElementById('reset-term').addEventListener('click', function(e){
    e.preventDefault();
    try { term.reset(); } catch(err){}
    safeSend('\\x0c');
    term.focus();
  });

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
      if (seq != null && !safeSend(consumeMods(seq))) flashBtnFail(btn);
      term.focus();
    });
  });

  document.querySelectorAll('[data-char]').forEach(function(btn){
    btn.addEventListener('pointerdown', function(e){ e.preventDefault(); });
    btn.addEventListener('click', function(e){
      e.preventDefault();
      if (!safeSend(consumeMods(btn.dataset.char))) flashBtnFail(btn);
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

  // ---- Resize triggers ----
  addEventListener('resize', function(){ scheduleResize(); });
  addEventListener('orientationchange', function(){ scheduleResize(); });
  if (window.visualViewport){
    window.visualViewport.addEventListener('resize', function(){ scheduleResize(); });
    window.visualViewport.addEventListener('scroll', function(){ scheduleResize(); });
  }
  let pendingRefocus = false;
  function armRefocus(){
    if (pendingRefocus) return;
    pendingRefocus = true;
    function onUserTouch(){
      pendingRefocus = false;
      try { term.focus(); } catch(e){}
      document.removeEventListener('touchstart', onUserTouch, true);
      document.removeEventListener('mousedown', onUserTouch, true);
    }
    document.addEventListener('touchstart', onUserTouch, true);
    document.addEventListener('mousedown', onUserTouch, true);
  }
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden){
      ensureConnected();
      scheduleResize();
      try { term.focus(); } catch(e){}
      armRefocus();
    }
  });
  addEventListener('pageshow', function(){
    ensureConnected();
    scheduleResize();
    try { term.focus(); } catch(e){}
    armRefocus();
  });
})();
</script>
</body></html>`;
}

// ---------- auth ----------

const COOKIE_NAME = 'llmuxd_token';
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`);

function isLocalhost(req: IncomingMessage): boolean {
  const ra = req.socket.remoteAddress;
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  const cookie = req.headers['cookie'];
  if (typeof cookie === 'string') {
    const m = COOKIE_RE.exec(cookie);
    if (m) return decodeURIComponent(m[1] ?? '');
  }
  return undefined;
}

function extractWsToken(req: IncomingMessage, urlSearch: URLSearchParams): string | undefined {
  const fromQuery = urlSearch.get('token');
  if (fromQuery) return fromQuery;
  return extractToken(req);
}

function isAuthorized(req: IncomingMessage): boolean {
  if (isLocalhost(req)) return true;
  if (!authStore.authEnabled()) return true;
  return authStore.validateAuthToken(extractToken(req));
}

function isWsAuthorized(req: IncomingMessage, urlSearch: URLSearchParams): boolean {
  if (isLocalhost(req)) return true;
  if (!authStore.authEnabled()) return true;
  return authStore.validateAuthToken(extractWsToken(req, urlSearch));
}

function gatePage(reason: 'missing' | 'invalid'): string {
  const message =
    reason === 'invalid' ? 'Token rejected. Try again.' : 'This llmux daemon requires a token.';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llmux — auth</title>
<link rel="icon" href="${FAVICON_DATA_URL}">
<style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px}
  body{padding:24px;max-width:520px;margin:0 auto;min-height:100dvh;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center}
  h1{font-size:18px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em}
  .sub{color:#7a7f87;font-size:12px;margin-bottom:18px}
  .card{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:20px}
  label{display:block;font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:10px;font:13px ui-monospace,monospace;outline:none}
  input:focus{border-color:#2d4a66}
  button{margin-top:14px;width:100%;background:#1c2128;color:#7cc4ff;border:1px solid #2d4a66;border-radius:6px;padding:10px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  button:hover{background:#252b34}
  button:disabled{opacity:.5;cursor:wait}
  .msg{margin-top:12px;font-size:12px;color:#f85149;min-height:18px}
  .hint{margin-top:18px;font-size:11px;color:#7a7f87;line-height:1.5}
  .hint code{color:#c9d1d9;background:#0b0c10;padding:2px 5px;border-radius:3px}
</style></head>
<body>
<h1><span class="brand">LLMUX</span> — auth required</h1>
<div class="sub">${escapeHtml(message)}</div>
<div class="card">
  <form id="auth-form">
    <label for="token">access token</label>
    <input id="token" type="password" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="sas_…" required>
    <button type="submit">unlock</button>
    <div class="msg" id="msg"></div>
  </form>
  <div class="hint">
    Generate a token on the daemon host: <code>llmux token create</code><br>
    The token is sent as a cookie after unlock. Localhost bypasses this gate.
  </div>
</div>
<script>
(function(){
  const form = document.getElementById('auth-form');
  const input = document.getElementById('token');
  const msg = document.getElementById('msg');
  form.addEventListener('submit', async function(e){
    e.preventDefault();
    const token = input.value.trim();
    if (!token) return;
    msg.textContent = '';
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (!r.ok) {
        const body = await r.json().catch(function(){ return {}; });
        msg.textContent = body.error || 'token rejected';
        btn.disabled = false;
        input.focus();
        input.select();
        return;
      }
      // Cookie set by server; reload the originally requested URL so the
      // user lands where they wanted, not at /. Strip any stale ?token= from
      // the URL — if we left it, the canonical-url rule on the next request
      // would invalidate the cookie we just set (infinite gate loop).
      const params = new URLSearchParams(location.search);
      params.delete('token');
      const query = params.toString();
      location.href = location.pathname + (query ? '?' + query : '');
    } catch(err){
      msg.textContent = 'request failed: ' + (err.message || err);
      btn.disabled = false;
    }
  });
  input.focus();
})();
</script>
</body></html>`;
}

function sendGate(res: ServerResponse, reason: 'missing' | 'invalid' = 'missing'): void {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
  res.end(gatePage(reason));
}

function buildCookie(token: string): string {
  // Session cookie — clears on browser exit. HttpOnly so JS can't lift it.
  // SameSite=Lax so the cookie travels on normal navigations.
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---------- helpers ----------

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

// ---------- API actions ----------

function buildAgentCommand(
  agent: AgentDefinition,
  flagsOverride?: string,
  resumeFrom?: string,
): string {
  const flags = flagsOverride !== undefined ? flagsOverride : (agent.flags ?? '');
  const resumeFragment = resumeFrom && agent.history ? agent.history.resumeFlag(resumeFrom) : '';
  const tail = [flags, resumeFragment].filter((s) => s.length > 0).join(' ');
  return tail ? `${agent.cmd} ${tail}` : agent.cmd;
}

function viewOf(s: state.SessionState, live: boolean): SessionView {
  const agentDef = DEFAULT_AGENTS[s.agent];
  let conversationCount = 0;
  if (agentDef?.history) {
    try {
      conversationCount = agentDef.history.listConversations(s.cwd).length;
    } catch {
      conversationCount = 0;
    }
  }
  return {
    name: s.name,
    agent: s.agent,
    cwd: s.cwd,
    cwdDisplay: shortenCwd(s.cwd),
    ...(s.flags !== undefined ? { flags: s.flags } : {}),
    defaultFlags: agentDef?.flags ?? '',
    ...(s.env !== undefined ? { env: s.env } : {}),
    defaultEnv: agentDef?.envDefaults ?? {},
    ...(s.resumeFrom !== undefined ? { resumeFrom: s.resumeFrom } : {}),
    hasHistory: Boolean(agentDef?.history),
    conversationCount,
    createdAt: s.createdAt,
    parent: s.parent,
    status: live ? 'running' : 'exited',
  };
}

/**
 * Parse a multi-line "KEY=VALUE" text blob into Record<string, string>.
 * Skips blank lines and comments (lines starting with #). Trims whitespace
 * around the key. Value is kept verbatim after the first `=`.
 */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/** Serialize Record<string,string> back to a KEY=VALUE\n blob (stable key order). */
function serializeEnv(env: Record<string, string>): string {
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}

/** Merge order: agent defaults < session override < the LLMUX_* internals. */
function mergeSpawnEnv(agent: AgentDefinition, sessionEnv: Record<string, string> | undefined, llmuxEnv: Record<string, string>): Record<string, string> {
  return { ...(agent.envDefaults ?? {}), ...(sessionEnv ?? {}), ...llmuxEnv };
}

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function createSession(input: { agent: string; name?: string; cwd?: string; flags?: string; env?: string; resumeFrom?: string }):
  | { ok: true; session: SessionView }
  | { ok: false; error: string } {
  if (!input.agent) return { ok: false, error: 'agent is required' };
  const agentDef = DEFAULT_AGENTS[input.agent];
  if (!agentDef) return { ok: false, error: `unknown agent "${input.agent}"` };
  if (!isAgentInstalled(agentDef)) return { ok: false, error: `agent "${input.agent}" is not installed on the daemon host` };

  const name = (input.name && input.name.trim()) || agentDef.key;
  if (!SESSION_NAME_RE.test(name)) {
    return { ok: false, error: 'name must start alphanumeric and contain only letters, numbers, _ or -' };
  }
  if (state.get(name) || tmux.hasSession(name)) {
    return { ok: false, error: `session "${name}" already exists` };
  }

  const cwdRaw = (input.cwd && input.cwd.trim()) || process.env.HOME || process.cwd();
  const cwd = expandTilde(cwdRaw);
  if (!existsSync(cwd)) return { ok: false, error: `cwd does not exist: ${cwdRaw}` };

  // flags semantics:
  //   input.flags === undefined → no override; use agent default at spawn, don't persist
  //   input.flags === string    → explicit override, including empty string ("no flags")
  const flagsOverride: string | undefined =
    input.flags !== undefined ? input.flags.trim() : undefined;

  // env semantics: same model — undefined = no override; string = parse + persist.
  const envOverride: Record<string, string> | undefined =
    input.env !== undefined ? parseEnvText(input.env) : undefined;

  // resumeFrom: optional conversation id. Only valid if the agent has a
  // history adapter; otherwise we silently drop it (don't fail).
  const resumeFrom = input.resumeFrom && agentDef.history ? input.resumeFrom : undefined;

  try {
    tmux.newSession({
      name,
      command: buildAgentCommand(agentDef, flagsOverride, resumeFrom),
      cwd,
      env: mergeSpawnEnv(agentDef, envOverride, { LLMUX_SESSION: name, LLMUX_AGENT: agentDef.key }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const session: state.SessionState = {
    name,
    agent: agentDef.key,
    cwd,
    ...(flagsOverride !== undefined ? { flags: flagsOverride } : {}),
    ...(envOverride !== undefined ? { env: envOverride } : {}),
    ...(resumeFrom !== undefined ? { resumeFrom } : {}),
    createdAt: new Date().toISOString(),
    parent: null,
    restart: 'on-failure',
  };
  state.record(session);

  return { ok: true, session: viewOf(session, true) };
}

function respawnSession(name: string): { ok: true; session: SessionView } | { ok: false; error: string } {
  const session = state.get(name);
  if (!session) return { ok: false, error: `no tracked session "${name}"` };
  const agent = DEFAULT_AGENTS[session.agent];
  if (!agent) return { ok: false, error: `unknown agent "${session.agent}"` };
  if (!isAgentInstalled(agent)) return { ok: false, error: `agent "${session.agent}" is not installed` };
  // If still running, kill first so the new spawn picks up any name/cwd/flags
  // edits the operator has made since the last spawn.
  if (tmux.hasSession(name)) {
    try {
      tmux.killSession(name);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  try {
    tmux.newSession({
      name: session.name,
      command: buildAgentCommand(agent, session.flags, session.resumeFrom),
      cwd: session.cwd,
      env: mergeSpawnEnv(agent, session.env, { LLMUX_SESSION: session.name, LLMUX_AGENT: session.agent }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const refreshed: state.SessionState = { ...session, createdAt: new Date().toISOString() };
  state.record(refreshed);
  return { ok: true, session: viewOf(refreshed, true) };
}

function resumeConversation(
  name: string,
  conversationId: string,
): { ok: true; session: SessionView } | { ok: false; error: string } {
  const session = state.get(name);
  if (!session) return { ok: false, error: `no tracked session "${name}"` };
  const agent = DEFAULT_AGENTS[session.agent];
  if (!agent) return { ok: false, error: `unknown agent "${session.agent}"` };
  if (!agent.history) return { ok: false, error: `agent "${session.agent}" has no history adapter` };
  if (!isAgentInstalled(agent)) return { ok: false, error: `agent "${session.agent}" is not installed` };

  // Kill the live session if any — switching conversations is destructive to
  // the current in-process agent state by definition. State (name, cwd,
  // flags, env) is preserved across the respawn.
  if (tmux.hasSession(name)) {
    try {
      tmux.killSession(name);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    tmux.newSession({
      name: session.name,
      command: buildAgentCommand(agent, session.flags, conversationId),
      cwd: session.cwd,
      env: mergeSpawnEnv(agent, session.env, { LLMUX_SESSION: session.name, LLMUX_AGENT: session.agent }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const refreshed: state.SessionState = {
    ...session,
    resumeFrom: conversationId,
    createdAt: new Date().toISOString(),
  };
  state.record(refreshed);
  return { ok: true, session: viewOf(refreshed, true) };
}

function editSession(
  oldName: string,
  patch: { name?: string; cwd?: string; flags?: string; env?: string },
): { ok: true; session: SessionView } | { ok: false; error: string } {
  const session = state.get(oldName);
  if (!session) return { ok: false, error: `no tracked session "${oldName}"` };

  // Build the new record. Validate first, mutate last.
  const newName = patch.name?.trim();
  const newCwd = patch.cwd?.trim();

  if (newName !== undefined && newName !== oldName) {
    if (!SESSION_NAME_RE.test(newName)) {
      return { ok: false, error: 'name must start alphanumeric and contain only letters, numbers, _ or -' };
    }
    if (state.get(newName) || tmux.hasSession(newName)) {
      return { ok: false, error: `session "${newName}" already exists` };
    }
  }

  if (newCwd !== undefined && newCwd.length > 0 && !existsSync(expandTilde(newCwd))) {
    return { ok: false, error: `cwd does not exist: ${newCwd}` };
  }

  const renaming = newName !== undefined && newName !== oldName && newName.length > 0;

  if (renaming) {
    try {
      tmux.renameSession(oldName, newName!);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // flags semantics on patch:
  //   patch.flags === undefined → no change (preserve existing)
  //   patch.flags === string    → set as override (explicit, including '')
  // The form always sends flags so users can save "no flags" by clearing the
  // input. To revert to agent default, retype the default value.
  const nextFlags = patch.flags !== undefined ? patch.flags.trim() : session.flags;

  // env semantics: undefined → no change; string → parse + set as override
  // (including empty → empty override = "no extra env vars beyond the LLMUX_*").
  const nextEnv = patch.env !== undefined ? parseEnvText(patch.env) : session.env;

  const updated: state.SessionState = {
    name: renaming ? newName! : oldName,
    agent: session.agent,
    cwd: newCwd !== undefined && newCwd.length > 0 ? expandTilde(newCwd) : session.cwd,
    ...(nextFlags !== undefined ? { flags: nextFlags } : {}),
    ...(nextEnv !== undefined ? { env: nextEnv } : {}),
    ...(session.resumeFrom !== undefined ? { resumeFrom: session.resumeFrom } : {}),
    createdAt: session.createdAt,
    parent: session.parent,
    restart: session.restart,
  };

  if (renaming) state.forget(oldName);
  state.record(updated);

  // cwd is set at tmux fork time and can't be changed on a live session — the
  // operator's edit would otherwise be invisible until they manually respawn.
  // Auto kill+respawn when cwd actually changed and the session is running.
  const cwdChanged =
    newCwd !== undefined && newCwd.length > 0 && updated.cwd !== session.cwd;
  if (cwdChanged && tmux.hasSession(updated.name)) {
    const agent = DEFAULT_AGENTS[updated.agent];
    if (agent && isAgentInstalled(agent)) {
      try {
        tmux.killSession(updated.name);
        tmux.newSession({
          name: updated.name,
          command: buildAgentCommand(agent, updated.flags, updated.resumeFrom),
          cwd: updated.cwd,
          env: mergeSpawnEnv(agent, updated.env, { LLMUX_SESSION: updated.name, LLMUX_AGENT: updated.agent }),
        });
        // Refresh createdAt so the picker's "started Xm ago" reflects the
        // actual moment the agent process began running with the new cwd.
        const refreshed: state.SessionState = { ...updated, createdAt: new Date().toISOString() };
        state.record(refreshed);
        return { ok: true, session: viewOf(refreshed, true) };
      } catch (err) {
        return { ok: false, error: `cwd updated but restart failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  const live = tmux.listSessions().some((s) => s.name === updated.name);
  return { ok: true, session: viewOf(updated, live) };
}

function killSession(name: string): { ok: true; status: 'running' | 'exited' } | { ok: false; error: string } {
  const session = state.get(name);
  if (!session) return { ok: false, error: `no tracked session "${name}"` };
  const wasRunning = tmux.hasSession(name);
  try {
    tmux.killSession(name);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  state.forget(name);
  return { ok: true, status: wasRunning ? 'running' : 'exited' };
}

// ---------- server ----------

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

const RESPAWN_RE = /^\/api\/sessions\/([^/]+)\/respawn$/;
const KILL_RE = /^\/api\/sessions\/([^/]+)\/kill$/;
const RESUME_RE = /^\/api\/sessions\/([^/]+)\/resume$/;
const SEND_RE = /^\/api\/sessions\/([^/]+)\/send$/;
const CONVERSATIONS_RE = /^\/api\/sessions\/([^/]+)\/conversations$/;
const EDIT_RE = /^\/api\/sessions\/([^/]+)$/;

export function startServer(opts: ServeOptions): ServerHandle {
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    // ---- Deep-link auth: ?token=<sas> on any path ----
    // When ?token= is present, the URL is canonical — it overrides any existing
    // cookie. Valid → 302 + set cookie + clean redirect. Invalid → clear the
    // cookie (so a stale prior session doesn't mask the rejection) + serve the
    // gate so the test is visible.
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      if (authStore.validateAuthToken(queryToken)) {
        url.searchParams.delete('token');
        const cleanPath = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
        res.writeHead(302, {
          location: cleanPath,
          'set-cookie': buildCookie(queryToken),
        });
        return res.end();
      }
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      });
      return res.end(gatePage('invalid'));
    }

    // ---- Always-open endpoints (no auth required) ----
    if (url.pathname === '/health') {
      return sendJson(res, {
        ok: true,
        version: DAEMON_VERSION,
        sessions: state.list().length,
        authEnabled: authStore.authEnabled(),
      });
    }
    if (url.pathname === '/api/version' && method === 'GET') {
      return sendJson(res, { version: DAEMON_VERSION });
    }

    // ---- Auth gate (POST /api/auth, no prior auth required) ----
    if (url.pathname === '/api/auth' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { token?: unknown };
        const candidate = typeof body.token === 'string' ? body.token : '';
        if (!authStore.validateAuthToken(candidate)) {
          return sendJson(res, { ok: false, error: 'invalid token' }, 401);
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': buildCookie(candidate),
        });
        return res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
      }
    }

    // ---- Auth check for everything else ----
    if (!isAuthorized(req)) {
      // HTML routes get the gate page; API routes get 401 JSON.
      const isApi = url.pathname.startsWith('/api/');
      if (isApi) {
        return sendJson(res, { ok: false, error: 'unauthorized' }, 401);
      }
      const hasInvalidToken = Boolean(extractToken(req));
      return sendGate(res, hasInvalidToken ? 'invalid' : 'missing');
    }

    // ---- API ----
    if (url.pathname === '/api/sessions' && method === 'GET') {
      return sendJson(res, listSessionViews());
    }
    if (url.pathname === '/api/agents' && method === 'GET') {
      const installed = Object.entries(DEFAULT_AGENTS)
        .filter(([, def]) => isAgentInstalled(def))
        .map(([key, def]) => ({
          key,
          displayName: def.displayName,
          cmd: def.cmd,
          flags: def.flags ?? '',
          envDefaults: def.envDefaults ?? {},
        }));
      return sendJson(res, installed);
    }
    if (url.pathname === '/api/agents/all' && method === 'GET') {
      const all = Object.entries(DEFAULT_AGENTS).map(([key, def]) => ({
        key,
        displayName: def.displayName,
        cmd: def.cmd,
        installed: isAgentInstalled(def),
        installHint: def.installHint ?? '',
        docsUrl: def.docsUrl ?? '',
      }));
      return sendJson(res, all);
    }
    if (url.pathname === '/api/sessions' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { agent?: unknown; name?: unknown; cwd?: unknown; flags?: unknown; env?: unknown; resumeFrom?: unknown };
        const result = createSession({
          agent: typeof body.agent === 'string' ? body.agent : '',
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          ...(typeof body.flags === 'string' ? { flags: body.flags } : {}),
          ...(typeof body.env === 'string' ? { env: body.env } : {}),
          ...(typeof body.resumeFrom === 'string' ? { resumeFrom: body.resumeFrom } : {}),
        });
        return sendJson(res, result, result.ok ? 200 : 400);
      } catch (err) {
        return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
      }
    }
    if (method === 'POST') {
      const mRespawn = url.pathname.match(RESPAWN_RE);
      if (mRespawn) {
        const name = decodeURIComponent(mRespawn[1]!);
        const result = respawnSession(name);
        return sendJson(res, result, result.ok ? 200 : 400);
      }
      const mKill = url.pathname.match(KILL_RE);
      if (mKill) {
        const name = decodeURIComponent(mKill[1]!);
        const result = killSession(name);
        return sendJson(res, result, result.ok ? 200 : 400);
      }
      const mSend = url.pathname.match(SEND_RE);
      if (mSend) {
        const name = decodeURIComponent(mSend[1]!);
        try {
          const body = (await readJsonBody(req)) as { prompt?: unknown; enter?: unknown };
          if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
            return sendJson(res, { ok: false, error: 'prompt required' }, 400);
          }
          if (!state.get(name)) return sendJson(res, { ok: false, error: `no tracked session "${name}"` }, 404);
          if (!tmux.hasSession(name)) return sendJson(res, { ok: false, error: `session "${name}" is not running` }, 409);
          const enter = body.enter !== false; // default true; explicitly false to suppress
          try {
            tmux.sendKeys(name, body.prompt, { enter });
          } catch (err) {
            return sendJson(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
          }
          return sendJson(res, { ok: true });
        } catch (err) {
          return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
        }
      }
      const mResume = url.pathname.match(RESUME_RE);
      if (mResume) {
        const name = decodeURIComponent(mResume[1]!);
        try {
          const body = (await readJsonBody(req)) as { conversationId?: unknown };
          if (typeof body.conversationId !== 'string' || body.conversationId.length === 0) {
            return sendJson(res, { ok: false, error: 'conversationId required' }, 400);
          }
          const result = resumeConversation(name, body.conversationId);
          return sendJson(res, result, result.ok ? 200 : 400);
        } catch (err) {
          return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
        }
      }
    }
    if (method === 'GET') {
      const mConvs = url.pathname.match(CONVERSATIONS_RE);
      if (mConvs) {
        const name = decodeURIComponent(mConvs[1]!);
        const session = state.get(name);
        if (!session) return sendJson(res, { ok: false, error: 'session not found' }, 404);
        const agent = DEFAULT_AGENTS[session.agent];
        if (!agent?.history) return sendJson(res, []);
        try {
          const convs: Conversation[] = agent.history.listConversations(session.cwd);
          return sendJson(res, convs);
        } catch (err) {
          return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'history read failed' }, 500);
        }
      }
    }
    if (method === 'PATCH') {
      const mEdit = url.pathname.match(EDIT_RE);
      if (mEdit) {
        const name = decodeURIComponent(mEdit[1]!);
        try {
          const body = (await readJsonBody(req)) as { name?: unknown; cwd?: unknown; flags?: unknown; env?: unknown };
          const result = editSession(name, {
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
            ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
            ...(typeof body.flags === 'string' ? { flags: body.flags } : {}),
            ...(typeof body.env === 'string' ? { env: body.env } : {}),
          });
          return sendJson(res, result, result.ok ? 200 : 400);
        } catch (err) {
          return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
        }
      }
    }

    // ---- Pages ----
    if (url.pathname === '/') {
      return sendHtml(res, pickerPage());
    }
    if (url.pathname.startsWith('/session/')) {
      const name = decodeURIComponent(url.pathname.slice('/session/'.length));
      const session = state.get(name);
      if (!session) return sendText(res, 'session not found', 404);
      // If tmux doesn't have it, serve the dead-session page instead of the chat
      // (which would immediately disconnect when pty.spawn('tmux attach …') fails).
      if (!tmux.hasSession(name)) {
        return sendHtml(res, deadSessionPage(viewOf(session, false)));
      }
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
    if (!isWsAuthorized(req, url.searchParams)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const name = decodeURIComponent(url.pathname.slice('/ws/'.length));
    if (!state.get(name)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!tmux.hasSession(name)) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
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
    ws.close(4040, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
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
      // 4040 is our app-level "session ended" signal (4xxx is application range)
      // so the client distinguishes it from a transient network drop.
      ws.close(4040, `pty exited code=${exitCode} signal=${signal ?? 'none'}`);
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
  console.log(`llmux v${DAEMON_VERSION}\n`);
  const addrs = getAddresses(port);
  const width = Math.max(10, ...addrs.map((a) => a.label.length + 2));
  for (const addr of addrs) {
    console.log(`  ▸ ${addr.label.padEnd(width)}${addr.url}`);
  }
  if (authStore.authEnabled()) {
    const count = authStore.listAuthTokens().length;
    console.log(`\n  ✓ auth required — ${count} active token${count === 1 ? '' : 's'} (localhost bypasses)\n`);
  } else {
    console.log(`\n  ⚠ running without auth — anyone on the network can attach.`);
    console.log(`    create a token with \`llmux token create\` to enable auth.\n`);
  }
}
