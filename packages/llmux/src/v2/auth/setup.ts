// First-run setup wizard.
//
// Trust context: SERVICE. The setup wizard runs in the daemon process
// (service user), gated by a one-time setup token printed to the daemon's
// terminal/journal at boot time when the user store is empty.
//
// Flow:
//   1. Daemon boots; if userStore.isEmpty() → SetupState.mint() prints
//      the URL to stdout/journal AND writes the token to
//      /var/run/llmux/setup-token so operators with shell access can
//      recover it.
//   2. Every incoming request: setupGate() — if no users exist AND the
//      request isn't to /setup/* or /api/setup/* → 503 with "setup needed."
//      Token validation happens in the handler, not the gate.
//   3. /setup wizard collects name + username + passphrase
//   4. POST /api/setup validates + creates user + mints bootstrap token
//      + invalidates the setup token
//   5. Subsequent requests go through normal auth
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Setup wizard — what invokes it (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 5

import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { UserStore } from './users.ts';
import { UserValidationError } from './users.ts';
import type { TokenStore, MintTokenResult } from './tokens.ts';

export interface SetupTokenRecord {
  /** Plaintext — kept in memory only, printed to operator out-of-band. */
  token: string;
  createdAt: string;
  /** Soft expiry; the daemon clears the token on successful setup OR on restart. */
  expiresAt: string;
}

export interface SetupSubmitInput {
  /** From the URL ?token=... query param or hidden form field. */
  setupToken: string;
  name: string;
  username: string;
  passphrase: string;
}

export interface SetupSubmitResult {
  ok: boolean;
  /** On success: bootstrap token for the new admin user (returned once). */
  bootstrapToken?: MintTokenResult;
  error?: string;
}

export interface GateResult {
  allow: boolean;
  status?: number;
  body?: unknown;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h soft expiry
const SETUP_TOKEN_BYTES = 24;               // 192 bits → 32-char base64url

/**
 * Holds the active setup token for the daemon process. One instance per
 * daemon — constructed in the boot path. Lifecycle:
 *
 *   - mint()  — boot calls this if userStore is empty. Writes plaintext
 *               to disk for shell-access recovery, returns the record so
 *               the boot path can format the URL + print the banner.
 *   - isValid() — handler calls this when a setup-token bearing request
 *               arrives. Constant-time compare.
 *   - clear() — called by handleSetupSubmit on success. Wipes in-memory
 *               state + removes the on-disk file.
 *
 * Token state is intentionally NOT persisted across daemon restarts —
 * if the daemon restarts mid-setup, the operator re-runs setup with a
 * fresh token. This is by design.
 */
export class SetupState {
  private activeToken: string | undefined;
  private mintedAt: Date | undefined;
  private readonly ttlMs: number;
  private readonly fileMode: number;

  constructor(
    private readonly tokenFilePath: string,
    opts?: { ttlMs?: number; fileMode?: number },
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.fileMode = opts?.fileMode ?? 0o600;
  }

  mint(): SetupTokenRecord {
    const token = randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
    const now = new Date();
    this.activeToken = token;
    this.mintedAt = now;

    mkdirSync(dirname(this.tokenFilePath), { recursive: true });
    writeFileSync(this.tokenFilePath, token + '\n', { mode: this.fileMode });

    return {
      token,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
  }

  isValid(presented: unknown): boolean {
    if (!this.activeToken || typeof presented !== 'string') return false;
    if (this.isExpired()) return false;
    const a = Buffer.from(this.activeToken);
    const b = Buffer.from(presented);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  clear(): void {
    this.activeToken = undefined;
    this.mintedAt = undefined;
    try { unlinkSync(this.tokenFilePath); } catch { /* file may not exist; ignore */ }
  }

  get hasActiveToken(): boolean {
    return this.activeToken !== undefined && !this.isExpired();
  }

  private isExpired(): boolean {
    if (!this.mintedAt) return true;
    return Date.now() > this.mintedAt.getTime() + this.ttlMs;
  }
}

/**
 * Per-request gate. In first-run mode (no users exist), only /setup and
 * /api/setup paths are allowed through; everything else gets 503.
 * Token validation is the handler's responsibility — keeps the gate
 * stateless and lets the HTTP layer add nuance (HTML vs JSON responses,
 * static assets, etc.) without re-implementing token checks.
 */
export async function setupGate(
  userStore: UserStore,
  path: string,
): Promise<GateResult> {
  if (!(await userStore.isEmpty())) return { allow: true };
  if (
    path === '/setup' || path.startsWith('/setup/') || path.startsWith('/setup?') ||
    path === '/api/setup' || path.startsWith('/api/setup/') || path.startsWith('/api/setup?')
  ) {
    return { allow: true };
  }
  return {
    allow: false,
    status: 503,
    body: {
      error: 'setup needed',
      hint: 'Visit /setup?token=... with the token printed by the daemon at boot (or read /var/run/llmux/setup-token).',
    },
  };
}

/**
 * Handle POST /api/setup. Validates token + input, creates the admin
 * user, mints the bootstrap token, invalidates the setup token. Returns
 * the bootstrap token (plaintext) ONCE for the wizard to display and
 * set as a session cookie.
 */
export async function handleSetupSubmit(
  input: SetupSubmitInput,
  userStore: UserStore,
  tokenStore: TokenStore,
  setup: SetupState,
): Promise<SetupSubmitResult> {
  if (!setup.isValid(input.setupToken)) {
    return { ok: false, error: 'invalid or expired setup token' };
  }
  if (!(await userStore.isEmpty())) {
    // Belt-and-suspenders: setupGate would already have routed this
    // through normal auth, but if we got here somehow, refuse.
    return { ok: false, error: 'setup already complete' };
  }

  try {
    const user = await userStore.createUser({
      username: input.username,
      name: input.name,
      passphrase: input.passphrase,
      admin: true,
    });
    const bootstrapToken = await tokenStore.mint({
      username: user.username,
      name: `${user.name}'s first device`,
    });
    setup.clear();
    return { ok: true, bootstrapToken };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof UserValidationError ? err.message : `setup failed: ${(err as Error).message}`,
    };
  }
}

/**
 * Non-interactive bootstrap from env vars. For Docker / CI / headless
 * deploys — bypasses the setup token gate but still uses the user store
 * + token store to enforce uniqueness and validation.
 *
 * Reads:
 *   LLMUX_INIT_USERNAME, LLMUX_INIT_NAME, LLMUX_INIT_PASSPHRASE
 *
 * Returns undefined if no env vars are set (caller falls back to setup
 * wizard). Throws if env vars are partial or if users already exist.
 */
export async function bootstrapFromEnv(
  userStore: UserStore,
  tokenStore: TokenStore,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MintTokenResult | undefined> {
  const username = env['LLMUX_INIT_USERNAME'];
  const name = env['LLMUX_INIT_NAME'];
  const passphrase = env['LLMUX_INIT_PASSPHRASE'];

  const anySet = username !== undefined || name !== undefined || passphrase !== undefined;
  if (!anySet) return undefined;

  if (!username || !name || !passphrase) {
    throw new Error(
      'bootstrapFromEnv: LLMUX_INIT_USERNAME, LLMUX_INIT_NAME, LLMUX_INIT_PASSPHRASE must all be set',
    );
  }
  if (!(await userStore.isEmpty())) {
    throw new Error('bootstrapFromEnv: refusing — users already exist');
  }

  const user = await userStore.createUser({ username, name, passphrase, admin: true });
  return tokenStore.mint({
    username: user.username,
    name: `${user.name}'s bootstrap device`,
  });
}

/**
 * Plain-text setup invocation banner — what the daemon prints to stdout
 * when it mints a setup token at boot. Format is stable for log scrapers.
 */
export function setupBanner(setupUrl: string): string {
  const sep = '─'.repeat(63);
  return `\n┌${sep}┐\n` +
    `│ llmux: first-run setup needed.${' '.repeat(31)}│\n` +
    `│ Visit: ${setupUrl.padEnd(54)}│\n` +
    `│ Don't share this URL — it grants admin to whoever uses it.    │\n` +
    `└${sep}┘\n`;
}
