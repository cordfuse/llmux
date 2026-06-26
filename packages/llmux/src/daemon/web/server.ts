import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tryV2Route, initV2Routes, getV2User } from '../v2-routes.ts';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import * as pty from 'node-pty';
import QRCode from 'qrcode';
import * as logBuffer from '../log-buffer.ts';
import * as turnqIntegration from '../turnq-integration.ts';
import type { IPty } from 'node-pty';
import { DEFAULT_AGENTS, isAgentInstalled, type AgentDefinition, type Conversation } from '../agents.ts';
import * as state from '../state.ts';
import * as tmux from '../tmux.ts';
import * as authStore from '../auth-store.ts';
import { getAddresses } from '../net.ts';
import { loadConfig, loadOverride, overridePath, saveOverride, type LlmuxConfig, type TurnqConfig } from '../config.ts';

function readDaemonVersion(): string {
  // Resolve package.json relative to this source file so the version stays
  // accurate whether running from src/ (bun) or dist/ (npm install -g).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      resolve(here, '../../package.json'),    // built dist/ layout
      resolve(here, '../package.json'),       // alternative built layout
      resolve(here, './package.json'),        // single-file build
      resolve(here, '../../../package.json'), // src/daemon/web/ → packages/llmux/ (tsx-source mode)
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
  /** Loaded YAML config. Surfaced by /api/settings; defaults to whatever
   *  `loadConfig()` returns if the caller doesn't pass anything. The server
   *  treats this as the boot snapshot — on overlay writes through
   *  PUT /api/settings/* it re-reads with `loadConfig()` so subsequent
   *  reads (and the WebSocket attach path's turnq config lookup) reflect
   *  the new state. */
  config?: LlmuxConfig;
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
  /**
   * Title of the conversation pointed to by `resumeFrom`, resolved by the
   * adapter's optional lookupTitle() at view-of time. Undefined when the
   * conversation can't be found (deleted, archived, never existed) — the
   * UI falls back to a truncated id.
   */
  resumeFromTitle?: string;
  /** Per-session init prompts (combined with daemon.initPrompts at next respawn). */
  initPrompts?: string[];
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

// Brand mark: bracketed monogram `{Lm}` rendered in monospace, sky-blue
// (#7cc4ff) on dark navy (#0b0c10). Matches the visual language of the
// Cordfuse PWA family ({Vz}, etc.) with llmux's own palette. Vector source
// is shared by the favicon, apple-touch-icon, and the PWA install icons
// (192/512) — browsers scale the SVG natively.
const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="90" ry="90" fill="#0b0c10"/><rect x="1.5" y="1.5" width="509" height="509" rx="89" ry="89" fill="none" stroke="#7cc4ff" stroke-width="1.5" stroke-opacity="0.22"/><text x="256" y="236" text-anchor="middle" dominant-baseline="central" font-family="'Noto Sans Mono', 'Courier New', monospace" font-size="185" font-weight="700" fill="#7cc4ff" letter-spacing="-3">{Lm}</text></svg>`;
const FAVICON_SVG = BRAND_SVG;
const FAVICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

// PWA support was removed in v0.16.3 — Chrome on Android bundles each
// installed PWA into a WebAPK whose package name is derived from the
// hostname only (port is ignored). Multiple Cordfuse PWAs on the same
// tailnet host can't coexist as installs. Operators add the URL as a
// Chrome bookmark / home-screen shortcut instead. `BRAND_SVG` is still
// used as the browser-tab favicon.

// ---------- shared drawer ----------

// Single source of truth for the nav-drawer markup, shared between the
// picker page and the orchestration page. Items with data-page are
// captured by per-page JS (picker = SPA tab flip; orch = localStorage
// write + redirect to /). Items with only href are real navigations
// (Account, Users — they go to dedicated v2 pages).
function renderNavDrawer(host: string, activeId: string): string {
  const items = [
    { id: 'sessions', icon: '▦', label: 'Chat', dataPage: 'sessions' },
    { id: 'tokens',   icon: '⚿', label: 'Tokens', dataPage: 'tokens' },
    { id: 'agents',   icon: '⌬', label: 'Agents', dataPage: 'agents' },
    { id: 'logs',     icon: '▤', label: 'Logs', dataPage: 'logs' },
    { id: 'settings', icon: '⚙', label: 'Settings', dataPage: 'settings' },
    { id: 'account',  icon: '◉', label: 'Account', href: '/account' },
    { id: 'users',    icon: '☷', label: 'Users', href: '/admin/users' },
    { id: 'about',    icon: 'ⓘ', label: 'About', dataPage: 'about' },
  ];
  const links = items.map(it => {
    const active = it.id === activeId ? ' class="active"' : '';
    const attrs: string[] = [];
    if (it.href) attrs.push(`href="${it.href}"`);
    if (it.dataPage) attrs.push(`data-page="${it.dataPage}"`);
    return `    <a${attrs.length ? ' ' + attrs.join(' ') : ''}${active}><span class="nav-icon">${it.icon}</span>${it.label}</a>`;
  }).join('\n');
  return `<div id="nav-backdrop" aria-hidden="true"></div>
<aside id="nav-drawer" aria-hidden="true">
  <div class="nav-header">
    <span class="nav-brand">LLMUX</span>
    <span class="nav-host">${escapeHtml(host)}</span>
  </div>
  <nav>
${links}
  </nav>
  <div class="nav-footer">
    <span>v${escapeHtml(DAEMON_VERSION)}</span>
  </div>
</aside>`;
}

// ---------- pages ----------

function pickerPage(): string {
  const sessions = listSessionViews();
  const host = hostname();
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llmux on ${escapeHtml(host)} · Chat</title>
<link rel="icon" href="${FAVICON_DATA_URL}">
<link rel="apple-touch-icon" href="${FAVICON_DATA_URL}">
<meta name="theme-color" content="#0b0c10">
<style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px;overflow-x:hidden}
  body{padding:18px 16px 80px;max-width:980px;margin:0 auto;box-sizing:border-box}
  header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  h1{font-size:18px;margin:0}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em;font-weight:600}
  h1 .host{color:#a371f7;font-weight:500}
  #nav-toggle{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:18px;line-height:1;margin-right:10px;flex:0 0 auto;transition:background 150ms ease,border-color 150ms ease}
  #nav-toggle:hover{background:#252b34;border-color:#3a414b}
  #nav-toggle:active{transform:scale(.94)}
  /* Two-row header: controls (hamburger + meta) on row 1, title on row 2.
     Keeps the h1 from being crushed between the hamburger and the "+ new
     session" button on portrait phones. */
  header{flex-direction:column;align-items:stretch;gap:8px}
  header .header-controls{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  #nav-drawer{position:fixed;top:0;left:-300px;width:280px;height:100dvh;background:#0e1116;border-right:1px solid #1f2329;transition:left 220ms ease;z-index:55;padding:18px 0;box-sizing:border-box;display:flex;flex-direction:column}
  #nav-drawer.open{left:0}
  #nav-backdrop{position:fixed;inset:0;background:rgba(11,12,16,.55);z-index:54;opacity:0;visibility:hidden;transition:opacity 180ms ease,visibility 0s 180ms}
  #nav-backdrop.show{opacity:1;visibility:visible;transition:opacity 180ms ease}
  #nav-drawer .nav-header{padding:0 20px 16px;border-bottom:1px solid #1f2329;display:flex;flex-direction:column;gap:4px}
  #nav-drawer .nav-brand{color:#7cc4ff;font-weight:600;letter-spacing:.08em;font-size:15px}
  #nav-drawer .nav-host{color:#a371f7;font-size:12px}
  #nav-drawer nav{flex:1;display:flex;flex-direction:column;padding:8px 0;overflow-y:auto}
  #nav-drawer a{display:flex;align-items:center;gap:10px;padding:12px 20px;color:#c9d1d9;text-decoration:none;font-size:14px;border-left:3px solid transparent;cursor:pointer}
  #nav-drawer a:hover{background:#11141a}
  #nav-drawer a.active{border-left-color:#7cc4ff;color:#7cc4ff;background:#11141a}
  #nav-drawer a .nav-icon{font-size:16px;width:20px;text-align:center;color:inherit}
  #nav-drawer .nav-footer{padding:10px 20px 0;border-top:1px solid #1f2329;font-size:11px;color:#7a7f87;display:flex;justify-content:space-between;align-items:center}
  .page{display:none;padding-bottom:56px}
  .page.active{display:block}
  .tokens-toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .tokens-toolbar button{background:#1c2128;color:#7cc4ff;border:1px solid #2d4a66;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  .tokens-toolbar button.danger{color:#f85149;border-color:#4a2329}
  .tokens-toolbar button:hover:not(:disabled){background:#252b34}
  .tokens-toolbar button:disabled{opacity:.4;cursor:not-allowed}
  #page-tokens .token-actions{text-align:right;white-space:nowrap}
  #page-tokens .token-actions button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:6px 10px;font:12px ui-monospace,monospace;cursor:pointer;margin-left:6px;transition:background 150ms ease,border-color 150ms ease}
  #page-tokens .token-actions button.danger{color:#f85149;border-color:#4a2329}
  #page-tokens .token-actions button:hover{background:#252b34;border-color:#3a414b}
  #page-tokens .token-actions button.danger:hover{background:#2a1c1f}
  #page-tokens .token-actions button:active{transform:scale(.95)}
  #page-tokens .token-id{font-family:ui-monospace,monospace;color:#7cc4ff;font-size:12px;word-break:break-all}
  #page-tokens .token-name{font-weight:500;word-break:break-word}
  #page-tokens .token-name .unnamed{color:#7a7f87;font-style:italic;font-weight:normal}
  #page-tokens .token-when{color:#9aa0a6;font-size:11px}
  #page-tokens .token-expired{color:#f0883e;font-size:11px}
  /* Mobile: collapse the token table — drop expires col, tighten padding,
     stack action buttons vertically so they don't crowd against the data. */
  @media (max-width:600px){
    #page-tokens table th:nth-child(4),#page-tokens table td:nth-child(4){display:none}
    #page-tokens table th,#page-tokens table td{padding:8px 6px;font-size:12px}
    #page-tokens .token-actions{padding-left:0}
    #page-tokens .token-actions button{display:block;width:100%;margin:4px 0 0;padding:7px 8px}
    #page-tokens .token-actions button:first-child{margin-top:0}
  }
  #token-create-form{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:14px;margin-bottom:14px;display:none}
  #token-create-form.open{display:block}
  #token-create-form h3{margin:0 0 12px;font-size:13px;color:#c9d1d9;font-weight:600}
  #token-create-form .field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
  #token-create-form label{font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em}
  #token-create-form input{background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 10px;font:13px ui-monospace,monospace;outline:none;width:100%;box-sizing:border-box}
  #token-create-form input:focus{border-color:#2d4a66}
  #token-create-form .actions{display:flex;gap:8px;justify-content:flex-end}
  #token-create-form button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #token-create-form button.primary{color:#7cc4ff;border-color:#2d4a66}
  #token-secret-modal{position:fixed;inset:0;background:rgba(11,12,16,.85);display:flex;align-items:center;justify-content:center;z-index:60;padding:20px;opacity:0;visibility:hidden;transition:opacity 160ms ease,visibility 0s 160ms}
  #token-secret-modal.open{opacity:1;visibility:visible;transition:opacity 160ms ease}
  #token-secret-modal .panel{background:#11141a;border:1px solid #1f2329;border-radius:10px;padding:22px;max-width:460px;width:100%;transform:translateY(8px) scale(.97);transition:transform 200ms ease}
  #token-secret-modal.open .panel{transform:translateY(0) scale(1)}
  #token-secret-modal h3{margin:0 0 6px;font-size:15px;color:#7ee787}
  #token-secret-modal .warn{margin:0 0 14px;font-size:12px;color:#d29922}
  #token-secret-modal label{display:block;font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 4px}
  #token-secret-modal .secret-value{font-family:ui-monospace,monospace;background:#0b0c10;color:#7ee787;padding:10px 12px;border:1px solid #1f4528;border-radius:6px;word-break:break-all;font-size:12px;cursor:pointer}
  #token-secret-modal .secret-value:hover{background:#0d1f10}
  #token-secret-modal .pair-url{font-family:ui-monospace,monospace;background:#0b0c10;color:#7cc4ff;padding:10px 12px;border:1px solid #2d4a66;border-radius:6px;word-break:break-all;font-size:11px;cursor:pointer}
  #token-secret-modal .pair-url:hover{background:#11141a}
  #token-secret-qr-wrap{display:none;flex-direction:column;align-items:center;gap:6px;margin-bottom:14px}
  #token-secret-qr-wrap.show{display:flex}
  #token-secret-qr svg{display:block;width:200px;height:200px;background:#0b0c10;border:1px solid #1f2329;border-radius:6px;padding:8px}
  #token-secret-modal .copy-hint{font-size:10px;color:#7a7f87;margin-top:4px}
  #token-secret-modal .actions{display:flex;justify-content:flex-end;margin-top:18px}
  #token-secret-modal button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #token-secret-modal button.primary{color:#7cc4ff;border-color:#2d4a66}
  #about-grid{display:grid;grid-template-columns:1fr;gap:14px}
  .about-card{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:16px}
  .about-card h3{margin:0 0 10px;font-size:13px;color:#7cc4ff;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
  .about-card .kv{display:flex;justify-content:space-between;gap:14px;padding:6px 0;border-bottom:1px solid #1f2329;font-size:13px}
  .about-card .kv:last-child{border-bottom:none}
  .about-card .kv .key{color:#9aa0a6}
  .about-card .kv .val{color:#e6e8eb;font-family:ui-monospace,monospace;text-align:right;word-break:break-word}
  .about-card .kv .val.host{color:#a371f7}
  .about-card .kv .val.version{color:#7cc4ff}
  @media (min-width:601px){
    #about-grid{grid-template-columns:1fr 1fr}
    #settings-grid{grid-template-columns:1fr 1fr}
  }
  #settings-grid{display:grid;grid-template-columns:1fr;gap:14px}
  /* min-width:0 lets the grid item shrink to its cell instead of expanding
     to fit overflowing children — the YAML pre's long lines were widening
     the card past the viewport, pushing every kv val off the right edge. */
  #settings-grid .about-card{box-sizing:border-box;min-width:0;overflow:hidden}
  #settings-grid .about-card .kv{align-items:baseline;gap:12px;flex-wrap:wrap}
  #settings-grid .about-card .kv .val{min-width:0;flex:1 1 auto;overflow-wrap:anywhere;word-break:break-word}
  #settings-grid .yaml-blob{margin:0;padding:10px 12px;background:#0b0c10;color:#7ee787;border:1px solid #1f2329;border-radius:6px;font:11px ui-monospace,monospace;line-height:1.5;overflow-x:auto;white-space:pre;max-height:280px;max-width:100%;box-sizing:border-box}
  #settings-grid .settings-init-sub{margin:0 0 10px;font-size:11px;color:#9aa0a6;line-height:1.5}
  #settings-grid .settings-init-sub code{color:#c9d1d9;background:#0b0c10;padding:1px 5px;border-radius:3px}
  #settings-grid #settings-daemon-init{display:flex;flex-direction:column;gap:8px}
  #settings-grid #settings-daemon-init .empty{color:#7a7f87;font-style:italic;font-size:12px;padding:8px 12px;background:#0b0c10;border:1px dashed #1f2329;border-radius:6px}
  #settings-grid #settings-daemon-init .prompt{background:#0b0c10;border:1px solid #1f2329;border-radius:6px;padding:8px 10px;font:11px ui-monospace,monospace;color:#c9d1d9;white-space:pre-wrap;word-break:break-word;line-height:1.5}
  #settings-grid #settings-daemon-init .prompt-idx{color:#7cc4ff;font-size:10px;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  #settings-grid .about-card.editable{padding-bottom:14px}
  #settings-grid .settings-input{flex:1 1 160px;min-width:0;background:#0b0c10;color:#c9d1d9;border:1px solid #1f2329;border-radius:4px;padding:6px 8px;font:12px ui-monospace,monospace;box-sizing:border-box}
  #settings-grid .settings-input:focus{outline:none;border-color:#388bfd}
  #settings-grid .settings-input::placeholder{color:#5a6068}
  #settings-grid label.toggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer;color:#c9d1d9;font-size:12px}
  #settings-grid label.toggle input{margin:0}
  #settings-grid textarea#settings-daemon-init-input{width:100%;min-height:90px;background:#0b0c10;color:#c9d1d9;border:1px solid #1f2329;border-radius:6px;padding:8px 10px;font:11px ui-monospace,monospace;box-sizing:border-box;resize:vertical;line-height:1.5}
  #settings-grid textarea#settings-daemon-init-input:focus{outline:none;border-color:#388bfd}
  #settings-grid .settings-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px}
  #settings-grid .settings-status{font-size:11px;color:#7a7f87;flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
  #settings-grid .settings-status.ok{color:#7ee787}
  #settings-grid .settings-status.err{color:#ff7b72}
  /* Match the rest of the app's primary-button style (subtle sky-blue text
     on dark bg with sky-blue border) — was an outlier with solid #388bfd. */
  #settings-grid .settings-save{background:#1c2128;color:#7cc4ff;border:1px solid #2d4a66;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer;transition:background 150ms ease,border-color 150ms ease}
  #settings-grid .settings-save:hover:not(:disabled){background:#11141a;border-color:#3e6082}
  #settings-grid .settings-save:active{transform:scale(.96)}
  #settings-grid .settings-save:disabled{opacity:.4;cursor:not-allowed}
  #settings-grid .overlay-badge{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#0b0c10;background:#7cc4ff;padding:2px 8px;border-radius:10px;margin-left:8px;vertical-align:middle}
  .agents-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;font-size:12px;color:#9aa0a6;flex-wrap:wrap;gap:10px}
  .agents-bar #agents-summary{color:#c9d1d9}
  .agents-toggle label{display:flex;align-items:center;gap:6px;cursor:pointer}
  .agents-toggle input{width:16px;height:16px;accent-color:#7cc4ff;margin:0}
  #page-agents .agent-row{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:14px 16px;margin-bottom:10px}
  #page-agents .agent-row.missing{opacity:.65}
  #page-agents .agent-head{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
  #page-agents .agent-name{font-weight:600;color:#e6e8eb;font-size:14px}
  #page-agents .agent-key{font-family:ui-monospace,monospace;color:#7a7f87;font-size:11px}
  #page-agents .agent-status{font-size:10px;padding:2px 7px;border-radius:3px;border:1px solid;letter-spacing:.04em;text-transform:uppercase}
  #page-agents .agent-status.ok{color:#7ee787;border-color:#235828;background:#0d1f10}
  #page-agents .agent-status.miss{color:#7a7f87;border-color:#262c34;background:#0e1116}
  #page-agents .agent-running{color:#7cc4ff;font-size:11px;margin-left:auto}
  #page-agents .agent-install{font:11px ui-monospace,monospace;color:#c9d1d9;background:#0b0c10;border:1px solid #1f2329;border-radius:4px;padding:6px 8px;margin-top:4px;word-break:break-all;cursor:pointer;transition:background 150ms ease}
  #page-agents .agent-install:hover{background:#11141a}
  #page-agents .agent-docs{font-size:11px;color:#7cc4ff;text-decoration:none;margin-top:6px;display:inline-block}
  #page-agents .agent-docs:hover{text-decoration:underline}
  .logs-toolbar{display:flex;gap:10px;align-items:center;margin-bottom:10px;padding:8px 10px;background:#11141a;border:1px solid #1f2329;border-radius:8px;flex-wrap:wrap;font-size:12px}
  .logs-toolbar select{background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:5px 8px;font:12px ui-monospace,monospace;cursor:pointer}
  .logs-toolbar .logs-autoscroll{display:flex;align-items:center;gap:6px;color:#9aa0a6;cursor:pointer}
  .logs-toolbar .logs-autoscroll input{width:16px;height:16px;accent-color:#7cc4ff;margin:0}
  .logs-toolbar #logs-status{color:#7a7f87;font-size:11px;margin-left:auto}
  .logs-toolbar #logs-status.live{color:#7ee787}
  .logs-toolbar #logs-status.offline{color:#f85149}
  .logs-toolbar #logs-clear{background:#1c2128;color:#9aa0a6;border:1px solid #262c34;border-radius:6px;padding:5px 10px;font:11px ui-monospace,monospace;cursor:pointer}
  .logs-toolbar #logs-clear:hover{background:#252b34;color:#e6e8eb}
  #logs-view{background:#0b0c10;border:1px solid #1f2329;border-radius:8px;padding:10px 12px;font:11px ui-monospace,monospace;height:calc(100dvh - 280px);min-height:280px;overflow-y:auto;line-height:1.5}
  #logs-view .log-line{display:flex;gap:8px;padding:2px 0;white-space:pre-wrap;word-break:break-all}
  #logs-view .log-line .ts{color:#7a7f87;flex:0 0 auto}
  #logs-view .log-line .lvl{flex:0 0 auto;width:46px;text-align:right;text-transform:uppercase;font-size:10px;padding-top:1px}
  #logs-view .log-line .txt{flex:1 1 auto;color:#e6e8eb}
  #logs-view .log-line.info .lvl{color:#7a7f87}
  #logs-view .log-line.warn .lvl{color:#d29922}
  #logs-view .log-line.warn .txt{color:#f0c478}
  #logs-view .log-line.error .lvl{color:#f85149}
  #logs-view .log-line.error .txt{color:#ff8a80}
  #logs-view .log-empty{color:#7a7f87;font-style:italic;padding:6px 0}
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
  .resumed-from{color:#a371f7;font-size:11px;margin-top:2px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
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
  .actions button.toggle[data-status="running"]{color:#f0883e;border-color:#4a3019}
  .actions button.toggle[data-status="exited"]{color:#7ee787;border-color:#1f4528}
  .actions button .icon{font-size:13px;line-height:1;display:inline-block;vertical-align:middle}
  .actions button:disabled{opacity:.5;cursor:wait}
  #bulk-toolbar{display:flex;gap:6px;align-items:center;margin-bottom:10px;padding:8px 10px;background:#11141a;border:1px solid #1f2329;border-radius:8px;flex-wrap:wrap}
  #bulk-toolbar .bulk-action-row{display:flex;gap:6px;flex:1;min-width:0;align-items:center}
  #bulk-toolbar button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:6px 12px;font:12px ui-monospace,monospace;cursor:pointer;transition:background 150ms ease,border-color 150ms ease;flex:0 0 auto}
  /* Portrait phones: 6 buttons can't fit one row at any readable size.
     Column layout — button row scrolls horizontally (swipe to see Kill),
     count chip drops to its own row below. Box-sizing + width:100% on
     every column item so they CAN'T expand past the toolbar's width,
     which previously let the row's intrinsic button-sum widen the whole
     toolbar past the viewport (Kill button + "N selected" chip both got
     cut off the right edge of the fold). */
  @media (max-width:600px){
    #bulk-toolbar{flex-direction:column;align-items:stretch;gap:6px;padding:6px 8px;flex-wrap:nowrap;box-sizing:border-box;width:100%;max-width:100%}
    #bulk-toolbar .bulk-action-row{overflow-x:auto;flex-wrap:nowrap;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:2px;width:100%;max-width:100%;min-width:0;flex:0 0 auto;box-sizing:border-box}
    #bulk-toolbar .bulk-action-row::-webkit-scrollbar{display:none}
    #bulk-toolbar button{padding:4px 8px;font-size:11px}
    #bulk-count{flex-basis:auto;margin-left:0;text-align:right;padding-top:0;width:100%;box-sizing:border-box}
  }
  #bulk-toolbar button:hover:not(:disabled){background:#252b34;border-color:#3a414b}
  #bulk-toolbar button.new{color:#7cc4ff;border-color:#2d4a66}
  #bulk-toolbar button.start{color:#7ee787;border-color:#1f4528}
  #bulk-toolbar button.stop{color:#f0883e;border-color:#4a3019}
  #bulk-toolbar button.respawn{color:#7cc4ff;border-color:#2d4a66}
  #bulk-toolbar button.kill{color:#f85149;border-color:#4a2329}
  #bulk-toolbar button.broadcast{color:#a371f7;border-color:#3c2a59}
  .actions button.send-btn{color:#a371f7;border-color:#3c2a59}
  #sessions-filter{display:flex;gap:6px;align-items:center;margin-bottom:10px}
  #sessions-filter input{flex:1;background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:7px 10px;font:13px ui-monospace,monospace;outline:none}
  #sessions-filter input:focus{border-color:#2d4a66}
  #sessions-filter button{background:#1c2128;color:#9aa0a6;border:1px solid #262c34;border-radius:6px;padding:7px 10px;font:11px ui-monospace,monospace;cursor:pointer}
  #sessions-filter button:hover{background:#252b34;color:#e6e8eb}
  #prompt-modal{position:fixed;inset:0;background:rgba(11,12,16,.85);display:flex;align-items:flex-end;justify-content:center;z-index:62;padding:0;opacity:0;visibility:hidden;transition:opacity 160ms ease,visibility 0s 160ms}
  #prompt-modal.open{opacity:1;visibility:visible;transition:opacity 160ms ease}
  #prompt-modal .panel{background:#11141a;border:1px solid #1f2329;border-top-left-radius:12px;border-top-right-radius:12px;padding:18px 20px 20px;max-width:520px;width:100%;transform:translateY(20px);transition:transform 200ms ease;box-sizing:border-box}
  #prompt-modal.open .panel{transform:translateY(0)}
  #prompt-modal h3{margin:0 0 4px;font-size:14px;color:#e6e8eb}
  #prompt-modal .sub{margin:0 0 10px;font-size:11px;color:#7a7f87}
  #prompt-modal textarea{width:100%;box-sizing:border-box;background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:10px 12px;font:13px ui-monospace,monospace;outline:none;resize:vertical;min-height:90px}
  #prompt-modal textarea:focus{border-color:#2d4a66}
  #prompt-modal .opts{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#9aa0a6}
  #prompt-modal .opts input{width:16px;height:16px;accent-color:#7cc4ff;margin:0}
  #prompt-modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
  #prompt-modal button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:9px 18px;font:13px ui-monospace,monospace;cursor:pointer}
  #prompt-modal button.primary{color:#a371f7;border-color:#3c2a59}
  #prompt-modal button:disabled{opacity:.5;cursor:wait}
  @media (min-width:601px){
    #prompt-modal{align-items:center;padding:20px}
    #prompt-modal .panel{border-radius:12px}
  }
  #bulk-toolbar button:disabled{opacity:.35;cursor:not-allowed;background:#11141a}
  #bulk-count{color:#7a7f87;font-size:11px;margin-left:auto;white-space:nowrap}
  th.select-col,td.select-col{width:24px;padding-right:14px;text-align:left}
  input.row-select,input#select-all{width:20px;height:20px;accent-color:#7cc4ff;cursor:pointer;vertical-align:middle;margin:0}
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
  #new-form button.destructive{color:#f85149;border-color:#4a2329;margin-right:auto}
  #new-form button.destructive:hover{background:#2a181a;border-color:#6e3338}
  #new-form button:hover{background:#252b34}
  #new-form button:disabled{opacity:.5;cursor:wait}
  #new-form .hint{font-size:11px;color:#7a7f87;margin-top:-4px;margin-bottom:10px}
  #new-form .field-suffix{color:#7a7f87;font-size:10px;font-weight:400;margin-left:6px;text-transform:none;letter-spacing:0}
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
  #convs-list .conv.has-current{background:rgba(163,113,247,.06);border-left:3px solid #a371f7;padding-left:8px;margin-left:-8px}
  #convs-modal .actions{display:flex;justify-content:flex-end}
  #convs-modal button.close-btn{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  #convs-modal button.close-btn:hover{background:#252b34}
  /* The state-dot prefix is mobile-only; suppress on desktop where the
     dedicated STATE column shows the textual status. */
  .name-block .state-dot{display:none}
  /* Mobile: hide cwd column, show under name */
  @media (max-width: 600px){
    body{padding:14px 8px 72px}
    th.cwd-col,td.cwd-col{display:none}
    /* Hide the dedicated STATE column on mobile — state is binary (running
       vs exited), so a colored dot prefixed onto the session name carries
       the same information in a fraction of the column width. The AGENT
       column stays visible per operator request — it's the more
       informationally-dense column when names diverge from agent keys. */
    th.state-col,td.state-col{display:none}
    .name-block .state-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;line-height:1}
    .name-block .state-dot.running{background:#7ee787;box-shadow:0 0 6px rgba(126,231,135,.4)}
    .name-block .state-dot.exited{background:#3a4047;border:1px solid #5a6068}
    .name-block .cwd{display:block;margin-top:3px;max-width:100%}
    th,td{padding:8px 4px;font-size:13px}
    .name-block{max-width:42vw}
    td.actions{white-space:nowrap;text-align:right;padding-right:0}
    /* Buttons collapse to icon-only — long-press surfaces title= for label. */
    .actions button .label{display:none}
    .actions button{padding:5px 6px;min-width:28px;justify-content:center;margin-left:2px}
  }
  /* Sub-420px viewports (Pixel/Galaxy portrait, Steve's screenshot) — tighten
     button width further so 4 per-row icons (Conversations / Resume / Edit /
     Kill on a session with history) still fit without clipping the right
     edge of the viewport. */
  @media (max-width: 420px){
    .actions button{padding:5px 4px;min-width:24px;margin-left:1px}
    .actions button .icon{font-size:12px}
    .name-block{max-width:38vw}
    th,td{padding:7px 3px;font-size:12px}
  }
  @media (min-width: 601px){
    .name-block .cwd{display:none}
  }
</style></head>
<body>
${renderNavDrawer(host, 'sessions')}
<header>
  <div class="header-controls">
    <button id="nav-toggle" type="button" aria-label="open navigation" title="open navigation">☰</button>
    <div id="meta">
      <span id="refresh-dot" title="updates every 3s"></span>
      <span id="refresh-label">live</span>
      <span>·</span>
      <span>v${escapeHtml(DAEMON_VERSION)}</span>
    </div>
  </div>
  <h1><span class="brand">LLMUX</span> on <span class="host">${escapeHtml(host)}</span> · <span id="page-title">Chat</span></h1>
</header>
<div id="page-sessions" class="page active">
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
    <div class="field">
      <label for="new-resume-from">resume from <span class="field-suffix" id="new-resume-from-count"></span></label>
      <select id="new-resume-from" autocomplete="off">
        <option value="">(none — fresh start)</option>
      </select>
    </div>
    <div id="new-resume-from-hint" class="hint">Past conversations for this agent + cwd. Takes effect on next respawn; changing this on a running session auto-restarts to apply.</div>
    <div class="field">
      <label for="new-init">init prompts (session level)</label>
      <textarea id="new-init" rows="4" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="one prompt per line — fired into the agent after spawn; composed AFTER daemon.initPrompts from .llmux.yaml"></textarea>
    </div>
    <div id="new-init-hint" class="hint">Daemon-wide prompts are configured in .llmux.yaml (see Settings → Daemon init prompts). These per-session prompts fire after the daemon ones.</div>
    <div class="actions">
      <button type="button" id="new-kill" class="destructive" hidden title="Kill this session and remove its state record (web-UI replacement for the bulk Kill button removed in v0.31.1)">kill</button>
      <button type="button" id="new-cancel">cancel</button>
      <button type="submit" class="primary" id="new-submit">spawn</button>
    </div>
  </form>
</div>
<div id="sessions-filter">
  <input id="sessions-filter-input" type="text" placeholder="filter by name or agent…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  <button type="button" id="sessions-filter-clear" title="clear filter">×</button>
</div>
<div id="bulk-toolbar">
  <div class="bulk-action-row">
    <button id="new-btn" type="button" class="new" title="Spawn a new session">+ new</button>
    <button id="bulk-start" type="button" class="start" disabled title="Start every checked session that's currently exited">Start</button>
    <button id="bulk-stop" type="button" class="stop" disabled title="Stop every checked session that's currently running">Stop</button>
    <button id="bulk-respawn" type="button" class="respawn" disabled title="Respawn every checked session (kill + relaunch with persisted config)">Respawn</button>
    <button id="bulk-broadcast" type="button" class="broadcast" disabled title="Send the same prompt to every checked running session">Broadcast</button>
  </div>
  <span id="bulk-count">0 selected</span>
</div>
<div id="list-container">${renderSessionTable(sessions)}</div>
</div>
<div id="page-tokens" class="page">
  <div class="tokens-toolbar">
    <button id="token-new-btn" type="button">+ new token</button>
    <button id="token-revoke-all-btn" type="button" class="danger">revoke all</button>
  </div>
  <div id="token-create-form">
    <h3>new token</h3>
    <form id="token-create-form-el">
      <div class="field">
        <label for="token-create-name">name (optional)</label>
        <input id="token-create-name" type="text" placeholder="phone-mac, ci, etc." autocomplete="off">
      </div>
      <div class="field">
        <label for="token-create-expiry">expires (optional)</label>
        <input id="token-create-expiry" type="datetime-local" autocomplete="off">
      </div>
      <div class="actions">
        <button type="button" id="token-create-cancel">cancel</button>
        <button type="submit" class="primary" id="token-create-submit">create</button>
      </div>
    </form>
  </div>
  <div id="tokens-list-container">loading…</div>
</div>
<div id="page-about" class="page">
  <div id="about-grid">
    <div class="about-card">
      <h3>Daemon</h3>
      <div class="kv"><span class="key">host</span><span class="val host" id="about-host">${escapeHtml(host)}</span></div>
      <div class="kv"><span class="key">version</span><span class="val version">${escapeHtml(DAEMON_VERSION)}</span></div>
      <div class="kv"><span class="key">sessions</span><span class="val" id="about-session-count">—</span></div>
      <div class="kv"><span class="key">auth</span><span class="val" id="about-auth-status">—</span></div>
      <div class="kv"><span class="key">active tokens</span><span class="val" id="about-token-count">—</span></div>
    </div>
    <div class="about-card">
      <h3>Web UI</h3>
      <div class="kv"><span class="key">page</span><span class="val" id="about-page">${escapeHtml(host)}</span></div>
      <div class="kv"><span class="key">poll interval</span><span class="val">3s</span></div>
      <div class="kv"><span class="key">your client</span><span class="val">cookie auth</span></div>
    </div>
  </div>
</div>
<div id="page-agents" class="page">
  <div class="agents-bar">
    <span id="agents-summary">loading…</span>
    <div class="agents-toggle">
      <label><input type="checkbox" id="agents-show-missing" checked> show missing</label>
    </div>
  </div>
  <div id="agents-list-container">loading…</div>
</div>
<div id="page-logs" class="page">
  <div class="logs-toolbar">
    <select id="logs-level"><option value="all">all levels</option><option value="warn">warn + error</option><option value="error">error only</option></select>
    <label class="logs-autoscroll"><input type="checkbox" id="logs-autoscroll" checked> auto-scroll</label>
    <span id="logs-status">connecting…</span>
    <button id="logs-clear" type="button" title="Clear the visible buffer (server-side keeps last 500)">clear</button>
  </div>
  <div id="logs-view"></div>
</div>
<div id="page-settings" class="page">
  <div id="settings-grid">
    <div class="about-card">
      <h3>Discovery</h3>
      <div class="kv"><span class="key">config source</span><span class="val" id="settings-config-source">—</span></div>
      <div class="kv"><span class="key">state dir</span><span class="val" id="settings-state-dir">—</span></div>
      <div class="kv"><span class="key">tmux on PATH</span><span class="val" id="settings-tmux">—</span></div>
    </div>
    <div class="about-card">
      <h3>Listen</h3>
      <div class="kv"><span class="key">port</span><span class="val" id="settings-port">—</span></div>
      <div class="kv"><span class="key">host</span><span class="val" id="settings-listen-host">—</span></div>
    </div>
    <div class="about-card">
      <h3>Environment</h3>
      <div class="kv"><span class="key">LLMUXD_PORT</span><span class="val" id="settings-env-llmuxd-port">—</span></div>
      <div class="kv"><span class="key">LLMUXD_HOST</span><span class="val" id="settings-env-llmuxd-host">—</span></div>
      <div class="kv"><span class="key">LLMUX_PORT</span><span class="val" id="settings-env-llmux-port">—</span></div>
      <div class="kv"><span class="key">XDG_STATE_HOME</span><span class="val" id="settings-env-xdg">—</span></div>
    </div>
    <div class="about-card editable">
      <h3>turnq (FIFO turn coordination)</h3>
      <p class="settings-init-sub">When enabled, every <code>send</code> wraps in a FIFO turn so multi-sender clashes can't tear a prompt mid-flight. Edits persist to <code>~/.config/llmux/overrides.yaml</code>; delete that file to revert.</p>
      <div class="kv"><span class="key">enabled</span><label class="toggle"><input type="checkbox" id="settings-turnq-enabled-input"> <span id="settings-turnq-enabled-label">no</span></label></div>
      <div class="kv"><span class="key">mode</span><span class="val" id="settings-turnq-mode">—</span></div>
      <div class="kv"><span class="key">url</span><input class="settings-input" type="text" id="settings-turnq-url-input" placeholder="(empty = local flock)" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="kv"><span class="key">max-hold (ms)</span><input class="settings-input" type="number" id="settings-turnq-maxhold-input" min="1000" step="1000" placeholder="300000"></div>
      <div class="settings-actions">
        <span class="settings-status" id="settings-turnq-status"></span>
        <button type="button" class="settings-save" id="settings-turnq-save">save turnq</button>
      </div>
    </div>
    <div class="about-card editable">
      <h3>Daemon init prompts</h3>
      <p class="settings-init-sub">One prompt per line. Fired into every newly-spawned session before per-session <code>initPrompts</code>. Edits persist to <code>~/.config/llmux/overrides.yaml</code>; delete that file to revert.</p>
      <textarea id="settings-daemon-init-input" rows="5" placeholder="one prompt per line" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="settings-actions">
        <span class="settings-status" id="settings-daemon-init-status"></span>
        <button type="button" class="settings-save" id="settings-daemon-init-save">save init prompts</button>
      </div>
    </div>
    <div class="about-card">
      <h3>Loaded YAML <span class="overlay-badge" id="settings-overlay-badge" style="display:none">overlay active</span></h3>
      <p class="settings-init-sub">Base config file as it exists on disk. The Settings UI never writes here — UI edits go to the overlay (shown below if active).</p>
      <pre id="settings-yaml" class="yaml-blob">—</pre>
    </div>
    <div class="about-card" id="settings-overlay-card" style="display:none">
      <h3>Active overrides</h3>
      <p class="settings-init-sub">Runtime overlay at <code id="settings-overlay-path">~/.config/llmux/overrides.yaml</code>. Delete this file on the daemon host to wipe all UI edits.</p>
      <pre id="settings-overlay-yaml" class="yaml-blob">—</pre>
    </div>
  </div>
</div>
<div id="toast"></div>
<div id="prompt-modal" aria-hidden="true">
  <div class="panel">
    <h3 id="prompt-title">Send prompt</h3>
    <p class="sub" id="prompt-sub"></p>
    <textarea id="prompt-text" placeholder="type your prompt…" rows="4"></textarea>
    <div class="opts">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prompt-enter" checked>append Enter</label>
    </div>
    <div class="actions">
      <button type="button" id="prompt-cancel">cancel</button>
      <button type="button" class="primary" id="prompt-send">send</button>
    </div>
  </div>
</div>
<div id="token-secret-modal" aria-hidden="true">
  <div class="panel">
    <h3 id="token-secret-title">Token created</h3>
    <p class="warn">Save this now — the token value is shown only once.</p>
    <div id="token-secret-qr-wrap"><div id="token-secret-qr"></div><div class="copy-hint">scan from another device to pair</div></div>
    <label>token</label>
    <div class="secret-value" id="token-secret-value" title="tap to copy"></div>
    <div class="copy-hint">tap to copy</div>
    <label>pairing url</label>
    <div class="pair-url" id="token-secret-url" title="tap to copy"></div>
    <div class="copy-hint">tap to copy</div>
    <div class="actions">
      <button type="button" class="primary" id="token-secret-close">done</button>
    </div>
  </div>
</div>
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

  // Logs page state hoisted up here because showPage() routes call
  // closeLogs() at initial-page time, which is BEFORE the Logs subsystem
  // would otherwise declare its let-bound locals. Object property mutation
  // avoids the temporal-dead-zone error that crashed v0.26.0 first ship.
  const logsState = { eventSource: null, buffer: [] };

  // ---- Nav drawer + page routing ----
  // The web UI grew beyond a single Sessions table — Tokens management and
  // an About panel ride alongside it now. The hamburger menu is the entry
  // point; each "page" is just a div toggled by adding/removing .active.
  // Last-viewed page persists in localStorage so a hard reload keeps the
  // operator on the same screen.
  const ROUTES = ['sessions', 'tokens', 'agents', 'logs', 'settings', 'about'];
  const PAGE_TITLES = { sessions: 'Chat', tokens: 'Tokens', agents: 'Agents', logs: 'Logs', settings: 'Settings', about: 'About' };
  const navToggle = document.getElementById('nav-toggle');
  const navDrawer = document.getElementById('nav-drawer');
  const navBackdrop = document.getElementById('nav-backdrop');
  const pageTitle = document.getElementById('page-title');

  function openDrawer(){
    navDrawer.classList.add('open');
    navDrawer.setAttribute('aria-hidden', 'false');
    navBackdrop.classList.add('show');
    navBackdrop.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer(){
    navDrawer.classList.remove('open');
    navDrawer.setAttribute('aria-hidden', 'true');
    navBackdrop.classList.remove('show');
    navBackdrop.setAttribute('aria-hidden', 'true');
  }
  navToggle.addEventListener('click', openDrawer);
  navBackdrop.addEventListener('click', closeDrawer);

  function showPage(name){
    if (ROUTES.indexOf(name) === -1) name = 'sessions';
    ROUTES.forEach(function(r){
      const el = document.getElementById('page-' + r);
      if (el) el.classList.toggle('active', r === name);
      const link = navDrawer.querySelector('a[data-page="' + r + '"]');
      if (link) link.classList.toggle('active', r === name);
    });
    pageTitle.textContent = PAGE_TITLES[name];
    try { localStorage.setItem('llmux.page', name); } catch(_){}
    closeDrawer();
    if (name === 'tokens') refreshTokens();
    if (name === 'about') refreshAbout();
    if (name === 'agents') refreshAgents();
    if (name === 'settings') refreshSettings();
    if (name === 'logs') openLogs(); else closeLogs();
  }
  navDrawer.querySelectorAll('a[data-page]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault();
      showPage(a.dataset.page);
    });
  });
  // Restore last-viewed page (default sessions).
  let initialPage = 'sessions';
  try {
    const saved = localStorage.getItem('llmux.page');
    if (saved && ROUTES.indexOf(saved) !== -1) initialPage = saved;
  } catch(_){}
  showPage(initialPage);

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
    const editBtn = '<button class="edit" data-action="edit" data-name="' + escapeHtml(s.name) + '" data-cwd="' + escapeHtml(s.cwd) + '" data-agent="' + escapeHtml(s.agent) + '" data-flags="' + escapeHtml(s.flags || '') + '" data-env="' + escapeHtml(JSON.stringify(s.env || {})) + '" data-init="' + escapeHtml(JSON.stringify(s.initPrompts || [])) + '" data-resume="' + escapeHtml(s.resumeFrom || '') + '" title="edit name, cwd, flags, env, init prompts, resume binding" aria-label="edit"><span class="icon">✎</span><span class="label">edit</span></button>';
    const killBtn = '<button class="kill" data-action="kill" data-name="' + escapeHtml(s.name) + '" title="kill this session and remove its state record" aria-label="kill"><span class="icon">✕</span><span class="label">kill</span></button>';
    const sendBtn = s.status === 'running'
      ? '<button class="send-btn" data-action="send" data-name="' + escapeHtml(s.name) + '" title="send a prompt to this session without attaching the terminal" aria-label="send"><span class="icon">⤴</span><span class="label">send</span></button>'
      : '';
    const resumeBtn = (s.hasHistory && s.conversationCount > 0)
      ? '<button class="resume-btn" data-action="resume" data-name="' + escapeHtml(s.name) + '" title="resume a past conversation for this agent + cwd" aria-label="resume"><span class="icon">☰</span><span class="label">' + s.conversationCount + '</span></button>'
      : '';
    const when = relativeTime(s.createdAt);
    const cwdShort = s.cwdDisplay || s.cwd;
    // On mobile the STATE column is hidden via CSS — we prefix a colored
    // dot before the session name in name-block so running/exited is
    // visible at a glance. The dot itself is display:none on desktop,
    // where the dedicated STATE column shows the textual status.
    const stateDot = '<span class="state-dot ' + s.status + '" aria-label="' + s.status + '" title="' + s.status + '"></span>';
    // "↻ resumed: <title>" badge — visible only when the session is
    // currently bound to a conversation id (s.resumeFrom is set).
    // Title comes from the adapter's lookupTitle(); fallback to the
    // truncated id when lookup returns undefined.
    let resumedFromHtml = '';
    if (s.resumeFrom) {
      const label = s.resumeFromTitle || (s.resumeFrom.length > 14 ? s.resumeFrom.slice(0, 14) + '…' : s.resumeFrom);
      resumedFromHtml = '<span class="resumed-from" title="resumed from conversation ' + escapeHtml(s.resumeFrom) + '">↻ ' + escapeHtml(label) + '</span>';
    }
    return '<tr data-name="' + escapeHtml(s.name) + '" data-agent="' + escapeHtml(s.agent) + '">' +
      '<td class="select-col"><input type="checkbox" class="row-select" data-name="' + escapeHtml(s.name) + '" data-status="' + s.status + '" aria-label="select ' + escapeHtml(s.name) + '"></td>' +
      '<td class="name-block">' + stateDot + '<span class="name">' + linkOpen + escapeHtml(s.name) + '</a></span>' + resumedFromHtml + (when ? '<span class="started">started ' + when + '</span>' : '') + '<span class="cwd" title="' + escapeHtml(s.cwd) + '"><code>' + escapeHtml(cwdShort) + '</code></span></td>' +
      '<td class="agent-col">' + escapeHtml(s.agent) + '</td>' +
      '<td class="state-col ' + cls + '">' + s.status + '</td>' +
      '<td class="cwd cwd-col" title="' + escapeHtml(s.cwd) + '"><code>' + escapeHtml(cwdShort) + '</code></td>' +
      '<td class="actions">' + resumeBtn + sendBtn + editBtn + killBtn + '</td>' +
      '</tr>';
  }

  function render(sessions){
    if (!sessions || sessions.length === 0){
      container.innerHTML = '<div class="empty">no sessions yet — spawn one from the CLI:<br><br><code>llmux session start claude --name <em>name</em></code></div>';
      return;
    }
    const rows = sessions.map(rowHtml).join('');
    container.innerHTML = '<table><thead><tr><th class="select-col"><input type="checkbox" id="select-all" aria-label="select all"></th><th>name</th><th class="agent-col">agent</th><th class="state-col">state</th><th class="cwd-col">cwd</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---- Bulk selection state ----
  // selected: Set<sessionName> — survives polls so the checked rows persist
  //   across the 3s auto-refresh. Sessions that no longer exist (killed, etc.)
  //   are pruned from this set during each poll so dead names don't haunt the
  //   toolbar count or the bulk-action fan-out.
  // lastStatusByName: Map<sessionName, 'running' | 'exited'> — needed to decide
  //   whether Start (acts on exited) and Stop (acts on running) should be
  //   enabled given the current selection.
  const selected = new Set();
  const lastStatusByName = new Map();
  const bulkStart = document.getElementById('bulk-start');
  const bulkStop = document.getElementById('bulk-stop');
  const bulkRespawn = document.getElementById('bulk-respawn');
  const bulkBroadcast = document.getElementById('bulk-broadcast');
  const bulkCount = document.getElementById('bulk-count');

  function updateToolbarState(){
    let running = 0, exited = 0;
    for (const n of selected){
      const s = lastStatusByName.get(n);
      if (s === 'running') running++;
      else if (s === 'exited') exited++;
    }
    const total = selected.size;
    bulkStart.disabled = exited === 0;
    bulkStop.disabled = running === 0;
    bulkRespawn.disabled = total === 0;
    bulkBroadcast.disabled = running === 0;
    bulkCount.textContent = total + ' selected';
  }

  function applySelectionAfterRender(){
    // Re-render replaces every checkbox node, so restore checked state from
    // the surviving "selected" set, then sync the select-all tri-state.
    const checkboxes = container.querySelectorAll('input.row-select');
    checkboxes.forEach(function(cb){
      if (selected.has(cb.dataset.name)) cb.checked = true;
    });
    syncSelectAllState();
  }

  function syncSelectAllState(){
    const sa = document.getElementById('select-all');
    if (!sa) return;
    const checkboxes = container.querySelectorAll('input.row-select');
    const total = checkboxes.length;
    let checked = 0;
    checkboxes.forEach(function(cb){ if (cb.checked) checked++; });
    sa.checked = total > 0 && checked === total;
    sa.indeterminate = checked > 0 && checked < total;
  }

  async function poll(){
    if (document.hidden) return;
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      // Refresh status map + prune selections for sessions that no longer exist.
      lastStatusByName.clear();
      const present = new Set();
      for (const s of data){
        lastStatusByName.set(s.name, s.status);
        present.add(s.name);
      }
      for (const n of [...selected]){
        if (!present.has(n)) selected.delete(n);
      }
      render(data);
      applySelectionAfterRender();
      applyFilter();
      updateToolbarState();
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
        const convCls = isCurrent ? 'conv has-current' : 'conv';
        const titleCls = isCurrent ? 'conv-title conv-current' : 'conv-title';
        return '<button class="' + convCls + '" data-conv-id="' + escapeHtml(c.id) + '" data-conv-title="' + escapeHtml(c.title) + '">' +
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

  container.addEventListener('click', function(e){
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    e.preventDefault();
    const name = btn.dataset.name;
    const kind = btn.dataset.action;
    if (kind === 'edit'){
      let env = {};
      try { env = JSON.parse(btn.dataset.env || '{}'); } catch(_){}
      let initPrompts = [];
      try { initPrompts = JSON.parse(btn.dataset.init || '[]'); } catch(_){}
      openEditForm({ name: name, agent: btn.dataset.agent, cwd: btn.dataset.cwd, flags: btn.dataset.flags, env: env, initPrompts: initPrompts, resumeFrom: btn.dataset.resume || '' });
      return;
    }
    if (kind === 'resume'){
      openConvsModal(name);
      return;
    }
    if (kind === 'send'){
      openPromptModal({ kind: 'single', name: name });
      return;
    }
    if (kind === 'kill'){
      // Per-row Kill — v0.31.2 home for the verb after the bulk toolbar's
      // 6-button overflow drove it off-fold on portrait phones. The same
      // askConfirm gate that guarded bulk Kill now guards the per-row tap.
      (async function(){
        const ok = await askConfirm({
          title: 'Kill session?',
          body: 'Terminate <code>' + escapeHtmlSafe(name) + '</code> and remove its state record. The agent process will be killed. This cannot be undone.',
          okLabel: 'kill',
          destructive: true,
        });
        if (!ok) return;
        btn.disabled = true;
        try {
          const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/kill', { method: 'POST' });
          const data = await r.json().catch(function(){ return {}; });
          if (!r.ok || data.ok === false) throw new Error(data.error || 'kill failed');
          showToast('killed ' + name);
          poll();
        } catch(e){
          showToast('kill failed: ' + (e.message || e), true);
          btn.disabled = false;
        }
      })();
      return;
    }
  });

  // ---- Sessions filter ----
  // Client-side filter — matches by name OR agent substring (case-insensitive).
  // Applied after every render so the poll doesn't blow it away. The filter
  // value itself is in-memory only (not persisted) so a hard reload clears it.
  const filterInput = document.getElementById('sessions-filter-input');
  const filterClear = document.getElementById('sessions-filter-clear');
  let filterText = '';
  function applyFilter(){
    const q = filterText.toLowerCase().trim();
    container.querySelectorAll('tbody tr').forEach(function(tr){
      if (!q){ tr.style.display = ''; return; }
      const name = (tr.dataset.name || '').toLowerCase();
      const agent = (tr.dataset.agent || '').toLowerCase();
      tr.style.display = (name.includes(q) || agent.includes(q)) ? '' : 'none';
    });
  }
  filterInput.addEventListener('input', function(){
    filterText = filterInput.value;
    applyFilter();
  });
  filterClear.addEventListener('click', function(){
    filterInput.value = '';
    filterText = '';
    applyFilter();
    filterInput.focus();
  });

  // ---- Prompt modal (one-shot send + broadcast) ----
  // Shared modal. State held in promptTarget; submit handler reads it and
  // either POSTs to one /send endpoint or fans out to N in parallel.
  const promptModal = document.getElementById('prompt-modal');
  const promptTitle = document.getElementById('prompt-title');
  const promptSub = document.getElementById('prompt-sub');
  const promptText = document.getElementById('prompt-text');
  const promptEnter = document.getElementById('prompt-enter');
  const promptCancel = document.getElementById('prompt-cancel');
  const promptSend = document.getElementById('prompt-send');
  let promptTarget = null;

  function openPromptModal(target){
    promptTarget = target;
    if (target.kind === 'single'){
      promptTitle.textContent = 'Send prompt';
      promptSub.textContent = 'to ' + target.name;
    } else {
      promptTitle.textContent = 'Broadcast prompt';
      const n = target.names.length;
      const total = target.totalSelected || n;
      const skipped = total - n;
      if (skipped === 0){
        promptSub.textContent = 'to ' + n + ' selected session' + (n === 1 ? '' : 's');
      } else {
        promptSub.textContent = 'to ' + n + ' of ' + total + ' selected · ' + skipped + ' skipped (not running)';
      }
    }
    promptText.value = '';
    promptEnter.checked = true;
    promptModal.classList.add('open');
    promptModal.setAttribute('aria-hidden', 'false');
    setTimeout(function(){ promptText.focus(); }, 50);
  }
  function closePromptModal(){
    promptModal.classList.remove('open');
    promptModal.setAttribute('aria-hidden', 'true');
    promptTarget = null;
    promptText.value = '';
  }
  promptCancel.addEventListener('click', closePromptModal);
  promptModal.addEventListener('click', function(e){
    if (e.target === promptModal) closePromptModal();
  });

  async function sendPromptToSession(name, prompt, enter){
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: prompt, enter: enter }),
      });
      const body = await r.json().catch(function(){ return {}; });
      return { name: name, ok: r.ok && body.ok !== false, error: body.error };
    } catch(e){
      return { name: name, ok: false, error: e.message || String(e) };
    }
  }

  promptSend.addEventListener('click', async function(){
    if (!promptTarget) return;
    const prompt = promptText.value;
    if (!prompt){
      promptText.focus();
      return;
    }
    promptSend.disabled = true;
    const enter = promptEnter.checked;
    try {
      if (promptTarget.kind === 'single'){
        const r = await sendPromptToSession(promptTarget.name, prompt, enter);
        if (r.ok) showToast('sent → ' + r.name);
        else showToast('send failed: ' + (r.error || 'unknown'), true);
      } else {
        const results = await Promise.all(promptTarget.names.map(function(n){
          return sendPromptToSession(n, prompt, enter);
        }));
        const okCount = results.filter(function(r){ return r.ok; }).length;
        const failCount = results.length - okCount;
        if (failCount === 0) showToast('sent to ' + okCount + ' session' + (okCount === 1 ? '' : 's'));
        else showToast(okCount + ' ok, ' + failCount + ' failed', failCount > 0);
      }
      closePromptModal();
    } finally {
      promptSend.disabled = false;
    }
  });

  // Cmd/Ctrl+Enter submits from the textarea.
  promptText.addEventListener('keydown', function(e){
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter'){
      e.preventDefault();
      promptSend.click();
    }
  });

  // ---- Checkbox + select-all wiring ----
  container.addEventListener('change', function(e){
    if (e.target.id === 'select-all'){
      const checkboxes = container.querySelectorAll('input.row-select');
      const checked = e.target.checked;
      checkboxes.forEach(function(cb){
        cb.checked = checked;
        if (checked) selected.add(cb.dataset.name);
        else selected.delete(cb.dataset.name);
      });
      e.target.indeterminate = false;
      updateToolbarState();
      return;
    }
    if (e.target.classList.contains('row-select')){
      const cbName = e.target.dataset.name;
      if (e.target.checked) selected.add(cbName);
      else selected.delete(cbName);
      syncSelectAllState();
      updateToolbarState();
    }
  });

  // ---- Bulk-action toolbar ----
  // Fan out per-name POSTs in parallel. Filter to eligible status when the
  // action only makes sense for one of {running, exited}. Aggregate into a
  // single toast — "stopped 3 sessions" / "2 ok, 1 failed".
  async function bulkAction(opts){
    const targets = [...selected].filter(function(n){
      return opts.filter ? opts.filter(lastStatusByName.get(n)) : true;
    });
    if (targets.length === 0){
      showToast('no eligible sessions in selection', true);
      return;
    }
    const results = await Promise.all(targets.map(async function(name){
      try {
        const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/' + opts.kind, { method: 'POST' });
        const body = await r.json().catch(function(){ return {}; });
        return { name: name, ok: r.ok && body.ok !== false };
      } catch(_) {
        return { name: name, ok: false };
      }
    }));
    const okCount = results.filter(function(r){ return r.ok; }).length;
    const failCount = results.length - okCount;
    if (failCount === 0){
      showToast(opts.verb + ' ' + okCount + ' session' + (okCount === 1 ? '' : 's'));
    } else {
      showToast(okCount + ' ok, ' + failCount + ' failed', true);
    }
    poll();
  }

  bulkStart.addEventListener('click', function(){
    bulkAction({ filter: function(s){ return s === 'exited'; }, kind: 'respawn', verb: 'started' });
  });
  bulkStop.addEventListener('click', function(){
    bulkAction({ filter: function(s){ return s === 'running'; }, kind: 'stop', verb: 'stopped' });
  });
  bulkRespawn.addEventListener('click', function(){
    bulkAction({ kind: 'respawn', verb: 'respawned' });
  });
  bulkBroadcast.addEventListener('click', function(){
    // Broadcast hits the existing /send endpoint per-name, so it's a prompt
    // surface, not a state-mutating fan-out. Filter to running sessions only
    // — an exited tmux session can't receive sendKeys. We surface the math
    // (M running of N selected, K skipped) in the modal subtitle so the
    // user understands their exited selections didn't silently lose their
    // checkmarks.
    const runningNames = [...selected].filter(function(n){
      return lastStatusByName.get(n) === 'running';
    });
    if (runningNames.length === 0){
      showToast('no running sessions selected', true);
      return;
    }
    openPromptModal({ kind: 'bulk', names: runningNames, totalSelected: selected.size });
  });
  // Per-session Kill lives inside the edit form (formMode.edit). The bulk
  // Kill button was removed in v0.31.1 — at 6 toolbar buttons it was hanging
  // off the right edge of portrait phones and discoverable only via horizontal
  // scroll. Killing is destructive enough that one-at-a-time-from-the-edit-
  // form is the correct rhythm; bulk Stop covers the common cleanup case.
  const newKillBtn = document.getElementById('new-kill');
  newKillBtn.addEventListener('click', async function(){
    if (!formMode || !formMode.edit) return;
    const name = formMode.edit;
    const ok = await askConfirm({
      title: 'Kill session?',
      body: 'Terminate <code>' + escapeHtmlSafe(name) + '</code> and remove its state record. The agent process will be killed. This cannot be undone.',
      okLabel: 'kill',
      destructive: true,
    });
    if (!ok) return;
    newKillBtn.disabled = true;
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(name) + '/kill', { method: 'POST' });
      const data = await r.json().catch(function(){ return {}; });
      if (!r.ok || data.ok === false) throw new Error(data.error || 'kill failed');
      showToast('killed ' + name);
      closeForm();
      poll();
    } catch(e){
      showToast('kill failed: ' + (e.message || e), true);
    } finally {
      newKillBtn.disabled = false;
    }
  });

  // ---- Tokens page ----
  // CRUD on /api/tokens. The create response contains the only chance to
  // see the token value — we surface it in the secret modal with a copy
  // hint and the pairing URL. After that the value is gone; rename + revoke
  // are the only remaining ops on a known id.
  const tokensListContainer = document.getElementById('tokens-list-container');
  const tokenNewBtn = document.getElementById('token-new-btn');
  const tokenRevokeAllBtn = document.getElementById('token-revoke-all-btn');
  const tokenCreateForm = document.getElementById('token-create-form');
  const tokenCreateFormEl = document.getElementById('token-create-form-el');
  const tokenCreateName = document.getElementById('token-create-name');
  const tokenCreateExpiry = document.getElementById('token-create-expiry');
  const tokenCreateCancel = document.getElementById('token-create-cancel');
  const tokenSecretModal = document.getElementById('token-secret-modal');
  const tokenSecretValue = document.getElementById('token-secret-value');
  const tokenSecretUrl = document.getElementById('token-secret-url');
  const tokenSecretClose = document.getElementById('token-secret-close');

  async function copyText(text){
    try {
      if (navigator.clipboard && navigator.clipboard.writeText){
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch(_){}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch(_){
      return false;
    }
  }
  tokenSecretValue.addEventListener('click', async function(){
    if (await copyText(tokenSecretValue.textContent)) showToast('token copied');
  });
  tokenSecretUrl.addEventListener('click', async function(){
    if (await copyText(tokenSecretUrl.textContent)) showToast('url copied');
  });
  tokenSecretClose.addEventListener('click', function(){
    tokenSecretModal.classList.remove('open');
    tokenSecretModal.setAttribute('aria-hidden', 'true');
    tokenSecretValue.textContent = '';
    tokenSecretUrl.textContent = '';
    const qrSlot = document.getElementById('token-secret-qr');
    const qrWrap = document.getElementById('token-secret-qr-wrap');
    if (qrSlot) qrSlot.innerHTML = '';
    if (qrWrap) qrWrap.classList.remove('show');
    refreshTokens();
  });
  tokenSecretModal.addEventListener('click', function(e){
    if (e.target === tokenSecretModal) tokenSecretClose.click();
  });

  function tokenRowHtml(t){
    const name = t.name
      ? '<span class="token-name">' + escapeHtml(t.name) + '</span>'
      : '<span class="token-name"><span class="unnamed">(unnamed)</span></span>';
    const created = new Date(t.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const expiresVal = t.expiresAt ? new Date(t.expiresAt) : null;
    let expires = '<span class="token-when">—</span>';
    if (expiresVal){
      const expired = expiresVal.getTime() < Date.now();
      expires = expired
        ? '<span class="token-expired">expired ' + escapeHtml(expiresVal.toISOString().slice(0, 16).replace('T', ' ')) + '</span>'
        : '<span class="token-when">' + escapeHtml(expiresVal.toISOString().slice(0, 16).replace('T', ' ')) + '</span>';
    }
    return '<tr data-id="' + escapeHtml(t.id) + '">' +
      '<td class="token-id">' + escapeHtml(t.id) + '</td>' +
      '<td>' + name + '</td>' +
      '<td class="token-when">' + escapeHtml(created) + '</td>' +
      '<td>' + expires + '</td>' +
      '<td class="token-actions">' +
        '<button data-action="rename" data-id="' + escapeHtml(t.id) + '" data-name="' + escapeHtml(t.name || '') + '">rename</button>' +
        '<button class="danger" data-action="revoke" data-id="' + escapeHtml(t.id) + '" data-name="' + escapeHtml(t.name || t.id) + '">revoke</button>' +
      '</td>' +
      '</tr>';
  }

  async function refreshTokens(){
    try {
      const r = await fetch('/api/tokens', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0){
        tokensListContainer.innerHTML = '<div class="empty">no tokens — auth is disabled. Mint one with <strong>+ new token</strong>.</div>';
        return;
      }
      const rows = list.map(tokenRowHtml).join('');
      tokensListContainer.innerHTML = '<table><thead><tr><th>id</th><th>name</th><th>created</th><th>expires</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    } catch(e){
      tokensListContainer.innerHTML = '<div class="empty">failed to load tokens: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }

  tokenNewBtn.addEventListener('click', function(){
    tokenCreateForm.classList.add('open');
    tokenCreateName.value = '';
    tokenCreateExpiry.value = '';
    tokenCreateName.focus();
  });
  tokenCreateCancel.addEventListener('click', function(){
    tokenCreateForm.classList.remove('open');
  });
  tokenCreateFormEl.addEventListener('submit', async function(e){
    e.preventDefault();
    const submitBtn = document.getElementById('token-create-submit');
    submitBtn.disabled = true;
    try {
      const body = { pairingOrigin: location.origin };
      if (tokenCreateName.value.trim()) body.name = tokenCreateName.value.trim();
      // datetime-local emits "YYYY-MM-DDTHH:MM" in the user's local time.
      // Convert to a full UTC ISO string so the server stores it as a stable
      // absolute instant — operators in different timezones see the same
      // expiry on the token list page.
      if (tokenCreateExpiry.value){
        const localTs = new Date(tokenCreateExpiry.value);
        if (isNaN(localTs.getTime())){
          showToast('invalid expiry', true);
          submitBtn.disabled = false;
          return;
        }
        body.expiresAt = localTs.toISOString();
      }
      const r = await fetch('/api/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'request failed');
      tokenCreateForm.classList.remove('open');
      tokenSecretValue.textContent = data.value;
      const pairingUrl = data.pairingUrl || (location.origin + '/#token=' + encodeURIComponent(data.value));
      tokenSecretUrl.textContent = pairingUrl;
      const qrWrap = document.getElementById('token-secret-qr-wrap');
      const qrSlot = document.getElementById('token-secret-qr');
      if (data.qrSvg){
        qrSlot.innerHTML = data.qrSvg;
        qrWrap.classList.add('show');
      } else {
        qrSlot.innerHTML = '';
        qrWrap.classList.remove('show');
      }
      tokenSecretModal.classList.add('open');
      tokenSecretModal.setAttribute('aria-hidden', 'false');
    } catch(err){
      showToast('create failed: ' + (err.message || err), true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  tokensListContainer.addEventListener('click', async function(e){
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const labelName = btn.dataset.name || id;
    if (action === 'rename'){
      const next = prompt('rename token "' + labelName + '" to:', btn.dataset.name || '');
      if (next === null) return;
      try {
        const r = await fetch('/api/tokens/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: next }),
        });
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'request failed');
        showToast('renamed');
        refreshTokens();
      } catch(err){
        showToast('rename failed: ' + (err.message || err), true);
      }
      return;
    }
    if (action === 'revoke'){
      const ok = await askConfirm({
        title: 'Revoke token?',
        body: 'Revoke <code>' + escapeHtmlSafe(labelName) + '</code> (id: <code>' + escapeHtmlSafe(id) + '</code>). Any device or script using this token will be locked out.',
        okLabel: 'revoke',
        destructive: true,
      });
      if (!ok) return;
      try {
        const r = await fetch('/api/tokens/' + encodeURIComponent(id), { method: 'DELETE' });
        const data = await r.json();
        if (!r.ok || data.ok === false) throw new Error(data.error || 'request failed');
        showToast('revoked');
        refreshTokens();
      } catch(err){
        showToast('revoke failed: ' + (err.message || err), true);
      }
    }
  });

  tokenRevokeAllBtn.addEventListener('click', async function(){
    const ok = await askConfirm({
      title: 'Revoke ALL tokens?',
      body: 'Remove every token from the auth store. Every paired phone or browser tab will be logged out; every script using a bearer token will break. Auth will be disabled until you create a fresh token.',
      okLabel: 'revoke all',
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await fetch('/api/tokens', { method: 'DELETE' });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || 'request failed');
      showToast('revoked ' + (data.removed || 0) + ' token' + ((data.removed || 0) === 1 ? '' : 's'));
      refreshTokens();
    } catch(err){
      showToast('revoke failed: ' + (err.message || err), true);
    }
  });

  // ---- About page ----
  // Reads /health for live counts. Endpoint already existed; we just call
  // it once on page-show plus a quiet 5s tick while the page is active.
  const aboutHost = document.getElementById('about-host');
  const aboutSessionCount = document.getElementById('about-session-count');
  const aboutAuthStatus = document.getElementById('about-auth-status');
  const aboutTokenCount = document.getElementById('about-token-count');
  const aboutPage = document.getElementById('about-page');
  let aboutTimer = null;

  async function refreshAbout(){
    try {
      const [healthR, tokensR] = await Promise.all([
        fetch('/health', { cache: 'no-store' }),
        fetch('/api/tokens', { cache: 'no-store' }).catch(function(){ return null; }),
      ]);
      const health = await healthR.json();
      aboutSessionCount.textContent = String(health.sessions);
      aboutAuthStatus.textContent = health.authEnabled ? 'required' : 'open';
      if (tokensR){
        const tokens = await tokensR.json();
        aboutTokenCount.textContent = String(Array.isArray(tokens) ? tokens.length : 0);
      }
      aboutPage.textContent = location.origin;
    } catch(_){
      aboutSessionCount.textContent = '—';
      aboutAuthStatus.textContent = 'offline';
      aboutTokenCount.textContent = '—';
    }
    // Re-tick only while the About page is the active route.
    if (document.getElementById('page-about').classList.contains('active')){
      clearTimeout(aboutTimer);
      aboutTimer = setTimeout(refreshAbout, 5000);
    }
  }

  // ---- Agents page ----
  // Lists every agent the daemon knows about (installed + missing). Counts
  // running sessions per-agent from the current poll's session list. Reuses
  // /api/agents/all which the new-session help modal already calls.
  const agentsListContainer = document.getElementById('agents-list-container');
  const agentsSummary = document.getElementById('agents-summary');
  const agentsShowMissing = document.getElementById('agents-show-missing');
  let agentsCache = null;

  function agentRowHtml(a, runningCount){
    const status = a.installed
      ? '<span class="agent-status ok">installed</span>'
      : '<span class="agent-status miss">missing</span>';
    const runningBadge = runningCount > 0
      ? '<span class="agent-running">' + runningCount + ' running</span>'
      : '';
    const install = a.installHint
      ? '<div class="agent-install" data-copy="' + escapeHtml(a.installHint) + '" title="tap to copy">' + escapeHtml(a.installHint) + '</div>'
      : '';
    const docs = a.docsUrl
      ? '<a class="agent-docs" href="' + escapeHtml(a.docsUrl) + '" target="_blank" rel="noopener">docs ↗</a>'
      : '';
    return '<div class="agent-row ' + (a.installed ? '' : 'missing') + '">' +
      '<div class="agent-head">' +
        '<span class="agent-name">' + escapeHtml(a.displayName) + '</span>' +
        '<span class="agent-key">' + escapeHtml(a.key) + '</span>' +
        status + runningBadge +
      '</div>' +
      install + docs +
      '</div>';
  }

  function renderAgents(){
    if (!agentsCache) return;
    // Build the running-count map from the Sessions page DOM — every tr
    // carries data-agent + a .state-running/.state-exited cell. We read
    // from the DOM rather than re-polling /api/sessions to keep the
    // Agents page free of its own poll loop.
    const runByAgent = new Map();
    container.querySelectorAll('tbody tr').forEach(function(tr){
      const agent = tr.dataset.agent;
      const stateCell = tr.querySelector('.state-running');
      if (agent && stateCell){
        runByAgent.set(agent, (runByAgent.get(agent) || 0) + 1);
      }
    });
    const showMissing = agentsShowMissing.checked;
    const visible = agentsCache.filter(function(a){ return showMissing || a.installed; });
    if (visible.length === 0){
      agentsListContainer.innerHTML = '<div class="empty">no agents to show</div>';
    } else {
      agentsListContainer.innerHTML = visible.map(function(a){
        return agentRowHtml(a, runByAgent.get(a.key) || 0);
      }).join('');
    }
    const installedCount = agentsCache.filter(function(a){ return a.installed; }).length;
    agentsSummary.textContent = installedCount + ' of ' + agentsCache.length + ' installed on this host';
  }

  async function refreshAgents(){
    try {
      const r = await fetch('/api/agents/all', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      agentsCache = await r.json();
      renderAgents();
    } catch(e){
      agentsListContainer.innerHTML = '<div class="empty">failed to load agents: ' + escapeHtml(e.message || String(e)) + '</div>';
    }
  }
  agentsShowMissing.addEventListener('change', renderAgents);
  agentsListContainer.addEventListener('click', async function(e){
    const target = e.target.closest('[data-copy]');
    if (!target) return;
    const text = target.dataset.copy;
    if (await copyText(text)) showToast('copied');
  });

  // ---- Settings page ----
  // GET /api/settings populates discovery + listen + env + turnq editor +
  // daemon initPrompts editor + the base YAML pane and (when active) the
  // overlay YAML pane. Save buttons PUT into /api/settings/{turnq,init-prompts}
  // which write to the runtime overlay at ~/.config/llmux/overrides.yaml
  // and reload the daemon's currentConfig snapshot.
  const settingsConfigSource = document.getElementById('settings-config-source');
  const settingsStateDir = document.getElementById('settings-state-dir');
  const settingsTmux = document.getElementById('settings-tmux');
  const settingsPort = document.getElementById('settings-port');
  const settingsListenHost = document.getElementById('settings-listen-host');
  const settingsYaml = document.getElementById('settings-yaml');
  const settingsEnvLlmuxdPort = document.getElementById('settings-env-llmuxd-port');
  const settingsEnvLlmuxdHost = document.getElementById('settings-env-llmuxd-host');
  const settingsEnvLlmuxPort = document.getElementById('settings-env-llmux-port');
  const settingsEnvXdg = document.getElementById('settings-env-xdg');
  const turnqEnabledInput = document.getElementById('settings-turnq-enabled-input');
  const turnqEnabledLabel = document.getElementById('settings-turnq-enabled-label');
  const turnqUrlInput = document.getElementById('settings-turnq-url-input');
  const turnqMaxHoldInput = document.getElementById('settings-turnq-maxhold-input');
  const turnqModeVal = document.getElementById('settings-turnq-mode');
  const turnqSaveBtn = document.getElementById('settings-turnq-save');
  const turnqStatus = document.getElementById('settings-turnq-status');
  const daemonInitInput = document.getElementById('settings-daemon-init-input');
  const daemonInitSaveBtn = document.getElementById('settings-daemon-init-save');
  const daemonInitStatus = document.getElementById('settings-daemon-init-status');
  const overlayBadge = document.getElementById('settings-overlay-badge');
  const overlayCard = document.getElementById('settings-overlay-card');
  const overlayPathLabel = document.getElementById('settings-overlay-path');
  const overlayYaml = document.getElementById('settings-overlay-yaml');

  function syncTurnqModeFromInputs(){
    if (!turnqEnabledInput.checked){
      turnqModeVal.textContent = 'disabled';
      return;
    }
    turnqModeVal.textContent = turnqUrlInput.value.trim().length > 0 ? 'distributed' : 'local';
  }
  turnqEnabledInput.addEventListener('change', function(){
    turnqEnabledLabel.textContent = turnqEnabledInput.checked ? 'yes' : 'no';
    syncTurnqModeFromInputs();
  });
  turnqUrlInput.addEventListener('input', syncTurnqModeFromInputs);

  function setStatus(el, msg, kind){
    el.textContent = msg;
    el.classList.remove('ok', 'err');
    if (kind === 'ok') el.classList.add('ok');
    else if (kind === 'err') el.classList.add('err');
  }

  turnqSaveBtn.addEventListener('click', async function(){
    turnqSaveBtn.disabled = true;
    setStatus(turnqStatus, 'saving…', '');
    const body = {
      enabled: turnqEnabledInput.checked,
      url: turnqUrlInput.value.trim() || null,
      maxHoldMs: Number(turnqMaxHoldInput.value) || 300000,
    };
    try {
      const r = await fetch('/api/settings/turnq', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'http ' + r.status);
      setStatus(turnqStatus, 'saved ✓', 'ok');
      await refreshSettings();
      setTimeout(function(){ setStatus(turnqStatus, '', ''); }, 2400);
    } catch(e){
      setStatus(turnqStatus, 'error: ' + (e.message || String(e)), 'err');
    } finally {
      turnqSaveBtn.disabled = false;
    }
  });

  daemonInitSaveBtn.addEventListener('click', async function(){
    daemonInitSaveBtn.disabled = true;
    setStatus(daemonInitStatus, 'saving…', '');
    const lines = (daemonInitInput.value || '')
      .split('\\n')
      .map(function(s){ return s.replace(/\\s+$/, ''); })
      .filter(function(s){ return s.length > 0; });
    try {
      const r = await fetch('/api/settings/init-prompts', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initPrompts: lines }),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'http ' + r.status);
      setStatus(daemonInitStatus, 'saved ✓ (' + lines.length + ' prompt' + (lines.length === 1 ? '' : 's') + ')', 'ok');
      await refreshSettings();
      setTimeout(function(){ setStatus(daemonInitStatus, '', ''); }, 2400);
    } catch(e){
      setStatus(daemonInitStatus, 'error: ' + (e.message || String(e)), 'err');
    } finally {
      daemonInitSaveBtn.disabled = false;
    }
  });

  async function refreshSettings(){
    try {
      const r = await fetch('/api/settings', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      settingsConfigSource.textContent = data.configSource || '(no .llmux.yaml found; using defaults)';
      settingsStateDir.textContent = data.stateDir || '—';
      settingsTmux.textContent = data.tmuxAvailable ? 'yes' : 'no';
      settingsPort.textContent = String(data.port);
      settingsListenHost.textContent = data.listenHost || '0.0.0.0';
      settingsEnvLlmuxdPort.textContent = data.env.LLMUXD_PORT || '(unset)';
      settingsEnvLlmuxdHost.textContent = data.env.LLMUXD_HOST || '(unset)';
      settingsEnvLlmuxPort.textContent = data.env.LLMUX_PORT || '(unset)';
      settingsEnvXdg.textContent = data.env.XDG_STATE_HOME || '(unset)';
      settingsYaml.textContent = data.yamlText || '(no .llmux.yaml found)';
      const turnq = data.turnq || { enabled: false, mode: 'disabled' };
      turnqEnabledInput.checked = Boolean(turnq.enabled);
      turnqEnabledLabel.textContent = turnq.enabled ? 'yes' : 'no';
      turnqUrlInput.value = turnq.url || '';
      turnqMaxHoldInput.value = turnq.maxHoldMs || 300000;
      syncTurnqModeFromInputs();
      const prompts = Array.isArray(data.daemonInitPrompts) ? data.daemonInitPrompts : [];
      daemonInitInput.value = prompts.join('\\n');
      if (data.overlayActive){
        overlayBadge.style.display = 'inline-block';
        overlayCard.style.display = '';
        overlayPathLabel.textContent = data.overlayPath || '~/.config/llmux/overrides.yaml';
        overlayYaml.textContent = data.overlayText || '(empty)';
      } else {
        overlayBadge.style.display = 'none';
        overlayCard.style.display = 'none';
      }
    } catch(e){
      settingsConfigSource.textContent = 'failed to load: ' + (e.message || String(e));
    }
  }

  // ---- Logs page (in-process tail) ----
  // Initial /api/logs snapshot then EventSource for live tail. Close the
  // stream when the user navigates away to avoid leaking sockets on long
  // sessions. Auto-scroll defaults on; flipping it off lets the operator
  // read history without the view jumping when a new line lands. Level
  // filter is client-side — the server always streams everything, the UI
  // just hides what the operator doesn't want to see.
  const logsView = document.getElementById('logs-view');
  const logsStatus = document.getElementById('logs-status');
  const logsLevel = document.getElementById('logs-level');
  const logsAutoscroll = document.getElementById('logs-autoscroll');
  const logsClear = document.getElementById('logs-clear');
  // logsState is declared at the top of this IIFE so showPage()'s initial
  // call (which fires before this section is reached) can safely invoke
  // closeLogs() without hitting a temporal-dead-zone error on let-declared
  // locals down here.

  function logLineHtml(e){
    const tsShort = e.ts.slice(11, 19);
    return '<div class="log-line ' + e.level + '"><span class="ts">' + escapeHtml(tsShort) + '</span><span class="lvl">' + e.level + '</span><span class="txt">' + escapeHtml(e.text) + '</span></div>';
  }

  function levelPasses(level){
    const want = logsLevel.value;
    if (want === 'all') return true;
    if (want === 'warn') return level === 'warn' || level === 'error';
    if (want === 'error') return level === 'error';
    return true;
  }

  function rerenderLogs(){
    const visible = logsState.buffer.filter(function(e){ return levelPasses(e.level); });
    if (visible.length === 0){
      logsView.innerHTML = '<div class="log-empty">(no log lines)</div>';
      return;
    }
    logsView.innerHTML = visible.map(logLineHtml).join('');
    if (logsAutoscroll.checked) logsView.scrollTop = logsView.scrollHeight;
  }

  function appendLog(entry){
    logsState.buffer.push(entry);
    // Cap client-side buffer at 1000 — server keeps 500, but we let the
    // client retain a bit more across reconnects.
    if (logsState.buffer.length > 1000) logsState.buffer.shift();
    if (!levelPasses(entry.level)) return;
    const div = document.createElement('div');
    div.innerHTML = logLineHtml(entry);
    const wasAtBottom = (logsView.scrollHeight - logsView.scrollTop - logsView.clientHeight) < 40;
    if (logsView.querySelector('.log-empty')) logsView.innerHTML = '';
    logsView.appendChild(div.firstChild);
    if (logsAutoscroll.checked || wasAtBottom){
      logsView.scrollTop = logsView.scrollHeight;
    }
  }

  async function openLogs(){
    closeLogs();
    logsStatus.textContent = 'loading…';
    logsStatus.classList.remove('live', 'offline');
    try {
      const r = await fetch('/api/logs', { cache: 'no-store' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      logsState.buffer = Array.isArray(data.entries) ? data.entries.slice() : [];
      rerenderLogs();
    } catch(e){
      logsView.innerHTML = '<div class="log-empty">failed to load logs: ' + escapeHtml(e.message || String(e)) + '</div>';
      logsStatus.textContent = 'offline';
      logsStatus.classList.add('offline');
      return;
    }
    try {
      logsState.eventSource = new EventSource('/api/logs/stream');
      logsState.eventSource.onopen = function(){
        logsStatus.textContent = 'live';
        logsStatus.classList.add('live');
        logsStatus.classList.remove('offline');
      };
      logsState.eventSource.onerror = function(){
        logsStatus.textContent = 'reconnecting…';
        logsStatus.classList.remove('live');
        logsStatus.classList.add('offline');
      };
      logsState.eventSource.onmessage = function(ev){
        try {
          const entry = JSON.parse(ev.data);
          appendLog(entry);
        } catch(_){}
      };
    } catch(e){
      logsStatus.textContent = 'sse not supported';
      logsStatus.classList.add('offline');
    }
  }

  function closeLogs(){
    if (logsState.eventSource){
      try { logsState.eventSource.close(); } catch(_){}
      logsState.eventSource = null;
    }
  }

  logsLevel.addEventListener('change', rerenderLogs);
  logsClear.addEventListener('click', function(){
    logsState.buffer = [];
    rerenderLogs();
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
  const newInit = document.getElementById('new-init');
  const newResumeFrom = document.getElementById('new-resume-from');
  const newResumeFromCount = document.getElementById('new-resume-from-count');
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
    newKillBtn.hidden = true;
    newForm.classList.add('open');
    newForm.setAttribute('aria-hidden', 'false');
    await loadAgents();
    // Pre-fill flags + env with the selected agent's defaults so the operator
    // can edit/clear from there. Empty = spawn with no flags / no env override.
    newFlags.value = agentDefaultFlags(newAgent.value);
    newEnv.value = envToText(agentDefaultEnv(newAgent.value));
    newInit.value = '';
    syncFlagsHint(newAgent.value);
    syncEnvHint(newAgent.value);
    refreshResumeFromOptions(newAgent.value, newCwd.value, '');
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
    newKillBtn.hidden = false;
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
    newInit.value = Array.isArray(row.initPrompts) ? row.initPrompts.join('\\n') : '';
    syncFlagsHint(newAgent.value);
    syncEnvHint(newAgent.value);
    refreshResumeFromOptions(newAgent.value, newCwd.value, row.resumeFrom || '');
    newName.focus();
    newName.select();
  }

  // Populates the "resume from" select with conversations for the
  // (agent, cwd) combo. Pre-selects selectedId when given. Called from
  // openNewForm + openEditForm and re-fired whenever the operator
  // changes the agent dropdown or the cwd input.
  let resumeFromReqToken = 0;
  function relTimeShort(iso){
    const ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms) || ms < 0) return '';
    if (ms < 60000) return 'now';
    const m = Math.floor(ms/60000);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m/60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h/24);
    return d + 'd ago';
  }
  async function refreshResumeFromOptions(agentKey, cwd, selectedId){
    const token = ++resumeFromReqToken;
    // Reset to just the empty-pick default while loading.
    newResumeFrom.innerHTML = '<option value="">(none — fresh start)</option>';
    newResumeFromCount.textContent = '';
    if (!agentKey) return;
    const agentMeta = agentList.find(function(x){ return x.key === agentKey; });
    if (!agentMeta || !agentMeta.hasHistory) {
      newResumeFromCount.textContent = '(this agent has no history adapter)';
      return;
    }
    const cwdParam = cwd && cwd.length > 0 ? cwd : '~';
    try {
      const r = await fetch('/api/conversations?agent=' + encodeURIComponent(agentKey) + '&cwd=' + encodeURIComponent(cwdParam), { cache: 'no-store' });
      if (token !== resumeFromReqToken) return; // raced — newer request in flight
      if (!r.ok) throw new Error('http ' + r.status);
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0){
        newResumeFromCount.textContent = '(no past conversations for this agent + cwd)';
        return;
      }
      const sortedSelectedFirst = selectedId
        ? list.slice().sort(function(a, b){
            if (a.id === selectedId) return -1;
            if (b.id === selectedId) return 1;
            return 0;
          })
        : list;
      const opts = sortedSelectedFirst.map(function(c){
        const isCurrent = c.id === selectedId;
        const when = relTimeShort(c.lastMessageAt);
        const titleShort = c.title.length > 60 ? c.title.slice(0, 60) + '…' : c.title;
        const prefix = isCurrent ? '↻ ' : '';
        return '<option value="' + escapeHtmlSafe(c.id) + '"' + (isCurrent ? ' selected' : '') + '>' +
          escapeHtmlSafe(prefix + titleShort + ' · ' + when + ' · ' + c.messageCount + ' msgs') +
          '</option>';
      }).join('');
      newResumeFrom.innerHTML = '<option value="">(none — fresh start)</option>' + opts;
      newResumeFromCount.textContent = '(' + list.length + ' past conversation' + (list.length === 1 ? '' : 's') + ')';
    } catch(e){
      if (token !== resumeFromReqToken) return;
      newResumeFromCount.textContent = '(failed to load: ' + (e.message || e) + ')';
    }
  }

  newAgent.addEventListener('change', function(){
    if (formMode === 'new'){
      // Reset flags + env to the new agent's defaults so fields reflect intent.
      newFlags.value = agentDefaultFlags(newAgent.value);
      newEnv.value = envToText(agentDefaultEnv(newAgent.value));
      syncFlagsHint(newAgent.value);
      syncEnvHint(newAgent.value);
    }
    refreshResumeFromOptions(newAgent.value, newCwd.value, '');
  });
  // Debounced cwd → conversation refresh so a typing operator doesn't
  // spam the daemon. 280ms is the inter-keystroke threshold the rest of
  // the form uses (filter input + send modal).
  let cwdResumeDebounce;
  newCwd.addEventListener('input', function(){
    clearTimeout(cwdResumeDebounce);
    cwdResumeDebounce = setTimeout(function(){
      refreshResumeFromOptions(newAgent.value, newCwd.value, newResumeFrom.value);
    }, 280);
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
    // initPrompts: one per line. Filter empty lines. The whole array is sent
    // (including [] when the textarea is cleared) so the operator can wipe
    // prompts via the form — same wipe semantics as the CLI edit --init.
    const initPrompts = newInit.value
      .split('\\n')
      .map(function(s){ return s.replace(/\\s+$/, ''); })
      .filter(function(s){ return s.length > 0; });
    newSubmit.disabled = true;
    const originalLabel = newSubmit.textContent;
    try {
      // resumeFrom: explicit string id binds; empty string clears the
      // binding. Always sent on both POST and PATCH so the operator can
      // wipe a stale binding from the form.
      const resumeFrom = newResumeFrom.value;
      if (formMode && formMode.edit){
        newSubmit.textContent = 'saving…';
        // For edit, always send flags + env so input values are canonical.
        // name/cwd still only sent if user typed (so blank = no change).
        const body = { flags: flags, env: env, initPrompts: initPrompts, resumeFrom: resumeFrom };
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
        if (initPrompts.length > 0) body.initPrompts = initPrompts;
        if (resumeFrom) body.resumeFrom = resumeFrom;
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

function renderSessionTable(_sessions: SessionView[]): string {
  // Initial server-rendered placeholder. The browser-side `render()` function
  // replaces this on the first /api/sessions poll (~0-3s after load) using
  // the modern row template (checkbox column, select-all header, per-row
  // Edit + Resume only — bulk actions live in the toolbar above). The
  // server-side legacy table we used to render here showed pre-v0.23.0
  // per-row Start/Stop/Respawn/Kill buttons that flashed on screen for
  // the duration of that first poll, looking like the page was broken
  // before the JS handlers wired up. Rendering an empty-header skeleton
  // keeps the page layout stable while the real rows load in.
  return `<table><thead><tr>
    <th class="select-col"><input type="checkbox" id="select-all" aria-label="select all" disabled></th>
    <th>name</th><th class="agent-col">agent</th><th class="state-col">state</th><th class="cwd-col">cwd</th><th></th>
  </tr></thead><tbody><tr><td colspan="6" style="padding:14px;color:#7a7f87;text-align:center">loading sessions…</td></tr></tbody></table>`;
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
  #title-brand{flex:0 0 auto;color:#7cc4ff;font-size:11px;font-weight:600;letter-spacing:.08em;padding-left:8px}
  #title-version{flex:0 0 auto;color:#7a7f87;font-size:10px;padding-left:6px}
  #copy-buf,#copy-all{flex:0 0 auto;background:#1c2128;color:#7ee787;border:1px solid #262c34;border-radius:6px;height:22px;padding:0 8px;font:500 11px/1 ui-monospace,monospace;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none;margin-right:4px;transition:background .12s,border-color .12s,color .12s}
  #copy-buf{margin-left:auto}
  #copy-buf:active,#copy-all:active{background:#252b34;border-color:#3a414b}
  #copy-buf.copied,#copy-all.copied{color:#0b0c10;background:#7ee787;border-color:#7ee787}
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
  /* touch-action:none claims all touch gestures for our handlers — without
     this, Android intercepts 2-finger touches for page-zoom before our
     touchstart's preventDefault can fire, which kills the pinch-to-zoom
     font scaling. xterm still receives wheel/keyboard input as normal. */
  #term{position:fixed;top:var(--topbar-h);left:0;right:0;bottom:var(--bar-h);touch-action:none}
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
  /* Desktop / mouse-primary devices have a real keyboard — hide the
     soft-keyboard bar + expanded-keys panel + collapse the layout. The
     "fine pointer + hover" combo is the standard CSS test for
     "operator has a mouse." Mobile / touch devices keep the bar. */
  @media (pointer: fine) and (hover: hover){
    :root{--bar-h:0px;--allkeys-h:0px}
    #bar, #all-keys{display:none}
  }
</style></head>
<body>
<div id="topbar">
  <button id="back" title="Back to chat list">⌂</button>
  <span id="title-block"><span id="title-dot" data-state="connecting" title="connecting…"></span><span id="title-name">${escapedName}</span></span>
  <button id="copy-buf" title="Copy visible terminal text" aria-label="copy visible">Copy</button>
  <button id="copy-all" title="Copy full scrollback" aria-label="copy all">All</button>
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
    // parseInt('0px', 10) || 42 treats a legitimate 0 as falsy and falls
    // back to 42. That broke desktop where the soft-keyboard media query
    // sets --bar-h:0 — layout reserved 42 px for the hidden bar, leaving a
    // dark strip under the terminal. Use a finite-number check instead.
    const _bar = parseInt(cs.getPropertyValue('--bar-h'), 10);
    const barH = Number.isFinite(_bar) ? _bar : 42;
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
      // After fit.fit() evicts bottom rows into scrollback (mobile keyboard
      // appear/disappear, address-bar collapse, rotation), wipe scrollback
      // AND the visible area so the daemon-side SIGWINCH + forced TUI
      // redraw (C-l from server.ts pty handler) paints onto a blank canvas
      // instead of leaving pre-resize rows visible next to post-resize ones.
      // \x1b[3J = ED 3 "Erase Scrollback"; \x1b[2J\x1b[H = clear viewport +
      // home cursor.
      try { term.write('\x1b[3J\x1b[2J\x1b[H'); } catch(_){}
      safeSend(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
    }, 60);
  }

  applyLayout();
  try { fit.fit(); } catch(e){}

  // ---- Pinch-to-zoom on the terminal canvas ----
  // Two-finger gesture changes xterm.options.fontSize, fits the viewport,
  // and resyncs cols/rows with the backend pty. preventDefault blocks the
  // browser's page-level pinch zoom so only the terminal scales.
  // Selected font size persists per-session in localStorage.
  const FONT_MIN = 8;
  const FONT_MAX = 32;
  const FONT_KEY = 'llmux.term.fontSize';
  try {
    const saved = parseInt(localStorage.getItem(FONT_KEY) || '', 10);
    if (saved >= FONT_MIN && saved <= FONT_MAX) {
      term.options.fontSize = saved;
      try { fit.fit(); } catch(_){}
    }
  } catch(_){}

  let pinchState = null;            // { startDist, startSize, lastApplied }
  let pinchRafPending = false;
  function _touchDist(t0, t1){
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.hypot(dx, dy);
  }
  termEl.addEventListener('touchstart', function(e){
    if (e.touches.length === 2){
      pinchState = {
        startDist: _touchDist(e.touches[0], e.touches[1]),
        startSize: term.options.fontSize,
        lastApplied: term.options.fontSize,
      };
      e.preventDefault();
    }
  }, { passive: false });
  termEl.addEventListener('touchmove', function(e){
    if (e.touches.length !== 2 || !pinchState) return;
    e.preventDefault();
    if (pinchRafPending) return;
    pinchRafPending = true;
    const d = _touchDist(e.touches[0], e.touches[1]);
    const ratio = d / pinchState.startDist;
    const target = Math.round(pinchState.startSize * ratio);
    const clamped = Math.max(FONT_MIN, Math.min(FONT_MAX, target));
    requestAnimationFrame(function(){
      pinchRafPending = false;
      if (!pinchState) return;
      if (clamped === pinchState.lastApplied) return;
      pinchState.lastApplied = clamped;
      term.options.fontSize = clamped;
      try { fit.fit(); } catch(_){}
      try { term.write('\x1b[3J'); } catch(_){}
      try { term.refresh(0, term.rows - 1); } catch(_){}
      safeSend(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
    });
  }, { passive: false });
  function _pinchEnd(){
    if (!pinchState) return;
    try { localStorage.setItem(FONT_KEY, String(term.options.fontSize)); } catch(_){}
    pinchState = null;
  }
  termEl.addEventListener('touchend',    function(e){ if (e.touches.length < 2) _pinchEnd(); }, { passive: true });
  termEl.addEventListener('touchcancel', _pinchEnd, { passive: true });

  // Desktop equivalent: trackpad pinch emits a wheel event with
  // ctrlKey: true (browsers synthesize the Ctrl flag — user isn't
  // actually pressing Ctrl). Mouse-wheel + real Ctrl also lands here,
  // which is the conventional zoom gesture too. preventDefault stops
  // the browser from page-zooming on top of us.
  let wheelStepPending = false;
  let wheelDeltaAccum = 0;
  termEl.addEventListener('wheel', function(e){
    if (!e.ctrlKey) return;
    e.preventDefault();
    wheelDeltaAccum += e.deltaY;
    if (wheelStepPending) return;
    wheelStepPending = true;
    requestAnimationFrame(function(){
      wheelStepPending = false;
      const delta = wheelDeltaAccum;
      wheelDeltaAccum = 0;
      if (delta === 0) return;
      // deltaY > 0 = scroll down = zoom out; deltaY < 0 = scroll up = zoom in.
      const step = delta > 0 ? -1 : 1;
      const current = term.options.fontSize;
      const target = Math.max(FONT_MIN, Math.min(FONT_MAX, current + step));
      if (target === current) return;
      term.options.fontSize = target;
      try { fit.fit(); } catch(_){}
      try { term.write('\x1b[3J'); } catch(_){}
      try { term.refresh(0, term.rows - 1); } catch(_){}
      safeSend(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows}));
      try { localStorage.setItem(FONT_KEY, String(target)); } catch(_){}
    });
  }, { passive: false });

  // ---- Wire toolbar ----
  document.querySelectorAll('#topbar button, #bar button, #all-keys button').forEach(function(b){ b.tabIndex = -1; });

  document.getElementById('back').addEventListener('click', function(e){ e.preventDefault(); location.href = '/'; });

  // --- copy-to-clipboard helpers (shared by the Copy button + the
  //     desktop mouse-drag auto-copy path below) ---
  function _showCopyToast(msg){
    let toast = document.getElementById('copy-toast');
    if (!toast){
      toast = document.createElement('div');
      toast.id = 'copy-toast';
      toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#11141a;color:#7ee787;border:1px solid #1f4528;padding:10px 18px;border-radius:8px;font:13px ui-monospace,monospace;z-index:99999;pointer-events:none;opacity:0;transition:opacity .2s';
      document.body.appendChild(toast);
    }
    toast.textContent = msg || '✓ copied';
    toast.style.opacity = '1';
    setTimeout(function(){ toast.style.opacity = '0'; }, 1200);
  }
  function _writeClipboard(text){
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ _showCopyToast(); }, function(){
        _writeClipboardFallback(text);
      });
    } else {
      _writeClipboardFallback(text);
    }
  }
  function _writeClipboardFallback(text){
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      _showCopyToast();
    } catch(_){}
  }

  // --- Copy buttons. Two surfaces:
  //     ⎘   = copy visible viewport (most common need)
  //     ⎘⎘  = copy full scrollback (whole conversation / log dump)
  //     Power users wanting granular selection use 'llmux session attach'
  //     in a real terminal where the shell's native selection works. ---
  function _readBufferRange(startRow, endRow){
    if (!term.buffer || !term.buffer.active) return '';
    const buf = term.buffer.active;
    const lines = [];
    for (let r = startRow; r < endRow; r++){
      const line = buf.getLine(r);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\\n');
  }
  function _flashButton(btn){
    btn.classList.add('copied');
    setTimeout(function(){ btn.classList.remove('copied'); }, 600);
  }
  const copyBufBtn = document.getElementById('copy-buf');
  copyBufBtn.addEventListener('click', function(e){
    e.preventDefault();
    if (!term.buffer || !term.buffer.active){ return; }
    const top = term.buffer.active.viewportY;
    const text = _readBufferRange(top, top + term.rows);
    if (!text){ _showCopyToast('nothing to copy'); return; }
    _writeClipboard(text);
    _flashButton(copyBufBtn);
  });
  const copyAllBtn = document.getElementById('copy-all');
  copyAllBtn.addEventListener('click', function(e){
    e.preventDefault();
    if (!term.buffer || !term.buffer.active){ return; }
    const total = term.buffer.active.length;
    const text = _readBufferRange(0, total);
    if (!text){ _showCopyToast('nothing to copy'); return; }
    _writeClipboard(text);
    _flashButton(copyAllBtn);
  });

  // --- Desktop: auto-copy on xterm selection change (ttyd's pattern). ---
  //     On desktop, mouse-drag triggers xterm's internal selection, which
  //     fires onSelectionChange. We write to clipboard on any non-empty
  //     change. Dedupe so a single selection doesn't write repeatedly.
  //     Skip while a pinch gesture is active — xterm fires spurious
  //     selection events during 2-finger touches, and writing to the
  //     clipboard from inside that callback was clobbering the pinch
  //     resize on Android (the regression introduced in v0.20.0).
  let _lastSelText = '';
  term.onSelectionChange(function(){
    if (pinchState) return;
    const text = term.getSelection();
    if (!text || text === _lastSelText) return;
    _lastSelText = text;
    _writeClipboard(text);
  });

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

  async function submitToken(token, { silent } = {}){
    const btn = form.querySelector('button');
    if (!silent) btn.disabled = true;
    try {
      const r = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (!r.ok) {
        const body = await r.json().catch(function(){ return {}; });
        if (!silent) {
          msg.textContent = body.error || 'token rejected';
          btn.disabled = false;
          input.focus();
          input.select();
        }
        return false;
      }
      // Cookie set. Strip any token from the URL — both ?token= and #token=
      // — before navigating so the auth credential isn't left behind in
      // browser history or the address bar. Leaving ?token= here would also
      // re-fire the server's canonical-url 302 rule and invalidate our cookie.
      const params = new URLSearchParams(location.search);
      params.delete('token');
      const query = params.toString();
      location.href = location.pathname + (query ? '?' + query : '');
      return true;
    } catch(err){
      if (!silent) {
        msg.textContent = 'request failed: ' + (err.message || err);
        btn.disabled = false;
      }
      return false;
    }
  }

  // First-tap pairing: token rides in the URL fragment (#token=…), which
  // browsers never send to the server. Read it, POST it, strip it. If this
  // path fires the user never sees the unlock form.
  const hash = location.hash || '';
  if (hash.startsWith('#token=')) {
    const fragToken = decodeURIComponent(hash.slice('#token='.length));
    // Strip the fragment from the visible URL immediately (before the POST
    // resolves) so the address bar doesn't briefly show the token.
    try { history.replaceState(null, '', location.pathname + location.search); } catch(_){}
    if (fragToken) {
      submitToken(fragToken, { silent: true }).then(function(ok){
        if (!ok) input.focus();
      });
    }
  }

  form.addEventListener('submit', function(e){
    e.preventDefault();
    const token = input.value.trim();
    if (!token) return;
    msg.textContent = '';
    submitToken(token);
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
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // Force browsers to re-check on every load. The HTML embeds page-bound
    // JS that ships in each commit; without this header the operator can
    // be silently stuck on a stale build until they hard-refresh.
    'cache-control': 'no-cache, no-store, must-revalidate',
  });
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

export function buildAgentCommand(
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
      // Prefer the fast count adapter when available — Claude Code's full
      // listConversations parses every transcript file (hundreds of MB on
      // long-running operator boxes), blocking the event loop. The count
      // adapter on claudeHistory is a directory-only readdir.
      conversationCount = agentDef.history.countConversations
        ? agentDef.history.countConversations(s.cwd)
        : agentDef.history.listConversations(s.cwd).length;
    } catch {
      conversationCount = 0;
    }
  }
  // Resolve the bound-conversation title for the per-row "↻ resumed: X"
  // badge. Adapters that implement lookupTitle do a single targeted read
  // (one file open / one SQL row) rather than walking the full set.
  let resumeFromTitle: string | undefined;
  if (s.resumeFrom && agentDef?.history?.lookupTitle) {
    try {
      resumeFromTitle = agentDef.history.lookupTitle(s.cwd, s.resumeFrom);
    } catch {
      resumeFromTitle = undefined;
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
    ...(resumeFromTitle !== undefined ? { resumeFromTitle } : {}),
    ...(s.initPrompts !== undefined ? { initPrompts: s.initPrompts } : {}),
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
export function parseEnvText(text: string): Record<string, string> {
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
export function mergeSpawnEnv(agent: AgentDefinition, sessionEnv: Record<string, string> | undefined, llmuxEnv: Record<string, string>): Record<string, string> {
  return { ...(agent.envDefaults ?? {}), ...(sessionEnv ?? {}), ...llmuxEnv };
}

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function createSession(input: { agent: string; name?: string; cwd?: string; flags?: string; env?: string; resumeFrom?: string; initPrompts?: string[]; orchAlias?: string }):
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

  const llmuxEnv: Record<string, string> = { LLMUX_SESSION: name, LLMUX_AGENT: agentDef.key };
  if (input.orchAlias) llmuxEnv['LLMUX_ORCH_ALIAS'] = input.orchAlias;
  agentDef.preSpawn?.({ cwd });
  try {
    tmux.newSession({
      name,
      command: buildAgentCommand(agentDef, flagsOverride, resumeFrom),
      cwd,
      env: mergeSpawnEnv(agentDef, envOverride, llmuxEnv),
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
    ...(input.initPrompts && input.initPrompts.length > 0 ? { initPrompts: input.initPrompts } : {}),
    ...(input.orchAlias ? { orchAlias: input.orchAlias } : {}),
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
    agent.preSpawn?.({ cwd: session.cwd });
    tmux.newSession({
      name: session.name,
      command: buildAgentCommand(agent, session.flags, session.resumeFrom),
      cwd: session.cwd,
      env: mergeSpawnEnv(agent, session.env, {
        LLMUX_SESSION: session.name,
        LLMUX_AGENT: session.agent,
        ...(session.orchAlias ? { LLMUX_ORCH_ALIAS: session.orchAlias } : {}),
      }),
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
    agent.preSpawn?.({ cwd: session.cwd });
    tmux.newSession({
      name: session.name,
      command: buildAgentCommand(agent, session.flags, conversationId),
      cwd: session.cwd,
      env: mergeSpawnEnv(agent, session.env, {
        LLMUX_SESSION: session.name,
        LLMUX_AGENT: session.agent,
        ...(session.orchAlias ? { LLMUX_ORCH_ALIAS: session.orchAlias } : {}),
      }),
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

export function editSession(
  oldName: string,
  patch: { name?: string; cwd?: string; flags?: string; env?: string; initPrompts?: string[]; resumeFrom?: string | null },
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

  // initPrompts semantics: undefined → no change; array → replace (empty
  // array clears the persisted list). Operator can wipe init prompts by
  // sending []; new prompts take effect on the next respawn.
  const nextInitPrompts = patch.initPrompts !== undefined
    ? (patch.initPrompts.length > 0 ? patch.initPrompts : undefined)
    : session.initPrompts;

  // resumeFrom semantics on patch:
  //   undefined → no change (preserve existing)
  //   ''  or null → explicit clear (no conversation bound, fresh start on respawn)
  //   '<id>' → set to that conversation id; takes effect on next respawn
  // We auto kill+respawn below if this changes on a running session, the
  // same way cwd changes auto-respawn — otherwise the edit would be
  // invisible until the operator manually restarts.
  const wantsResumeChange = patch.resumeFrom !== undefined;
  const nextResumeFrom: string | undefined = wantsResumeChange
    ? (typeof patch.resumeFrom === 'string' && patch.resumeFrom.length > 0 ? patch.resumeFrom : undefined)
    : session.resumeFrom;

  const updated: state.SessionState = {
    name: renaming ? newName! : oldName,
    agent: session.agent,
    cwd: newCwd !== undefined && newCwd.length > 0 ? expandTilde(newCwd) : session.cwd,
    ...(nextFlags !== undefined ? { flags: nextFlags } : {}),
    ...(nextEnv !== undefined ? { env: nextEnv } : {}),
    ...(nextResumeFrom !== undefined ? { resumeFrom: nextResumeFrom } : {}),
    ...(nextInitPrompts !== undefined ? { initPrompts: nextInitPrompts } : {}),
    ...(session.turnqMarker !== undefined ? { turnqMarker: session.turnqMarker } : {}),
    createdAt: session.createdAt,
    parent: session.parent,
    restart: session.restart,
  };

  if (renaming) state.forget(oldName);
  state.record(updated);

  // cwd + resumeFrom are baked into the launch command at tmux fork time
  // — neither can be changed on a live session. Auto kill+respawn when
  // either actually changed and the session is running, so the operator's
  // edit isn't invisible until manual restart.
  const cwdChanged =
    newCwd !== undefined && newCwd.length > 0 && updated.cwd !== session.cwd;
  const resumeChanged = wantsResumeChange && updated.resumeFrom !== session.resumeFrom;
  if ((cwdChanged || resumeChanged) && tmux.hasSession(updated.name)) {
    const agent = DEFAULT_AGENTS[updated.agent];
    if (agent && isAgentInstalled(agent)) {
      try {
        tmux.killSession(updated.name);
        agent.preSpawn?.({ cwd: updated.cwd });
        tmux.newSession({
          name: updated.name,
          command: buildAgentCommand(agent, updated.flags, updated.resumeFrom),
          cwd: updated.cwd,
          env: mergeSpawnEnv(agent, updated.env, {
            LLMUX_SESSION: updated.name,
            LLMUX_AGENT: updated.agent,
            ...(updated.orchAlias ? { LLMUX_ORCH_ALIAS: updated.orchAlias } : {}),
          }),
        });
        // Refresh createdAt so the picker's "started Xm ago" reflects the
        // actual moment the agent process began running with the new cwd.
        const refreshed: state.SessionState = { ...updated, createdAt: new Date().toISOString() };
        state.record(refreshed);
        return { ok: true, session: viewOf(refreshed, true) };
      } catch (err) {
        const what = cwdChanged && resumeChanged ? 'cwd + resumeFrom' : (cwdChanged ? 'cwd' : 'resumeFrom');
        return { ok: false, error: `${what} updated but restart failed: ${err instanceof Error ? err.message : String(err)}` };
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

/**
 * Stop a session without forgetting it. Idempotent — already-stopped sessions
 * return ok. The state record stays intact so the session can be started again
 * from the same config via /respawn.
 */
function stopSession(name: string): { ok: true } | { ok: false; error: string } {
  const session = state.get(name);
  if (!session) return { ok: false, error: `no tracked session "${name}"` };
  if (!tmux.hasSession(name)) return { ok: true };
  try {
    tmux.killSession(name);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

// ---------- server ----------

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

const RESPAWN_RE = /^\/api\/sessions\/([^/]+)\/respawn$/;
const STOP_RE = /^\/api\/sessions\/([^/]+)\/stop$/;
const KILL_RE = /^\/api\/sessions\/([^/]+)\/kill$/;
const RESUME_RE = /^\/api\/sessions\/([^/]+)\/resume$/;
const SEND_RE = /^\/api\/sessions\/([^/]+)\/send$/;
const CONVERSATIONS_RE = /^\/api\/sessions\/([^/]+)\/conversations$/;
const EDIT_RE = /^\/api\/sessions\/([^/]+)$/;

export function startServer(opts: ServeOptions): ServerHandle {
  // Boot snapshot — refreshed in-place by the PUT /api/settings/* handlers
  // so subsequent reads (including the WebSocket attach path's turnq
  // lookup) reflect the new overlay state without restarting the daemon.
  let currentConfig: LlmuxConfig | undefined = opts.config;
  function reloadCurrentConfig(): LlmuxConfig {
    currentConfig = loadConfig();
    return currentConfig;
  }
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    // ---- v2 auth routes (independent of v1 SAS auth) ----
    // Setup wizard, login, account, admin/users — all use llmux_session
    // cookie + identity-bound tokens. The v1 SAS cookie (llmuxd_token)
    // doesn't bleed into these and vice versa.
    if (await tryV2Route(req, res)) return;

    // ---- Deep-link auth: ?token=<sas> on any path (LEGACY) ----
    // v0.22.0 moved first-tap pairing to a URL fragment (#token=) so the
    // credential never reaches the server in the request line. This branch
    // stays for one release to keep older QRs working, with a one-shot
    // operator warning that surfaces the URL-borne credential in logs.
    // Valid → 302 + set cookie + clean redirect. Invalid → clear the cookie
    // (so a stale prior session doesn't mask the rejection) + serve the gate.
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      console.warn(
        `[llmux] deprecated: ?token= in URL — visible in server / proxy / browser logs. ` +
        `Regenerate the pairing QR with \`llmux token create --qr\` on v0.22.0+ to use the fragment form.`,
      );
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

    // ---- Token management (CRUD) ----
    // List: never includes the token VALUE — only id / name / createdAts.
    // Create: returns the value ONCE. After the response is sent, the
    //   plaintext is unreachable from the daemon's REST surface again.
    //   Mirrors the CLI's "show once" semantics.
    // Patch: rename only (mutate the .name field; empty string clears).
    // Delete by id: revoke a single token.
    // Delete (no id): revoke all tokens.
    if (url.pathname === '/api/tokens' && method === 'GET') {
      const list = authStore.listAuthTokens().map((t) => ({
        id: t.id,
        ...(t.name !== undefined ? { name: t.name } : {}),
        createdAt: t.createdAt,
        ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      }));
      return sendJson(res, list);
    }
    if (url.pathname === '/api/tokens' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { name?: unknown; expiresAt?: unknown; pairingOrigin?: unknown };
        const name = typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined;
        const expiresAt = typeof body.expiresAt === 'string' && body.expiresAt.length > 0 ? body.expiresAt : undefined;
        const pairingOrigin = typeof body.pairingOrigin === 'string' && body.pairingOrigin.length > 0 ? body.pairingOrigin : undefined;
        if (expiresAt && isNaN(new Date(expiresAt).getTime())) {
          return sendJson(res, { ok: false, error: 'expiresAt must be an ISO-8601 createdAt' }, 400);
        }
        const rec = authStore.createAuthToken({
          ...(name !== undefined ? { name } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        // Build the pairing URL using the same hash-form the printQr CLI
        // emits. Client passes its own location.origin so the QR points at
        // the URL the operator is actually using (tailscale-https most often,
        // not localhost). Defensive fall-back: just the token value.
        const pairingUrl = pairingOrigin
          ? `${pairingOrigin.replace(/\/$/, '')}/#token=${encodeURIComponent(rec.token)}`
          : undefined;
        let qrSvg: string | undefined;
        if (pairingUrl) {
          try {
            qrSvg = await QRCode.toString(pairingUrl, {
              type: 'svg',
              errorCorrectionLevel: 'M',
              margin: 1,
              width: 240,
              color: { dark: '#e6e8eb', light: '#0b0c1000' },
            });
          } catch {
            // QR render failure is non-fatal; the client still has the URL.
          }
        }
        return sendJson(
          res,
          {
            ok: true,
            value: rec.token,
            token: {
              id: rec.id,
              ...(rec.name !== undefined ? { name: rec.name } : {}),
              createdAt: rec.createdAt,
              ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
            },
            ...(pairingUrl !== undefined ? { pairingUrl } : {}),
            ...(qrSvg !== undefined ? { qrSvg } : {}),
          },
          201,
        );
      } catch (err) {
        return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
      }
    }
    if (url.pathname === '/api/tokens' && method === 'DELETE') {
      const before = authStore.listAuthTokens().length;
      const removed = authStore.revokeAllAuthTokens();
      return sendJson(res, { ok: true, removed, before });
    }
    const tokenIdMatch = url.pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (tokenIdMatch) {
      const id = decodeURIComponent(tokenIdMatch[1]!);
      if (method === 'PATCH') {
        try {
          const body = (await readJsonBody(req)) as { name?: unknown };
          if (typeof body.name !== 'string') {
            return sendJson(res, { ok: false, error: 'name must be a string (pass "" to clear)' }, 400);
          }
          const rec = authStore.renameAuthToken(id, body.name);
          if (!rec) return sendJson(res, { ok: false, error: `no token with id "${id}"` }, 404);
          return sendJson(res, {
            ok: true,
            token: {
              id: rec.id,
              ...(rec.name !== undefined ? { name: rec.name } : {}),
              createdAt: rec.createdAt,
              ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
            },
          });
        } catch (err) {
          return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
        }
      }
      if (method === 'DELETE') {
        const ok = authStore.revokeAuthToken(id);
        if (!ok) return sendJson(res, { ok: false, error: `no token with id "${id}"` }, 404);
        return sendJson(res, { ok: true });
      }
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
          hasHistory: Boolean(def.history),
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

    // ---- Logs (in-process ring buffer + SSE tail) ----
    // GET /api/logs        — snapshot of the buffer for initial render
    // GET /api/logs/stream — Server-Sent Events: one `data: { ts, level, text }`
    //                       message per new console line. Operators can stop
    //                       watching by closing the EventSource.
    if (url.pathname === '/api/logs' && method === 'GET') {
      return sendJson(res, { capacity: logBuffer.getCapacity(), entries: logBuffer.getBuffer() });
    }
    if (url.pathname === '/api/logs/stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      // Send a comment line as a heartbeat / handshake so proxies don't buffer
      // the first message indefinitely.
      res.write(': stream open\n\n');
      const unsubscribe = logBuffer.subscribe((entry) => {
        try {
          res.write(`data: ${JSON.stringify(entry)}\n\n`);
        } catch {
          // res may be closed; let the close handler clean up.
        }
      });
      const heartbeat = setInterval(() => {
        try { res.write(': heartbeat\n\n'); } catch {}
      }, 30000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { res.end(); } catch {}
      });
      return;
    }

    // ---- Settings ----
    // GET: effective config + diagnostic info. The web UI's Settings page
    // reads this on every nav-in.
    // PUT /api/settings/init-prompts: replace the daemon-wide init prompts
    // PUT /api/settings/turnq: replace the turnq subconfig
    // Both PUT verbs persist to the runtime overlay file (separate from the
    // hand-edited base YAML — see config.ts) and reload currentConfig.
    if (url.pathname === '/api/settings' && method === 'GET') {
      const cfg = currentConfig;
      let yamlText = '';
      if (cfg?.sourcePath) {
        try { yamlText = readFileSync(cfg.sourcePath, 'utf8'); } catch { yamlText = '(failed to read config file)'; }
      }
      let overlayText = '';
      if (cfg?.overlayPath) {
        try { overlayText = readFileSync(cfg.overlayPath, 'utf8'); } catch { overlayText = '(failed to read overlay file)'; }
      }
      let tmuxAvailable = false;
      try { tmux.requireTmux(); tmuxAvailable = true; } catch { tmuxAvailable = false; }
      return sendJson(res, {
        version: DAEMON_VERSION,
        host: hostname(),
        configSource: cfg?.sourcePath ?? null,
        yamlText,
        overlayPath: cfg?.overlayPath ?? overridePath(),
        overlayText,
        overlayActive: Boolean(cfg?.overlayPath),
        stateDir: state.stateDir(),
        tmuxAvailable,
        port: opts.port,
        listenHost: opts.host,
        env: {
          LLMUXD_PORT: process.env.LLMUXD_PORT ?? null,
          LLMUXD_HOST: process.env.LLMUXD_HOST ?? null,
          LLMUX_PORT: process.env.LLMUX_PORT ?? null,
          XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? null,
        },
        turnq: cfg?.turnq
          ? {
              enabled: Boolean(cfg.turnq.enabled),
              url: cfg.turnq.url ?? null,
              mode: cfg.turnq.url ? 'distributed' : 'local',
              maxHoldMs: cfg.turnq.maxHoldMs ?? 300_000,
            }
          : { enabled: false, url: null, mode: 'disabled', maxHoldMs: null },
        daemonInitPrompts: cfg?.initPrompts ?? [],
      });
    }

    if (url.pathname === '/api/settings/init-prompts' && method === 'PUT') {
      try {
        const body = (await readJsonBody(req)) as { initPrompts?: unknown };
        if (!Array.isArray(body.initPrompts)) {
          return sendJson(res, { ok: false, error: 'initPrompts must be an array' }, 400);
        }
        const cleaned = body.initPrompts
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.replace(/\s+$/, ''))
          .filter((p) => p.length > 0);
        saveOverride({ initPrompts: cleaned });
        reloadCurrentConfig();
        console.log(`[settings] daemon initPrompts updated via web UI (${cleaned.length} prompt${cleaned.length === 1 ? '' : 's'})`);
        return sendJson(res, { ok: true, initPrompts: cleaned, overlayActive: Boolean(currentConfig?.overlayPath) });
      } catch (err) {
        return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
      }
    }

    if (url.pathname === '/api/settings/turnq' && method === 'PUT') {
      try {
        const body = (await readJsonBody(req)) as { enabled?: unknown; maxHoldMs?: unknown; url?: unknown };
        const next: TurnqConfig = { enabled: Boolean(body.enabled) };
        if (typeof body.maxHoldMs === 'number' && Number.isFinite(body.maxHoldMs) && body.maxHoldMs > 0) {
          next.maxHoldMs = Math.floor(body.maxHoldMs);
        }
        if (typeof body.url === 'string' && body.url.trim().length > 0) {
          next.url = body.url.trim();
        }
        saveOverride({ turnq: next });
        reloadCurrentConfig();
        const mode = next.url ? 'distributed' : 'local';
        console.log(`[settings] turnq updated via web UI (enabled=${next.enabled}, mode=${mode})`);
        return sendJson(res, {
          ok: true,
          turnq: {
            enabled: next.enabled,
            url: next.url ?? null,
            mode: next.enabled ? mode : 'disabled',
            maxHoldMs: next.maxHoldMs ?? 300_000,
          },
          overlayActive: Boolean(currentConfig?.overlayPath),
        });
      } catch (err) {
        return sendJson(res, { ok: false, error: err instanceof Error ? err.message : 'bad request' }, 400);
      }
    }

    if (url.pathname === '/api/sessions' && method === 'POST') {
      try {
        const body = (await readJsonBody(req)) as { agent?: unknown; name?: unknown; cwd?: unknown; flags?: unknown; env?: unknown; resumeFrom?: unknown; initPrompts?: unknown };
        const result = createSession({
          agent: typeof body.agent === 'string' ? body.agent : '',
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          ...(typeof body.flags === 'string' ? { flags: body.flags } : {}),
          ...(typeof body.env === 'string' ? { env: body.env } : {}),
          ...(typeof body.resumeFrom === 'string' ? { resumeFrom: body.resumeFrom } : {}),
          ...(Array.isArray(body.initPrompts)
            ? { initPrompts: body.initPrompts.filter((p): p is string => typeof p === 'string') }
            : {}),
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
      const mStop = url.pathname.match(STOP_RE);
      if (mStop) {
        const name = decodeURIComponent(mStop[1]!);
        const result = stopSession(name);
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
          const body = (await readJsonBody(req)) as { prompt?: unknown; enter?: unknown; skipTurnq?: unknown };
          if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
            return sendJson(res, { ok: false, error: 'prompt required' }, 400);
          }
          if (!state.get(name)) return sendJson(res, { ok: false, error: `no tracked session "${name}"` }, 404);
          if (!tmux.hasSession(name)) return sendJson(res, { ok: false, error: `session "${name}" is not running` }, 409);
          const enter = body.enter !== false; // default true; explicitly false to suppress
          const skipTurnq = body.skipTurnq === true;
          try {
            await turnqIntegration.sendWithTurn(name, body.prompt, {
              enter,
              skipTurnq,
              turnqConfig: currentConfig?.turnq,
            });
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
      // GET /api/conversations?agent=<key>&cwd=<path> — list conversations
      // for an arbitrary agent + cwd combo (no session record required).
      // The +new and edit forms call this to populate the "resume from"
      // dropdown as the operator chooses an agent / cwd, before the
      // session exists. Falls back to '~' shorthand expansion same as
      // the spawn path.
      if (url.pathname === '/api/conversations') {
        const agentKey = url.searchParams.get('agent') ?? '';
        const rawCwd = url.searchParams.get('cwd') ?? '';
        if (!agentKey || !rawCwd) return sendJson(res, []);
        const agent = DEFAULT_AGENTS[agentKey];
        if (!agent?.history) return sendJson(res, []);
        const cwd = expandTilde(rawCwd);
        try {
          const convs: Conversation[] = agent.history.listConversations(cwd);
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
          const body = (await readJsonBody(req)) as { name?: unknown; cwd?: unknown; flags?: unknown; env?: unknown; initPrompts?: unknown; resumeFrom?: unknown };
          const result = editSession(name, {
            ...(typeof body.name === 'string' ? { name: body.name } : {}),
            ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
            ...(typeof body.flags === 'string' ? { flags: body.flags } : {}),
            ...(typeof body.env === 'string' ? { env: body.env } : {}),
            ...(Array.isArray(body.initPrompts)
              ? { initPrompts: body.initPrompts.filter((p): p is string => typeof p === 'string') }
              : {}),
            // resumeFrom: string sets the binding, '' or null clears it,
            // undefined preserves the existing binding. Same semantics as
            // editSession's patch type.
            ...(typeof body.resumeFrom === 'string' ? { resumeFrom: body.resumeFrom } : {}),
            ...(body.resumeFrom === null ? { resumeFrom: null } : {}),
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

  // Initialise the v2 auth subsystem after the http server is bound so
  // the setup-token URL printed in the banner uses the correct port.
  // Failure here is non-fatal — v1 picker keeps working without v2.
  void initV2Routes(opts.port).catch((err) => {
    console.error('[v2] init failed (v1 picker unaffected):', err);
  });

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

  // Stream pty output straight to the WS. The prior implementation
  // line-buffered the stream when the session had a turnqMarker, in order
  // to strip `<<LLMUX_DONE_xxxx>>` lines from the operator's view. But TUI
  // agents (agy/gemini/codex/opencode) emit keystroke renders as `\n`-less
  // cursor-move sequences — those sat in the buffer until a newline-bearing
  // chunk flushed them, making the web terminal look frozen for every agent
  // except Claude (which streams text constantly). The marker line is
  // cosmetic noise at worst; CLI tmux-attach always saw it anyway.
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
          // Force the inner TUI to redraw after SIGWINCH propagates through
          // tmux. Partial-redraw TUIs (most chat-prompt agents — claude,
          // codex, gemini, agy, qwen, opencode — and shells at a prompt)
          // only re-emit cells they think changed, so post-resize rows sit
          // next to pre-resize stale rows until the next render tick. C-l
          // is the unix convention for "redraw screen" and every supported
          // agent honors it. ~100ms delay gives tmux time to deliver
          // SIGWINCH first so the TUI redraws into the new geometry.
          const t = term;
          setTimeout(() => { try { t.write('\x0c'); } catch { /* pty gone */ } }, 100);
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
