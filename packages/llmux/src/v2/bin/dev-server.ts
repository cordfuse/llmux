#!/usr/bin/env node
// v2 dev-server — boots the v2 daemon code in USER MODE and serves the
// auth API + 4 web pages on a separate port so you can drive the whole
// loop in a browser without touching the live v1 daemon.
//
// Run with:
//   npx tsx packages/llmux/src/v2/bin/dev-server.ts
// Override port:
//   LLMUX_V2_DEV_PORT=3092 npx tsx packages/llmux/src/v2/bin/dev-server.ts
// Bind localhost-only instead of 0.0.0.0:
//   LLMUX_V2_BIND_LOCALHOST=1 npx tsx packages/llmux/src/v2/bin/dev-server.ts
//
// IMPORTANT — user mode is the ONLY context in which v2 code touches a
// user's $HOME, and it does so because the daemon IS the operator in
// user mode (not a separate service user). System mode (the v2 default)
// NEVER reads or writes any /home/* path.

import { existsSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { loadSystemConfig, userModeDefaults, type SystemConfig } from '../system/config.ts';
import { dropToService, checkSystemModeReadiness } from '../system/privilege.ts';
import { FileUserStore } from '../auth/users.ts';
import { FileTokenStore } from '../auth/tokens.ts';
import { SetupState, setupGate, handleSetupSubmit, setupBanner } from '../auth/setup.ts';
import {
  authenticateRequest, sessionCookieFor, clearSessionCookie,
  type AuthSuccess,
} from '../auth/middleware.ts';
import {
  handleLogin, handleLogout, handleProfileUpdate, handlePassphraseChange,
  handleRevokeToken, handleAdminCreateUser, handleAdminDeleteUser,
  handleAdminResetPassphrase,
} from '../auth/handlers.ts';
import { requireAdmin } from '../auth/enforce.ts';
import { setupPage } from '../web/setup.ts';
import { loginPage } from '../web/login.ts';
import { accountPage } from '../web/account.ts';
import { adminUsersPage } from '../web/admin-users.ts';
import { V2_AUTH_NAV_IDS } from '../web/layout.ts';
import { join } from 'node:path';

function banner(line: string): void {
  console.log('\n' + '─'.repeat(65));
  console.log('  ' + line);
  console.log('─'.repeat(65));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
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

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function main(): Promise<void> {
  banner('llmuxd v2 — dev-server (user mode, no sudo)');

  process.env['LLMUX_USER_MODE'] = '1';
  const config: SystemConfig = process.env['LLMUX_V2_CONFIG']
    ? loadSystemConfig(process.env['LLMUX_V2_CONFIG'])
    : userModeDefaults();

  // Dev-server overrides: default to 0.0.0.0 + port 3002 so a tailnet
  // browser can reach it. Opt out with LLMUX_V2_BIND_LOCALHOST=1.
  const bindHost = process.env['LLMUX_V2_BIND_LOCALHOST'] === '1' ? '127.0.0.1' : '0.0.0.0';
  const port = Number(process.env['LLMUX_V2_DEV_PORT'] ?? 3002);

  console.log('  config:');
  console.log('    userMode      :', config.userMode);
  console.log('    dataDir       :', config.dataDir);
  console.log('    transportDir  :', config.transportDir);

  banner('readiness check');
  const problems = checkSystemModeReadiness(config);
  if (problems.length === 0) console.log('  ✓ ready');
  else for (const p of problems) console.log('    • ' + p);

  banner('first-run directory creation');
  for (const dir of [config.dataDir, config.transportDir]) {
    if (existsSync(dir)) console.log('  ✓ ' + dir);
    else { mkdirSync(dir, { recursive: true }); console.log('  + created ' + dir); }
  }

  dropToService(config); // no-op in user mode

  // Construct stores
  const usersPath = join(config.dataDir, 'users.json');
  const tokensPath = join(config.dataDir, 'tokens.json');
  const setupTokenPath = join(config.dataDir, 'setup-token');
  const users = new FileUserStore(usersPath);
  const tokens = new FileTokenStore(tokensPath);
  const setup = new SetupState(setupTokenPath);

  // First-run: mint setup token if users.json is empty
  if (await users.isEmpty()) {
    const rec = setup.mint();
    const host = hostname();
    const url = `http://${host}:${port}/setup?token=${rec.token}`;
    console.log(setupBanner(url));
    console.log(`  Local equivalent: http://localhost:${port}/setup?token=${rec.token}\n`);
  }

  // ── Router ─────────────────────────────────────────────────────────────
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';
      const host = hostname();

      // 1. Setup gate first — when users.json is empty, only /setup* paths flow through
      const gate = await setupGate(users, path);
      if (!gate.allow) {
        if (path === '/' || path.startsWith('/login') || path.startsWith('/account') || path.startsWith('/admin')) {
          redirect(res, `/setup?token=${url.searchParams.get('token') ?? ''}`);
          return;
        }
        jsonResp(res, gate.status!, gate.body);
        return;
      }

      // 2. Public pre-auth routes (HTML pages + their submit endpoints)
      if (path === '/setup' && method === 'GET') {
        const token = url.searchParams.get('token') ?? '';
        htmlResp(res, 200, setupPage(token, host));
        return;
      }
      if (path === '/api/setup' && method === 'POST') {
        const body = await parseJsonBody(req) as { setupToken?: string; name?: string; username?: string; passphrase?: string };
        const r = await handleSetupSubmit({
          setupToken: body.setupToken ?? '',
          name: body.name ?? '',
          username: body.username ?? '',
          passphrase: body.passphrase ?? '',
        }, users, tokens, setup);
        if (r.ok && r.bootstrapToken) {
          // Auto-sign-in the new admin (cookie session)
          jsonResp(res, 200, r, { 'set-cookie': sessionCookieFor(r.bootstrapToken.plaintextSecret) });
        } else {
          jsonResp(res, r.ok ? 200 : 400, r);
        }
        return;
      }
      if (path === '/login' && method === 'GET') {
        const returnTo = url.searchParams.get('returnTo') ?? '/account';
        htmlResp(res, 200, loginPage({ host, returnTo }));
        return;
      }
      if (path === '/api/auth/login' && method === 'POST') {
        const body = await parseJsonBody(req);
        const r = await handleLogin(body as never, users, tokens);
        if (r.status === 200 && 'token' in r.body) {
          jsonResp(res, 200, r.body, { 'set-cookie': sessionCookieFor(r.body.token) });
        } else {
          jsonResp(res, r.status, r.body);
        }
        return;
      }
      if (path === '/' && method === 'GET') {
        // Tiny landing — redirect to /account if signed in, else /login
        const auth = await authenticateRequest(req, { tokenStore: tokens, userStore: users });
        redirect(res, auth.ok ? '/account' : '/login');
        return;
      }

      // 3. Auth gate for everything below
      const auth = await authenticateRequest(req, { tokenStore: tokens, userStore: users });
      if (!auth.ok) {
        if (path.startsWith('/api/')) {
          jsonResp(res, auth.status, auth.body);
        } else {
          redirect(res, `/login?returnTo=${encodeURIComponent(path)}`);
        }
        return;
      }
      const me: AuthSuccess = auth;

      // 4. Authenticated routes
      if (path === '/api/auth/logout' && method === 'POST') {
        const r = await handleLogout(me.token, tokens);
        jsonResp(res, r.status, r.body, { 'set-cookie': clearSessionCookie() });
        return;
      }
      if (path === '/account' && method === 'GET') {
        const myTokens = await tokens.list(me.user.username);
        htmlResp(res, 200, accountPage({ host, user: me.user, tokens: myTokens, navItemIds: V2_AUTH_NAV_IDS }));
        return;
      }
      if (path === '/api/account/profile' && method === 'POST') {
        const body = await parseJsonBody(req);
        const r = await handleProfileUpdate(body as never, me.user, users);
        jsonResp(res, r.status, r.body);
        return;
      }
      if (path === '/api/account/passphrase' && method === 'POST') {
        const body = await parseJsonBody(req);
        const r = await handlePassphraseChange(body as never, me.user, users, tokens);
        jsonResp(res, r.status, r.body);
        return;
      }
      const tokenMatch = path.match(/^\/api\/tokens\/([^/]+)$/);
      if (tokenMatch && method === 'DELETE') {
        const r = await handleRevokeToken(tokenMatch[1]!, me.user, tokens);
        jsonResp(res, r.status, r.body);
        return;
      }

      // 5. Admin routes
      if (path === '/admin/users' && method === 'GET') {
        const ad = requireAdmin(me.user);
        if (!ad.ok) { jsonResp(res, ad.status, ad.body); return; }
        const all = await users.listUsers();
        htmlResp(res, 200, adminUsersPage({ host, currentUser: me.user, users: all, navItemIds: V2_AUTH_NAV_IDS }));
        return;
      }
      if (path === '/api/admin/users' && method === 'POST') {
        const ad = requireAdmin(me.user);
        if (!ad.ok) { jsonResp(res, ad.status, ad.body); return; }
        const body = await parseJsonBody(req);
        const r = await handleAdminCreateUser(body as never, users);
        jsonResp(res, r.status, r.body);
        return;
      }
      const adminUserMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && method === 'DELETE') {
        const ad = requireAdmin(me.user);
        if (!ad.ok) { jsonResp(res, ad.status, ad.body); return; }
        const r = await handleAdminDeleteUser(adminUserMatch[1]!, me.user, users, tokens);
        jsonResp(res, r.status, r.body);
        return;
      }
      const adminResetMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/passphrase$/);
      if (adminResetMatch && method === 'POST') {
        const ad = requireAdmin(me.user);
        if (!ad.ok) { jsonResp(res, ad.status, ad.body); return; }
        const body = await parseJsonBody(req);
        const r = await handleAdminResetPassphrase(adminResetMatch[1]!, body as never, users, tokens);
        jsonResp(res, r.status, r.body);
        return;
      }

      jsonResp(res, 404, { error: `no route for ${method} ${path}` });
    } catch (err) {
      console.error('[dev-server]', (err as Error).stack || err);
      jsonResp(res, 500, { error: 'internal error' });
    }
  });

  await new Promise<void>(r => server.listen(port, bindHost, () => r()));

  banner('listening');
  const host = hostname();
  console.log(`  bound to ${bindHost}:${port}`);
  console.log(`  local : http://localhost:${port}/`);
  console.log(`  tailnet (short) : http://${host}:${port}/`);
  console.log(`  tailnet (full)  : add your .ts.net suffix to ${host} if needed`);
  console.log(`  Ctrl-C to stop.`);
}

main().catch((err) => {
  console.error('dev-server failed:', err);
  process.exit(1);
});
