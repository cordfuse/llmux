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

// ── Dev-mode overrides ───────────────────────────────────────────────────
//
// When `devMode: true` is set in SystemConfig (or LLMUX_V2_DEV=1 in env),
// all paths shift into the current OS user's home so the v2 daemon code
// can boot + serve + persist state without root or any sudo-touched system
// directories. Lets you exercise Phases 3-9 (users, tokens, setup wizard,
// account/admin pages, orch enforcement) without running install.sh.
//
// IMPORTANT — dev mode is the ONLY context in which v2 code touches a
// user's $HOME, and it does so because the daemon IS the operator in dev
// mode (not a separate service user). Production v2 daemon NEVER reads or
// writes any /home/* path. See V2-SYSTEM-AUTH-DESIGN.md § "$HOME usage
// principle."

function xdgData(home: string = homedir()): string {
  return process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
}
function xdgConfig(home: string = homedir()): string {
  return process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');
}
function xdgState(home: string = homedir()): string {
  return process.env['XDG_STATE_HOME'] ?? join(home, '.local', 'state');
}

/** Dev-mode equivalent of /etc/llmux. Only used when devMode=true. */
export const DEV_MODE_CONFIG_DIR = join(xdgConfig(), 'llmux', 'v2-dev');
/** Dev-mode equivalent of /var/lib/llmux. Only used when devMode=true. */
export const DEV_MODE_DATA_DIR = join(xdgData(), 'llmux', 'v2-dev');
/** Dev-mode equivalent of /var/lib/llmux/orchestration. Only used when devMode=true. */
export const DEV_MODE_TRANSPORT_DIR = join(DEV_MODE_DATA_DIR, 'orchestration');
/** Dev-mode equivalent of /var/run/llmux. Only used when devMode=true. */
export const DEV_MODE_RUNTIME_DIR = join(xdgState(), 'llmux', 'v2-dev', 'run');

// ── Per-operator client-side paths (unchanged by mode) ───────────────────
//
// This is the ONE legitimate $HOME usage in production: each operator's
// CLI stores their own auth token in their own home. The daemon NEVER
// reads these — they're for the operator's own llmux CLI to send as a
// bearer token on outgoing API requests. Same shape as ~/.aws/credentials,
// ~/.kube/config, ~/.docker/config.json — those tools' daemons don't read
// these either.

/** Per-operator credentials path on each user's machine (client-side; daemon never reads this). */
export function operatorCredentialsPath(home: string = homedir()): string {
  return join(home, '.config', 'llmux', 'credentials.json');
}
