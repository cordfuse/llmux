// Login page — username + passphrase form.
//
// Trust context: SERVICE. Served when an unauthenticated request hits
// any non-public path AND users.json is NOT empty (if it's empty, setup
// gate wins and serves /setup instead).
//
// Visual consistency: pageShell() in layout.ts.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Operator workflows (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Web UI (v2)" — /login row

import { pageShell, escapeHtml, TOAST_HELPER } from './layout.ts';

export function loginPage(opts: { host: string; returnTo?: string }): string {
  const returnToSafe = opts.returnTo ? escapeHtml(opts.returnTo) : '/';
  return pageShell({
    title: `llmux on ${opts.host} · Sign in`,
    host: opts.host,
    withNav: false,
    pageTitle: 'Sign in',
    body: `
<div class="centered-card">
  <div class="about-card">
    <h3>Sign in</h3>
    <form id="login-form" autocomplete="on" novalidate>
      <input type="hidden" name="returnTo" value="${returnToSafe}">
      <div class="field">
        <label for="li-username">Username</label>
        <input id="li-username" name="username" type="text" autocomplete="username" pattern="[a-z0-9_-]+" required autofocus>
      </div>
      <div class="field">
        <label for="li-passphrase">Passphrase</label>
        <input id="li-passphrase" name="passphrase" type="password" autocomplete="current-passphrase" minlength="8" required>
      </div>
      <div class="actions">
        <button type="submit" class="primary" id="li-submit">Sign in</button>
      </div>
    </form>
  </div>
  <p class="footer-note">Forgot your passphrase? Run <code>llmux user reset-passphrase &lt;username&gt;</code> on the daemon host, as the user the daemon runs as (not root/sudo — that would look at the wrong home directory).</p>
</div>`,
    inlineScript: `${TOAST_HELPER}
(() => {
  const form = document.getElementById('login-form');
  const submit = document.getElementById('li-submit');
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    const fd = new FormData(form);
    const body = { username: fd.get('username'), passphrase: fd.get('passphrase') };
    try {
      const r = await fetch('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.token) {
        // The server is expected to set the session cookie out-of-band
        // (Set-Cookie on the response); the body is informational only.
        window.showToast('Signed in — redirecting.', 'ok');
        const dest = fd.get('returnTo') || '/';
        setTimeout(() => location.assign(dest), 400);
      } else {
        window.showToast(data.error || ('sign-in failed (' + r.status + ')'), 'err');
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
