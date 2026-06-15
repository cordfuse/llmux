import { randomBytes } from 'node:crypto';
import { notImplemented } from './cli.ts';

export interface TokenRecord {
  token: string;
  createdAt: string;
  expiresAt?: string;
}

/** 32-byte URL-safe token (44 chars). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createToken(_expiry?: string): TokenRecord {
  notImplemented('token.create');
}

export function refreshToken(): TokenRecord {
  notImplemented('token.refresh');
}

export function revokeToken(): void {
  notImplemented('token.revoke');
}

export function showToken(): TokenRecord | null {
  notImplemented('token.show');
}

export function validateToken(_candidate: string): boolean {
  notImplemented('token.validate');
}
