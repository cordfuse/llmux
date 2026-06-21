// System-mode daemon config. Loaded from /etc/llmux/config.yaml at boot.
//
// Trust context: boot (read by root before privilege drop). Subsequent
// reads in the service context are from the in-memory cache.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Data plane (v2)" — /etc/llmux/config.yaml row
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 2

import { SYSTEM_CONFIG_DIR, SYSTEM_DATA_DIR, SYSTEM_TRANSPORT_DIR, SERVICE_USER, SERVICE_GROUP } from './paths.ts';

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
}

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  listenPort: 3001,
  listenHost: '0.0.0.0',
  transportDir: SYSTEM_TRANSPORT_DIR,
  dataDir: SYSTEM_DATA_DIR,
  serviceUser: SERVICE_USER,
  serviceGroup: SERVICE_GROUP,
  workerSpawner: 'systemd-run',
};

/**
 * Read /etc/llmux/config.yaml, merge over DEFAULT_SYSTEM_CONFIG, validate.
 * Throws on syntactically-invalid YAML; missing file is fine (defaults).
 *
 * Trust: called from BOOT context (as root, before privilege drop).
 */
export function loadSystemConfig(_path: string = `${SYSTEM_CONFIG_DIR}/config.yaml`): SystemConfig {
  // TODO(phase 2): YAML parse + merge over DEFAULT_SYSTEM_CONFIG + validation
  //   - Parse with `yaml` (already a dep)
  //   - Validate listenPort range, listenHost format, TLS paths exist if set
  //   - Validate workerSpawner is one of the supported helpers
  //   - Return merged config
  return { ...DEFAULT_SYSTEM_CONFIG };
}
