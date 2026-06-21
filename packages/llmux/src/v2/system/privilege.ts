// Drop from root to the llmux service user after binding ports.
//
// Trust context: BOOT (the only file in v2 that ever runs as root). After
// dropToService() returns, the process is the service user for the rest
// of its lifetime — code in the auth/ and worker/ trees ONLY ever runs
// in the service context (or in spawned per-user workers).
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "v2 architecture" — privilege boundary
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 2

import type { SystemConfig } from './config.ts';

export interface DropResult {
  ok: boolean;
  ranAsRoot: boolean;
  effectiveUser: string;
  error?: string;
}

/**
 * Drop the current process's uid/gid to the configured service user.
 *
 * If already running as a non-root user, this is a no-op (and we log a
 * warning that system-mode features may be limited — e.g., no per-user
 * spawning via systemd-run --uid will work without root).
 *
 * MUST be called after binding the listen port (binding < 1024 needs root;
 * binding 3001 doesn't, so order matters less here, but the convention
 * is bind-then-drop).
 *
 * Trust: BOOT context only. Calling this from any other context is a bug.
 */
export function dropToService(_config: SystemConfig): DropResult {
  // TODO(phase 2): implement
  //   - Check process.getuid() — if not 0, return ranAsRoot:false + warn
  //   - getpwnam(config.serviceUser) to resolve uid/gid
  //   - process.setgid(gid) then process.setuid(uid) — ORDER MATTERS
  //   - chdir to a non-user dir (/) so we don't hold a former-root cwd handle
  //   - Return result
  return {
    ok: true,
    ranAsRoot: process.getuid?.() === 0,
    effectiveUser: 'unknown',
  };
}

/**
 * Sanity-check the runtime environment for system-mode requirements.
 * Returns a list of problems; empty list = ready to boot.
 *
 * Trust: BOOT context (called before dropToService).
 */
export function checkSystemModeReadiness(_config: SystemConfig): string[] {
  // TODO(phase 2): implement
  //   - /etc/llmux exists + readable
  //   - /var/lib/llmux exists + writable by service user
  //   - getpwnam(serviceUser) resolves
  //   - The chosen workerSpawner helper is on PATH (systemd-run / sudo / runuser)
  //   - If TLS configured, cert + key files exist + readable
  return [];
}
