import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { stateDir } from './state.ts';
import { generateToken, tokenId } from './token.ts';

/**
 * Persisted token record. v0.29.0 dropped the plaintext `token` field and
 * stores only `hash` (SHA-256 hex of the value). This closes the
 * auth.json-as-live-credentials hole: backup snapshots, dotfile syncs, and
 * co-tenant file reads no longer leak usable tokens. Validation uses
 * crypto.timingSafeEqual against the hash, so we don't leak match-position
 * via timing either.
 *
 * SHA-256 is the right choice here, not bcrypt/argon2/scrypt. Tokens are
 * 256-bit random (from `randomBytes(32)`); brute-forcing them is infeasible
 * regardless of hash speed, and password-hash slowness would add per-request
 * latency for zero security gain.
 */
export interface AuthToken {
  id: string;
  hash: string;
  name?: string;
  createdAt: string;
  expiresAt?: string;
}

interface AuthFileV1 {
  version: 1;
  tokens: Array<{
    id: string;
    token: string; // plaintext (legacy)
    name?: string;
    createdAt: string;
    expiresAt?: string;
  }>;
}

interface AuthFileV2 {
  version: 2;
  tokens: AuthToken[];
}

const EMPTY: AuthFileV2 = { version: 2, tokens: [] };

export function authPath(): string {
  return join(stateDir(), 'auth.json');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Load auth.json, migrating v1 (plaintext) records to v2 (hashed) in place.
 * The migration is silent — operators see no churn. The on-disk file is
 * rewritten if any v1 records are encountered. Failure to read or parse
 * is non-fatal: we return an empty store rather than crash, matching the
 * pre-v0.29 behavior.
 */
function load(): AuthFileV2 {
  const p = authPath();
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AuthFileV1 | AuthFileV2>;
    if (parsed.version === 2 && Array.isArray(parsed.tokens)) {
      return { version: 2, tokens: parsed.tokens as AuthToken[] };
    }
    if (parsed.version === 1 && Array.isArray(parsed.tokens)) {
      const v1 = parsed as AuthFileV1;
      const migrated: AuthToken[] = v1.tokens.map((t) => ({
        id: t.id,
        hash: hashToken(t.token),
        ...(t.name !== undefined ? { name: t.name } : {}),
        createdAt: t.createdAt,
        ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
      }));
      const upgraded: AuthFileV2 = { version: 2, tokens: migrated };
      save(upgraded);
      return upgraded;
    }
  } catch {
    // fall through to empty
  }
  return structuredClone(EMPTY);
}

function save(file: AuthFileV2): void {
  const p = authPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export function listAuthTokens(): AuthToken[] {
  return load().tokens;
}

/**
 * Create a new token. The plaintext `token` is returned ONCE in the
 * response object — after this call returns, the daemon has no way to
 * recover it. The on-disk record holds only the SHA-256 hash. This
 * matches GitHub-PAT semantics; the existing CLI/web "show once, never
 * again" UX already reflects this.
 */
export function createAuthToken(
  opts: { name?: string; expiresAt?: string } = {},
): AuthToken & { token: string } {
  const token = generateToken();
  const rec: AuthToken = {
    id: tokenId(token),
    hash: hashToken(token),
    createdAt: new Date().toISOString(),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
  const file = load();
  file.tokens.push(rec);
  save(file);
  return { ...rec, token };
}

/** Revoke by id prefix (the 8-char display id). Returns true if anything was removed. */
export function revokeAuthToken(idPrefix: string): boolean {
  const file = load();
  const before = file.tokens.length;
  file.tokens = file.tokens.filter((t) => t.id !== idPrefix);
  if (file.tokens.length === before) return false;
  save(file);
  return true;
}

/** Revoke every token. Returns the count removed. */
export function revokeAllAuthTokens(): number {
  const file = load();
  const removed = file.tokens.length;
  file.tokens = [];
  save(file);
  return removed;
}

/**
 * Rename a token's display label. Empty string clears the name.
 * Returns the updated record or null if no token matches the id prefix.
 */
export function renameAuthToken(idPrefix: string, newName: string): AuthToken | null {
  const file = load();
  const tok = file.tokens.find((t) => t.id === idPrefix);
  if (!tok) return null;
  if (newName === '') delete tok.name;
  else tok.name = newName;
  save(file);
  return tok;
}

/**
 * Validate by parsing the candidate's display id out of the prefix, finding
 * THAT one stored record (avoids hashing every token per request), then
 * timing-safe comparing the candidate's SHA-256 against the stored hash.
 *
 * Generic `false` for both unknown-id and hash-mismatch — observers can't
 * tell from timing whether the id was unknown or the hash was wrong.
 */
export function validateAuthToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const candidateId = tokenId(candidate);
  const candidateHash = hashToken(candidate);
  const now = Date.now();
  const file = load();
  const rec = file.tokens.find((t) => t.id === candidateId);
  if (!rec) return false;
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < now) return false;
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Auth is enabled when at least one token has been provisioned. */
export function authEnabled(): boolean {
  return load().tokens.length > 0;
}
