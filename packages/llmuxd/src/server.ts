import { notImplemented } from './cli.ts';
import type { LlmuxConfig } from './config.ts';

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export async function startLocalDaemon(_config: LlmuxConfig): Promise<ServerHandle> {
  // Unix-socket-only mode — no HTTP. Used for `llmuxd` (no subcommand).
  notImplemented('server.startLocalDaemon');
}

export async function startHttpServer(_config: LlmuxConfig): Promise<ServerHandle> {
  // REST API + WebSocket + static web terminal. Used for `llmuxd serve`.
  notImplemented('server.startHttpServer');
}
