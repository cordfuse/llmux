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

export interface IdentityToken {
  /** Server-side token id (UUID or short hash). Stable; safe to log. */
  tokenId: string;
  /** scrypt-hashed token secret. Plaintext never persisted. */
  secretHash: string;
  /** The user this token authenticates as. Owning user enforces `from:`. */
  username: string;
  /** Human-readable label. e.g. "alice-iphone", "ci-pipeline". */
  name: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. Optional — tokens without expiry are long-lived by default. */
  expiresAt?: string;
  /** ISO-8601. Refreshed by the daemon on each successful auth. */
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
  /** The plaintext secret. RETURNED ONCE. Never readable again from the store. */
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
  /** List tokens (admin sees all; user sees own). */
  list(filterUsername?: string): Promise<IdentityToken[]>;
  /** Revoke by tokenId. Idempotent. */
  revoke(tokenId: string): Promise<void>;
  /** Validate a presented secret against the store. Touches lastUsedAt on success. */
  validate(presentedSecret: string): Promise<TokenValidation>;
}

/**
 * Wire format for presented secrets: `<tokenId>.<plaintextSecret>`. The
 * tokenId prefix lets us look up the row in O(1) without scanning every
 * hash. Same shape as GitHub PATs (`ghp_<id>_<secret>`) and AWS access
 * keys (`AKIA<id>` + `<secret>`).
 */
export const TOKEN_WIRE_SEPARATOR = '.';
export const TOKEN_PREFIX = 'sas_'; // matches v1.x for migration

export class FileTokenStore implements TokenStore {
  // TODO(phase 4): implement
  //   - Read /var/lib/llmux/tokens.json on construction; default empty
  //   - Atomic write: tmp file + rename
  //   - Mint: crypto.randomBytes(32).toString('base64url'); hash with scrypt
  //   - Validate: parse `<tokenId>.<secret>`, lookup row, scrypt-compare,
  //     check expiry, touch lastUsedAt, return token
  //   - Revoke: delete row + invalidate any in-memory cache

  constructor(private _storePath: string) {}

  async mint(_input: MintTokenInput): Promise<MintTokenResult> { throw new Error('TODO(phase 4)'); }
  async get(_tokenId: string): Promise<IdentityToken | undefined> { throw new Error('TODO(phase 4)'); }
  async list(_filterUsername?: string): Promise<IdentityToken[]> { throw new Error('TODO(phase 4)'); }
  async revoke(_tokenId: string): Promise<void> { throw new Error('TODO(phase 4)'); }
  async validate(_presentedSecret: string): Promise<TokenValidation> { throw new Error('TODO(phase 4)'); }
}
