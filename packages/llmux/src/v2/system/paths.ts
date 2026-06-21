// System-mode path constants.
//
// Trust context: any. These are pure constants + path-derivation helpers,
// no I/O.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Data plane (v2)"

import { join } from 'node:path';
import { homedir } from 'node:os';

/** Read-only root for daemon config (operator-edited, root-owned). */
export const SYSTEM_CONFIG_DIR = '/etc/llmux';

/** Mutable runtime data root, owned by the service user. */
export const SYSTEM_DATA_DIR = '/var/lib/llmux';

/** Default shared orch transport for the system instance. */
export const SYSTEM_TRANSPORT_DIR = join(SYSTEM_DATA_DIR, 'orchestration');

/** Service user + group the daemon drops to after binding ports. */
export const SERVICE_USER = 'llmux';
export const SERVICE_GROUP = 'llmux';

/** Where the daemon's pid + the one-time setup token live (tmpfs/ephemeral). */
export const RUNTIME_DIR = '/var/run/llmux';

/** Per-operator credentials path on each user's machine (NOT system-owned). */
export function operatorCredentialsPath(home: string = homedir()): string {
  return join(home, '.config', 'llmux', 'credentials.json');
}

/** Per-user runtime state (claims, cursors, etc.) lives in the USER's home,
 *  not in /var/lib. Workers write here as the user's uid. */
export function userRuntimeStateDir(home: string): string {
  return join(home, '.local', 'state', 'llmux');
}
