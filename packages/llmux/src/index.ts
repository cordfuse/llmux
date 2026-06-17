#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseArgs, type ParsedArgs } from './cli.ts';
import * as h from './daemon/handlers.ts';
import * as state from './daemon/state.ts';
import * as tmux from './daemon/tmux.ts';
import * as authStore from './daemon/auth-store.ts';
import { DEFAULT_AGENTS, isAgentInstalled } from './daemon/agents.ts';
import { clientCommands } from './client/client.ts';

// ----------------- version helper -----------------

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, '../package.json'), resolve(here, '../../package.json')]) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
        if (pkg.name === '@cordfuse/llmux' && typeof pkg.version === 'string') return pkg.version;
      } catch {}
    }
  } catch {}
  return 'unknown';
}
const VERSION = readVersion();

// ----------------- argv shape -----------------

interface GlobalEnv {
  /** When set, session/agent verbs go over HTTP to this daemon. */
  server?: string;
  /** SAS token for remote auth. */
  token?: string;
}

/**
 * Strip global flags (`--server`, `--token`, `--help`, `--version`) and their
 * values from the head of argv. Returns the remaining tokens plus the
 * extracted env, so the per-noun routers see clean positional args.
 *
 * Global flag values can appear anywhere — operators tend to put them at the
 * end (`llmux session list --server http://…`) or the beginning. We sweep
 * both passes.
 */
function stripGlobals(argv: readonly string[]): { rest: string[]; env: GlobalEnv; help: boolean; version: boolean } {
  const env: GlobalEnv = {};
  const rest: string[] = [];
  let help = false;
  let version = false;
  if (process.env.LLMUX_SERVER) env.server = process.env.LLMUX_SERVER;
  if (process.env.LLMUX_TOKEN) env.token = process.env.LLMUX_TOKEN;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--server') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error('--server requires a URL');
      env.server = next;
      i++;
      continue;
    }
    if (t.startsWith('--server=')) {
      env.server = t.slice('--server='.length);
      continue;
    }
    if (t === '--token') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error('--token requires a value');
      env.token = next;
      i++;
      continue;
    }
    if (t.startsWith('--token=')) {
      env.token = t.slice('--token='.length);
      continue;
    }
    if (t === '--help' || t === '-h') {
      help = true;
      continue;
    }
    if (t === '--version' || t === '-v') {
      version = true;
      continue;
    }
    rest.push(t);
  }
  return { rest, env, help, version };
}

// Map our positional argv → the legacy ParsedArgs shape so we can re-use the
// existing daemon handlers without rewriting them.
function asParsedArgs(positional: string[], flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { positional, flags };
}

// ----------------- help -----------------

function printRootHelp(): void {
  console.log(
    `llmux v${VERSION} — tmux-based AI agent dispatcher (daemon + client in one binary)

Usage:
  llmux <noun> <verb> [args] [--server <url>] [--token <sas>]

Session verbs (local by default; pass --server <url> to target a remote daemon):
  session list                                  list tracked sessions
  session start <agent> [--name N] [--cwd P]    spawn a new agent in tmux
                       [--flags "F"] [--env "K=V"] [--resume-from <id>]
  session stop <name>                           kill + forget the session
  session restart <name>                        kill + relaunch with persisted config
  session attach <name>                         open the terminal (tmux locally, WS remotely)
  session prompt <name> "<text>" [--no-enter]   send a prompt
  session broadcast <agent> "<text>"            send to every session of an agent type (local)
  session resume <name> --conversation <id> | --latest
                                                rebind to a past agent conversation
  session history <name>                        list past conversations for the session's cwd

Server verbs (always local):
  server start [--port N] [--no-qr]             run the HTTP/WS daemon (formerly: llmuxd serve)

Token verbs (always local — managing the daemon-host's auth store):
  token create [--name N] [--expiry ISO] [--qr] [--qr-endpoint <label>]
  token list                                    show active tokens
  token revoke <id>                             revoke a token by id

Agent verbs:
  agent list [--all] [--installed] [--json]     list agents (default: installed-only)

Global flags:
  --server <url>     route session/agent verbs to a remote daemon over HTTP
  --token <sas>      SAS token for remote auth (LLMUX_TOKEN env fallback)
  --help / -h        print this help
  --version / -v     print version

Environment:
  LLMUX_SERVER       default --server URL
  LLMUX_TOKEN        default --token value`,
  );
}

function printVerbHelp(noun: string, verb: string | undefined): void {
  // Light help; full help is in the root.
  if (!verb) {
    console.log(`llmux ${noun} — see \`llmux --help\` for verbs under this noun`);
    return;
  }
  console.log(`llmux ${noun} ${verb} — see \`llmux --help\` for usage`);
}

// ----------------- dispatchers -----------------

async function dispatchSession(verb: string | undefined, args: string[], env: GlobalEnv): Promise<void> {
  if (!verb) {
    printVerbHelp('session', verb);
    return;
  }
  // Backward-compat aliases
  const v = verb === 'ls' ? 'list' : verb === 'send' ? 'prompt' : verb === 'spawn' ? 'start' : verb === 'kill' ? 'stop' : verb === 'respawn' ? 'restart' : verb === 'conversations' ? 'history' : verb;

  if (env.server !== undefined) {
    // Remote — delegate to the existing client command map.
    const cmdMap: Record<string, string> = {
      list: 'ls',
      start: 'spawn',
      stop: 'kill',
      restart: 'restart',
      attach: 'attach',
      prompt: 'send',
      resume: 'resume',
      history: 'conversations',
    };
    const clientCmd = cmdMap[v];
    if (!clientCmd) throw new Error(`session ${v}: no remote equivalent`);
    process.env.LLMUX_SERVER = env.server;
    if (env.token) process.env.LLMUX_TOKEN = env.token;
    const cmd = clientCommands[clientCmd];
    if (!cmd) throw new Error(`internal: client command "${clientCmd}" missing`);
    await cmd.run(args);
    return;
  }

  // Local — call daemon handlers directly.
  const parsed = parseArgs(args, sessionLocalFlags());
  switch (v) {
    case 'list':
      h.handleStatus(parsed);
      return;
    case 'start':
      h.handleSpawn(parsed);
      return;
    case 'stop':
      h.handleKill(parsed);
      return;
    case 'restart':
      h.handleRespawn(parsed);
      return;
    case 'attach':
      h.handleChat(parsed);
      return;
    case 'prompt':
      h.handleSend(parsed);
      return;
    case 'broadcast':
      h.handleBroadcast(parsed);
      return;
    case 'resume': {
      const name = parsed.positional[0];
      if (!name) throw new Error('session resume requires <name>');
      const session = state.get(name);
      if (!session) throw new Error(`no tracked session "${name}"`);
      const agent = DEFAULT_AGENTS[session.agent];
      if (!agent?.history) throw new Error(`agent "${session.agent}" has no history adapter`);
      if (!isAgentInstalled(agent)) throw new Error(`agent "${session.agent}" is not installed`);
      let conversationId = parsed.flags.conversation as string | undefined;
      if (!conversationId) {
        if (!parsed.flags.latest) throw new Error('resume requires --conversation <id> or --latest');
        const convs = agent.history.listConversations(session.cwd);
        if (convs.length === 0) throw new Error(`no past conversations for ${name}`);
        conversationId = convs[0]!.id;
      }
      if (tmux.hasSession(name)) tmux.killSession(name);
      const cmd = `${agent.cmd} ${agent.flags ?? ''} ${agent.history.resumeFlag(conversationId)}`.trim();
      tmux.newSession({
        name,
        command: cmd,
        cwd: session.cwd,
        env: { ...(agent.envDefaults ?? {}), ...(session.env ?? {}), LLMUX_SESSION: name, LLMUX_AGENT: session.agent },
      });
      state.record({ ...session, resumeFrom: conversationId, createdAt: new Date().toISOString() });
      console.log(`${name} resumed from ${conversationId.slice(0, 8)}…`);
      return;
    }
    case 'history': {
      const name = parsed.positional[0];
      if (!name) throw new Error('session history requires <name>');
      const session = state.get(name);
      if (!session) throw new Error(`no tracked session "${name}"`);
      const agent = DEFAULT_AGENTS[session.agent];
      if (!agent?.history) {
        console.log('agent has no history adapter');
        return;
      }
      const convs = agent.history.listConversations(session.cwd);
      if (convs.length === 0) {
        console.log('no past conversations');
        return;
      }
      for (const c of convs) console.log(`${c.id.slice(0, 8)}…  ${c.messageCount.toString().padStart(5)}  ${c.title.slice(0, 80)}`);
      return;
    }
    default:
      throw new Error(`unknown session verb "${v}"`);
  }
}

function sessionLocalFlags() {
  return {
    name: { kind: 'string' as const, description: 'session name' },
    cwd: { kind: 'string' as const, description: 'working directory' },
    flags: { kind: 'string' as const, description: 'launch flags override' },
    env: { kind: 'string' as const, description: 'env vars (KEY=VAL one per line)' },
    prefix: { kind: 'string' as const, description: 'session-name prefix (start only)' },
    cascade: { kind: 'boolean' as const, description: 'cascade kill to children' },
    conversation: { kind: 'string' as const, description: 'conversation id (resume)' },
    latest: { kind: 'boolean' as const, description: 'resume the most recent conversation' },
    'no-enter': { kind: 'boolean' as const, description: 'do not append Enter to prompt' },
    browser: { kind: 'boolean' as const, description: 'open in web browser (attach)' },
    it: { kind: 'boolean' as const, description: 'interactive (attach)' },
    json: { kind: 'boolean' as const, description: 'emit JSON' },
  };
}

async function dispatchServer(verb: string | undefined, args: string[]): Promise<void> {
  if (!verb) {
    printVerbHelp('server', verb);
    return;
  }
  const parsed = parseArgs(args, {
    config: { kind: 'string', description: 'Path to .llmux.yaml' },
    port: { kind: 'string', description: 'Listen port' },
    'no-qr': { kind: 'boolean', description: 'Suppress QR codes' },
  });
  switch (verb) {
    case 'start':
    case 'serve':
      await h.handleServe(parsed);
      return;
    default:
      throw new Error(`unknown server verb "${verb}"`);
  }
}

async function dispatchToken(verb: string | undefined, args: string[]): Promise<void> {
  if (!verb) {
    printVerbHelp('token', verb);
    return;
  }
  const parsed = parseArgs(args, {
    name: { kind: 'string', description: 'token label' },
    expiry: { kind: 'string', description: 'ISO-8601 expiry' },
    qr: { kind: 'boolean', description: 'render QR for first-tap login' },
    'qr-endpoint': { kind: 'string', description: 'endpoint label or URL for QR target' },
    json: { kind: 'boolean', description: 'emit JSON' },
  });
  switch (verb) {
    case 'create':
      await h.handleTokenCreate(parsed);
      return;
    case 'list':
    case 'show':
      h.handleTokenShow(parsed);
      return;
    case 'revoke':
      h.handleTokenRevoke(parsed);
      return;
    default:
      throw new Error(`unknown token verb "${verb}"`);
  }
}

async function dispatchAgent(verb: string | undefined, args: string[], env: GlobalEnv): Promise<void> {
  if (!verb) {
    printVerbHelp('agent', verb);
    return;
  }
  // Remote agent verbs route through the client.
  if (env.server !== undefined && verb === 'list') {
    process.env.LLMUX_SERVER = env.server;
    if (env.token) process.env.LLMUX_TOKEN = env.token;
    const cmd = clientCommands['agents'];
    if (!cmd) throw new Error('internal: client agents command missing');
    await cmd.run(args);
    return;
  }
  const parsed = parseArgs(args, {
    all: { kind: 'boolean', description: 'include not-installed agents' },
    installed: { kind: 'boolean', description: 'only installed agents (default)' },
    json: { kind: 'boolean', description: 'emit JSON' },
  });
  switch (verb) {
    case 'list': {
      const showAll = Boolean(parsed.flags.all);
      const rows = Object.values(DEFAULT_AGENTS)
        .filter((d) => showAll || isAgentInstalled(d))
        .map((d) => ({ key: d.key, displayName: d.displayName, cmd: d.cmd, flags: d.flags ?? '', installed: isAgentInstalled(d) }));
      if (parsed.flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const r of rows) {
        console.log(`${r.key.padEnd(10)}  ${r.displayName.padEnd(24)}  ${r.installed ? 'installed' : 'not installed'}  ${r.flags || '-'}`);
      }
      return;
    }
    default:
      throw new Error(`unknown agent verb "${verb}"`);
  }
}

// ----------------- main -----------------

async function main(): Promise<void> {
  const { rest, env, help, version } = stripGlobals(process.argv.slice(2));

  if (version) {
    console.log(VERSION);
    return;
  }
  if (rest.length === 0 || help) {
    printRootHelp();
    return;
  }

  const noun = rest[0]!;
  const verb = rest[1];
  const remainder = rest.slice(2);

  try {
    switch (noun) {
      case 'session':
        await dispatchSession(verb, remainder, env);
        return;
      case 'server':
        await dispatchServer(verb, remainder);
        return;
      case 'token':
        await dispatchToken(verb, remainder);
        return;
      case 'agent':
        await dispatchAgent(verb, remainder, env);
        return;
      // Backward-compat shorthand — some shells will already have `llmuxd serve`
      // wired up. These verbs sit at noun-position so all of rest.slice(1) is
      // their args, not just slice(2).
      case 'serve':
        await dispatchServer('start', rest.slice(1));
        return;
      case 'ls':
      case 'status':
        await dispatchSession('list', rest.slice(1), env);
        return;
      case 'help':
        printRootHelp();
        return;
      default: {
        // Treat anything we don't recognise as a client command (e.g. legacy
        // `llmux send`, `llmux spawn`). The client module knows about them.
        const cmd = clientCommands[noun];
        if (cmd) {
          if (env.server) process.env.LLMUX_SERVER = env.server;
          if (env.token) process.env.LLMUX_TOKEN = env.token;
          await cmd.run([verb!, ...remainder].filter((x) => x !== undefined));
          return;
        }
        console.error(`llmux: unknown command "${noun}"`);
        console.error('Run `llmux --help` to see the noun-prefix surface.');
        process.exit(64);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`llmux: ${msg}`);
    process.exit(1);
  }
}

void main();
