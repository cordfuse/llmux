export interface ClientCommand {
  summary: string;
  usage: string;
  help: () => string;
  run: (argv: readonly string[]) => Promise<void>;
}

function notImplemented(command: string): never {
  console.error(`llmux ${command}: not yet implemented (scaffold)`);
  process.exit(70);
}

function help(name: string, summary: string, usage: string): () => string {
  return () => [`llmux ${name} — ${summary}`, '', 'Usage:', `  ${usage}`, ''].join('\n');
}

interface ClientContext {
  baseUrl: string;
  token: string | undefined;
}

export function resolveContext(): ClientContext {
  const baseUrl = process.env.LLMUX_SERVER;
  if (!baseUrl) {
    throw new Error('LLMUX_SERVER is not set. Point it at your llmuxd (e.g. http://localhost:3000).');
  }
  return { baseUrl, token: process.env.LLMUX_TOKEN };
}

/** Helper for future use — Phase 3 fills these in. */
export async function _request(
  _ctx: ClientContext,
  _method: 'GET' | 'POST' | 'DELETE',
  _path: string,
  _body?: unknown,
): Promise<unknown> {
  notImplemented('client._request');
}

const send: ClientCommand = {
  summary: 'Send a prompt to a session (fire-and-forget)',
  usage: 'llmux send <session> "<prompt>"',
  help: help('send', 'Send a prompt to a session (fire-and-forget)', 'llmux send <session> "<prompt>"'),
  run: async (argv) => {
    if (argv.length < 2) throw new Error('send requires <session> and "<prompt>"');
    notImplemented('send');
  },
};

const broadcast: ClientCommand = {
  summary: 'Send a prompt to ALL sessions of an agent type',
  usage: 'llmux broadcast <agent> "<prompt>"',
  help: help('broadcast', 'Send a prompt to ALL sessions of an agent type', 'llmux broadcast <agent> "<prompt>"'),
  run: async (argv) => {
    if (argv.length < 2) throw new Error('broadcast requires <agent> and "<prompt>"');
    notImplemented('broadcast');
  },
};

const spawn: ClientCommand = {
  summary: 'Spawn one or more agent sessions (proxies to llmuxd spawn)',
  usage: 'llmux spawn <agent|list|all> [--name <n>] [--prefix <p>] [--cwd <path>]',
  help: help(
    'spawn',
    'Spawn one or more agent sessions',
    'llmux spawn <agent|list|all> [--name <n>] [--prefix <p>] [--cwd <path>]',
  ),
  run: async (argv) => {
    if (argv.length < 1) throw new Error('spawn requires an agent (or `all`)');
    notImplemented('spawn');
  },
};

const kill: ClientCommand = {
  summary: 'Terminate a session or all sessions',
  usage: 'llmux kill <session|all>',
  help: help('kill', 'Terminate a session or all sessions', 'llmux kill <session|all>'),
  run: async (argv) => {
    if (argv.length < 1) throw new Error('kill requires <session> or `all`');
    notImplemented('kill');
  },
};

const status: ClientCommand = {
  summary: 'List all running sessions',
  usage: 'llmux status [--json]',
  help: help('status', 'List all running sessions', 'llmux status [--json]'),
  run: async () => {
    notImplemented('status');
  },
};

const chat: ClientCommand = {
  summary: 'Open the browser web terminal for a session',
  usage: 'llmux chat <session>',
  help: help('chat', 'Open the browser web terminal for a session', 'llmux chat <session>'),
  run: async (argv) => {
    if (argv.length < 1) throw new Error('chat requires <session>');
    notImplemented('chat');
  },
};

export const clientCommands: Record<string, ClientCommand> = {
  send,
  broadcast,
  spawn,
  kill,
  status,
  chat,
};
