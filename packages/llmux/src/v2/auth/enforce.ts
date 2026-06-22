// API-level identity enforcement helpers for v2 endpoints.
//
// Per the v2 design, every orch action carries a `from:` / `alias` field
// that names the user it's being performed AS. The authenticated user
// (resolved by middleware.ts) MUST match this field — Alice can't post
// as Bob, even if she has a valid token.
//
// Admins do NOT bypass this — admin status lets you create/delete users
// and mint tokens for them, but it does NOT let you pose as them on the
// orch channel. That's a deliberate design choice (anti-impersonation).
//
// Trust context: SERVICE — called per request after authenticate().
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Identity-bound tokens" — no impersonation
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 7

import type { User } from './users.ts';
import type { HttpResult, ErrorBody } from './handlers.ts';

export type EnforceOk = { ok: true };
export type EnforceFail = HttpResult<ErrorBody> & { ok: false };
export type EnforceResult = EnforceOk | EnforceFail;

const FORBIDDEN = (msg: string): EnforceFail => ({
  ok: false,
  status: 403,
  body: { error: msg },
});

/**
 * Per v2 design, the user's `username` IS their orch alias. Requests
 * that target a specific alias (orch send `from:`, claim release `by:`,
 * etc.) MUST match the authenticated user. Admin status confers NO
 * bypass — admins cannot pose as other users on orch.
 *
 * Returns `{ ok: true }` if the alias matches. Otherwise an EnforceFail
 * the HTTP layer can pass through directly.
 *
 * Pass `requestedAlias = undefined` if the endpoint doesn't take an
 * explicit alias — this returns ok and the handler should use
 * `user.username` as the implicit alias.
 */
export function requireOwnAlias(user: User, requestedAlias: string | undefined): EnforceResult {
  if (requestedAlias === undefined || requestedAlias === user.username) {
    return { ok: true };
  }
  return FORBIDDEN(`alias '${requestedAlias}' does not belong to authenticated user '${user.username}'`);
}

/**
 * Admin-gated endpoints (create/delete users, mint tokens for others,
 * reset passphrases). Use this AFTER authenticate() succeeds.
 */
export function requireAdmin(user: User): EnforceResult {
  if (user.admin) return { ok: true };
  return FORBIDDEN('admin only');
}

/**
 * Endpoints that allow either the user themselves OR an admin (e.g.,
 * viewing tokens, rotating own passphrase). The targetUsername is the
 * resource owner the request is acting on.
 */
export function requireSelfOrAdmin(user: User, targetUsername: string): EnforceResult {
  if (user.username === targetUsername || user.admin) return { ok: true };
  return FORBIDDEN(`access denied: not '${targetUsername}' and not admin`);
}
