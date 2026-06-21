// First-run setup wizard.
//
// Trust context: SERVICE. The setup wizard runs in the daemon process
// (service user), gated by a one-time setup token printed to the daemon's
// terminal/journal at boot time when the user store is empty.
//
// Flow:
//   1. Daemon boots; if userStore.isEmpty() → mintSetupToken() + print
//      the URL to stdout/journal AND write the token to /var/run/llmux/setup-token
//      (mode 0640, group llmux) so operators with shell access can recover it.
//   2. Every incoming request: setupGate() — if no users exist AND the
//      request isn't to /setup/* OR the setup token is invalid → 503
//      with "setup needed" guidance.
//   3. /setup wizard collects name + username + passphrase
//   4. POST /api/setup validates + creates user + mints bootstrap token
//      + invalidates the setup token
//   5. Subsequent requests go through normal auth
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Setup wizard — what invokes it (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 6

import type { UserStore, CreateUserInput } from './users.ts';
import type { TokenStore, MintTokenResult } from './tokens.ts';

export interface SetupTokenRecord {
  /** Plaintext — kept in memory only, printed to operator out-of-band. */
  token: string;
  createdAt: string;
  /** Soft expiry; the daemon clears the token on successful setup OR on restart. */
  expiresAt: string;
}

export interface SetupSubmitInput {
  /** From the URL ?token=... query param. */
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

/**
 * Mint a new setup token. Called only at boot when the user store is empty.
 * The plaintext is kept in memory + written to /var/run/llmux/setup-token
 * (perm 0640, owner root:llmux). Operators with shell access (root or
 * llmux group) can recover it via `cat /var/run/llmux/setup-token`.
 */
export function mintSetupToken(): SetupTokenRecord {
  // TODO(phase 6): implement
  //   - crypto.randomBytes(24).toString('base64url')
  //   - Write plaintext to /var/run/llmux/setup-token (mode 0640)
  //   - Print URL to stdout + journal
  throw new Error('TODO(phase 6)');
}

/**
 * Validate that a presented setup token matches the active one in memory.
 * Constant-time compare. Returns false if no active token or mismatch.
 */
export function isSetupTokenValid(_presented: string): boolean {
  // TODO(phase 6): implement
  throw new Error('TODO(phase 6)');
}

/**
 * Per-request gate. Returns either:
 *   { allow: true } — request may proceed (auth not yet bootstrapped OR
 *     bootstrap-related path with valid setup token)
 *   { allow: false, status, body } — daemon should respond with these
 */
export interface GateResult {
  allow: boolean;
  status?: number;
  body?: unknown;
}

export async function setupGate(
  _userStore: UserStore,
  _path: string,
  _setupTokenQueryParam: string | undefined,
): Promise<GateResult> {
  // TODO(phase 6): implement
  //   - if !await userStore.isEmpty() → { allow: true }  (normal auth handles the rest)
  //   - if path startsWith('/setup') or '/api/setup' AND isSetupTokenValid(query) → allow
  //   - else → { allow: false, status: 503, body: { error: 'setup needed', see: '/setup' } }
  throw new Error('TODO(phase 6)');
}

/**
 * Handle POST /api/setup. Validates input, creates the user, mints the
 * bootstrap token, invalidates the setup token. Returns the bootstrap
 * token (plaintext) ONCE for the wizard to display + use as a session
 * cookie.
 */
export async function handleSetupSubmit(
  _input: SetupSubmitInput,
  _userStore: UserStore,
  _tokenStore: TokenStore,
): Promise<SetupSubmitResult> {
  // TODO(phase 6): implement
  //   - Validate setup token
  //   - Validate username format + OS user exists (getpwnam)
  //   - Validate passphrase basic strength
  //   - userStore.createUser({ ...input, admin: true })
  //   - tokenStore.mint({ username, name: `${name}'s first device` })
  //   - Invalidate setup token
  //   - Return MintTokenResult
  throw new Error('TODO(phase 6)');
}

/** For the non-interactive bootstrap path (env-var driven, no wizard). */
export interface BootstrapEnvInput {
  username: string;
  name: string;
  passphrase: string;
}

export async function bootstrapFromEnv(
  _input: BootstrapEnvInput,
  _userStore: UserStore,
  _tokenStore: TokenStore,
): Promise<MintTokenResult> {
  // TODO(phase 6): same as handleSetupSubmit but no setup-token gate,
  // for Docker / CI / headless. Reads LLMUX_INIT_USERNAME / NAME /
  // PASSPHRASE from process.env.
  throw new Error('TODO(phase 6)');
}

/**
 * Plain-text setup invocation banner — what the daemon prints to stdout
 * when it mints a setup token at boot. Keep in this module so the format
 * stays stable for ops + log scrapers.
 */
export function setupBanner(setupUrl: string): string {
  const sep = '─'.repeat(63);
  return `\n┌${sep}┐\n` +
    `│ llmux: first-run setup needed.${' '.repeat(31)}│\n` +
    `│ Visit: ${setupUrl.padEnd(54)}│\n` +
    `│ Don't share this URL — it grants admin to whoever uses it.    │\n` +
    `└${sep}┘\n`;
}
