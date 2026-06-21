// Admin-only user CRUD page.
//
// Trust context: SERVICE. Only admin tokens may load this page; non-
// admin users get 403 and the drawer item is hidden in their nav.
//
// Visual consistency: pageShell() in layout.ts. Drawer present; the
// 'Users' item is rendered active.

import { pageShell, escapeHtml, TOAST_HELPER } from './layout.ts';
import type { User } from '../auth/users.ts';

export interface AdminUsersPageData {
  host: string;
  currentUser: User;
  users: User[];
}

export function adminUsersPage(data: AdminUsersPageData): string {
  // Serialize without passphraseHash (defense-in-depth — don't leak hash to client).
  const usersJson = JSON.stringify(data.users.map(u => ({
    username: u.username, name: u.name, admin: u.admin, createdAt: u.createdAt,
  })));
  const meUsername = escapeHtml(data.currentUser.username);

  return pageShell({
    title: `llmux on ${data.host} · Users`,
    host: data.host,
    withNav: true,
    activeNav: 'users',
    isAdmin: true,
    pageTitle: 'Users',
    extraCss: `
  .toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
  .toolbar .spacer{flex:1}
  #user-create-form{background:#11141a;border:1px solid #1f2329;border-radius:8px;padding:14px;margin-bottom:14px;display:none}
  #user-create-form.open{display:block}
  .toggle-admin{display:inline-flex;align-items:center;gap:8px;color:#c9d1d9;font-size:12px;cursor:pointer}
  .toggle-admin input{margin:0;accent-color:#7cc4ff}
  .reveal-pp{margin-top:6px;font-size:11px;color:#7cc4ff;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font-family:inherit}
`,
    body: `
<div class="toolbar">
  <button class="primary" id="open-create">+ new user</button>
  <div class="spacer"></div>
  <span style="font-size:11px;color:#7a7f87">${data.users.length} user${data.users.length === 1 ? '' : 's'}</span>
</div>

<div id="user-create-form">
  <h3 style="margin:0 0 12px;font-size:13px;color:#c9d1d9;font-weight:600">Create user</h3>
  <form id="uc-form" autocomplete="off">
    <div class="field">
      <label for="uc-username">Username</label>
      <input id="uc-username" name="username" type="text" pattern="[a-z0-9_-]+" maxlength="32" required>
    </div>
    <div class="field">
      <label for="uc-name">Display name</label>
      <input id="uc-name" name="name" type="text" required>
    </div>
    <div class="field">
      <label for="uc-passphrase">Initial passphrase</label>
      <input id="uc-passphrase" name="passphrase" type="password" minlength="8" required>
      <span class="help">You'll need to share this out-of-band with the new user. They can change it on first sign-in.</span>
    </div>
    <div class="field">
      <label class="toggle-admin"><input type="checkbox" id="uc-admin" name="admin"> Grant admin (create/delete users, mint tokens for others)</label>
    </div>
    <div class="actions">
      <button type="button" id="uc-cancel">Cancel</button>
      <button type="submit" class="primary">Create</button>
    </div>
  </form>
</div>

<table id="users-table">
  <thead><tr><th>Username</th><th>Name</th><th>Created</th><th></th></tr></thead>
  <tbody id="users-tbody"></tbody>
</table>`,
    inlineScript: `${TOAST_HELPER}
(() => {
  const users = ${usersJson};
  const me = '${meUsername}';

  const form = document.getElementById('user-create-form');
  document.getElementById('open-create').addEventListener('click', () => form.classList.toggle('open'));
  document.getElementById('uc-cancel').addEventListener('click', () => form.classList.remove('open'));

  const ucForm = document.getElementById('uc-form');
  ucForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ucForm);
    const body = {
      username: fd.get('username'),
      name: fd.get('name'),
      passphrase: fd.get('passphrase'),
      admin: document.getElementById('uc-admin').checked,
    };
    try {
      const r = await fetch('/api/admin/users', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        users.push({ username: body.username, name: body.name, admin: body.admin, createdAt: new Date().toISOString() });
        render();
        form.classList.remove('open');
        ucForm.reset();
        window.showToast('User created.', 'ok');
      } else {
        window.showToast(data.error || ('create failed (' + r.status + ')'), 'err');
      }
    } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
  });

  function fmt(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }
  function escapeText(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

  function render() {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#7a7f87;font-style:italic;text-align:center;padding:18px">No users.</td></tr>';
      return;
    }
    for (const u of users) {
      const tr = document.createElement('tr');
      const adminBadge = u.admin ? '<span class="badge">admin</span>' : '';
      const selfBadge = u.username === me ? '<span class="badge muted">you</span>' : '';
      const deleteBtn = u.username === me
        ? '<button disabled title="You cannot delete your own account">Delete</button>'
        : '<button class="danger" data-act="delete" data-u="' + escapeText(u.username) + '">Delete</button>';
      tr.innerHTML = '<td><span class="username">' + escapeText(u.username) + '</span>' + selfBadge + adminBadge + '</td>' +
                     '<td>' + escapeText(u.name) + '</td>' +
                     '<td class="when">' + fmt(u.createdAt) + '</td>' +
                     '<td class="row-actions"><button data-act="reset" data-u="' + escapeText(u.username) + '">Reset pass</button>' + deleteBtn + '</td>';
      tbody.appendChild(tr);
    }
    wire();
  }

  function wire() {
    for (const btn of document.querySelectorAll('button[data-act="delete"]')) {
      btn.addEventListener('click', async () => {
        const u = btn.dataset.u;
        if (!confirm('Delete user ' + u + '? All their tokens will be revoked and orch claims released.')) return;
        try {
          const r = await fetch('/api/admin/users/' + encodeURIComponent(u), { method:'DELETE' });
          if (r.ok) {
            const i = users.findIndex(x => x.username === u);
            if (i >= 0) users.splice(i, 1);
            render();
            window.showToast('User deleted.', 'ok');
          } else {
            const d = await r.json().catch(() => ({}));
            window.showToast(d.error || 'delete failed', 'err');
          }
        } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
      });
    }
    for (const btn of document.querySelectorAll('button[data-act="reset"]')) {
      btn.addEventListener('click', async () => {
        const u = btn.dataset.u;
        const pw = prompt('New passphrase for ' + u + ' (≥8 chars). You will need to share it out-of-band.');
        if (!pw) return;
        if (pw.length < 8) { window.showToast('Passphrase must be at least 8 characters.', 'err'); return; }
        try {
          const r = await fetch('/api/admin/users/' + encodeURIComponent(u) + '/passphrase', {
            method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ newPassphrase: pw }),
          });
          if (r.ok) window.showToast('Passphrase reset for ' + u + '.', 'ok');
          else { const d = await r.json().catch(() => ({})); window.showToast(d.error || 'reset failed', 'err'); }
        } catch (e) { window.showToast('network error: ' + e.message, 'err'); }
      });
    }
  }

  render();
})();`,
  });
}
