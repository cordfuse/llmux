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

import type { UserStore, User, CreateUserInput } from './users.ts';
import { UserValidationError } from './users.ts';
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

// ── Account self-service handlers ──────────────────────────────────────────

export interface ProfileUpdateRequest { name: unknown; }

export async function handleProfileUpdate(
  input: ProfileUpdateRequest,
  caller: User,
  userStore: UserStore,
): Promise<HttpResult<{ ok: true; user: User } | ErrorBody>> {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return { status: 400, body: { error: 'name required' } };
  }
  try {
    await userStore.updateName(caller.username, input.name);
  } catch (err) {
    return wrapValidation(err);
  }
  const updated = await userStore.getUser(caller.username);
  return { status: 200, body: { ok: true, user: updated! } };
}

export interface PassphraseChangeRequest {
  oldPassphrase: unknown;
  newPassphrase: unknown;
}

/**
 * Change own passphrase. Verifies the old one (no admin bypass) — even
 * the user themselves must prove the current one. Revokes ALL of the
 * caller's tokens on success so any other devices have to re-login,
 * which is the expected behavior after a passphrase rotation.
 */
export async function handlePassphraseChange(
  input: PassphraseChangeRequest,
  caller: User,
  userStore: UserStore,
  tokenStore: TokenStore,
): Promise<HttpResult<{ ok: true; revokedTokens: number } | ErrorBody>> {
  if (typeof input.oldPassphrase !== 'string' || typeof input.newPassphrase !== 'string') {
    return { status: 400, body: { error: 'oldPassphrase and newPassphrase required' } };
  }
  const ok = await userStore.verifyPassphrase(caller.username, input.oldPassphrase);
  if (!ok) return { status: 401, body: { error: 'current passphrase incorrect' } };
  try {
    await userStore.setPassphrase(caller.username, input.newPassphrase);
  } catch (err) {
    return wrapValidation(err);
  }
  const revoked = await tokenStore.revokeAllForUser(caller.username);
  return { status: 200, body: { ok: true, revokedTokens: revoked } };
}

/**
 * Revoke a token by id. Caller must own the token OR be admin. Returns
 * 404 if no such token; 403 if owner mismatch + caller not admin.
 */
export async function handleRevokeToken(
  tokenId: string,
  caller: User,
  tokenStore: TokenStore,
): Promise<HttpResult<{ ok: true } | ErrorBody>> {
  const row = await tokenStore.get(tokenId);
  if (!row) return { status: 404, body: { error: 'token not found' } };
  if (row.username !== caller.username && !caller.admin) {
    return { status: 403, body: { error: 'cannot revoke tokens owned by another user' } };
  }
  await tokenStore.revoke(tokenId);
  return { status: 200, body: { ok: true } };
}

// ── Admin user CRUD ────────────────────────────────────────────────────────

export interface AdminCreateUserRequest {
  username: unknown;
  name: unknown;
  passphrase: unknown;
  admin?: unknown;
}

export async function handleAdminCreateUser(
  input: AdminCreateUserRequest,
  userStore: UserStore,
): Promise<HttpResult<{ ok: true; user: User } | ErrorBody>> {
  if (typeof input.username !== 'string' || typeof input.name !== 'string' || typeof input.passphrase !== 'string') {
    return { status: 400, body: { error: 'username, name, passphrase required' } };
  }
  const payload: CreateUserInput = {
    username: input.username,
    name: input.name,
    passphrase: input.passphrase,
    admin: input.admin === true,
  };
  try {
    const user = await userStore.createUser(payload);
    return { status: 200, body: { ok: true, user } };
  } catch (err) {
    return wrapValidation(err);
  }
}

/**
 * Delete a user. Refuses to delete the caller (no foot-shooting) and the
 * last admin (no lockout). Cascades to token revocation.
 */
export async function handleAdminDeleteUser(
  targetUsername: string,
  caller: User,
  userStore: UserStore,
  tokenStore: TokenStore,
): Promise<HttpResult<{ ok: true; revokedTokens: number } | ErrorBody>> {
  if (targetUsername === caller.username) {
    return { status: 400, body: { error: 'cannot delete your own account' } };
  }
  const target = await userStore.getUser(targetUsername);
  if (!target) return { status: 404, body: { error: 'user not found' } };
  if (target.admin) {
    const all = await userStore.listUsers();
    const adminCount = all.filter(u => u.admin).length;
    if (adminCount <= 1) {
      return { status: 400, body: { error: 'cannot delete the last admin' } };
    }
  }
  try {
    await userStore.deleteUser(targetUsername);
  } catch (err) {
    return wrapValidation(err);
  }
  const revoked = await tokenStore.revokeAllForUser(targetUsername);
  return { status: 200, body: { ok: true, revokedTokens: revoked } };
}

export interface AdminResetPassphraseRequest { newPassphrase: unknown; }

/**
 * Admin override — set another user's passphrase WITHOUT proving the old
 * one. Revokes all of the target's tokens so they have to re-login with
 * the new passphrase.
 */
export async function handleAdminResetPassphrase(
  targetUsername: string,
  input: AdminResetPassphraseRequest,
  userStore: UserStore,
  tokenStore: TokenStore,
): Promise<HttpResult<{ ok: true; revokedTokens: number } | ErrorBody>> {
  if (typeof input.newPassphrase !== 'string') {
    return { status: 400, body: { error: 'newPassphrase required' } };
  }
  const target = await userStore.getUser(targetUsername);
  if (!target) return { status: 404, body: { error: 'user not found' } };
  try {
    await userStore.setPassphrase(targetUsername, input.newPassphrase);
  } catch (err) {
    return wrapValidation(err);
  }
  const revoked = await tokenStore.revokeAllForUser(targetUsername);
  return { status: 200, body: { ok: true, revokedTokens: revoked } };
}

function wrapValidation(err: unknown): HttpResult<ErrorBody> {
  if (err instanceof UserValidationError) {
    return { status: 400, body: { error: err.message } };
  }
  return { status: 500, body: { error: `internal: ${(err as Error).message}` } };
}
