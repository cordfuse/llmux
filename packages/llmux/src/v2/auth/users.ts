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
  /** Create a new user. Validates OS-user existence + uniqueness + passphrase strength. */
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

/**
 * File-backed user store. Reads/writes /var/lib/llmux/users.json (or
 * config.dataDir/users.json).
 *
 * Concurrency model: in-process mutex on writes (the daemon is single-process).
 * Reads load + cache; writes invalidate the cache.
 */
export class FileUserStore implements UserStore {
  // TODO(phase 3): implement
  //   - Read users.json on construction; default to empty array if missing
  //   - Atomic write: tmp file + rename
  //   - scrypt hashing: crypto.scryptSync with N=2^17 (or higher), random salt
  //   - Hash format: `scrypt$N$saltBase64$hashBase64` (self-describing for future tuning)
  //   - createUser validates: username matches /^[a-z0-9_-]+$/,
  //     not already in store, passphrase passes basic length check (>= 8 chars suggested).
  //     Application-layer username only — NO OS user lookup (per Grafana model).
  //   - verifyPassphrase uses crypto.timingSafeEqual to prevent timing attacks

  constructor(private _storePath: string) {}

  async createUser(_input: CreateUserInput): Promise<User> { throw new Error('TODO(phase 3)'); }
  async getUser(_username: string): Promise<User | undefined> { throw new Error('TODO(phase 3)'); }
  async listUsers(): Promise<User[]> { throw new Error('TODO(phase 3)'); }
  async updateName(_username: string, _newName: string): Promise<void> { throw new Error('TODO(phase 3)'); }
  async setPassphrase(_username: string, _newPassphrase: string): Promise<void> { throw new Error('TODO(phase 3)'); }
  async deleteUser(_username: string): Promise<void> { throw new Error('TODO(phase 3)'); }
  async verifyPassphrase(_username: string, _candidate: string): Promise<boolean> { throw new Error('TODO(phase 3)'); }
  async isEmpty(): Promise<boolean> { throw new Error('TODO(phase 3)'); }
}
