// Client-side operator credentials file.
//
// Trust context: CLIENT (the operator's own llmux CLI on their own
// machine). The daemon NEVER reads this file — it's read only by the
// operator's CLI, which sends the contained token as a bearer credential
// on outgoing API requests.
//
// This is the ONE legitimate $HOME path in v2 production. Same shape and
// purpose as ~/.aws/credentials, ~/.kube/config, ~/.docker/config.json,
// gh/hosts.yml — those tools' daemons don't read those files either.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "$HOME principle" — exception 1
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 6

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { operatorCredentialsPath } from '../system/paths.ts';

export interface ProfileEntry {
  /** Daemon URL — e.g. http://localhost:3001 or https://myhost.tailnet:3001 */
  serverUrl: string;
  /** Application-layer username this profile authenticates as. */
  username: string;
  /** Wire token (sas_<id>.<secret>). Plaintext — file is 0o600 in $HOME. */
  token: string;
  /** ISO-8601 when this profile was last saved (created or token-rotated). */
  savedAt: string;
}

export interface CredentialsFile {
  version: 1;
  /** Profile name marked active. Used when no --profile is passed. */
  active?: string;
  /** Map of profile name → entry. Profile names are operator-chosen labels. */
  profiles: Record<string, ProfileEntry>;
}

const EMPTY: CredentialsFile = { version: 1, profiles: {} };

export class CredentialsError extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialsError'; }
}

/**
 * Derive a sensible default profile name from a server URL. Used when the
 * operator hasn't specified one explicitly. `https://myhost.tailnet:3001`
 * → `myhost.tailnet-3001`.
 */
export function defaultProfileName(serverUrl: string): string {
  let host: string;
  let port: string | undefined;
  try {
    const u = new URL(serverUrl);
    host = u.hostname || 'localhost';
    port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : undefined);
  } catch {
    return serverUrl.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  }
  return port ? `${host}-${port}` : host;
}

/**
 * Load the credentials file. Returns the empty shape if the file doesn't
 * exist or contains an empty object — first-time use is not an error.
 */
export function loadCredentials(path: string = operatorCredentialsPath()): CredentialsFile {
  if (!existsSync(path)) return { ...EMPTY };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new CredentialsError(`cannot read ${path}: ${(err as Error).message}`);
  }
  if (raw.trim().length === 0) return { ...EMPTY };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialsError(`invalid JSON at ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialsError(`expected JSON object at ${path}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== 1) {
    throw new CredentialsError(`unsupported credentials file version: ${String(obj['version'])}`);
  }
  const profilesRaw = obj['profiles'];
  if (typeof profilesRaw !== 'object' || profilesRaw === null || Array.isArray(profilesRaw)) {
    throw new CredentialsError(`credentials.profiles must be an object`);
  }
  const profiles: Record<string, ProfileEntry> = {};
  for (const [name, entry] of Object.entries(profilesRaw)) {
    const e = entry as Record<string, unknown>;
    if (typeof e['serverUrl'] !== 'string' || typeof e['username'] !== 'string'
        || typeof e['token'] !== 'string' || typeof e['savedAt'] !== 'string') {
      throw new CredentialsError(`profile '${name}' is malformed`);
    }
    profiles[name] = {
      serverUrl: e['serverUrl'],
      username: e['username'],
      token: e['token'],
      savedAt: e['savedAt'],
    };
  }
  const active = typeof obj['active'] === 'string' ? (obj['active'] as string) : undefined;
  const result: CredentialsFile = { version: 1, profiles };
  if (active && profiles[active]) result.active = active;
  return result;
}

/**
 * Persist the credentials file atomically with 0o600 perms. Creates
 * parent directories as needed.
 */
export function saveCredentials(
  file: CredentialsFile,
  path: string = operatorCredentialsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export interface UpsertProfileInput {
  name?: string;          // defaults to defaultProfileName(serverUrl)
  serverUrl: string;
  username: string;
  token: string;
  /** When true (default), mark this profile as the active one. */
  setActive?: boolean;
}

/**
 * Add or replace a profile and persist. Returns the resolved profile name.
 */
export function upsertProfile(
  input: UpsertProfileInput,
  path: string = operatorCredentialsPath(),
): string {
  const name = input.name && input.name.trim().length > 0
    ? input.name.trim()
    : defaultProfileName(input.serverUrl);
  const file = loadCredentials(path);
  file.profiles[name] = {
    serverUrl: input.serverUrl,
    username: input.username,
    token: input.token,
    savedAt: new Date().toISOString(),
  };
  if (input.setActive !== false) file.active = name;
  saveCredentials(file, path);
  return name;
}

/**
 * Remove a profile. If it was the active one, the active marker is also
 * cleared (operator must run `auth use <name>` to re-pick one). Returns
 * true if a profile was actually removed.
 */
export function removeProfile(
  name: string,
  path: string = operatorCredentialsPath(),
): boolean {
  const file = loadCredentials(path);
  if (!file.profiles[name]) return false;
  delete file.profiles[name];
  if (file.active === name) delete file.active;
  saveCredentials(file, path);
  return true;
}

/**
 * Mark a profile as active. Throws if no such profile.
 */
export function setActiveProfile(
  name: string,
  path: string = operatorCredentialsPath(),
): void {
  const file = loadCredentials(path);
  if (!file.profiles[name]) throw new CredentialsError(`no profile named '${name}'`);
  file.active = name;
  saveCredentials(file, path);
}

/**
 * Resolve which profile to use given an optional explicit name. Falls
 * back to the active profile. Returns undefined if no match (caller
 * decides how to handle — typically fall back to LLMUX_TOKEN env or
 * unauthenticated mode).
 */
export function resolveProfile(
  file: CredentialsFile,
  explicitName?: string,
): { name: string; profile: ProfileEntry } | undefined {
  const name = explicitName ?? file.active;
  if (!name) return undefined;
  const profile = file.profiles[name];
  if (!profile) return undefined;
  return { name, profile };
}
