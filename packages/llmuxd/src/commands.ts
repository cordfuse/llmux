import { renderFlagHelp, notImplemented, type FlagSpecs, type ParsedArgs } from './cli.ts';
import * as h from './handlers.ts';

export interface Command {
  summary: string;
  flags: FlagSpecs;
  usage: string;
  help: () => string;
  run: (args: ParsedArgs) => Promise<void> | void;
}

function makeHelp(name: string, summary: string, usage: string, flags: FlagSpecs): () => string {
  return () => {
    const flagBlock = Object.keys(flags).length ? `\nOptions:\n${renderFlagHelp(flags)}\n` : '\n';
    return [`llmuxd ${name} — ${summary}`, '', `Usage:`, `  ${usage}`, flagBlock].join('\n');
  };
}

// Default daemon — local mode (unix socket only).
const defaultDaemon: Command = {
  summary: 'Start the daemon in local mode (unix socket only)',
  usage: 'llmuxd [--config <path>]',
  flags: {
    config: { kind: 'string', description: 'Path to .llmux.yaml' },
  },
  help: () => '',
  run: () => notImplemented('(local daemon)'),
};
defaultDaemon.help = makeHelp('', defaultDaemon.summary, defaultDaemon.usage, defaultDaemon.flags);

const serve: Command = {
  summary: 'Start REST API + web terminal server',
  usage: 'llmuxd serve [--config <path>] [--port <n>] [--no-qr]',
  flags: {
    config: { kind: 'string', description: 'Path to .llmux.yaml' },
    port: { kind: 'string', description: 'Listen port (overrides config)' },
    'no-qr': { kind: 'boolean', description: 'Suppress QR codes (CI/headless)' },
  },
  help: () => '',
  run: (args) => h.handleServe(args),
};
serve.help = makeHelp('serve', serve.summary, serve.usage, serve.flags);

const init: Command = {
  summary: 'Generate a starter .llmux.yaml interactively',
  usage: 'llmuxd init [--global]',
  flags: {
    global: { kind: 'boolean', description: 'Write to ~/.config/llmux/config.yaml' },
  },
  help: () => '',
  run: () => notImplemented('init'),
};
init.help = makeHelp('init', init.summary, init.usage, init.flags);

const configCmd: Command = {
  summary: 'Inspect configuration (subcommands: show)',
  usage: 'llmuxd config show [--config <path>]',
  flags: {
    config: { kind: 'string', description: 'Path to .llmux.yaml' },
  },
  help: () => '',
  run: (args) => {
    const sub = args.positional[0];
    if (sub === 'show') return notImplemented('config show');
    throw new Error(`config: unknown subcommand "${sub ?? ''}". Try \`llmuxd config show\`.`);
  },
};
configCmd.help = makeHelp('config', configCmd.summary, configCmd.usage, configCmd.flags);

const spawn: Command = {
  summary: 'Spawn one or more agent sessions in tmux',
  usage: 'llmuxd spawn <agent|agent,agent,...|all> [--name <n> | --prefix <p>] [--cwd <path>]',
  flags: {
    name: { kind: 'string', description: 'Named session (single agent only)' },
    prefix: { kind: 'string', description: 'Prefixed sessions (e.g. proj- → proj-claude)' },
    cwd: { kind: 'string', description: 'Working directory for the agent process' },
  },
  help: () => '',
  run: (args) => h.handleSpawn(args),
};
spawn.help = makeHelp('spawn', spawn.summary, spawn.usage, spawn.flags);

const send: Command = {
  summary: 'Send a prompt to a session (fire-and-forget)',
  usage: 'llmuxd send <session> "<prompt>"',
  flags: {},
  help: () => '',
  run: (args) => h.handleSend(args),
};
send.help = makeHelp('send', send.summary, send.usage, send.flags);

const broadcast: Command = {
  summary: 'Send a prompt to ALL sessions of an agent type',
  usage: 'llmuxd broadcast <agent> "<prompt>"',
  flags: {},
  help: () => '',
  run: (args) => h.handleBroadcast(args),
};
broadcast.help = makeHelp('broadcast', broadcast.summary, broadcast.usage, broadcast.flags);

const attach: Command = {
  summary: 'Interactively attach to a session (tmux switch-client / attach-session)',
  usage: 'llmuxd attach <session> [--browser] [-it]',
  flags: {
    browser: { kind: 'boolean', description: 'Open in browser web terminal (requires serve)' },
    it: { kind: 'boolean', description: 'Interactive picker when ambiguous' },
  },
  help: () => '',
  run: (args) => h.handleChat(args),
};
attach.help = makeHelp('attach', attach.summary, attach.usage, attach.flags);

// Deprecated alias for `attach` — kept for one minor cycle.
// The verb `chat` misled users into expecting a chat composer; the action
// is a TTY takeover, so `attach` is the truer name.
const chat: Command = {
  summary: '[deprecated] Alias for `attach`',
  usage: 'llmuxd chat <session> [--browser] [-it]',
  flags: attach.flags,
  help: () => '',
  run: (args) => {
    process.stderr.write(
      "llmuxd: 'chat' is deprecated; use 'attach' instead. The verb attaches a TTY to a running session, not a chat composer.\n"
    );
    return h.handleChat(args);
  },
};
chat.help = makeHelp('chat', chat.summary, chat.usage, chat.flags);

const kill: Command = {
  summary: 'Terminate a session (or all sessions)',
  usage: 'llmuxd kill <session|all> [--cascade]',
  flags: {
    cascade: { kind: 'boolean', description: 'Also kill child sessions spawned by this one' },
  },
  help: () => '',
  run: (args) => h.handleKill(args),
};
kill.help = makeHelp('kill', kill.summary, kill.usage, kill.flags);

const status: Command = {
  summary: 'Show all sessions, agent type, and state',
  usage: 'llmuxd status [--json]',
  flags: {
    json: { kind: 'boolean', description: 'Emit JSON' },
  },
  help: () => '',
  run: (args) => h.handleStatus(args),
};
status.help = makeHelp('status', status.summary, status.usage, status.flags);

const logs: Command = {
  summary: 'View dispatch history for a session',
  usage: 'llmuxd logs <session> [--tail <n>] [--follow]',
  flags: {
    tail: { kind: 'string', description: 'Show last N entries' },
    follow: { kind: 'boolean', description: 'Stream new entries as they arrive' },
  },
  help: () => '',
  run: (args) => {
    if (args.positional.length < 1) throw new Error('logs requires <session>');
    return notImplemented('logs');
  },
};
logs.help = makeHelp('logs', logs.summary, logs.usage, logs.flags);

const respawn: Command = {
  summary: 'Restart a crashed or exited session',
  usage: 'llmuxd respawn <session>',
  flags: {},
  help: () => '',
  run: (args) => h.handleRespawn(args),
};
respawn.help = makeHelp('respawn', respawn.summary, respawn.usage, respawn.flags);

const token: Command = {
  summary: 'Manage SAS tokens (subcommands: create, show, revoke)',
  usage: 'llmuxd token <create|show|revoke> [--name <label>] [--expiry <iso-date>] [--json]',
  flags: {
    name: { kind: 'string', description: 'Human label for the token (create only)' },
    expiry: { kind: 'string', description: 'ISO-8601 timestamp for token expiry (create only)' },
    json: { kind: 'boolean', description: 'Emit JSON (show only)' },
  },
  help: () => '',
  run: (args) => {
    const sub = args.positional[0];
    switch (sub) {
      case 'create':
        return h.handleTokenCreate(args);
      case 'show':
        return h.handleTokenShow(args);
      case 'revoke':
        return h.handleTokenRevoke(args);
      default:
        throw new Error(`token: unknown subcommand "${sub ?? ''}". Try create|show|revoke.`);
    }
  },
};
token.help = makeHelp('token', token.summary, token.usage, token.flags);

export const commands: Record<string, Command> = {
  serve,
  init,
  config: configCmd,
  spawn,
  send,
  broadcast,
  attach,
  chat,
  kill,
  status,
  logs,
  respawn,
  token,
};

// Re-export default daemon for use when no subcommand is given (`llmuxd` alone).
export { defaultDaemon };
