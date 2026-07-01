// `llmux auth login` plumbing — POST passphrase to the daemon, receive
// an identity-bound token, persist to ~/.config/llmux/credentials.json.
//
// Trust context: CLIENT.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Auth flow (v2 client side)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 6

import { hostname } from 'node:os';
import {
  upsertProfile, removeProfile, loadCredentials, resolveProfile,
  type ProfileEntry,
} from './credentials.ts';

export interface LoginInput {
  serverUrl: string;
  username: string;
  passphrase: string;
  /** Friendly device label sent to the daemon (becomes the token's name). */
  deviceName?: string;
  /** Optional override; defaults to defaultProfileName(serverUrl). */
  profileName?: string;
  /** Persist after success. Defaults to true; set false for dry-run/test. */
  persist?: boolean;
  /** Override the credentials file path (testing). */
  credentialsPath?: string;
}

export interface LoginResult {
  ok: boolean;
  /** Profile name as persisted (when persist=true and ok=true). */
  profileName?: string;
  /** The minted token row (without the secret — secret is in credentials file). */
  tokenName?: string;
  /** Server's view of who you logged in as. */
  username?: string;
  error?: string;
  status?: number;
}

/**
 * POST /api/auth/login on the daemon. The daemon validates the
 * passphrase against users.json, mints a fresh identity-bound token,
 * returns { token: 'sas_<id>.<secret>', tokenName, username }.
 *
 * On success: write the token to credentials.json under the resolved
 * profile name and mark it active.
 */
export async function login(input: LoginInput): Promise<LoginResult> {
  const url = `${input.serverUrl.replace(/\/+$/, '')}/api/auth/login`;
  const deviceName = input.deviceName || `${input.username}@${guessHostname()}`;
  const body = JSON.stringify({
    username: input.username,
    passphrase: input.passphrase,
    deviceName,
  });

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch (err) {
    return { ok: false, error: `connect failed: ${(err as Error).message}` };
  }

  if (!resp.ok) {
    let raw = '';
    try { raw = await resp.text(); } catch { /* ignore */ }
    // The daemon's error body is JSON ({"error":"..."}) — parse it out
    // instead of printing the raw blob (previously: `auth login failed:
    // {"error":"invalid credentials"} (HTTP 401)`).
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) detail = parsed.error;
    } catch { /* not JSON — fall back to the raw body below */ }
    return {
      ok: false,
      status: resp.status,
      error: detail || `daemon returned ${resp.status} ${resp.statusText}`,
    };
  }

  let payload: { token?: string; tokenName?: string; username?: string };
  try {
    payload = await resp.json() as typeof payload;
  } catch (err) {
    return { ok: false, error: `daemon returned non-JSON: ${(err as Error).message}` };
  }
  if (!payload.token || !payload.username) {
    return { ok: false, error: 'daemon response missing token or username' };
  }

  const result: LoginResult = {
    ok: true,
    username: payload.username,
    ...(payload.tokenName ? { tokenName: payload.tokenName } : {}),
  };
  if (input.persist !== false) {
    result.profileName = upsertProfile(
      {
        serverUrl: input.serverUrl,
        username: payload.username,
        token: payload.token,
        ...(input.profileName ? { name: input.profileName } : {}),
      },
      input.credentialsPath,
    );
  }
  return result;
}

export interface LogoutInput {
  /** Profile to log out. Defaults to the active profile. */
  profileName?: string;
  /** Also call POST /api/auth/logout to revoke server-side. Default true. */
  revokeOnServer?: boolean;
  credentialsPath?: string;
}

export interface LogoutResult {
  ok: boolean;
  profileName?: string;
  revokedOnServer?: boolean;
  error?: string;
}

/**
 * Remove a profile locally. If revokeOnServer (default true), also POST
 * /api/auth/logout so the daemon revokes the token. Local removal happens
 * even if the server call fails — operators expect logout to be local-
 * authoritative.
 */
export async function logout(input: LogoutInput = {}): Promise<LogoutResult> {
  const file = loadCredentials(input.credentialsPath);
  const resolved = resolveProfile(file, input.profileName);
  if (!resolved) {
    return { ok: false, error: 'no active profile to log out' };
  }
  const { name, profile } = resolved;

  let revokedOnServer: boolean | undefined;
  if (input.revokeOnServer !== false) {
    try {
      const resp = await fetch(`${profile.serverUrl.replace(/\/+$/, '')}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${profile.token}` },
      });
      revokedOnServer = resp.ok;
    } catch {
      revokedOnServer = false;
    }
  }

  removeProfile(name, input.credentialsPath);
  const result: LogoutResult = { ok: true, profileName: name };
  if (revokedOnServer !== undefined) result.revokedOnServer = revokedOnServer;
  return result;
}

export interface WhoamiResult {
  ok: boolean;
  profileName?: string;
  profile?: ProfileEntry;
  error?: string;
}

/**
 * Local-only — reads credentials.json and returns the active profile.
 * Does NOT call the daemon (use a live API call if you need to confirm
 * the token is still valid).
 */
export function whoami(profileName?: string, credentialsPath?: string): WhoamiResult {
  const file = loadCredentials(credentialsPath);
  const resolved = resolveProfile(file, profileName);
  if (!resolved) return { ok: false, error: 'no active profile' };
  return { ok: true, profileName: resolved.name, profile: resolved.profile };
}

function guessHostname(): string {
  try { return hostname() || 'unknown'; } catch { return 'unknown'; }
}
