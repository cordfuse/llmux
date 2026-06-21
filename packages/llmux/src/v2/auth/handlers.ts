// /api/auth/login + /api/auth/logout endpoint logic.
//
// Framework-agnostic — handlers take parsed input + stores, return
// { status, body } that the HTTP layer maps to its response shape. The
// HTTP layer is responsible for: extracting the request body, calling
// the handler, writing the status + JSON response.
//
// Trust context: SERVICE.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Auth flow (v2 client side)" — server side
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 7

import type { UserStore } from './users.ts';
import type { TokenStore, IdentityToken } from './tokens.ts';

export interface HttpResult<TBody = unknown> {
  status: number;
  body: TBody;
}

export interface LoginRequest {
  username: unknown;
  passphrase: unknown;
  deviceName?: unknown;
}

export interface LoginResponseOk {
  token: string;       // wire format: sas_<id>.<secret>
  tokenName: string;
  username: string;
}

export interface ErrorBody { error: string; }

/**
 * POST /api/auth/login
 *
 * Validates username + passphrase against the user store, mints a fresh
 * identity-bound token, returns the wire-form plaintext (ONCE).
 *
 * Status codes:
 *   400 — request body missing required fields or wrong types
 *   401 — username unknown OR passphrase wrong (returned same way to
 *         prevent username enumeration)
 *   200 — { token, tokenName, username }
 *
 * Side effects: tokens.json gets one new row on success.
 */
export async function handleLogin(
  input: LoginRequest,
  userStore: UserStore,
  tokenStore: TokenStore,
): Promise<HttpResult<LoginResponseOk | ErrorBody>> {
  if (typeof input.username !== 'string' || typeof input.passphrase !== 'string') {
    return { status: 400, body: { error: 'username and passphrase required' } };
  }
  const username = input.username;
  const passphrase = input.passphrase;
  const deviceName = typeof input.deviceName === 'string' && input.deviceName.trim().length > 0
    ? input.deviceName.trim()
    : `${username} device`;

  // Constant-time-ish: verifyPassphrase returns false for unknown users
  // (no separate exists check that would leak existence via response time).
  const ok = await userStore.verifyPassphrase(username, passphrase);
  if (!ok) {
    return { status: 401, body: { error: 'invalid credentials' } };
  }

  const minted = await tokenStore.mint({ username, name: deviceName });
  return {
    status: 200,
    body: {
      token: minted.plaintextSecret,
      tokenName: minted.token.name,
      username,
    },
  };
}

/**
 * POST /api/auth/logout
 *
 * Revokes the bearer token the caller authenticated with. Must be called
 * AFTER the auth middleware so we already have the validated token row.
 * Idempotent — re-logout on an already-revoked token still returns 200
 * (the token can't be reused anyway).
 *
 * Note: revoke is per-token, not per-user. To log out everywhere, the
 * caller iterates list({ username }) + revoke individually, or calls the
 * admin revokeAllForUser path.
 */
export async function handleLogout(
  callerToken: IdentityToken,
  tokenStore: TokenStore,
): Promise<HttpResult<{ ok: true } | ErrorBody>> {
  await tokenStore.revoke(callerToken.tokenId);
  return { status: 200, body: { ok: true } };
}
