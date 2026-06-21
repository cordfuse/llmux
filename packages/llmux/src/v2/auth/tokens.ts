// Identity-bound tokens.
//
// Every token is owned by exactly one user. The daemon enforces:
//   - API requests authenticated by this token operate as that user
//   - orch send/reply/next/etc. require the `from:` / `alias` field to
//     match the token's owning user (no impersonation across users)
//
// Trust context: SERVICE.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Token lifecycle (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Data plane (v2)" — tokens.json row
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 4

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface IdentityToken {
  /** Server-side token id (URL-safe random). Stable; safe to log. */
  tokenId: string;
  /** SHA-256 hash of the secret (base64). Plaintext never persisted. */
  secretHash: string;
  /** The user this token authenticates as. Owning user enforces `from:`. */
  username: string;
  /** Human-readable label. e.g. "alice-iphone", "ci-pipeline". */
  name: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. Optional — tokens without expiry are long-lived by default. */
  expiresAt?: string;
  /** ISO-8601. Refreshed by the daemon on each successful validate. */
  lastUsedAt?: string;
}

export interface MintTokenInput {
  username: string;
  name: string;
  /** Optional expiry as ISO-8601. */
  expiresAt?: string;
}

export interface MintTokenResult {
  token: IdentityToken;
  /** The plaintext wire secret (`sas_<tokenId>.<secret>`). RETURNED ONCE. */
  plaintextSecret: string;
}

export interface TokenValidation {
  ok: boolean;
  token?: IdentityToken;
  reason?: 'not-found' | 'expired' | 'malformed';
}

export interface TokenStore {
  /** Create a new token; returns plaintext ONCE. */
  mint(input: MintTokenInput): Promise<MintTokenResult>;
  /** Look up by tokenId. Doesn't validate secret. */
  get(tokenId: string): Promise<IdentityToken | undefined>;
  /** List tokens (admin sees all; pass a username to filter). */
  list(filterUsername?: string): Promise<IdentityToken[]>;
  /** Revoke by tokenId. Idempotent — no-op if already gone. */
  revoke(tokenId: string): Promise<void>;
  /** Revoke all tokens owned by a user. Used on user deletion. */
  revokeAllForUser(username: string): Promise<number>;
  /** Validate a presented wire secret. On success, touches lastUsedAt. */
  validate(presentedSecret: string): Promise<TokenValidation>;
}

export class TokenValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'TokenValidationError'; }
}

/**
 * Wire format for presented secrets: `sas_<tokenId>.<plaintextSecret>`.
 * The tokenId prefix lets us look up the row in O(1) without scanning
 * every hash. Same shape as GitHub PATs (`ghp_<id>_<secret>`).
 */
export const TOKEN_PREFIX = 'sas_'; // matches v1.x for migration
export const TOKEN_WIRE_SEPARATOR = '.';

const TOKEN_ID_BYTES = 12;      // 96 bits of randomness → 16-char base64url
const TOKEN_SECRET_BYTES = 32;  // 256 bits of randomness → 43-char base64url

function newTokenId(): string {
  return randomBytes(TOKEN_ID_BYTES).toString('base64url');
}

function newSecret(): string {
  return randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
}

/** SHA-256 over the secret (base64). Tokens are 256-bit random so a fast
 *  hash is appropriate — brute force is infeasible without slowing every
 *  authenticated request to scrypt speeds. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64');
}

interface WireParts { tokenId: string; secret: string; }

function parseWire(presented: string): WireParts | undefined {
  if (typeof presented !== 'string') return undefined;
  if (!presented.startsWith(TOKEN_PREFIX)) return undefined;
  const body = presented.slice(TOKEN_PREFIX.length);
  const sepIdx = body.indexOf(TOKEN_WIRE_SEPARATOR);
  if (sepIdx <= 0 || sepIdx >= body.length - 1) return undefined;
  return { tokenId: body.slice(0, sepIdx), secret: body.slice(sepIdx + 1) };
}

function isExpired(token: IdentityToken, now: Date = new Date()): boolean {
  if (!token.expiresAt) return false;
  const expMs = Date.parse(token.expiresAt);
  if (Number.isNaN(expMs)) return false;
  return expMs <= now.getTime();
}

/**
 * File-backed token store. Reads/writes config.dataDir/tokens.json.
 *
 * Concurrency model matches FileUserStore — single-process daemon, in-
 * process write mutex, in-memory cache.
 *
 * lastUsedAt persistence: updated on every successful validate. At the
 * daemon's expected request rate this is fine; if it ever becomes a
 * hotspot we can debounce writes to once-per-N-seconds-per-token.
 */
export class FileTokenStore implements TokenStore {
  private cache: IdentityToken[] | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private storePath: string) {}

  async mint(input: MintTokenInput): Promise<MintTokenResult> {
    if (typeof input.username !== 'string' || input.username.length === 0) {
      throw new TokenValidationError('username required');
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new TokenValidationError('name required');
    }
    if (input.expiresAt !== undefined) {
      const t = Date.parse(input.expiresAt);
      if (Number.isNaN(t)) throw new TokenValidationError('expiresAt must be ISO-8601');
      if (t <= Date.now()) throw new TokenValidationError('expiresAt must be in the future');
    }
    return this.withLock(async () => {
      const tokens = this.load();
      let tokenId: string;
      do { tokenId = newTokenId(); }
      while (tokens.some(t => t.tokenId === tokenId));
      const secret = newSecret();
      const token: IdentityToken = {
        tokenId,
        secretHash: hashSecret(secret),
        username: input.username,
        name: input.name.trim(),
        createdAt: new Date().toISOString(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      };
      tokens.push(token);
      this.save(tokens);
      return {
        token,
        plaintextSecret: `${TOKEN_PREFIX}${tokenId}${TOKEN_WIRE_SEPARATOR}${secret}`,
      };
    });
  }

  async get(tokenId: string): Promise<IdentityToken | undefined> {
    return this.load().find(t => t.tokenId === tokenId);
  }

  async list(filterUsername?: string): Promise<IdentityToken[]> {
    const all = this.load();
    if (filterUsername === undefined) return [...all];
    return all.filter(t => t.username === filterUsername);
  }

  async revoke(tokenId: string): Promise<void> {
    return this.withLock(async () => {
      const tokens = this.load();
      const idx = tokens.findIndex(t => t.tokenId === tokenId);
      if (idx < 0) return; // idempotent
      tokens.splice(idx, 1);
      this.save(tokens);
    });
  }

  async revokeAllForUser(username: string): Promise<number> {
    return this.withLock(async () => {
      const tokens = this.load();
      const before = tokens.length;
      const remaining = tokens.filter(t => t.username !== username);
      if (remaining.length === before) return 0;
      this.save(remaining);
      return before - remaining.length;
    });
  }

  async validate(presented: string): Promise<TokenValidation> {
    const parts = parseWire(presented);
    if (!parts) return { ok: false, reason: 'malformed' };
    const tokens = this.load();
    const row = tokens.find(t => t.tokenId === parts.tokenId);
    if (!row) return { ok: false, reason: 'not-found' };

    const presentedHashBuf = Buffer.from(hashSecret(parts.secret), 'base64');
    const storedHashBuf = Buffer.from(row.secretHash, 'base64');
    if (presentedHashBuf.length !== storedHashBuf.length) {
      return { ok: false, reason: 'not-found' };
    }
    if (!timingSafeEqual(presentedHashBuf, storedHashBuf)) {
      return { ok: false, reason: 'not-found' };
    }
    if (isExpired(row)) return { ok: false, reason: 'expired', token: row };

    // Touch lastUsedAt. Use the write queue so we don't race with mint/revoke.
    const now = new Date().toISOString();
    row.lastUsedAt = now;
    void this.withLock(async () => {
      const live = this.load();
      const liveRow = live.find(t => t.tokenId === row.tokenId);
      if (liveRow) {
        liveRow.lastUsedAt = now;
        this.save(live);
      }
    });

    return { ok: true, token: row };
  }

  // ── private ─────────────────────────────────────────────────────────────

  private load(): IdentityToken[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.storePath)) {
      this.cache = [];
      return this.cache;
    }
    const raw = readFileSync(this.storePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`tokens.json: invalid JSON at ${this.storePath}: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`tokens.json: expected array at ${this.storePath}`);
    }
    this.cache = parsed as IdentityToken[];
    return this.cache;
  }

  private save(tokens: IdentityToken[]): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.storePath);
    try { chmodSync(this.storePath, 0o600); } catch { /* best-effort */ }
    this.cache = tokens;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
