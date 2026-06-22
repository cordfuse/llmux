// First-run setup wizard page.
//
// Trust context: SERVICE. Served only when userStore.isEmpty() AND the
// presented setup token is valid (see auth/setup.ts setupGate()).
//
// Visual consistency: pageShell() in layout.ts (factored from
// pickerPage()'s style block in daemon/web/server.ts).
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Setup wizard — what invokes it (v2)"

import { pageShell, escapeHtml, TOAST_HELPER } from './layout.ts';

/**
 * Render the /setup wizard HTML.
 *
 * Fields: Name, Username (application-layer only — does NOT need to
 * match an OS user; Grafana model), Passphrase + confirm.
 *
 * POSTs to /api/setup with the setup token included in the body.
 * On 200 → location.assign('/').
 * On 400/4xx → toast the error message.
 */
export function setupPage(setupToken: string, host: string): string {
  const tokenSafe = escapeHtml(setupToken);
  return pageShell({
    title: `llmux on ${host} · First-run setup`,
    host,
    withNav: false,
    pageTitle: 'First-run setup',
    body: `
<div class="centered-card">
  <div class="about-card">
    <h3>Create the first user</h3>
    <p class="sub">This account becomes the daemon admin. Pick a passphrase you'll remember — there's no email recovery.</p>
    <form id="setup-form" autocomplete="off" novalidate>
      <input type="hidden" name="setupToken" value="${tokenSafe}">
      <div class="field">
        <label for="su-name">Display name</label>
        <input id="su-name" name="name" type="text" autocomplete="name" required>
      </div>
      <div class="field">
        <label for="su-username">Username</label>
        <input id="su-username" name="username" type="text" pattern="[a-z0-9_-]+" maxlength="32" required>
        <span class="help">Lowercase letters, digits, dashes, underscores. This is also your orchestration alias.</span>
      </div>
      <div class="field">
        <label for="su-passphrase">Passphrase</label>
        <input id="su-passphrase" name="passphrase" type="password" minlength="8" autocomplete="new-password" required>
        <span class="help">Minimum 8 characters.</span>
      </div>
      <div class="field">
        <label for="su-passphrase2">Confirm passphrase</label>
        <input id="su-passphrase2" name="passphrase2" type="password" minlength="8" autocomplete="new-password" required>
        <span class="err" id="su-pp-err" hidden>Passphrases don't match.</span>
      </div>
      <div class="actions">
        <button type="submit" class="primary" id="su-submit">Create admin account</button>
      </div>
    </form>
  </div>
  <p class="footer-note">After setup, run <code>llmux auth login --server &lt;url&gt; --username &lt;u&gt;</code> from any client machine to save credentials.</p>
</div>`,
    inlineScript: `${TOAST_HELPER}
(() => {
  const form = document.getElementById('setup-form');
  const pp = document.getElementById('su-passphrase');
  const pp2 = document.getElementById('su-passphrase2');
  const err = document.getElementById('su-pp-err');
  const submit = document.getElementById('su-submit');
  pp2.addEventListener('input', () => { err.hidden = !pp2.value || pp.value === pp2.value; });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (pp.value !== pp2.value) { err.hidden = false; pp2.focus(); return; }
    submit.disabled = true;
    const fd = new FormData(form);
    const body = { setupToken: fd.get('setupToken'), name: fd.get('name'), username: fd.get('username'), passphrase: fd.get('passphrase') };
    try {
      const r = await fetch('/api/setup', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        window.showToast('Setup complete — redirecting.', 'ok');
        setTimeout(() => location.assign('/'), 600);
      } else {
        window.showToast(data.error || ('setup failed (' + r.status + ')'), 'err');
        submit.disabled = false;
      }
    } catch (e) {
      window.showToast('network error: ' + e.message, 'err');
      submit.disabled = false;
    }
  });
})();`,
  });
}
