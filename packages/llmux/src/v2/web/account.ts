// Account page — change name + passphrase, manage own tokens.
//
// Trust context: SERVICE. Authenticated users only. Sensitive actions
// (passphrase change, token revoke) require re-prompting the current
// passphrase — defense-in-depth per V2-SYSTEM-AUTH-DESIGN.md §
// "Sensitive actions — when re-prompting is OK".
//
// Visual consistency: pageShell() in layout.ts. Drawer present; this
// page lives under the same nav as sessions/orch/tokens/etc.

import { pageShell, escapeHtml, TOAST_HELPER } from './layout.ts';
import type { User } from '../auth/users.ts';
import type { IdentityToken } from '../auth/tokens.ts';

export interface AccountPageData {
  host: string;
  user: User;
  tokens: IdentityToken[];
}

export function accountPage(data: AccountPageData): string {
  const userJson = JSON.stringify({ username: data.user.username, name: data.user.name, admin: data.user.admin });
  const tokensJson = JSON.stringify(data.tokens.map(t => ({
    tokenId: t.tokenId, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt,
  })));
  return pageShell({
    title: `llmux on ${data.host} · Account`,
    host: data.host,
    withNav: true,
    activeNav: 'account',
    isAdmin: data.user.admin,
    pageTitle: 'Account',
    body: `
<section class="about-card">
  <h3>Profile</h3>
  <div class="field">
    <label>Username</label>
    <input id="ac-username" type="text" value="${escapeHtml(data.user.username)}" readonly disabled>
    <span class="help">Usernames are immutable. Username rename = delete + recreate (admin).</span>
  </div>
  <form id="ac-profile-form">
    <div class="field">
      <label for="ac-name">Display name</label>
      <input id="ac-name" name="name" type="text" value="${escapeHtml(data.user.name)}" required>
    </div>
    <div class="actions">
      <button type="submit" class="primary">Save profile</button>
    </div>
  </form>
</section>

<section class="about-card">
  <h3>Change passphrase</h3>
  <p class="sub">You'll be signed out of this device after saving. Re-sign-in with the new passphrase.</p>
  <form id="ac-pp-form" autocomplete="off">
    <div class="field">
      <label for="ac-pp-old">Current passphrase</label>
      <input id="ac-pp-old" name="oldPassphrase" type="password" required>
    </div>
    <div class="field">
      <label for="ac-pp-new">New passphrase</label>
      <input id="ac-pp-new" name="newPassphrase" type="password" minlength="8" required>
    </div>
    <div class="field">
      <label for="ac-pp-confirm">Confirm new passphrase</label>
      <input id="ac-pp-confirm" name="confirm" type="password" minlength="8" required>
      <span class="err" id="ac-pp-err" hidden>Passphrases don't match.</span>
    </div>
    <div class="actions">
      <button type="submit" class="primary">Update passphrase</button>
    </div>
  </form>
</section>

<section class="about-card">
  <h3>Active tokens</h3>
  <p class="sub">Each row is a device or CLI that has signed in as you. Revoke any you don't recognise.</p>
  <table id="ac-tokens">
    <thead><tr><th>Device</th><th>Created</th><th>Last used</th><th></th></tr></thead>
    <tbody id="ac-tokens-tbody"></tbody>
  </table>
</section>`,
    inlineScript: `${TOAST_HELPER}
(() => {
  const me = ${userJson};
  const tokens = ${tokensJson};

  // Profile save
  const pForm = document.getElementById('ac-profile-form');
  pForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(pForm);
    try {
      const r = await fetch('/api/account/profile', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ name: fd.get('name') }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) window.showToast('Profile saved.', 'ok');
      else window.showToast(data.error || ('save failed (' + r.status + ')'), 'err');
    } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
  });

  // Passphrase change
  const ppForm = document.getElementById('ac-pp-form');
  const ppNew = document.getElementById('ac-pp-new');
  const ppConfirm = document.getElementById('ac-pp-confirm');
  const ppErr = document.getElementById('ac-pp-err');
  ppConfirm.addEventListener('input', () => { ppErr.hidden = !ppConfirm.value || ppNew.value === ppConfirm.value; });
  ppForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (ppNew.value !== ppConfirm.value) { ppErr.hidden = false; ppConfirm.focus(); return; }
    const fd = new FormData(ppForm);
    try {
      const r = await fetch('/api/account/passphrase', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ oldPassphrase: fd.get('oldPassphrase'), newPassphrase: fd.get('newPassphrase') }) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        window.showToast('Passphrase updated — signing out.', 'ok');
        setTimeout(() => location.assign('/login'), 800);
      } else {
        window.showToast(data.error || ('passphrase change failed (' + r.status + ')'), 'err');
      }
    } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
  });

  // Tokens table
  function fmt(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }
  function render() {
    const tbody = document.getElementById('ac-tokens-tbody');
    tbody.innerHTML = '';
    if (tokens.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#7a7f87;font-style:italic;text-align:center;padding:18px">No active tokens.</td></tr>';
      return;
    }
    for (const t of tokens) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td><span class="username">' + escapeText(t.name || 'unnamed') + '</span></td>' +
                     '<td class="when">' + fmt(t.createdAt) + '</td>' +
                     '<td class="when">' + fmt(t.lastUsedAt) + '</td>' +
                     '<td class="row-actions"><button class="danger" data-id="' + t.tokenId + '">Revoke</button></td>';
      tbody.appendChild(tr);
    }
    for (const btn of tbody.querySelectorAll('button.danger')) {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this token? Any session using it will be signed out.')) return;
        const id = btn.dataset.id;
        try {
          const r = await fetch('/api/tokens/' + encodeURIComponent(id), { method:'DELETE' });
          if (r.ok) {
            const idx = tokens.findIndex(t => t.tokenId === id);
            if (idx >= 0) tokens.splice(idx, 1);
            render();
            window.showToast('Token revoked.', 'ok');
          } else {
            const d = await r.json().catch(() => ({}));
            window.showToast(d.error || 'revoke failed', 'err');
          }
        } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
      });
    }
  }
  function escapeText(s) { const div = document.createElement('div'); div.textContent = s || ''; return div.innerHTML; }
  render();
})();`,
  });
}
