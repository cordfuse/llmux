import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import qrcodeTerminal from 'qrcode-terminal';
import { DEFAULT_AGENTS, isAgentInstalled, type AgentDefinition } from './agents.ts';
import * as state from './state.ts';
import * as tmux from './tmux.ts';
import * as authStore from './auth-store.ts';
import { startServer, printBanner } from './web/server.ts';
import { getAddresses } from './net.ts';
import type { ParsedArgs } from './cli.ts';

// ---------- helpers ----------

function expandAgentList(spec: string): AgentDefinition[] {
  if (spec === 'all') return Object.values(DEFAULT_AGENTS).filter(isAgentInstalled);
  const keys = spec.split(',').map((k) => k.trim()).filter(Boolean);
  const out: AgentDefinition[] = [];
  for (const k of keys) {
    const def = DEFAULT_AGENTS[k];
    if (!def) throw new Error(`unknown agent "${k}". Known: ${Object.keys(DEFAULT_AGENTS).join(', ')}`);
    if (!isAgentInstalled(def)) throw new Error(`agent "${k}" is not installed (looked for: ${def.cmd})`);
    out.push(def);
  }
  return out;
}

function buildCommand(agent: AgentDefinition): string {
  return agent.flags ? `${agent.cmd} ${agent.flags}` : agent.cmd;
}

function resolveCwd(input: string | undefined): string {
  if (!input) return process.cwd();
  const out = resolve(input);
  if (!existsSync(out)) throw new Error(`cwd does not exist: ${out}`);
  return out;
}

interface ResolvedTarget {
  session: state.SessionState;
}

/** Resolve `<target>` to a single session; supports session-name OR agent-type-with-N=1. */
export function resolveTarget(target: string): ResolvedTarget {
  const direct = state.get(target);
  if (direct) return { session: direct };

  const byAgent = state.list().filter((s) => s.agent === target);
  if (byAgent.length === 0) {
    throw new Error(`no session matches "${target}" (not a session name; no agent of that type running)`);
  }
  if (byAgent.length > 1) {
    const names = byAgent.map((s) => s.name).join(', ');
    throw new Error(`"${target}" is ambiguous — ${byAgent.length} ${target} sessions: ${names}`);
  }
  return { session: byAgent[0]! };
}

// ---------- handlers ----------

export function handleSpawn(args: ParsedArgs): void {
  tmux.requireTmux();
  const spec = args.positional[0];
  if (!spec) throw new Error('spawn requires an agent (or `all`)');
  const name = args.flags.name as string | undefined;
  const prefix = args.flags.prefix as string | undefined;
  const cwd = resolveCwd(args.flags.cwd as string | undefined);
  if (name && prefix) throw new Error('--name and --prefix are mutually exclusive');

  const agents = expandAgentList(spec);

  if (name && agents.length > 1) {
    throw new Error('--name is only valid with a single agent');
  }

  const parent = process.env.LLMUX_SESSION ?? null;
  const created: string[] = [];

  for (const agent of agents) {
    const sessionName = name ?? (prefix ? `${prefix}${agent.key}` : agent.key);
    if (state.get(sessionName) || tmux.hasSession(sessionName)) {
      throw new Error(`session "${sessionName}" already exists`);
    }
    tmux.newSession({
      name: sessionName,
      command: buildCommand(agent),
      cwd,
      env: { LLMUX_SESSION: sessionName, LLMUX_AGENT: agent.key },
    });
    state.record({
      name: sessionName,
      agent: agent.key,
      cwd,
      createdAt: new Date().toISOString(),
      parent,
      restart: 'on-failure',
    });
    created.push(sessionName);
    console.log(`spawned ${sessionName} (agent: ${agent.key}, cwd: ${cwd})`);
  }

  if (created.length === 0) {
    console.log('no sessions spawned');
  }
}

export function handleStatus(args: ParsedArgs): void {
  // Reconcile state against tmux: anything tracked but missing in tmux is marked exited.
  const tracked = state.list();
  const live = new Set(tmux.listSessions().map((s) => s.name));

  if (args.flags.json) {
    const out = tracked.map((s) => ({
      ...s,
      state: live.has(s.name) ? 'running' : 'exited',
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (tracked.length === 0) {
    console.log('no llmuxd sessions');
    return;
  }

  const rows = tracked.map((s) => [
    s.name,
    s.agent,
    live.has(s.name) ? 'running' : 'exited',
    s.parent ?? '-',
    s.cwd,
  ]);
  const headers = ['NAME', 'AGENT', 'STATE', 'PARENT', 'CWD'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

export function handleSend(args: ParsedArgs): void {
  tmux.requireTmux();
  const [target, ...promptParts] = args.positional;
  if (!target || promptParts.length === 0) {
    throw new Error('send requires <session> and "<prompt>"');
  }
  const prompt = promptParts.join(' ');
  const { session } = resolveTarget(target);
  if (!tmux.hasSession(session.name)) {
    throw new Error(`session "${session.name}" is in state but not live in tmux (exited?). Try \`llmuxd respawn ${session.name}\`.`);
  }
  tmux.sendKeys(session.name, prompt, { enter: true });
  console.log(`sent ${prompt.length} bytes → ${session.name}`);
}

export function handleBroadcast(args: ParsedArgs): void {
  tmux.requireTmux();
  const [agentKey, ...promptParts] = args.positional;
  if (!agentKey || promptParts.length === 0) {
    throw new Error('broadcast requires <agent> and "<prompt>"');
  }
  if (!DEFAULT_AGENTS[agentKey]) {
    throw new Error(`unknown agent "${agentKey}". Known: ${Object.keys(DEFAULT_AGENTS).join(', ')}`);
  }
  const prompt = promptParts.join(' ');
  const sessions = state.list().filter((s) => s.agent === agentKey);
  if (sessions.length === 0) {
    console.log(`no ${agentKey} sessions running`);
    return;
  }
  let n = 0;
  for (const s of sessions) {
    if (!tmux.hasSession(s.name)) continue;
    tmux.sendKeys(s.name, prompt, { enter: true });
    console.log(`sent → ${s.name}`);
    n++;
  }
  console.log(`broadcast to ${n}/${sessions.length} ${agentKey} sessions`);
}

export function handleChat(args: ParsedArgs): void {
  tmux.requireTmux();
  const target = args.positional[0];
  if (!target) throw new Error('chat requires <session>');
  if (args.flags.browser) {
    throw new Error('--browser requires `llmuxd serve` (Phase 4). Use `llmuxd chat` without --browser for now.');
  }
  const { session } = resolveTarget(target);
  if (!tmux.hasSession(session.name)) {
    throw new Error(`session "${session.name}" is not live in tmux`);
  }
  tmux.attachOrSwitch(session.name);
}

export async function handleServe(args: ParsedArgs): Promise<void> {
  tmux.requireTmux();
  const portRaw = (args.flags.port as string | undefined) ?? process.env.LLMUXD_PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  const host = process.env.LLMUXD_HOST ?? '0.0.0.0';
  const handle = startServer({ port, host });
  printBanner(handle.port);

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received — shutting down`);
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Idle forever — the http server and ws server keep the event loop alive.
  await new Promise<void>(() => {});
}

function endpointPort(): number {
  // Default daemon port — matches the `serve` command default in commands.ts.
  // QR builders run from a separate `token create` invocation that doesn't
  // know which port the daemon is bound to, so we resolve from the running
  // daemon if reachable, else fall back to 3030 (the documented default).
  return Number(process.env.LLMUX_PORT) || 3030;
}

function selectorOf(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-');
}

function resolveQrEndpoint(selector: string, port: number): { label: string; url: string } {
  const addrs = getAddresses(port);
  const wanted = selector.toLowerCase().trim();
  const matches = addrs.filter((a) => selectorOf(a.label) === wanted);
  if (matches.length === 0) {
    const available = Array.from(new Set(addrs.map((a) => selectorOf(a.label)))).join(', ');
    throw new Error(`unknown --qr-endpoint "${selector}". Available: ${available}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `--qr-endpoint "${selector}" is ambiguous (${matches.length} matches). Use \`llmuxd token create --qr\` without an endpoint to pick interactively.`,
    );
  }
  return matches[0]!;
}

async function pickEndpointInteractively(port: number): Promise<{ label: string; url: string }> {
  const addrs = getAddresses(port);
  if (addrs.length === 0) throw new Error('no reachable endpoints found');
  console.log('');
  console.log('Pick an endpoint for the QR code:');
  for (let i = 0; i < addrs.length; i++) {
    console.log(`  ${i + 1}) ${addrs[i]!.label.padEnd(18)} ${addrs[i]!.url}`);
  }
  if (!process.stdin.isTTY) {
    throw new Error('--qr without --qr-endpoint requires an interactive terminal');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question('  > ', (a) => resolve(a)));
  rl.close();
  const idx = Number(answer.trim()) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= addrs.length) {
    throw new Error(`invalid selection "${answer}"`);
  }
  return addrs[idx]!;
}

function printQr(url: string, token: string, label: string): void {
  const deepLink = `${url.replace(/\/$/, '')}/?token=${encodeURIComponent(token)}`;
  console.log('');
  console.log(`QR for ${label}:`);
  console.log('');
  qrcodeTerminal.generate(deepLink, { small: true });
  console.log(`  ${deepLink}`);
}

export async function handleTokenCreate(args: ParsedArgs): Promise<void> {
  const name = args.flags.name as string | undefined;
  const expiry = args.flags.expiry as string | undefined;
  const qrFlag = Boolean(args.flags.qr);
  const qrEndpoint = args.flags['qr-endpoint'] as string | undefined;
  if (expiry && isNaN(new Date(expiry).getTime())) {
    throw new Error(`--expiry must be an ISO-8601 timestamp (got "${expiry}")`);
  }
  const wantsQr = qrFlag || qrEndpoint !== undefined;

  // Resolve the QR endpoint BEFORE creating the token so a bad selector
  // doesn't leave an orphan token in auth.json.
  let endpoint: { label: string; url: string } | undefined;
  if (wantsQr) {
    const port = endpointPort();
    endpoint = qrEndpoint
      ? resolveQrEndpoint(qrEndpoint, port)
      : await pickEndpointInteractively(port);
  }

  const wasEnabled = authStore.authEnabled();
  const rec = authStore.createAuthToken({
    ...(name !== undefined ? { name } : {}),
    ...(expiry !== undefined ? { expiresAt: expiry } : {}),
  });
  console.log(`token created (id: ${rec.id})${rec.name ? ` "${rec.name}"` : ''}`);
  console.log('');
  console.log(`  ${rec.token}`);
  console.log('');
  console.log('Save this token now — it is shown once. Use in the LLMUX_TOKEN env var, the');
  console.log('`Authorization: Bearer <token>` header, or paste it into the web gate page.');
  if (!wasEnabled) {
    console.log('');
    console.log('Auth is now enabled. All non-localhost requests require this (or another) token.');
  }
  if (endpoint) {
    printQr(endpoint.url, rec.token, endpoint.label);
  }
}

export function handleTokenShow(args: ParsedArgs): void {
  const tokens = authStore.listAuthTokens();
  if (args.flags.json) {
    const out = tokens.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, expiresAt: t.expiresAt }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (tokens.length === 0) {
    console.log('no tokens — auth is disabled. Create one with `llmuxd token create`.');
    return;
  }
  const headers = ['ID', 'NAME', 'CREATED', 'EXPIRES'];
  const rows = tokens.map((t) => [t.id, t.name ?? '-', t.createdAt, t.expiresAt ?? '-']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  console.log(headers.map((h, i) => h.padEnd(widths[i]!)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  '));
}

export function handleTokenRevoke(args: ParsedArgs): void {
  const idPrefix = args.positional[1];
  if (!idPrefix) throw new Error('token revoke requires an <id> (the 8-char prefix shown by `token show`)');
  const ok = authStore.revokeAuthToken(idPrefix);
  if (!ok) throw new Error(`no token with id "${idPrefix}"`);
  console.log(`revoked ${idPrefix}`);
  if (!authStore.authEnabled()) {
    console.log('No tokens remain — auth is now disabled.');
  }
}

export function handleRespawn(args: ParsedArgs): void {
  tmux.requireTmux();
  const target = args.positional[0];
  if (!target) throw new Error('respawn requires <session>');

  const session = state.get(target);
  if (!session) throw new Error(`no tracked session "${target}"`);

  if (tmux.hasSession(target)) {
    throw new Error(`session "${target}" is still running — kill it first`);
  }

  const agent = DEFAULT_AGENTS[session.agent];
  if (!agent) throw new Error(`unknown agent "${session.agent}" — cannot respawn`);
  if (!isAgentInstalled(agent)) {
    throw new Error(`agent "${session.agent}" is not installed (looked for: ${agent.cmd})`);
  }

  tmux.newSession({
    name: session.name,
    command: buildCommand(agent),
    cwd: session.cwd,
    env: { LLMUX_SESSION: session.name, LLMUX_AGENT: session.agent },
  });
  state.record({ ...session, createdAt: new Date().toISOString() });
  console.log(`respawned ${target} (agent: ${session.agent}, cwd: ${session.cwd})`);
}

export function handleKill(args: ParsedArgs): void {
  tmux.requireTmux();
  const target = args.positional[0];
  if (!target) throw new Error('kill requires <session> or `all`');
  const cascade = Boolean(args.flags.cascade);

  if (target === 'all') {
    const all = state.list();
    for (const s of all) {
      tmux.killSession(s.name);
      state.forget(s.name);
      console.log(`killed ${s.name}`);
    }
    if (all.length === 0) console.log('no sessions to kill');
    return;
  }

  const session = state.get(target);
  if (!session) throw new Error(`no tracked session "${target}"`);

  if (cascade) {
    const queue: string[] = [target];
    const killed = new Set<string>();
    while (queue.length) {
      const name = queue.shift()!;
      if (killed.has(name)) continue;
      for (const child of state.children(name)) queue.push(child.name);
      tmux.killSession(name);
      state.forget(name);
      killed.add(name);
      console.log(`killed ${name}`);
    }
    return;
  }

  tmux.killSession(target);
  state.forget(target);
  console.log(`killed ${target}`);
}
