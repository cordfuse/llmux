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

// ── User-mode (dev) overrides ────────────────────────────────────────────
//
// When `userMode: true` is set in SystemConfig, all paths shift into the
// current OS user's home so the v2 daemon can boot + serve + persist state
// without root or any sudo-touched system directories. Lets you exercise
// Phases 3-4-6-7-9 (users, tokens, setup wizard, account/admin pages,
// orch enforcement) without running install.sh.
//
// Per-user worker spawn (Phase 5) is the only thing that still needs real
// privileges to test multi-user isolation; spawning as yourself works in
// user-mode for the single-operator case.

function xdgData(home: string = homedir()): string {
  return process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
}
function xdgConfig(home: string = homedir()): string {
  return process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
}
function xdgState(home: string = homedir()): string {
  return process.env['XDG_STATE_HOME'] ?? join(home, '.local', 'state');
}

/** User-mode equivalent of /etc/llmux. */
export const USER_MODE_CONFIG_DIR = join(xdgConfig(), 'llmux', 'v2-dev');
/** User-mode equivalent of /var/lib/llmux. */
export const USER_MODE_DATA_DIR = join(xdgData(), 'llmux', 'v2-dev');
/** User-mode equivalent of /var/lib/llmux/orchestration. */
export const USER_MODE_TRANSPORT_DIR = join(USER_MODE_DATA_DIR, 'orchestration');
/** User-mode equivalent of /var/run/llmux. */
export const USER_MODE_RUNTIME_DIR = join(xdgState(), 'llmux', 'v2-dev', 'run');

// ── Per-operator client-side paths (unchanged by mode) ───────────────────

/** Per-operator credentials path on each user's machine (NOT system-owned). */
export function operatorCredentialsPath(home: string = homedir()): string {
  return join(home, '.config', 'llmux', 'credentials.json');
}

/** Per-user runtime state (claims, cursors, etc.) lives in the USER's home,
 *  not in /var/lib. Workers write here as the user's uid. */
export function userRuntimeStateDir(home: string): string {
  return join(home, '.local', 'state', 'llmux');
}
