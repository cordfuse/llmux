// Spawn per-user worker processes via the configured spawner helper
// (systemd-run --uid by default; sudo / runuser fallbacks).
//
// Trust context: SERVICE. This is the boundary that crosses INTO the
// per-user worker context. Once spawnAsUser returns a handle, the
// returned process is running under the user's uid + has the user's
// home + env. The daemon talks to it over stdin/stdout/IPC.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "v2 architecture" — per-user worker spawn
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 5

import type { ChildProcess } from 'node:child_process';

export type WorkerSpawner = 'systemd-run' | 'sudo' | 'runuser';

export interface SpawnOptions {
  /** OS username — must exist (checked at user-creation time). */
  username: string;
  /** The command + args the worker should run (e.g. ['tmux', 'new-session', ...]). */
  command: string[];
  /** Optional: working directory. Defaults to the user's home. */
  cwd?: string;
  /** Optional: extra env vars to inject. Inherits the user's env otherwise. */
  env?: Record<string, string>;
  /** Spawner mechanism. Defaults to config.workerSpawner. */
  spawner?: WorkerSpawner;
}

export interface SpawnedWorker {
  /** The child process handle. stdin/stdout/stderr piped. */
  process: ChildProcess;
  /** Which user this worker is running as. */
  username: string;
  /** When it was spawned. */
  startedAt: string;
}

/**
 * Spawn a process AS the given user. Service-user daemon (parent) calls
 * this; the resulting process runs under the target user's uid + gid +
 * env + home + login shell.
 *
 * Implementation per spawner:
 *
 *   systemd-run --pty --uid=<uid> --gid=<gid> --setenv=HOME=/home/<u>
 *               --working-directory=<cwd> -- <command...>
 *
 *   sudo -u <username> -i -- <command...>
 *     (caveat: sudo wants a real tty for some configs; pty alloc may be needed)
 *
 *   runuser -u <username> -- <command...>
 *     (RHEL/Fedora family; PAM-aware)
 *
 * Trust: SERVICE → spawns into PER-USER context.
 */
export async function spawnAsUser(_opts: SpawnOptions): Promise<SpawnedWorker> {
  // TODO(phase 5): implement
  //   - Resolve uid/gid from username via getpwnam
  //   - Resolve home dir for HOME env
  //   - Build the spawner command based on _opts.spawner
  //   - Spawn via child_process.spawn() with stdio: 'pipe'
  //   - Wrap the ChildProcess + metadata in a SpawnedWorker
  //   - On exit: hand-off to registry.ts to update tracking
  throw new Error('TODO(phase 5)');
}

/**
 * Probe whether a given spawner helper is usable on this host.
 * Used by checkSystemModeReadiness() in system/privilege.ts.
 */
export async function probeSpawner(_spawner: WorkerSpawner): Promise<{ ok: boolean; error?: string }> {
  // TODO(phase 5): implement
  //   - systemd-run: which systemd-run + ability to exec it (test --version)
  //   - sudo: which sudo + check NOPASSWD config exists for relevant users (out of scope to check fully)
  //   - runuser: which runuser
  throw new Error('TODO(phase 5)');
}
