// HTTP-framework-agnostic auth middleware for v2.
//
// Inputs are parsed primitives (bearer token string) so the same logic
// works behind raw http, fastify, hono, koa, etc. Outputs are structured
// results the HTTP layer maps to its response shape.
//
// Trust context: SERVICE.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Per-request auth gate"
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 7

import type { TokenStore, IdentityToken } from './tokens.ts';
import type { UserStore, User } from './users.ts';

export interface AuthContext {
  tokenStore: TokenStore;
  userStore: UserStore;
}

export interface AuthSuccess {
  ok: true;
  user: User;
  token: IdentityToken;
}

export interface AuthFailure {
  ok: false;
  status: number;
  body: { error: string };
}

export type AuthResult = AuthSuccess | AuthFailure;

const UNAUTHORIZED = (msg: string): AuthFailure => ({
  ok: false,
  status: 401,
  body: { error: msg },
});

/**
 * Extract `Bearer <token>` from an Authorization header value. Returns
 * undefined if the header is missing or not in bearer form. Tolerant of
 * case ('bearer', 'Bearer', 'BEARER') and extra whitespace.
 */
export function extractBearer(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') return undefined;
  const match = authorizationHeader.match(/^\s*bearer\s+(.+?)\s*$/i);
  return match ? match[1] : undefined;
}

/**
 * Authenticate a request given its bearer token. Validates the token,
 * resolves the owning user, returns both. Failure modes:
 *   - no bearer → 401 missing
 *   - malformed wire / bad signature / not found → 401 invalid
 *   - expired → 401 expired
 *   - user behind token has been deleted → 401 stale + best-effort revoke
 *
 * Stale-token cleanup: if a token validates but its owning user is gone,
 * the token row is orphaned (deleteUser doesn't reach into tokens to
 * preserve store decoupling). We revoke it inline so the orphan doesn't
 * linger; treat as 401.
 */
export async function authenticate(
  bearerToken: string | undefined,
  ctx: AuthContext,
): Promise<AuthResult> {
  if (!bearerToken) return UNAUTHORIZED('missing bearer token');

  const validation = await ctx.tokenStore.validate(bearerToken);
  if (!validation.ok || !validation.token) {
    if (validation.reason === 'expired') return UNAUTHORIZED('token expired');
    return UNAUTHORIZED('invalid token');
  }

  const user = await ctx.userStore.getUser(validation.token.username);
  if (!user) {
    void ctx.tokenStore.revoke(validation.token.tokenId);
    return UNAUTHORIZED('token owner no longer exists');
  }

  return { ok: true, user, token: validation.token };
}

/**
 * Convenience: pull the Authorization header off a Node http IncomingMessage
 * (or any object with a headers map) and authenticate. Saves callers from
 * doing the header-name dance themselves. Also falls back to the
 * `llmux_session` cookie so browser sessions work without JS having to
 * juggle Authorization on every request.
 */
export async function authenticateRequest(
  req: { headers: Record<string, string | string[] | undefined> },
  ctx: AuthContext,
): Promise<AuthResult> {
  const raw = req.headers['authorization'] ?? req.headers['Authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  const fromHeader = extractBearer(header);
  if (fromHeader) return authenticate(fromHeader, ctx);

  const cookieRaw = req.headers['cookie'];
  const cookieHeader = Array.isArray(cookieRaw) ? cookieRaw.join('; ') : cookieRaw;
  const fromCookie = extractSessionCookie(cookieHeader);
  return authenticate(fromCookie, ctx);
}

/** Parse the `llmux_session` value out of a Cookie header. */
export function extractSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader || typeof cookieHeader !== 'string') return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'llmux_session') return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Set-Cookie value for a freshly issued session token. HttpOnly + SameSite=Lax. */
export function sessionCookieFor(wireToken: string, opts?: { secure?: boolean }): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts?.secure) flags.push('Secure');
  return `llmux_session=${encodeURIComponent(wireToken)}; ${flags.join('; ')}`;
}

/** Set-Cookie value that clears the session. */
export function clearSessionCookie(opts?: { secure?: boolean }): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (opts?.secure) flags.push('Secure');
  return `llmux_session=; ${flags.join('; ')}`;
}
