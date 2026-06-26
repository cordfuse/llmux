// /w — Workflows page. Read-only list of open + completed workflows
// inferred from the orch transport. v1 ships without a detail page or
// in-browser compose form — operators submit via `llmux workflow run
// <file>` (CLI) or POST /api/workflows/submit (HTTP).

import { collectWorkflowSummaries, type WorkflowSummary } from '../../orch/workflow-summary.ts';

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function phaseBadge(p: WorkflowSummary['phase']): string {
  const styles: Record<WorkflowSummary['phase'], { color: string; bg: string; label: string }> = {
    pending_compile: { color: '#d29922', bg: '#574122', label: 'COMPILING' },
    fanout:          { color: '#7cc4ff', bg: '#2d4a66', label: 'FANOUT'    },
    synthesize:      { color: '#a371f7', bg: '#3c2a59', label: 'SYNTHESIZE'},
    complete:        { color: '#7ee787', bg: '#1f4528', label: 'COMPLETE'  },
    failed:          { color: '#f85149', bg: '#4a2329', label: 'FAILED'    },
  };
  const s = styles[p];
  return `<span style="display:inline-block;color:${s.color};background:${s.bg}33;border:1px solid ${s.bg};border-radius:10px;padding:2px 9px;font-size:10px;font-weight:600;letter-spacing:.05em">${s.label}</span>`;
}

function renderRow(w: WorkflowSummary): string {
  const parentLabel = w.parentChannelName ?? w.parentChannelUuid.slice(0, 8) + '…';
  const fanout = w.phase === 'pending_compile' ? '—' : `${w.fanoutReplied}/${w.fanoutTotal}`;
  return `<div style="display:block;padding:12px 4px;border-bottom:1px solid #1f2329">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <span><span style="display:inline-block;background:#11192b;color:#7cc4ff;border:1px solid #2d4a66;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600">${escapeHtml(w.childChannelUuid.slice(0, 8))}…</span> in <span style="color:#a371f7">${escapeHtml(parentLabel)}</span></span>
      ${phaseBadge(w.phase)}
    </div>
    <div style="margin-top:6px;font-size:11px;color:#7a7f87">
      from <span style="color:#7cc4ff">${escapeHtml(w.markerFrom)}</span>
      · fanout ${fanout}${w.dispatchHost ? ` · host <span style="color:#a371f7">${escapeHtml(w.dispatchHost)}</span>` : ''}
    </div>
  </div>`;
}

export function workflowsPage(
  host: string,
  faviconDataUrl: string,
  renderNavDrawer: (host: string, activeId: string) => string,
  transportRoot: string,
): string {
  const summaries = collectWorkflowSummaries(transportRoot);
  const open = summaries.filter((w) => w.phase !== 'complete' && w.phase !== 'failed');
  const closed = summaries.filter((w) => w.phase === 'complete' || w.phase === 'failed');

  const body = `
<section class="card">
  <h3>Open workflows (${open.length})</h3>
  <p class="sub">Compile → fanout → synthesize is in flight. The runtime advances these deterministically per dispatcher tick (no LLM orchestrator).</p>
  ${open.length === 0 ? '<p class="empty">No open workflows yet.</p>' : open.map(renderRow).join('')}
</section>

<section class="card">
  <h3>Recent (${closed.length})</h3>
  <p class="sub">Completed (synthesis replied successfully) or failed (compile error, dispatcher crash, etc.).</p>
  ${closed.length === 0 ? '<p class="empty">No completed workflows yet.</p>' : closed.slice(0, 20).map(renderRow).join('')}
</section>

<section class="card">
  <h3>Submit a workflow</h3>
  <p class="sub">v1 ships read-only in the browser. Submit a pre-authored workflow YAML via:</p>
  <pre style="background:#0b0c10;border:1px solid #1f2329;border-radius:6px;padding:10px;font-size:12px;color:#c9d1d9;overflow-x:auto">llmux workflow run path/to/plan.yaml --channel main</pre>
  <p class="sub">Or POST the YAML body to <code>/api/workflows/submit</code> as <code>{"yaml":"…","channel":"main"}</code>.</p>
</section>
`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>llmux on ${escapeHtml(host)} · Workflows</title>
<link rel="icon" href="${faviconDataUrl}">
<link rel="apple-touch-icon" href="${faviconDataUrl}">
<meta name="theme-color" content="#0b0c10">
<style>
  :root{color-scheme:dark}
  html,body{margin:0;background:#0b0c10;color:#e6e8eb;font-family:ui-monospace,monospace;font-size:14px;overflow-x:hidden}
  body{padding:18px 16px 80px;max-width:980px;margin:0 auto;box-sizing:border-box}
  header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  h1{font-size:18px;margin:0}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em;font-weight:600}
  h1 .host{color:#a371f7;font-weight:500}
  #nav-toggle{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:18px;line-height:1;flex:0 0 auto}
  #nav-toggle:hover{background:#252b34;border-color:#3a414b}
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
  .card{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:14px 16px;margin-bottom:14px}
  .card h3{margin:0 0 6px;font-size:14px;color:#e6e8eb;letter-spacing:.02em}
  .card .sub{margin:0 0 10px;font-size:11px;color:#7a7f87;line-height:1.5}
  .card .empty{margin:0;font-size:12px;color:#7a7f87;font-style:italic}
  code{font-family:ui-monospace,monospace;color:#c9d1d9;background:#0b0c10;border:1px solid #1f2329;padding:1px 5px;border-radius:3px;font-size:12px}
</style>
</head>
<body>
${renderNavDrawer(host, 'workflows')}
<header>
  <button id="nav-toggle" aria-label="Open navigation">☰</button>
  <h1><span class="brand">LLMUX</span> on <span class="host">${escapeHtml(host)}</span> · Workflows</h1>
</header>
${body}
<script>
const navDrawer = document.getElementById('nav-drawer');
const navBackdrop = document.getElementById('nav-backdrop');
const navToggle = document.getElementById('nav-toggle');
function openNav(){ navDrawer.classList.add('open'); navBackdrop.classList.add('show'); }
function closeNav(){ navDrawer.classList.remove('open'); navBackdrop.classList.remove('show'); }
navToggle.addEventListener('click', openNav);
navBackdrop.addEventListener('click', closeNav);
// Drawer items with data-page navigate via picker; href items navigate normally.
document.querySelectorAll('#nav-drawer a[data-page]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.setItem('llmux.page', a.dataset.page); } catch(_) {}
    location.href = '/';
  });
});
// Auto-refresh every 5s while open workflows exist (cheap; same pattern as orch).
${open.length > 0 ? 'setTimeout(() => location.reload(), 5000);' : ''}
</script>
</body></html>`;
}
