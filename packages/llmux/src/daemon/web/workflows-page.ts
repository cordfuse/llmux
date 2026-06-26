// /w — Workflows page. Lists open + recent workflows and offers a
// compose form that talks to /api/workflows/compose + /submit.
//
// Workflow state is reconstructed each request by walking channel
// messages for `type: workflow` markers + inspecting the child channel's
// PLAN.json + COMPLETE files (see workflow-summary.ts).

import { collectWorkflowSummaries, readChannelMeta, type WorkflowSummary } from '../../orch/workflow-summary.ts';
import { discoverChannels } from '../../orch/transport.ts';
import { loadRegistry } from '../../orch/models.ts';

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

  // Compose-form supporting data: claimed models + existing channels.
  // Either source missing → warnings render + compose button disabled.
  let claimedModels: string[] = [];
  try { claimedModels = [...loadRegistry(transportRoot).claimed.keys()]; } catch { /* no models.yaml */ }
  const channels = discoverChannels(transportRoot).map((u) => {
    const meta = readChannelMeta(transportRoot, u);
    return { uuid: u, name: meta.name };
  });
  const channelOptions = channels.length === 0
    ? '<option value="" disabled>(no channels — create one via Channels first)</option>'
    : channels.map((c) => {
        const label = c.name ?? c.uuid.slice(0, 8) + '…';
        return `<option value="${escapeHtml(c.name ?? c.uuid)}">${escapeHtml(label)}</option>`;
      }).join('');
  const compilerOptions = claimedModels.length === 0
    ? '<option value="" disabled>(no claimed models — populate data/crosstalk.yaml + restart)</option>'
    : claimedModels.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  const canCompose = claimedModels.length > 0 && channels.length > 0;
  const warnings: string[] = [];
  if (claimedModels.length === 0) warnings.push('No claimed models — the compiler can\'t run. Populate <code>data/crosstalk.yaml</code> under the transport root with at least one provider+model whose CLI is on PATH, then restart the daemon.');
  if (channels.length === 0) warnings.push('No channels exist yet — create one via the <a href="/orch" style="color:#7cc4ff">Channels</a> page first.');
  const warningBlock = warnings.length === 0 ? '' : warnings.map((w) =>
    `<p style="background:#3c2a10;color:#d29922;border:1px solid #574122;border-radius:6px;padding:8px 10px;margin:0 0 12px;font-size:11px">⚠ ${w}</p>`,
  ).join('');

  const composeCard = `
<section class="card" id="compose-card">
  <h3>Compose new workflow</h3>
  <p class="sub">Describe what you want in plain English; the compiler agent turns it into a fanout/synthesize plan you can review and edit before submitting. The dispatcher then runs the plan deterministically.</p>
  ${warningBlock}
  <div id="compose-step-prompt">
    <div class="field">
      <label for="cw-prompt">prompt</label>
      <textarea id="cw-prompt" rows="4" placeholder="e.g. compare how claude, codex, and gemini would refactor src/auth/users.ts to use bun's built-in crypto instead of node:crypto"></textarea>
    </div>
    <div class="field">
      <label for="cw-compiler">compiler agent</label>
      <select id="cw-compiler"${claimedModels.length === 0 ? ' disabled' : ''}>${compilerOptions}</select>
    </div>
    <div class="field">
      <label for="cw-channel">target channel</label>
      <select id="cw-channel"${channels.length === 0 ? ' disabled' : ''}>${channelOptions}</select>
    </div>
    <div class="actions">
      <button type="button" class="primary" id="cw-compile"${!canCompose ? ' disabled title="resolve the warnings above first"' : ''}>Compile preview</button>
    </div>
  </div>
  <div id="compose-step-preview" style="display:none">
    <p class="sub">Review the compiled plan. Edit the YAML if anything looks off — common fixes: the <code>to:</code> model identity, the <code>count:</code> integer, or the <code>body:</code> instructions. On submit, the engine writes <code>PLAN.json</code> verbatim and dispatches without re-compiling.</p>
    <div id="cw-summary" style="background:#0b0c10;border:1px solid #1f2329;border-radius:6px;padding:10px;margin-bottom:10px;font-size:12px"></div>
    <div class="field">
      <label for="cw-prompt-readback">your prompt (committed as the workflow marker body)</label>
      <textarea id="cw-prompt-readback" rows="3" readonly style="font:12px ui-monospace,monospace;background:#0b0c10;color:#c9d1d9;opacity:.85;cursor:default"></textarea>
    </div>
    <div class="field">
      <label for="cw-yaml">plan (yaml)</label>
      <textarea id="cw-yaml" rows="12" spellcheck="false" style="font:12px ui-monospace,monospace"></textarea>
    </div>
    <div class="actions" style="justify-content:space-between">
      <button type="button" id="cw-cancel">← Cancel</button>
      <button type="button" class="primary" id="cw-submit">Submit workflow →</button>
    </div>
  </div>
  <div id="compose-status" style="margin-top:10px;font-size:12px;color:#7a7f87;min-height:18px"></div>
</section>`;

  const body = `${composeCard}
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
  .field{margin-bottom:10px;display:flex;flex-direction:column;gap:4px}
  .field label{font-size:11px;color:#9aa0a6;text-transform:uppercase;letter-spacing:.05em}
  .field input,.field textarea,.field select{background:#0b0c10;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 10px;font:13px ui-monospace,monospace;outline:none;width:100%;box-sizing:border-box;resize:vertical}
  .field input:focus,.field textarea:focus,.field select:focus{border-color:#2d4a66}
  .field select:disabled,.field textarea:disabled,.field input:disabled{opacity:.5;cursor:not-allowed}
  .actions{display:flex;gap:10px;align-items:center;margin-top:6px}
  .actions button{background:#1c2128;color:#e6e8eb;border:1px solid #262c34;border-radius:6px;padding:8px 14px;font:13px ui-monospace,monospace;cursor:pointer}
  .actions button:hover:not(:disabled){background:#252b34;border-color:#3a414b}
  .actions button.primary{background:#11192b;color:#7cc4ff;border-color:#2d4a66;font-weight:600}
  .actions button.primary:hover:not(:disabled){background:#1a2842}
  .actions button:disabled{opacity:.5;cursor:not-allowed}
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
document.querySelectorAll('#nav-drawer a[data-page]').forEach(a => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    try { localStorage.setItem('llmux.page', a.dataset.page); } catch(_) {}
    location.href = '/';
  });
});

// ---- Compose flow ----
const promptStep = document.getElementById('compose-step-prompt');
const previewStep = document.getElementById('compose-step-preview');
const statusEl = document.getElementById('compose-status');
const yamlInput = document.getElementById('cw-yaml');
const summaryEl = document.getElementById('cw-summary');
let lastPrompt = '';
let lastChannel = '';

function setStatus(msg, isErr){
  statusEl.textContent = msg || '';
  statusEl.style.color = isErr ? '#f85149' : '#7a7f87';
}
function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function renderSummary(plan){
  summaryEl.innerHTML =
    '<div><span style="color:#9aa0a6">fanout:</span> <span style="color:#7cc4ff">' + esc(plan.fanout.to) + '</span> &times; <strong>' + plan.fanout.count + '</strong></div>' +
    '<div style="margin-top:4px"><span style="color:#9aa0a6">synthesize:</span> <span style="color:#a371f7">' + esc(plan.synthesize.to) + '</span></div>';
}

const compileBtn = document.getElementById('cw-compile');
let compileInFlight = false;
if (compileBtn) {
  compileBtn.addEventListener('click', async () => {
    if (compileInFlight) return;
    const prompt = document.getElementById('cw-prompt').value.trim();
    const compiler = document.getElementById('cw-compiler').value;
    const channel = document.getElementById('cw-channel').value;
    if (!prompt){ setStatus('prompt required', true); return; }
    lastPrompt = prompt;
    lastChannel = channel;
    compileInFlight = true;
    compileBtn.disabled = true;
    const originalLabel = compileBtn.textContent;
    compileBtn.textContent = 'Compiling…';
    setStatus('compiling — this may take a moment…');
    try {
      const r = await fetch('/api/workflows/compose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, compilerAgent: compiler }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok){
        setStatus(body.error || 'compile failed', true);
        if (body.rawOutput) console.log('compiler raw output:', body.rawOutput);
        return;
      }
      yamlInput.value = body.yaml;
      document.getElementById('cw-prompt-readback').value = lastPrompt;
      renderSummary(body.plan);
      promptStep.style.display = 'none';
      previewStep.style.display = 'block';
      setStatus('compiled by ' + body.compiler + ' — review and edit before submitting');
    } catch (e){ setStatus('error: ' + e.message, true); }
    finally {
      compileInFlight = false;
      compileBtn.disabled = false;
      compileBtn.textContent = originalLabel;
    }
  });
}

const cancelBtn = document.getElementById('cw-cancel');
if (cancelBtn) {
  cancelBtn.addEventListener('click', () => {
    previewStep.style.display = 'none';
    promptStep.style.display = 'block';
    setStatus('');
  });
}

const submitBtn = document.getElementById('cw-submit');
let submitInFlight = false;
if (submitBtn) {
  submitBtn.addEventListener('click', async () => {
    if (submitInFlight) return;
    const yaml = yamlInput.value;
    if (!yaml.trim()){ setStatus('yaml is empty', true); return; }
    submitInFlight = true;
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    yamlInput.readOnly = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Submitting…';
    setStatus('submitting — committing workflow marker + PLAN.json…');
    try {
      const r = await fetch('/api/workflows/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml, channel: lastChannel, prompt: lastPrompt }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok){
        setStatus(body.error || 'submit failed', true);
        submitInFlight = false;
        submitBtn.disabled = false;
        cancelBtn.disabled = false;
        yamlInput.readOnly = false;
        submitBtn.textContent = originalLabel;
        return;
      }
      // Success — reload to show the new workflow in the Open list.
      setStatus('submitted — reloading…');
      setTimeout(() => location.reload(), 500);
    } catch (e){
      setStatus('error: ' + e.message, true);
      submitInFlight = false;
      submitBtn.disabled = false;
      cancelBtn.disabled = false;
      yamlInput.readOnly = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

// Auto-refresh every 5s while open workflows exist (so phase transitions
// surface without a manual reload). Skip if compose is in progress to
// avoid clobbering operator input.
${open.length > 0 ? `setTimeout(() => {
  if (compileInFlight || submitInFlight) return;
  if (previewStep.style.display !== 'none') return;
  location.reload();
}, 5000);` : ''}
</script>
</body></html>`;
}
