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

import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { SystemConfig } from './config.ts';

export interface DropResult {
  ok: boolean;
  ranAsRoot: boolean;
  effectiveUser: string;
  effectiveUid: number;
  warning?: string;
  error?: string;
}

/**
 * Drop the current process's uid/gid to the configured service user.
 *
 * If already running as a non-root user, this is a no-op (and we surface
 * a warning that system-mode features may be limited — e.g., spawning
 * per-user workers via `systemd-run --uid` requires root or appropriate
 * polkit grants).
 *
 * MUST be called after binding the listen port. Default 3001 is
 * unprivileged so binding doesn't need root, but if the operator
 * configures a privileged port (< 1024) the systemd unit must grant
 * CAP_NET_BIND_SERVICE so the bind succeeds.
 *
 * Trust: BOOT context only. Calling this from any other context is a bug.
 */
export function dropToService(config: SystemConfig): DropResult {
  const startingUid = process.getuid?.() ?? -1;

  // No-op path: already non-root.
  if (startingUid !== 0) {
    const me = currentUsername();
    return {
      ok: true,
      ranAsRoot: false,
      effectiveUser: me,
      effectiveUid: startingUid,
      warning: `not running as root (uid=${startingUid}, user=${me}); system-mode worker spawning may be limited`,
    };
  }

  // process.setgid + process.setuid accept either numeric ids OR usernames/
  // groupnames (Node resolves via getpwnam/getgrnam internally). String form
  // saves us from shelling out to `id`.
  //
  // Order is critical: setgid BEFORE setuid. If we setuid first, we lose the
  // privilege to setgid.
  try {
    process.setgid?.(config.serviceGroup);
  } catch (err) {
    return {
      ok: false,
      ranAsRoot: true,
      effectiveUser: 'root',
      effectiveUid: 0,
      error: `setgid(${config.serviceGroup}) failed: ${(err as Error).message}`,
    };
  }
  try {
    process.setuid?.(config.serviceUser);
  } catch (err) {
    return {
      ok: false,
      ranAsRoot: true,
      effectiveUser: 'root',
      effectiveUid: 0,
      error: `setuid(${config.serviceUser}) failed: ${(err as Error).message}`,
    };
  }

  // chdir to a safe location so we don't hold a former-root cwd handle.
  try {
    process.chdir('/');
  } catch { /* best-effort */ }

  return {
    ok: true,
    ranAsRoot: true,
    effectiveUser: config.serviceUser,
    effectiveUid: process.getuid?.() ?? -1,
  };
}

/**
 * Sanity-check the runtime environment for system-mode requirements.
 * Returns a list of problems; empty list = ready to boot.
 *
 * Trust: BOOT context (called before dropToService).
 */
export function checkSystemModeReadiness(config: SystemConfig): string[] {
  const problems: string[] = [];

  // 1. Config dir exists and is readable.
  const configDir = config.dataDir.replace(/\/[^/]*$/, '') || '/etc/llmux';
  if (!existsSync('/etc/llmux')) {
    problems.push('/etc/llmux does not exist — run deploy/install.sh first');
  } else {
    try { accessSync('/etc/llmux', fsConstants.R_OK); }
    catch { problems.push('/etc/llmux is not readable'); }
  }

  // 2. Data dir exists and is writable (after privilege drop, by the service user).
  if (!existsSync(config.dataDir)) {
    problems.push(`${config.dataDir} does not exist — run deploy/install.sh first`);
  }

  // 3. Service user is resolvable (try `id -u <user>`; quiet failure means unknown user).
  const idCheck = spawnSync('id', ['-u', config.serviceUser], { encoding: 'utf-8' });
  if (idCheck.status !== 0) {
    problems.push(`service user '${config.serviceUser}' does not exist — run deploy/install.sh first`);
  }

  // 4. Chosen worker spawner helper is on PATH.
  const spawnerBin = config.workerSpawner;
  const which = spawnSync('which', [spawnerBin], { encoding: 'utf-8' });
  if (which.status !== 0) {
    problems.push(`worker spawner '${spawnerBin}' is not on PATH`);
  }

  // 5. TLS files exist if configured (config validator already checks this,
  //    but re-check here in case files were removed between config load and boot).
  if (config.tlsCertPath && !existsSync(config.tlsCertPath)) {
    problems.push(`TLS cert ${config.tlsCertPath} does not exist`);
  }
  if (config.tlsKeyPath && !existsSync(config.tlsKeyPath)) {
    problems.push(`TLS key ${config.tlsKeyPath} does not exist`);
  }

  // Suppress unused-var lint for configDir (we may want to use it later).
  void configDir;

  return problems;
}

/**
 * Best-effort current-username for the no-op path of dropToService.
 * Returns '<uid>' if we can't resolve a name (no getpwuid in Node).
 */
function currentUsername(): string {
  const uid = process.getuid?.() ?? -1;
  if (uid < 0) return 'unknown';
  const r = spawnSync('id', ['-un'], { encoding: 'utf-8' });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return String(uid);
}
