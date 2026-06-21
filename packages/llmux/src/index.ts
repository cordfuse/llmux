#!/usr/bin/env node
// Bootstrap must come FIRST — it loads ~/.config/llmux/.env into
// process.env before any other module imports its handlers/config.
import './bootstrap.ts';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseArgs, type ParsedArgs } from './cli.ts';
import * as h from './daemon/handlers.ts';
import * as state from './daemon/state.ts';
import * as tmux from './daemon/tmux.ts';
import { DEFAULT_AGENTS, isAgentInstalled } from './daemon/agents.ts';
import { buildAgentCommand, mergeSpawnEnv } from './daemon/web/server.ts';
import { clientCommands } from './client/client.ts';
import { init as orchInit, defaultTransportRoot } from './orch/init.ts';
import { syncBackupPush } from './orch/transport.ts';
import * as orch from './orch/orch.ts';
import { loadFleet, startFleet, stopFleet } from './orch/fleet.ts';
import { login as authLogin, logout as authLogout, whoami as authWhoami } from './v2/auth/login.ts';
import { loadCredentials, setActiveProfile } from './v2/auth/credentials.ts';
import { readPassphrase } from './v2/auth/prompt.ts';

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
                       [--init "<prompt>" ...] [--skip-init]
  session stop <name> [<name>...]               kill + forget the session(s)
  session restart <name> [<name>...]            kill + relaunch with persisted config
  session edit <name> [--name N] [--cwd P]      patch persisted config of a tracked session
                      [--flags "F"] [--env "K=V"] [--apply]
  session attach <name>                         open the terminal (tmux locally, WS remotely)
  session prompt <name> "<text>" [--no-enter]   send a prompt
  session broadcast <agent> "<text>"            send to every session of an agent type (local)
  session resume <name> --conversation <id> | --latest
                                                rebind to a past agent conversation
  session history <name>                        list past conversations for the session's cwd

Server verbs (always local):
  server start [--port N] [--no-qr]             run the HTTP/WS daemon. By default,
               [--qr-endpoint <label>]          creates a pairing token and prints
               [--qr-name N] [--qr-expiry ISO]  a QR; --no-qr to suppress.

Token verbs (always local — managing the daemon-host's auth store):
  token create [--name N] [--expiry ISO] [--qr] [--qr-endpoint <label>] [--port N]
  token list                                    show active tokens
  token rename <id> --name <label>              rename a token (pass --name "" to clear)
  token revoke <id>                             revoke a token by id
  token revoke --all [--yes]                    revoke every token (prompts unless --yes)

Agent verbs:
  agent list [--all] [--installed] [--json]     list agents (default: installed-only)

Logs verbs (always local — reads the daemon's in-process ring buffer):
  logs list [--limit N] [--json]                print buffered log lines (newest at the end)
  logs tail [--since ISO]                       print buffer then live-tail until Ctrl-C

Settings verbs (always local — diagnostic dump):
  settings show [--json]                        config source, state dir, env, loaded YAML

Auth verbs (v2 — client-side credentials at ~/.config/llmux/credentials.json):
  auth login --server <url> [--username U]      passphrase-auth to a v2 daemon; save token
             [--profile N] [--passphrase P]
  auth logout [--profile N] [--no-revoke]       remove saved profile (default: revoke server-side)
  auth whoami [--profile N]                     show the active (or named) profile
  auth list                                     list saved profiles
  auth use <profile>                            mark a saved profile as active

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
      await h.handleSpawn(parsed);
      return;
    case 'stop':
      h.handleKill(parsed);
      return;
    case 'restart':
      await h.handleRespawn(parsed);
      return;
    case 'edit':
      await h.handleSessionEdit(parsed);
      return;
    case 'attach':
      h.handleChat(parsed);
      return;
    case 'prompt':
      await h.handleSend(parsed);
      return;
    case 'broadcast':
      await h.handleBroadcast(parsed);
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
      tmux.newSession({
        name,
        command: buildAgentCommand(agent, session.flags, conversationId),
        cwd: session.cwd,
        env: mergeSpawnEnv(agent, session.env, { LLMUX_SESSION: name, LLMUX_AGENT: session.agent }),
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
    'resume-from': { kind: 'string' as const, description: 'native conversation id to resume at spawn time' },
    'no-enter': { kind: 'boolean' as const, description: 'do not append Enter to prompt' },
    'no-turnq': { kind: 'boolean' as const, description: 'skip turnq FIFO turn coordination for this send (default: honor turnq.enabled)' },
    browser: { kind: 'boolean' as const, description: 'open in web browser (attach)' },
    it: { kind: 'boolean' as const, description: 'interactive (attach)' },
    apply: { kind: 'boolean' as const, description: 'with `edit`: respawn the session after patching' },
    init: { kind: 'string-array' as const, description: 'init prompt to fire on spawn (repeatable; composes with daemon.initPrompts)' },
    'skip-init': { kind: 'boolean' as const, description: 'skip firing init prompts on this spawn' },
    'orch-alias': { kind: 'string' as const, description: 'register this session as an llmux orch bus participant under this alias (sets $LLMUX_ORCH_ALIAS in the agent env)' },
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
    'no-qr': { kind: 'boolean', description: 'Suppress pairing-QR output' },
    'qr-endpoint': { kind: 'string', description: 'endpoint label for the pairing QR (e.g. tailscale-https)' },
    'qr-name': { kind: 'string', description: 'pairing-token name (default: server-start-<ISO date>)' },
    'qr-expiry': { kind: 'string', description: 'ISO-8601 expiry for the pairing token' },
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
    port: { kind: 'string', description: 'override the port baked into the QR URL (defaults to the daemon\'s resolved port)' },
    all: { kind: 'boolean', description: 'with `revoke`: revoke every token' },
    yes: { kind: 'boolean', description: 'with `revoke --all`: skip the interactive confirm prompt' },
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
      await h.handleTokenRevoke(parsed);
      return;
    case 'rename':
      h.handleTokenRename(parsed);
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

async function dispatchAuth(verb: string | undefined, args: string[], env: GlobalEnv): Promise<void> {
  if (!verb) {
    printVerbHelp('auth', verb);
    return;
  }
  const parsed = parseArgs(args, {
    username: { kind: 'string', description: 'application-layer username' },
    profile: { kind: 'string', description: 'profile name (defaults to host-port slug)' },
    passphrase: { kind: 'string', description: 'passphrase (env LLMUX_PASSPHRASE fallback; interactive prompt if neither)' },
    'no-revoke': { kind: 'boolean', description: 'with logout: skip server-side token revoke' },
    json: { kind: 'boolean', description: 'emit JSON' },
  });

  switch (verb) {
    case 'login': {
      const serverUrl = env.server ?? process.env.LLMUX_SERVER;
      if (!serverUrl) throw new Error('auth login requires --server <url> or LLMUX_SERVER');
      const username = (parsed.flags.username as string | undefined)
        ?? parsed.positional[0];
      if (!username) throw new Error('auth login requires --username <name>');
      const passphrase = (parsed.flags.passphrase as string | undefined)
        ?? process.env.LLMUX_PASSPHRASE
        ?? await readPassphrase(`Passphrase for ${username}@${serverUrl}: `);
      const result = await authLogin({
        serverUrl,
        username,
        passphrase,
        ...(parsed.flags.profile ? { profileName: parsed.flags.profile as string } : {}),
      });
      if (parsed.flags.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      if (!result.ok) {
        console.error(`auth login failed: ${result.error ?? 'unknown'}${result.status ? ` (HTTP ${result.status})` : ''}`);
        process.exit(1);
      }
      console.log(`logged in as ${result.username} → profile "${result.profileName}" (saved to ~/.config/llmux/credentials.json)`);
      return;
    }
    case 'logout': {
      const result = await authLogout({
        ...(parsed.flags.profile ? { profileName: parsed.flags.profile as string } : {}),
        revokeOnServer: !parsed.flags['no-revoke'],
      });
      if (parsed.flags.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      if (!result.ok) {
        console.error(`auth logout: ${result.error}`);
        process.exit(1);
      }
      const tail = result.revokedOnServer === false ? ' (server revoke failed — local profile removed anyway)' : '';
      console.log(`logged out of profile "${result.profileName}"${tail}`);
      return;
    }
    case 'whoami': {
      const result = authWhoami(parsed.flags.profile as string | undefined);
      if (parsed.flags.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(1);
        return;
      }
      if (!result.ok) {
        console.error(result.error);
        process.exit(1);
      }
      const p = result.profile!;
      console.log(`profile: ${result.profileName}`);
      console.log(`server : ${p.serverUrl}`);
      console.log(`user   : ${p.username}`);
      console.log(`since  : ${p.savedAt}`);
      return;
    }
    case 'list': {
      const file = loadCredentials();
      const rows = Object.entries(file.profiles).map(([name, p]) => ({
        name, active: name === file.active, ...p,
      }));
      if (parsed.flags.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log('no profiles saved — run `llmux auth login --server <url> --username <u>`');
        return;
      }
      for (const r of rows) {
        const marker = r.active ? '*' : ' ';
        console.log(`${marker} ${r.name.padEnd(24)}  ${r.username.padEnd(16)}  ${r.serverUrl}`);
      }
      return;
    }
    case 'use': {
      const name = parsed.positional[0];
      if (!name) throw new Error('auth use requires <profile>');
      setActiveProfile(name);
      console.log(`active profile: ${name}`);
      return;
    }
    default:
      throw new Error(`unknown auth verb "${verb}"`);
  }
}

async function dispatchLogs(verb: string | undefined, args: string[]): Promise<void> {
  if (!verb) {
    printVerbHelp('logs', verb);
    return;
  }
  const parsed = parseArgs(args, {
    limit: { kind: 'string', description: 'max lines to print' },
    since: { kind: 'string', description: 'ISO-8601 cutoff (tail: only entries at/after this ts)' },
    json: { kind: 'boolean', description: 'emit JSON' },
  });
  switch (verb) {
    case 'list':
    case 'show':
      h.handleLogsList(parsed);
      return;
    case 'tail':
      await h.handleLogsTail(parsed);
      return;
    default:
      throw new Error(`unknown logs verb "${verb}"`);
  }
}

async function dispatchSettings(verb: string | undefined, args: string[]): Promise<void> {
  if (!verb) {
    printVerbHelp('settings', verb);
    return;
  }
  const parsed = parseArgs(args, {
    json: { kind: 'boolean', description: 'emit JSON' },
  });
  switch (verb) {
    case 'show':
    case 'list':
      h.handleSettingsShow(parsed);
      return;
    default:
      throw new Error(`unknown settings verb "${verb}"`);
  }
}

async function dispatchOrch(verb: string | undefined, args: string[]): Promise<void> {
  if (!verb) {
    printVerbHelp('orch', verb);
    return;
  }
  const parsed = parseArgs(args, {
    remote: { kind: 'string', description: 'Optional DR-only git remote (init only)' },
    'transport-root': { kind: 'string', description: `Override the transport path (default: ${defaultTransportRoot()})` },
    alias: { kind: 'string', description: 'Participant alias (defaults to $LLMUX_ORCH_ALIAS)' },
    to: { kind: 'string', description: 'Recipient alias (or `all` for broadcast) — send only' },
    from: { kind: 'string', description: 'Sender alias override — send only (defaults to --alias or $LLMUX_ORCH_ALIAS)' },
    channel: { kind: 'string', description: 'Channel name (default: main)' },
    re: { kind: 'string', description: 'Parent msg-id for replies — send only' },
    body: { kind: 'string', description: 'Message body — send only (alternative to positional). Useful for shell-piped or multi-line bodies.' },
    limit: { kind: 'string', description: 'Max messages to return — inbox only (default: 50)' },
    'include-claimed': { kind: 'boolean', description: 'Include messages claimed by other aliases — inbox only' },
    file: { kind: 'string', description: 'Fleet YAML config path — fleet start/stop only' },
    json: { kind: 'boolean', description: 'emit JSON' },
  });
  const root = typeof parsed.flags['transport-root'] === 'string'
    ? parsed.flags['transport-root'] as string
    : defaultTransportRoot();
  const aliasFlag = typeof parsed.flags['alias'] === 'string' ? parsed.flags['alias'] as string : undefined;
  const aliasFromEnv = process.env['LLMUX_ORCH_ALIAS'];
  const alias = aliasFlag ?? aliasFromEnv;
  const channel = typeof parsed.flags['channel'] === 'string' ? parsed.flags['channel'] as string : 'main';
  const json = !!parsed.flags['json'];

  function requireAlias(verbName: string): string {
    if (!alias) {
      throw new Error(`\`llmux orch ${verbName}\` needs --alias <name> (or set $LLMUX_ORCH_ALIAS in the session env)`);
    }
    return alias;
  }
  switch (verb) {
    case 'init': {
      const opts: { transportRoot?: string; remote?: string } = {};
      if (typeof parsed.flags['transport-root'] === 'string') opts.transportRoot = parsed.flags['transport-root'];
      if (typeof parsed.flags['remote'] === 'string') opts.remote = parsed.flags['remote'];
      const result = orchInit(opts);
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        const remoteLine = result.remote ? `  remote: ${result.remote}\n` : '';
        const modeLine = result.mode === 'clone'
          ? 'cloned existing transport from remote (DR-restore path)'
          : 'initialised fresh transport';
        console.log(`llmux orch: ${modeLine}\n  path:   ${result.transportRoot}\n${remoteLine}`);
      }
      return;
    }
    case 'backup': {
      const result = syncBackupPush(root);
      if (json) {
        console.log(JSON.stringify({ transportRoot: root, ...result }));
      } else if (result.ok) {
        console.log(`llmux orch: backup pushed to origin/main (${root})`);
      } else {
        console.error(`llmux orch: backup failed — ${result.error ?? 'unknown'}`);
        process.exit(1);
      }
      return;
    }
    case 'send': {
      const me = requireAlias('send');
      const to = typeof parsed.flags['to'] === 'string' ? parsed.flags['to'] as string : undefined;
      if (!to) throw new Error('`llmux orch send` needs --to <alias|all>');
      const bodyFlag = typeof parsed.flags['body'] === 'string' ? parsed.flags['body'] as string : '';
      const body = bodyFlag.trim() || parsed.positional.join(' ').trim();
      if (!body) throw new Error('`llmux orch send` needs a message body (--body "text" or positional arg)');
      const from = typeof parsed.flags['from'] === 'string' ? parsed.flags['from'] as string : me;
      const input: orch.SendInput = { from, to, body, channel };
      if (typeof parsed.flags['re'] === 'string') input.re = parsed.flags['re'] as string;
      const result = orch.send(root, input);
      if (json) console.log(JSON.stringify(result));
      else console.log(`sent: ${result.id} (${from} → ${to}, channel=${channel})`);
      return;
    }
    case 'inbox': {
      const me = requireAlias('inbox');
      const limit = typeof parsed.flags['limit'] === 'string' ? parseInt(parsed.flags['limit'] as string, 10) : 50;
      const messages = orch.inbox(root, me, {
        channel,
        limit: Number.isFinite(limit) ? limit : 50,
        includeClaimedByOthers: !!parsed.flags['include-claimed'],
      });
      if (json) {
        console.log(JSON.stringify(messages));
      } else if (messages.length === 0) {
        console.log(`inbox empty for ${me} (channel=${channel})`);
      } else {
        for (const m of messages) {
          const claimMark = m.claimed ? `[claimed by ${m.claimed.alias}]` : '';
          console.log(`${m.id}  from=${m.from}  to=${formatTo(m.to)}  ${claimMark}`);
        }
      }
      return;
    }
    case 'next': {
      const me = requireAlias('next');
      const m = orch.claimNext(root, me, { channel });
      if (json) console.log(JSON.stringify(m));
      else if (!m) console.log(`no work for ${me} (channel=${channel})`);
      else {
        console.log(`claimed ${m.id}`);
        console.log(`from: ${m.from}`);
        console.log(`to: ${formatTo(m.to)}`);
        if (m.re) console.log(`re: ${Array.isArray(m.re) ? m.re.join(',') : m.re}`);
        console.log('');
        console.log(m.body);
      }
      return;
    }
    case 'reply': {
      const me = requireAlias('reply');
      const msgId = parsed.positional[0];
      if (!msgId) throw new Error('`llmux orch reply` needs <msg-id> as the first positional arg');
      const body = parsed.positional.slice(1).join(' ').trim();
      if (!body) throw new Error('`llmux orch reply` needs a body as a positional arg after <msg-id>');
      const result = orch.reply(root, msgId, me, body, channel);
      if (json) console.log(JSON.stringify(result));
      else console.log(`replied: ${result.id} (re: ${msgId})`);
      return;
    }
    case 'release': {
      const me = requireAlias('release');
      const msgId = parsed.positional[0];
      if (!msgId) throw new Error('`llmux orch release` needs <msg-id> as the first positional arg');
      orch.release(root, msgId, me);
      if (json) console.log(JSON.stringify({ ok: true, released: msgId }));
      else console.log(`released ${msgId} (was held by ${me})`);
      return;
    }
    case 'ack': {
      const me = requireAlias('ack');
      const msgId = parsed.positional[0];
      if (!msgId) throw new Error('`llmux orch ack` needs <msg-id> as the first positional arg');
      orch.ack(root, msgId, me);
      if (json) console.log(JSON.stringify({ ok: true, acked: msgId, alias: me }));
      else console.log(`acked ${msgId} for ${me} (filtered from inbox; not re-deliverable)`);
      return;
    }
    case 'fleet': {
      const sub = parsed.positional[0];
      const file = typeof parsed.flags['file'] === 'string' ? parsed.flags['file'] as string : parsed.positional[1];
      if (!file) throw new Error('`llmux orch fleet <start|stop>` needs --file <path> (or positional)');
      const fleet = loadFleet(file);
      if (sub === 'start') {
        const r = startFleet(fleet);
        if (json) { console.log(JSON.stringify(r)); return; }
        if (r.spawned.length) console.log(`spawned: ${r.spawned.join(', ')}`);
        if (r.skipped.length) console.log(`skipped (already running): ${r.skipped.join(', ')}`);
        if (r.bootstrapped.length) console.log(`bootstrapped: ${r.bootstrapped.join(', ')}`);
        if (r.errors.length) {
          console.error(`errors:`);
          for (const e of r.errors) console.error(`  • ${e.name} (${e.phase}): ${e.error}`);
          process.exit(1);
        }
        return;
      }
      if (sub === 'stop') {
        const r = stopFleet(fleet);
        if (json) { console.log(JSON.stringify(r)); return; }
        if (r.stopped.length) console.log(`stopped: ${r.stopped.join(', ')}`);
        if (r.notFound.length) console.log(`not running: ${r.notFound.join(', ')}`);
        if (r.errors.length) {
          console.error(`errors:`);
          for (const e of r.errors) console.error(`  • ${e.name}: ${e.error}`);
          process.exit(1);
        }
        return;
      }
      throw new Error(`unknown fleet sub-verb "${sub}". Use: start | stop`);
    }
    case 'status': {
      const result = orch.status(root);
      if (json) console.log(JSON.stringify(result));
      else {
        console.log(`llmux orch status`);
        console.log(`  path:   ${result.transportRoot}`);
        console.log(`  channels: ${result.channels.join(', ') || '<none>'}`);
        console.log(`  live claims: ${result.liveClaims}`);
      }
      return;
    }
    default:
      throw new Error(
        `unknown orch verb "${verb}". Try one of: init | backup | send | inbox | next | reply | release | ack | status | fleet`,
      );
  }
}

function formatTo(to: string | string[]): string {
  return Array.isArray(to) ? to.join(',') : to;
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
      case 'logs':
        await dispatchLogs(verb, remainder);
        return;
      case 'settings':
        await dispatchSettings(verb, remainder);
        return;
      case 'orch':
        await dispatchOrch(verb, remainder);
        return;
      case 'auth':
        await dispatchAuth(verb, remainder, env);
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
