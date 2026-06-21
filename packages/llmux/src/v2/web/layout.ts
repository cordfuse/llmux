// Shared HTML/CSS helpers for v2 web pages.
//
// Visual source of truth: packages/llmux/src/daemon/web/server.ts
// pickerPage(). This module factors out the head/style/header/nav so the
// v2 pages (setup, login, account, admin/users) stay byte-for-byte
// consistent with the existing picker design without re-copying the
// whole stylesheet.

const BRAND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="90" ry="90" fill="#0b0c10"/><rect x="1.5" y="1.5" width="509" height="509" rx="89" ry="89" fill="none" stroke="#7cc4ff" stroke-width="1.5" stroke-opacity="0.22"/><text x="256" y="236" text-anchor="middle" dominant-baseline="central" font-family="'Noto Sans Mono', 'Courier New', monospace" font-size="185" font-weight="700" fill="#7cc4ff" letter-spacing="-3">{Lm}</text></svg>`;
const FAVICON_DATA_URL = `data:image/svg+xml,${encodeURIComponent(BRAND_SVG)}`;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Color + typography + form/button/card styles shared by all pages. Pulled
 * verbatim from pickerPage()'s CSS — change anything here only after
 * changing the picker (or vice versa) so the family stays in lockstep.
 */
export function commonStyles(): string {
  return `
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px;overflow-x:hidden}
  body{padding:18px 16px 80px;max-width:980px;margin:0 auto;box-sizing:border-box}
  a{color:#7cc4ff;text-decoration:none}
  a:hover{text-decoration:underline}
  header{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-bottom:18px}
  header .header-controls{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  h1{font-size:18px;margin:0}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em;font-weight:600}
  h1 .host{color:#a371f7;font-weight:500;margin-left:8px}
  #nav-toggle{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:18px;line-height:1;margin-right:10px;flex:0 0 auto;transition:background 150ms ease,border-color 150ms ease}
  #nav-toggle:hover{background:#252b34;border-color:#3a414b}
  #nav-toggle:active{transform:scale(.94)}
  #nav-drawer{position:fixed;top:0;left:-300px;width:280px;height:100dvh;background:#0e1116;border-right:1px solid #1f2329;transition:left 220ms ease;z-index:55;padding:18px 0;box-sizing:border-box;display:flex;flex-direction:column}
  #nav-drawer.open{left:0}
  #nav-backdrop{position:fixed;inset:0;background:rgba(11,12,16,.55);z-index:54;opacity:0;visibility:hidden;transition:opacity 180ms ease,visibility 0s 180ms}
  #nav-backdrop.show{opacity:1;visibility:visible;transition:opacity 180ms ease}
  #nav-drawer .nav-header{padding:0 20px 16px;border-bottom:1px solid #1f2329;display:flex;flex-direction:column;gap:4px}
  #nav-drawer .nav-brand{color:#7cc4ff;font-weight:600;letter-spacing:.08em;font-size:15px}
  #nav-drawer .nav-host{color:#a371f7;font-size:12px}
  #nav-drawer nav{flex:1;display:flex;flex-direction:column;padding:8px 0;overflow-y:auto}
  #nav-drawer a{display:flex;align-items:center;gap:10px;padding:12px 20px;color:#c9d1d9;text-decoration:none;font-size:14px;border-left:3px solid transparent;cursor:pointer}
  #nav-drawer a:hover{background:#11141a;text-decoration:none}
  #nav-drawer a.active{border-left-color:#7cc4ff;color:#7cc4ff;background:#11141a}
  #nav-drawer a .nav-icon{font-size:16px;width:20px;text-align:center;color:inherit}
  #nav-drawer .nav-footer{padding:10px 20px 0;border-top:1px solid #1f2329;font-size:11px;color:#7a7f87;display:flex;justify-content:space-between;align-items:center}
  .about-card{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:16px;margin-bottom:14px}
  .about-card h3{margin:0 0 12px;font-size:13px;color:#7cc4ff;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
  .about-card .sub{margin:-6px 0 12px;font-size:11px;color:#9aa0a6;line-height:1.5}
  .field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
  .field label{font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em}
  .field input,.field select{background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 10px;font:13px ui-monospace,monospace;outline:none;width:100%;box-sizing:border-box}
  .field input:focus,.field select:focus{border-color:#2d4a66}
  .field .help{font-size:11px;color:#7a7f87;line-height:1.4}
  .field .err{font-size:11px;color:#f85149;line-height:1.4}
  .actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}
  .actions .spacer{flex:1}
  button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer;transition:background 150ms ease,border-color 150ms ease}
  button:hover:not(:disabled){background:#252b34;border-color:#3a414b}
  button:active{transform:scale(.96)}
  button:disabled{opacity:.4;cursor:not-allowed}
  button.primary{color:#7cc4ff;border-color:#2d4a66}
  button.primary:hover:not(:disabled){background:#11141a}
  button.save{background:#388bfd;color:#fff;border:none;font-weight:600}
  button.save:hover:not(:disabled){background:#4895ff}
  button.danger{color:#f85149;border-color:#4a2329}
  button.danger:hover:not(:disabled){background:#2a1c1f}
  .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:10px 16px;font-size:13px;z-index:80;opacity:0;transition:opacity 180ms ease,transform 220ms ease;pointer-events:none;max-width:90vw;text-align:center}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.ok{color:#7ee787;border-color:#1f4528}
  .toast.err{color:#f85149;border-color:#4a2329}
  .toast.warn{color:#d29922;border-color:#574122}
  .centered-card{max-width:420px;margin:48px auto 0}
  .footer-note{margin-top:18px;color:#7a7f87;font-size:11px;text-align:center;line-height:1.6}
  .footer-note code{color:#c9d1d9;background:#0b0c10;border:1px solid #1f2329;padding:1px 6px;border-radius:3px}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1f2329;vertical-align:middle}
  th{font-weight:500;color:#9aa0a6;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td .username{font-weight:600}
  td .badge{display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:#0b0c10;background:#7cc4ff;padding:2px 8px;border-radius:10px;margin-left:6px;vertical-align:middle}
  td .badge.muted{background:#262c34;color:#9aa0a6}
  td .when{color:#9aa0a6;font-size:11px}
  td.row-actions{text-align:right;white-space:nowrap}
  td.row-actions button{padding:6px 10px;font-size:12px;margin-left:6px}
  @media (max-width:600px){
    td.row-actions button{display:block;width:100%;margin:4px 0 0;padding:7px 8px}
    td.row-actions button:first-child{margin-top:0}
  }
  `;
}

export interface NavItem {
  /** Stable id used to mark the active item. */
  id: string;
  label: string;
  /** Single-glyph icon to match the existing picker drawer. */
  icon: string;
  /** href; if absent, the item is a SPA tab (will be rendered as a span). */
  href?: string;
  /** Admin-only items are hidden unless `isAdmin` passed to navDrawer. */
  adminOnly?: boolean;
}

/**
 * v2 nav drawer. Same shape as the picker's, with two extra v2-only
 * items at the bottom (Account, Users [admin-only]). The picker is the
 * source of truth — keep these ids/icons in sync if the picker drawer
 * changes.
 */
export const V2_NAV: NavItem[] = [
  { id: 'sessions', label: 'Sessions', icon: '▦', href: '/' },
  { id: 'orch',     label: 'Orchestration', icon: '⇄', href: '/orch' },
  { id: 'tokens',   label: 'Tokens', icon: '⚿', href: '/?p=tokens' },
  { id: 'agents',   label: 'Agents', icon: '⌬', href: '/?p=agents' },
  { id: 'logs',     label: 'Logs', icon: '▤', href: '/?p=logs' },
  { id: 'settings', label: 'Settings', icon: '⚙', href: '/?p=settings' },
  { id: 'account',  label: 'Account', icon: '◉', href: '/account' },
  { id: 'users',    label: 'Users', icon: '☷', href: '/admin/users', adminOnly: true },
];

export function navDrawer(opts: { host: string; activeId?: string; isAdmin?: boolean }): string {
  const items = V2_NAV.filter(i => !i.adminOnly || opts.isAdmin)
    .map(item => {
      const active = item.id === opts.activeId ? ' class="active"' : '';
      const href = item.href ? ` href="${escapeHtml(item.href)}"` : '';
      return `    <a${href}${active}><span class="nav-icon">${item.icon}</span>${escapeHtml(item.label)}</a>`;
    }).join('\n');
  return `
<div id="nav-backdrop" aria-hidden="true"></div>
<aside id="nav-drawer" aria-hidden="true">
  <div class="nav-header">
    <span class="nav-brand">LLMUX</span>
    <span class="nav-host">${escapeHtml(opts.host)}</span>
  </div>
  <nav>
${items}
  </nav>
</aside>`;
}

export function brandHeader(opts: { host: string; pageTitle?: string; withNavToggle: boolean }): string {
  const toggle = opts.withNavToggle
    ? `<button id="nav-toggle" aria-label="Open menu" type="button">≡</button>`
    : '';
  const titleSuffix = opts.pageTitle ? ` <span class="host">· ${escapeHtml(opts.pageTitle)}</span>` : '';
  return `
<header>
  <div class="header-controls">
    <h1>${toggle}<span class="brand">LLMUX</span> <span class="host">${escapeHtml(opts.host)}</span>${titleSuffix}</h1>
  </div>
</header>`;
}

export interface PageShellOpts {
  title: string;
  host: string;
  /** Extra <style> rules appended to commonStyles(). */
  extraCss?: string;
  /** Page-body HTML (the part inside the centered-card or main region). */
  body: string;
  /** True for authenticated pages (account, admin/users). False for setup/login. */
  withNav: boolean;
  /** Marks the active nav item when withNav=true. */
  activeNav?: string;
  /** Reveals admin-only nav items. */
  isAdmin?: boolean;
  /** Optional page subtitle shown next to the host name. */
  pageTitle?: string;
  /** JS to run after DOMContentLoaded (no <script> tags — wrapped here). */
  inlineScript?: string;
}

/** Render a complete <!doctype html> page that matches the picker's look. */
export function pageShell(opts: PageShellOpts): string {
  const css = `${commonStyles()}${opts.extraCss ?? ''}`;
  const nav = opts.withNav ? navDrawer({ host: opts.host, ...(opts.activeNav ? { activeId: opts.activeNav } : {}), ...(opts.isAdmin !== undefined ? { isAdmin: opts.isAdmin } : {}) }) : '';
  const header = brandHeader({ host: opts.host, withNavToggle: opts.withNav, ...(opts.pageTitle ? { pageTitle: opts.pageTitle } : {}) });
  const script = opts.inlineScript ? `<script>${opts.inlineScript}</script>` : '';
  const navScript = opts.withNav ? NAV_TOGGLE_SCRIPT : '';
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" href="${FAVICON_DATA_URL}">
<link rel="apple-touch-icon" href="${FAVICON_DATA_URL}">
<meta name="theme-color" content="#0b0c10">
<style>${css}</style>
</head><body>
${nav}
${header}
<main>
${opts.body}
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${navScript}
${script}
</body></html>`;
}

const NAV_TOGGLE_SCRIPT = `<script>
(() => {
  const drawer = document.getElementById('nav-drawer');
  const backdrop = document.getElementById('nav-backdrop');
  const toggle = document.getElementById('nav-toggle');
  if (!drawer || !backdrop || !toggle) return;
  const open = () => { drawer.classList.add('open'); backdrop.classList.add('show'); drawer.setAttribute('aria-hidden','false'); };
  const close = () => { drawer.classList.remove('open'); backdrop.classList.remove('show'); drawer.setAttribute('aria-hidden','true'); };
  toggle.addEventListener('click', () => drawer.classList.contains('open') ? close() : open());
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();
</script>`;

/** Toast helper script — call window.showToast(msg, kind) from page JS. */
export const TOAST_HELPER = `
window.showToast = function(msg, kind){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + (kind || 'ok');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.className = 'toast ' + (kind || 'ok'); }, 3200);
};
`;
