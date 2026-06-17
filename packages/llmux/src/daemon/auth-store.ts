import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDir } from './state.ts';
import { generateToken, tokenId } from './token.ts';

export interface AuthToken {
  id: string;
  token: string;
  name?: string;
  createdAt: string;
  expiresAt?: string;
}

interface AuthFile {
  version: 1;
  tokens: AuthToken[];
}

const EMPTY: AuthFile = { version: 1, tokens: [] };

export function authPath(): string {
  return join(stateDir(), 'auth.json');
}

function load(): AuthFile {
  const p = authPath();
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<AuthFile>;
    if (parsed.version === 1 && Array.isArray(parsed.tokens)) {
      return { version: 1, tokens: parsed.tokens };
    }
  } catch {}
  return structuredClone(EMPTY);
}

function save(file: AuthFile): void {
  const p = authPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export function listAuthTokens(): AuthToken[] {
  return load().tokens;
}

export function createAuthToken(opts: { name?: string; expiresAt?: string } = {}): AuthToken {
  const token = generateToken();
  const rec: AuthToken = {
    id: tokenId(token),
    token,
    createdAt: new Date().toISOString(),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
  const file = load();
  file.tokens.push(rec);
  save(file);
  return rec;
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

export function validateAuthToken(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const now = Date.now();
  return load().tokens.some((t) => {
    if (t.token !== candidate) return false;
    if (t.expiresAt && new Date(t.expiresAt).getTime() < now) return false;
    return true;
  });
}

/** Auth is enabled when at least one token has been provisioned. */
export function authEnabled(): boolean {
  return load().tokens.length > 0;
}
