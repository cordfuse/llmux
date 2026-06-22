// User store — username, name, scrypt-hashed passphrase, admin flag.
//
// Trust context: SERVICE. The service-user daemon owns /var/lib/llmux/users.json
// and is the only thing that reads/writes it. Workers receive their
// identity via env vars + token validation, not by reading the user store
// directly.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "User model (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Data plane (v2)" — users.json row
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 3

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface User {
  /** Stable identifier. Application-layer only — does NOT need to match any OS user on the host.
   *  Also the user's orch alias. Format: [a-z0-9_-]+ */
  username: string;
  /** Display name. */
  name: string;
  /** scrypt-hashed passphrase + salt + params. Plaintext never written. */
  passphraseHash: string;
  /** Admin can create/delete other users + mint tokens for them. */
  admin: boolean;
  /** ISO-8601. */
  createdAt: string;
}

export interface CreateUserInput {
  username: string;
  name: string;
  /** Plaintext — hashed by createUser before persistence. NEVER persisted. */
  passphrase: string;
  /** Defaults false. Only admins can set this. */
  admin?: boolean;
}

export interface UserStore {
  /** Create a new user. Validates username format + uniqueness + passphrase strength. */
  createUser(input: CreateUserInput): Promise<User>;
  /** Look up by username. Returns undefined if not present. */
  getUser(username: string): Promise<User | undefined>;
  /** List all users. Admin-callable; non-admin must filter to self. */
  listUsers(): Promise<User[]>;
  /** Update name. Username + admin status + passphrase have their own methods. */
  updateName(username: string, newName: string): Promise<void>;
  /** Replace the passphrase hash. Caller verifies the old one separately. */
  setPassphrase(username: string, newPassphrase: string): Promise<void>;
  /** Delete user record. Caller responsible for revoking tokens + reaping orch claims. */
  deleteUser(username: string): Promise<void>;
  /** Verify a candidate passphrase against the stored hash. */
  verifyPassphrase(username: string, candidate: string): Promise<boolean>;
  /** Whether ANY users exist. Used by the setup wizard to detect first-run. */
  isEmpty(): Promise<boolean>;
}

// ── scrypt format ─────────────────────────────────────────────────────────
// Self-describing string so we can tune N over time without breaking old
// hashes. Format: `scrypt$<N>$<saltBase64>$<hashBase64>`.
//
// N=2^17 (131072) is the modern OWASP recommendation for interactive auth
// (~100ms on commodity hardware). r=8, p=1 are scrypt's standard tuning.
const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
// Memory required by scrypt is ≈ 128 * N * r bytes; for N=2^17 r=8 that's
// ~128 MB. Node's default maxmem is 32 MB, so we raise it explicitly.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function hashPassphrase(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyHash(plain: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'base64');
  const expected = Buffer.from(parts[3]!, 'base64');
  if (!Number.isInteger(n) || n <= 0 || salt.length === 0 || expected.length === 0) return false;
  let candidate: Buffer;
  try {
    candidate = scryptSync(plain, salt, expected.length, { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ── validation ────────────────────────────────────────────────────────────
const USERNAME_RE = /^[a-z0-9_-]+$/;
const USERNAME_MAX = 32;
const PASSPHRASE_MIN = 8;

export class UserValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'UserValidationError'; }
}

function validateUsername(username: string): void {
  if (typeof username !== 'string' || username.length === 0) {
    throw new UserValidationError('username required');
  }
  if (username.length > USERNAME_MAX) {
    throw new UserValidationError(`username too long (max ${USERNAME_MAX})`);
  }
  if (!USERNAME_RE.test(username)) {
    throw new UserValidationError('username must match [a-z0-9_-]+ (lowercase, no spaces)');
  }
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < PASSPHRASE_MIN) {
    throw new UserValidationError(`passphrase must be at least ${PASSPHRASE_MIN} characters`);
  }
}

/**
 * File-backed user store. Reads/writes /var/lib/llmux/users.json (or
 * config.dataDir/users.json).
 *
 * Concurrency model: in-process mutex on writes (the daemon is single-process).
 * Reads load + cache; writes invalidate the cache.
 */
export class FileUserStore implements UserStore {
  private cache: User[] | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private storePath: string) {}

  async createUser(input: CreateUserInput): Promise<User> {
    validateUsername(input.username);
    validatePassphrase(input.passphrase);
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new UserValidationError('name required');
    }
    return this.withLock(async () => {
      const users = this.load();
      if (users.some(u => u.username === input.username)) {
        throw new UserValidationError(`username '${input.username}' already exists`);
      }
      const user: User = {
        username: input.username,
        name: input.name.trim(),
        passphraseHash: hashPassphrase(input.passphrase),
        admin: input.admin === true,
        createdAt: new Date().toISOString(),
      };
      users.push(user);
      this.save(users);
      return user;
    });
  }

  async getUser(username: string): Promise<User | undefined> {
    return this.load().find(u => u.username === username);
  }

  async listUsers(): Promise<User[]> {
    return [...this.load()];
  }

  async updateName(username: string, newName: string): Promise<void> {
    if (typeof newName !== 'string' || newName.trim().length === 0) {
      throw new UserValidationError('name required');
    }
    return this.withLock(async () => {
      const users = this.load();
      const u = users.find(x => x.username === username);
      if (!u) throw new UserValidationError(`user '${username}' not found`);
      u.name = newName.trim();
      this.save(users);
    });
  }

  async setPassphrase(username: string, newPassphrase: string): Promise<void> {
    validatePassphrase(newPassphrase);
    return this.withLock(async () => {
      const users = this.load();
      const u = users.find(x => x.username === username);
      if (!u) throw new UserValidationError(`user '${username}' not found`);
      u.passphraseHash = hashPassphrase(newPassphrase);
      this.save(users);
    });
  }

  async deleteUser(username: string): Promise<void> {
    return this.withLock(async () => {
      const users = this.load();
      const idx = users.findIndex(u => u.username === username);
      if (idx < 0) throw new UserValidationError(`user '${username}' not found`);
      users.splice(idx, 1);
      this.save(users);
    });
  }

  async verifyPassphrase(username: string, candidate: string): Promise<boolean> {
    const u = this.load().find(x => x.username === username);
    if (!u) return false;
    return verifyHash(candidate, u.passphraseHash);
  }

  async isEmpty(): Promise<boolean> {
    return this.load().length === 0;
  }

  // ── private ─────────────────────────────────────────────────────────────

  private load(): User[] {
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
      throw new Error(`users.json: invalid JSON at ${this.storePath}: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`users.json: expected array at ${this.storePath}`);
    }
    this.cache = parsed as User[];
    return this.cache;
  }

  private save(users: User[]): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = this.storePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.storePath);
    try { chmodSync(this.storePath, 0o600); } catch { /* best-effort */ }
    this.cache = users;
  }

  /**
   * Serialize writes through a single promise chain. The daemon is
   * single-process so we don't need cross-process locking, but two
   * concurrent createUser calls in the same process would otherwise
   * race on load/save.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
