// v2 auth routes + page renderers bolted onto the v1 daemon.
//
// Strategy: keep v1 + v2 auth systems independent (v1 uses SAS tokens
// gated by isAuthorized; v2 uses identity-bound tokens + session cookies
// gated by v2/auth/middleware). Both run side-by-side on the same port —
// the v1 picker continues to use llmuxd_token cookie; v2 pages use
// llmux_session cookie. No cross-contamination.
//
// Routes handled here:
//   GET  /setup                    — wizard (public)
//   POST /api/setup                — wizard submit + auto-sign-in
//   GET  /login                    — sign-in form (public)
//   POST /api/auth/login           — v2 login + set llmux_session
//   POST /api/auth/logout          — clear llmux_session + revoke token
//   GET  /account                  — profile + passphrase + own tokens
//   POST /api/account/profile      — update display name
//   POST /api/account/passphrase   — rotate passphrase
//   DELETE /api/tokens/:id         — revoke own (or any-if-admin) v2 token
//   GET  /admin/users              — user CRUD page (admin only)
//   POST /api/admin/users          — create user
//   DELETE /api/admin/users/:u     — delete user
//   POST /api/admin/users/:u/passphrase — admin reset
//
// Returns true if the request was a v2 route AND was handled; false
// otherwise (caller continues to v1 auth + route table).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

import { FileUserStore } from '../v2/auth/users.ts';
import { FileTokenStore } from '../v2/auth/tokens.ts';
import {
  SetupState, handleSetupSubmit, setupBanner,
} from '../v2/auth/setup.ts';
import {
  authenticateRequest, sessionCookieFor, clearSessionCookie,
  type AuthSuccess,
} from '../v2/auth/middleware.ts';
import type { User } from '../v2/auth/users.ts';
import {
  handleLogin, handleLogout, handleProfileUpdate, handlePassphraseChange,
  handleRevokeToken, handleAdminCreateUser, handleAdminDeleteUser,
  handleAdminResetPassphrase,
} from '../v2/auth/handlers.ts';
import { requireAdmin } from '../v2/auth/enforce.ts';
import { setupPage } from '../v2/web/setup.ts';
import { loginPage } from '../v2/web/login.ts';
import { accountPage } from '../v2/web/account.ts';
import { adminUsersPage } from '../v2/web/admin-users.ts';

// ── singleton state ─────────────────────────────────────────────────────
//
// startServer() calls initV2Routes(port) once at boot — it constructs the
// stores, mints the setup token if users.json is empty, logs the URL.
// Subsequent per-request calls to tryV2Route() reuse this singleton.

let v2: V2Singleton | undefined;

interface V2Singleton {
  users: FileUserStore;
  tokens: FileTokenStore;
  setup: SetupState;
  dataDir: string;
}

function v2Paths() {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  const dataDir = join(base, 'llmux', 'v2');
  return {
    dataDir,
    usersPath: join(dataDir, 'users.json'),
    tokensPath: join(dataDir, 'tokens.json'),
    setupTokenPath: join(dataDir, 'setup-token'),
  };
}

/**
 * Look up the v2 user signed in to this request (via llmux_session cookie
 * or Authorization: Bearer). Returns undefined if v2 isn't initialised,
 * no credential is presented, or it fails to validate. Use this from v1
 * handlers that want to layer in v2 identity (e.g., the orch page).
 */
export async function getV2User(req: IncomingMessage): Promise<User | undefined> {
  if (!v2) return undefined;
  const auth = await authenticateRequest(req, { tokenStore: v2.tokens, userStore: v2.users });
  return auth.ok ? auth.user : undefined;
}

/**
 * Expose the singleton v2 stores so /api/tokens (in server.ts) can mint +
 * list + revoke identity tokens against the same userStore + tokenStore
 * that v2 login uses. Returns undefined before initV2Routes() has run.
 */
export function getV2Stores(): { users: FileUserStore; tokens: FileTokenStore } | undefined {
  if (!v2) return undefined;
  return { users: v2.users, tokens: v2.tokens };
}

export async function initV2Routes(port: number): Promise<void> {
  const p = v2Paths();
  if (!existsSync(p.dataDir)) mkdirSync(p.dataDir, { recursive: true });
  const users = new FileUserStore(p.usersPath);
  const tokens = new FileTokenStore(p.tokensPath);
  const setup = new SetupState(p.setupTokenPath);
  v2 = { users, tokens, setup, dataDir: p.dataDir };

  if (await users.isEmpty()) {
    const rec = setup.mint();
    const host = hostname();
    const url = `http://${host}:${port}/setup?token=${rec.token}`;
    console.log(setupBanner(url));
    console.log(`  Local equivalent: http://localhost:${port}/setup?token=${rec.token}`);
  } else {
    const count = (await users.listUsers()).length;
    console.log(`  [v2] auth ready (${count} user${count === 1 ? '' : 's'}); /login, /account, /admin/users available`);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function jsonResp(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function htmlResp(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { location: to });
  res.end();
}

/**
 * v2 route paths the picker drawer's Account + Users items point at.
 * Used by isV2Path() to recognise paths that belong to v2 so we can
 * apply v2 auth instead of v1.
 */
const V2_PUBLIC_PATHS = new Set(['/setup', '/login', '/api/setup', '/api/auth/login']);
const V2_AUTHED_PATH_PREFIXES = [
  '/account', '/admin/users',
  '/api/auth/logout', '/api/account/', '/api/admin/users',
];
const V2_TOKEN_DELETE_RE = /^\/api\/tokens\/[^/]+$/;

export function isV2Path(path: string, method: string): boolean {
  if (V2_PUBLIC_PATHS.has(path)) return true;
  for (const prefix of V2_AUTHED_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(prefix)) return true;
  }
  // DELETE /api/tokens/:id is the v2 own-token revoke. The v1 daemon also
  // has a /api/tokens namespace for SAS tokens — but uses GET/POST and
  // DELETE for that. Resolve by method: DELETE on /api/tokens/<id> with
  // a v2 session cookie is a v2 own-token revoke; without a v2 session,
  // fall through to v1 (which also handles DELETE /api/tokens/:id for
  // its own SAS tokens). We pick v2 when method=DELETE AND a v2 session
  // is presented — tryV2Route resolves that by checking the cookie first.
  if (method === 'DELETE' && V2_TOKEN_DELETE_RE.test(path)) return true;
  return false;
}

// ── main entry: tryV2Route ──────────────────────────────────────────────

/**
 * Dispatch a request to v2 routes if it matches. Returns true if the
 * request was handled (response written), false if the caller should
 * continue with v1 routing.
 *
 * Auth model: public v2 paths (/setup, /login, their API submits) need
 * no auth. Authed v2 paths use the llmux_session cookie via the v2
 * middleware (which also accepts Authorization: Bearer for CLI clients).
 * v1 SAS cookies are ignored here — the two systems don't bleed.
 */
export async function tryV2Route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!v2) return false;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // DELETE /api/tokens/:id — v2 only if a v2 session is presented.
  // Otherwise let v1 handle (SAS token revoke).
  const isDeleteToken = method === 'DELETE' && V2_TOKEN_DELETE_RE.test(path);
  if (isDeleteToken) {
    const auth = await authenticateRequest(req, { tokenStore: v2.tokens, userStore: v2.users });
    if (!auth.ok) return false; // not a v2 caller; let v1 handle
    const id = path.slice('/api/tokens/'.length);
    const r = await handleRevokeToken(id, auth.user, v2.tokens);
    jsonResp(res, r.status, r.body);
    return true;
  }

  if (!isV2Path(path, method)) return false;

  const host = hostname();

  try {
    // ── Public v2 routes ───────────────────────────────────────────────
    if (path === '/setup' && method === 'GET') {
      const token = url.searchParams.get('token') ?? '';
      htmlResp(res, 200, setupPage(token, host));
      return true;
    }
    if (path === '/api/setup' && method === 'POST') {
      const body = await parseJsonBody(req) as { setupToken?: string; name?: string; username?: string; passphrase?: string };
      const r = await handleSetupSubmit({
        setupToken: body.setupToken ?? '',
        name: body.name ?? '',
        username: body.username ?? '',
        passphrase: body.passphrase ?? '',
      }, v2.users, v2.tokens, v2.setup);
      if (r.ok && r.bootstrapToken) {
        jsonResp(res, 200, r, { 'set-cookie': sessionCookieFor(r.bootstrapToken.plaintextSecret) });
      } else {
        jsonResp(res, r.ok ? 200 : 400, r);
      }
      return true;
    }
    if (path === '/login' && method === 'GET') {
      const returnTo = url.searchParams.get('returnTo') ?? '/account';
      htmlResp(res, 200, loginPage({ host, returnTo }));
      return true;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      const r = await handleLogin(body as never, v2.users, v2.tokens);
      if (r.status === 200 && 'token' in r.body) {
        jsonResp(res, 200, r.body, { 'set-cookie': sessionCookieFor(r.body.token) });
      } else {
        jsonResp(res, r.status, r.body);
      }
      return true;
    }

    // ── Authed v2 routes ──────────────────────────────────────────────
    const auth = await authenticateRequest(req, { tokenStore: v2.tokens, userStore: v2.users });
    if (!auth.ok) {
      if (path.startsWith('/api/')) {
        jsonResp(res, auth.status, auth.body);
      } else {
        redirect(res, `/login?returnTo=${encodeURIComponent(path)}`);
      }
      return true;
    }
    const me: AuthSuccess = auth;

    if (path === '/api/auth/logout' && method === 'POST') {
      const r = await handleLogout(me.token, v2.tokens);
      jsonResp(res, r.status, r.body, { 'set-cookie': clearSessionCookie() });
      return true;
    }
    if (path === '/account' && method === 'GET') {
      const myTokens = await v2.tokens.list(me.user.username);
      htmlResp(res, 200, accountPage({ host, user: me.user, tokens: myTokens }));
      return true;
    }
    if (path === '/api/account/profile' && method === 'POST') {
      const body = await parseJsonBody(req);
      const r = await handleProfileUpdate(body as never, me.user, v2.users);
      jsonResp(res, r.status, r.body);
      return true;
    }
    if (path === '/api/account/passphrase' && method === 'POST') {
      const body = await parseJsonBody(req);
      const r = await handlePassphraseChange(body as never, me.user, v2.users, v2.tokens);
      jsonResp(res, r.status, r.body);
      return true;
    }

    // Admin routes
    if (path === '/admin/users' && method === 'GET') {
      const ad = requireAdmin(me.user);
      if (!ad.ok) { jsonResp(res, ad.status, ad.body); return true; }
      const all = await v2.users.listUsers();
      htmlResp(res, 200, adminUsersPage({ host, currentUser: me.user, users: all }));
      return true;
    }
    if (path === '/api/admin/users' && method === 'POST') {
      const ad = requireAdmin(me.user);
      if (!ad.ok) { jsonResp(res, ad.status, ad.body); return true; }
      const body = await parseJsonBody(req);
      const r = await handleAdminCreateUser(body as never, v2.users);
      jsonResp(res, r.status, r.body);
      return true;
    }
    const adminUserMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && method === 'DELETE') {
      const ad = requireAdmin(me.user);
      if (!ad.ok) { jsonResp(res, ad.status, ad.body); return true; }
      const r = await handleAdminDeleteUser(adminUserMatch[1]!, me.user, v2.users, v2.tokens);
      jsonResp(res, r.status, r.body);
      return true;
    }
    const adminResetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/passphrase$/);
    if (adminResetMatch && method === 'POST') {
      const ad = requireAdmin(me.user);
      if (!ad.ok) { jsonResp(res, ad.status, ad.body); return true; }
      const body = await parseJsonBody(req);
      const r = await handleAdminResetPassphrase(adminResetMatch[1]!, body as never, v2.users, v2.tokens);
      jsonResp(res, r.status, r.body);
      return true;
    }

    // V2-marked path with no handler → 404 as JSON.
    jsonResp(res, 404, { error: `no v2 route for ${method} ${path}` });
    return true;
  } catch (err) {
    console.error('[v2-routes]', (err as Error).stack || err);
    jsonResp(res, 500, { error: 'internal error in v2 route' });
    return true;
  }
}
