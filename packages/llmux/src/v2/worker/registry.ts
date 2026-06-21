// Track active per-user workers.
//
// Trust context: SERVICE. The daemon owns this registry. It's the
// service-user's view of "who has a live worker right now."
//
// Each worker is one ChildProcess + metadata. Workers come up on demand
// (e.g., when an authenticated request needs to spawn a tmux session as
// the user) and go down when the operation completes OR when the daemon
// reaps them on shutdown.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "v2 architecture" — hub + per-user workers
//   V2-SYSTEM-AUTH-DESIGN.md § "Build plan" — Phase 5

import type { SpawnedWorker } from './spawner.ts';

export interface WorkerRegistry {
  /** Register a freshly-spawned worker. Idempotent if PID already known. */
  register(worker: SpawnedWorker): void;
  /** All currently-tracked workers. */
  list(): SpawnedWorker[];
  /** Workers for one specific user. */
  forUser(username: string): SpawnedWorker[];
  /** Remove on exit. Caller invokes this from the child's 'exit' event. */
  unregister(pid: number): void;
  /** SIGTERM-then-SIGKILL every tracked worker. Called on daemon shutdown. */
  shutdownAll(): Promise<void>;
}

export class InMemoryWorkerRegistry implements WorkerRegistry {
  // TODO(phase 5): implement
  //   - Map<pid, SpawnedWorker>
  //   - On register: attach .on('exit', () => this.unregister(pid))
  //   - shutdownAll: send SIGTERM, wait 5s, send SIGKILL for any still alive,
  //     wait for all 'exit' events before resolving

  register(_worker: SpawnedWorker): void { throw new Error('TODO(phase 5)'); }
  list(): SpawnedWorker[] { throw new Error('TODO(phase 5)'); }
  forUser(_username: string): SpawnedWorker[] { throw new Error('TODO(phase 5)'); }
  unregister(_pid: number): void { throw new Error('TODO(phase 5)'); }
  async shutdownAll(): Promise<void> { throw new Error('TODO(phase 5)'); }
}
