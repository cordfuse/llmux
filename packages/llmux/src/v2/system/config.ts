// System-mode daemon config. Loaded from /etc/llmux/config.yaml at boot.
//
// Trust context: boot (read by root before privilege drop). Subsequent
// reads in the service context are from the in-memory cache.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Data plane (v2)" — /etc/llmux/config.yaml row
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 2

import { existsSync, readFileSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  SYSTEM_CONFIG_DIR, SYSTEM_DATA_DIR, SYSTEM_TRANSPORT_DIR, SERVICE_USER, SERVICE_GROUP,
  USER_MODE_DATA_DIR, USER_MODE_TRANSPORT_DIR,
} from './paths.ts';

/**
 * On-disk YAML config schema. Defaults below; operator overrides via
 * /etc/llmux/config.yaml. All paths are absolute.
 */
export interface SystemConfig {
  /** TCP listen port. Defaults to 3001 (matches v1.x). */
  listenPort: number;
  /** Listen interface. '0.0.0.0' default (tailscale-friendly). '127.0.0.1' for loopback-only. */
  listenHost: string;
  /** TLS — optional. If both set, daemon serves HTTPS on listenPort. */
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /** Where the shared orch transport lives. Default /var/lib/llmux/orchestration. */
  transportDir: string;
  /** Where users.json + tokens.json live. Default /var/lib/llmux. */
  dataDir: string;
  /** Service user/group to drop to after port bind. */
  serviceUser: string;
  serviceGroup: string;
  /** How to spawn per-user workers. Defaults to systemd-run on linux+systemd hosts. */
  workerSpawner: 'systemd-run' | 'sudo' | 'runuser';
  /**
   * Dev/test mode. When true:
   *   - Default paths flip to ~/.local/share/llmux/v2-dev (no root required)
   *   - serviceUser / serviceGroup default to the current OS user
   *   - Readiness checks for system-only paths (/etc/llmux, /var/lib/llmux,
   *     'llmux' service user) are skipped
   *   - dropToService is a no-op (already true for non-root, but explicit
   *     in dev mode regardless)
   * Production deployments leave this false.
   */
  userMode: boolean;
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  listenPort: 3001,
  listenHost: '0.0.0.0',
  transportDir: SYSTEM_TRANSPORT_DIR,
  dataDir: SYSTEM_DATA_DIR,
  serviceUser: SERVICE_USER,
  serviceGroup: SERVICE_GROUP,
  workerSpawner: 'systemd-run',
  userMode: false,
};

/** Defaults when userMode is true — paths in $HOME, service user = current OS user. */
export function userModeDefaults(): SystemConfig {
  const me = userInfo();
  return {
    listenPort: 3001,
    listenHost: '127.0.0.1',
    transportDir: USER_MODE_TRANSPORT_DIR,
    dataDir: USER_MODE_DATA_DIR,
    serviceUser: me.username,
    serviceGroup: me.username,
    workerSpawner: 'sudo',  // systemd-run --uid requires polkit in non-root; sudo is the dev fallback
    userMode: true,
  };
}

const VALID_SPAWNERS: ReadonlyArray<SystemConfig['workerSpawner']> = ['systemd-run', 'sudo', 'runuser'];

/**
 * Read /etc/llmux/config.yaml, merge over DEFAULT_SYSTEM_CONFIG, validate.
 * Throws on syntactically-invalid YAML or validation failures; missing
 * file is fine (returns defaults).
 *
 * Trust: called from BOOT context (as root, before privilege drop).
 */
export function loadSystemConfig(path: string = `${SYSTEM_CONFIG_DIR}/config.yaml`): SystemConfig {
  // The userMode env-var shortcut, useful for one-shot test runs:
  //   LLMUX_V2_USER_MODE=1 llmuxd ...
  // Equivalent to loadUserModeConfig() with no on-disk overrides.
  if (process.env['LLMUX_V2_USER_MODE'] === '1' && !existsSync(path)) {
    return userModeDefaults();
  }
  if (!existsSync(path)) {
    return { ...DEFAULT_SYSTEM_CONFIG };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`config: cannot read ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw) ?? {};
  } catch (err) {
    throw new Error(`config: invalid YAML at ${path}: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config: ${path} must be a YAML mapping at the top level`);
  }

  const overrides = parsed as Record<string, unknown>;
  // userMode in the YAML flips the defaults BEFORE per-field merge so any
  // explicit overrides still win on top.
  const base = overrides['userMode'] === true ? userModeDefaults() : { ...DEFAULT_SYSTEM_CONFIG };
  const merged: SystemConfig = { ...base };

  // Per-field merge + per-field validation. Explicit beats clever.
  if (overrides['listenPort'] !== undefined) {
    const v = overrides['listenPort'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 65535) {
      throw new Error(`config: listenPort must be an integer 1..65535 (got ${JSON.stringify(v)})`);
    }
    merged.listenPort = v;
  }
  if (overrides['listenHost'] !== undefined) {
    if (typeof overrides['listenHost'] !== 'string') {
      throw new Error(`config: listenHost must be a string`);
    }
    merged.listenHost = overrides['listenHost'] as string;
  }
  if (overrides['tlsCertPath'] !== undefined) {
    if (typeof overrides['tlsCertPath'] !== 'string') throw new Error('config: tlsCertPath must be a string');
    merged.tlsCertPath = overrides['tlsCertPath'] as string;
  }
  if (overrides['tlsKeyPath'] !== undefined) {
    if (typeof overrides['tlsKeyPath'] !== 'string') throw new Error('config: tlsKeyPath must be a string');
    merged.tlsKeyPath = overrides['tlsKeyPath'] as string;
  }
  if ((merged.tlsCertPath && !merged.tlsKeyPath) || (!merged.tlsCertPath && merged.tlsKeyPath)) {
    throw new Error('config: tlsCertPath and tlsKeyPath must both be set, or neither');
  }
  if (merged.tlsCertPath && !existsSync(merged.tlsCertPath)) {
    throw new Error(`config: tlsCertPath ${merged.tlsCertPath} does not exist`);
  }
  if (merged.tlsKeyPath && !existsSync(merged.tlsKeyPath)) {
    throw new Error(`config: tlsKeyPath ${merged.tlsKeyPath} does not exist`);
  }
  if (overrides['transportDir'] !== undefined) {
    if (typeof overrides['transportDir'] !== 'string') throw new Error('config: transportDir must be a string');
    merged.transportDir = overrides['transportDir'] as string;
  }
  if (overrides['dataDir'] !== undefined) {
    if (typeof overrides['dataDir'] !== 'string') throw new Error('config: dataDir must be a string');
    merged.dataDir = overrides['dataDir'] as string;
  }
  if (overrides['serviceUser'] !== undefined) {
    if (typeof overrides['serviceUser'] !== 'string') throw new Error('config: serviceUser must be a string');
    merged.serviceUser = overrides['serviceUser'] as string;
  }
  if (overrides['serviceGroup'] !== undefined) {
    if (typeof overrides['serviceGroup'] !== 'string') throw new Error('config: serviceGroup must be a string');
    merged.serviceGroup = overrides['serviceGroup'] as string;
  }
  if (overrides['workerSpawner'] !== undefined) {
    const v = overrides['workerSpawner'];
    if (typeof v !== 'string' || !VALID_SPAWNERS.includes(v as SystemConfig['workerSpawner'])) {
      throw new Error(`config: workerSpawner must be one of ${VALID_SPAWNERS.join(', ')} (got ${JSON.stringify(v)})`);
    }
    merged.workerSpawner = v as SystemConfig['workerSpawner'];
  }

  // Cross-field sanity: dataDir + transportDir should be readable/writable
  // by the service user. We can't fully validate that as root (we haven't
  // dropped yet), but we can at least check the path exists or is creatable.
  for (const dir of [merged.dataDir, merged.transportDir]) {
    try {
      if (existsSync(dir)) {
        const s = statSync(dir);
        if (!s.isDirectory()) {
          throw new Error(`config: ${dir} exists but is not a directory`);
        }
      }
      // If it doesn't exist, install.sh creates it before first boot. Not an error here.
    } catch (err) {
      throw new Error(`config: ${dir} sanity check failed: ${(err as Error).message}`);
    }
  }

  return merged;
}
