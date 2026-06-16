import { randomBytes } from 'node:crypto';

const TOKEN_PREFIX = 'sas_';

/** Generate a fresh SAS token: `sas_<43-char-base64url>`. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** Stable short id for a token: 8 chars after the `sas_` prefix. */
export function tokenId(token: string): string {
  return token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 8) : token.slice(0, 8);
}
