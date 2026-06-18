import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import qrcodeTerminal from 'qrcode-terminal';
import { DEFAULT_AGENTS, isAgentInstalled, type AgentDefinition } from './agents.ts';
import { loadConfig } from './config.ts';
import * as logBuffer from './log-buffer.ts';
import * as state from './state.ts';
import * as tmux from './tmux.ts';
import * as authStore from './auth-store.ts';
import { startServer, printBanner, buildAgentCommand, parseEnvText, mergeSpawnEnv } from './web/server.ts';
import { getAddresses } from './net.ts';
import type { ParsedArgs } from '../cli.ts';

// ---------- helpers ----------

/**
 * Merge YAML `agents.<key>.{cmd,flags}` overrides over the catalog default.
 * Discovery uses process.cwd() so a project-local `.llmux.yaml` takes effect
 * when the operator invokes from that project.
 */
function applyAgentOverrides(base: AgentDefinition): AgentDefinition {
  const cfg = loadConfig();
  const o = cfg.agents[base.key];
  if (!o) return base;
  return {
    ...base,
    ...(o.cmd !== undefined ? { cmd: o.cmd } : {}),
    ...(o.flags !== undefined ? { flags: o.flags } : {}),
  };
}

function expandAgentList(spec: string): AgentDefinition[] {
  if (spec === 'all') {
    return Object.values(DEFAULT_AGENTS).map(applyAgentOverrides).filter(isAgentInstalled);
  }
  const keys = spec.split(',').map((k) => k.trim()).filter(Boolean);
  const out: AgentDefinition[] = [];
  for (const k of keys) {
    const base = DEFAULT_AGENTS[k];
    if (!base) throw new Error(`unknown agent "${k}". Known: ${Object.keys(DEFAULT_AGENTS).join(', ')}`);
    const def = applyAgentOverrides(base);
    if (!isAgentInstalled(def)) throw new Error(`agent "${k}" is not installed (looked for: ${def.cmd})`);
    out.push(def);
  }
  return out;
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

  // Per-spawn overrides — semantics mirror POST /api/sessions:
  //   undefined   = no override (use agent defaults at spawn, don't persist)
  //   string      = explicit override (persisted on the session record)
  // resumeFrom only sticks when the agent has a history adapter; silently
  // dropped otherwise so `--all`-style spawns don't error on mixed agents.
  const flagsOverride = args.flags.flags as string | undefined;
  const envOverride =
    args.flags.env !== undefined
      ? parseEnvText(args.flags.env as string)
      : undefined;
  const resumeFrom = args.flags['resume-from'] as string | undefined;

  const agents = expandAgentList(spec);

  if (name && agents.length > 1) {
    throw new Error('--name is only valid with a single agent');
  }
  if (resumeFrom !== undefined && agents.length > 1) {
    throw new Error('--resume-from is only valid with a single agent');
  }

  const parent = process.env.LLMUX_SESSION ?? null;
  const created: string[] = [];

  for (const agent of agents) {
    const sessionName = name ?? (prefix ? `${prefix}${agent.key}` : agent.key);
    if (state.get(sessionName) || tmux.hasSession(sessionName)) {
      throw new Error(`session "${sessionName}" already exists`);
    }
    const effectiveResume = resumeFrom && agent.history ? resumeFrom : undefined;
    tmux.newSession({
      name: sessionName,
      command: buildAgentCommand(agent, flagsOverride, effectiveResume),
      cwd,
      env: mergeSpawnEnv(agent, envOverride, { LLMUX_SESSION: sessionName, LLMUX_AGENT: agent.key }),
    });
    state.record({
      name: sessionName,
      agent: agent.key,
      cwd,
      ...(flagsOverride !== undefined ? { flags: flagsOverride } : {}),
      ...(envOverride !== undefined ? { env: envOverride } : {}),
      ...(effectiveResume !== undefined ? { resumeFrom: effectiveResume } : {}),
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
    console.log('no llmux sessions');
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
    throw new Error(`session "${session.name}" is in state but not live in tmux (exited?). Try \`llmux session restart ${session.name}\`.`);
  }
  const enter = !args.flags['no-enter'];
  tmux.sendKeys(session.name, prompt, { enter });
  console.log(`sent ${prompt.length} bytes → ${session.name}${enter ? '' : ' (no-enter)'}`);
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
    throw new Error('--browser requires the web server (`llmux server start`). Without --browser, use `llmux session attach` for raw TTY pass-through.');
  }
  const { session } = resolveTarget(target);
  if (!tmux.hasSession(session.name)) {
    throw new Error(`session "${session.name}" is not live in tmux`);
  }
  tmux.attachOrSwitch(session.name);
}

export async function handleServe(args: ParsedArgs): Promise<void> {
  // Install console capture BEFORE any logging so the banner + warnings
  // make it into the in-process log buffer that the web UI's Logs page
  // tails. Idempotent.
  logBuffer.install();
  tmux.requireTmux();
  const explicitConfig = args.flags.config as string | undefined;
  const cfg = loadConfig(explicitConfig ? { explicit: explicitConfig } : {});
  // Precedence: CLI --port > LLMUXD_PORT env > config.server.port (schema
  // default already 3000 when no YAML present).
  const portRaw =
    (args.flags.port as string | undefined) ??
    process.env.LLMUXD_PORT ??
    String(cfg.server.port);
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  const host = process.env.LLMUXD_HOST ?? '0.0.0.0';
  const handle = startServer({ port, host, config: cfg });
  printBanner(handle.port);

  // QR pairing: default on; --no-qr to suppress.
  // Auto-creates a fresh pairing token (named `server-start-<ISO date>` unless
  // `--qr-name` is given), picks the best reachable endpoint (tailscale-https >
  // tailscale-http > lan > local) unless `--qr-endpoint` overrides, and prints
  // a scannable QR with the token baked into the deep link.
  if (!args.flags['no-qr']) {
    try {
      await printServerStartQr(handle.port, args);
    } catch (e) {
      console.log('');
      console.log(`  ⚠ QR generation skipped: ${(e as Error).message}`);
      console.log('    Pass --no-qr to silence, or create a token explicitly with `llmux token create --qr`.');
    }
  }

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

async function printServerStartQr(port: number, args: ParsedArgs): Promise<void> {
  const endpointFlag = args.flags['qr-endpoint'] as string | undefined;
  const nameFlag = args.flags['qr-name'] as string | undefined;
  const expiryFlag = args.flags['qr-expiry'] as string | undefined;
  if (expiryFlag && isNaN(new Date(expiryFlag).getTime())) {
    throw new Error(`--qr-expiry must be an ISO-8601 timestamp (got "${expiryFlag}")`);
  }
  const endpoint = endpointFlag
    ? resolveQrEndpoint(endpointFlag, port)
    : autoPickQrEndpoint(port);
  const defaultName = `server-start-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const rec = authStore.createAuthToken({
    name: nameFlag ?? defaultName,
    ...(expiryFlag !== undefined ? { expiresAt: expiryFlag } : {}),
  });
  console.log('');
  console.log(`  ✓ created pairing token (id: ${rec.id}, name: "${rec.name}")`);
  printQr(endpoint.url, rec.token, endpoint.label);
}

/**
 * Auto-select the most useful endpoint for a server-start QR. Phones living
 * on tailnet want tailscale-https first; same-LAN devices fall through; the
 * local-only loopback is the last resort and signals to the operator that
 * no externally reachable surface was found.
 */
function autoPickQrEndpoint(port: number): { label: string; url: string } {
  const addrs = getAddresses(port);
  if (addrs.length === 0) throw new Error('no reachable endpoints found');
  const priority = ['tailscale-https', 'tailscale-http', 'lan', 'local'];
  for (const want of priority) {
    const hit = addrs.find((a) => selectorOf(a.label) === want);
    if (hit) return hit;
  }
  return addrs[0]!;
}

/**
 * Resolve the port the daemon is (or will be) bound to. Mirrors `handleServe`'s
 * precedence so `token create --qr` from a separate terminal builds a URL that
 * actually reaches the running daemon:
 *   CLI --port > LLMUXD_PORT > LLMUX_PORT (legacy) > config.server.port > 3030
 * The CLI flag is consulted via the caller — pass `args.flags.port` as the
 * `explicitPort` argument when invoking.
 */
function endpointPort(explicitPort?: string): number {
  const cfg = loadConfig();
  const raw =
    explicitPort ??
    process.env.LLMUXD_PORT ??
    process.env.LLMUX_PORT ??
    String(cfg.server.port ?? 3030);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return n;
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
      `--qr-endpoint "${selector}" is ambiguous (${matches.length} matches). Use \`llmux token create --qr\` without an endpoint to pick interactively.`,
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
  // URL fragment, not query string. Browsers do NOT send the fragment in the
  // HTTP request — it stays purely client-side. The gate page reads it from
  // window.location.hash, POSTs to /api/auth, and history.replaceStates the
  // fragment off the visible URL. Result: same one-tap pairing UX, no token
  // in server logs / referrer / reverse proxies / Tailscale serve access logs.
  const deepLink = `${url.replace(/\/$/, '')}/#token=${encodeURIComponent(token)}`;
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
  const portFlag = args.flags.port as string | undefined;
  if (expiry && isNaN(new Date(expiry).getTime())) {
    throw new Error(`--expiry must be an ISO-8601 timestamp (got "${expiry}")`);
  }
  const wantsQr = qrFlag || qrEndpoint !== undefined;

  // Resolve the QR endpoint BEFORE creating the token so a bad selector
  // doesn't leave an orphan token in auth.json.
  let endpoint: { label: string; url: string } | undefined;
  if (wantsQr) {
    const port = endpointPort(portFlag);
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
    console.log('no tokens — auth is disabled. Create one with `llmux token create`.');
    return;
  }
  const headers = ['ID', 'NAME', 'CREATED', 'EXPIRES'];
  const rows = tokens.map((t) => [t.id, t.name ?? '-', t.createdAt, t.expiresAt ?? '-']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  console.log(headers.map((h, i) => h.padEnd(widths[i]!)).join('  '));
  for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  '));
}

export async function handleTokenRevoke(args: ParsedArgs): Promise<void> {
  if (args.flags.all) {
    const tokens = authStore.listAuthTokens();
    if (tokens.length === 0) {
      console.log('no tokens to revoke');
      return;
    }
    const skipConfirm = Boolean(args.flags.yes);
    if (!skipConfirm) {
      if (!process.stdin.isTTY) {
        throw new Error('--all without --yes requires an interactive terminal');
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) =>
        rl.question(`Revoke ALL ${tokens.length} token${tokens.length === 1 ? '' : 's'}? [y/N] `, (a) => resolve(a)),
      );
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log('cancelled');
        return;
      }
    }
    const removed = authStore.revokeAllAuthTokens();
    console.log(`revoked ${removed} token${removed === 1 ? '' : 's'}`);
    console.log('No tokens remain — auth is now disabled.');
    return;
  }
  // Accept the id at positional[0] (new flat dispatcher) OR positional[1] (legacy
  // `llmuxd token revoke <id>` form where positional[0] was "revoke").
  const idPrefix = args.positional[0] === 'revoke' ? args.positional[1] : args.positional[0];
  if (!idPrefix) throw new Error('token revoke requires an <id> (the 8-char prefix shown by `token list`), or --all to revoke every token');
  const ok = authStore.revokeAuthToken(idPrefix);
  if (!ok) throw new Error(`no token with id "${idPrefix}"`);
  console.log(`revoked ${idPrefix}`);
  if (!authStore.authEnabled()) {
    console.log('No tokens remain — auth is now disabled.');
  }
}

export function handleTokenRename(args: ParsedArgs): void {
  const idPrefix = args.positional[0] === 'rename' ? args.positional[1] : args.positional[0];
  if (!idPrefix) throw new Error('token rename requires an <id> (the 8-char prefix shown by `token list`)');
  const newName = args.flags.name as string | undefined;
  if (newName === undefined) throw new Error('token rename requires --name <label> (pass --name "" to clear)');
  const rec = authStore.renameAuthToken(idPrefix, newName);
  if (!rec) throw new Error(`no token with id "${idPrefix}"`);
  console.log(`renamed ${rec.id} → "${rec.name ?? ''}"`);
}

export function handleRespawn(args: ParsedArgs): void {
  tmux.requireTmux();
  const target = args.positional[0];
  if (!target) throw new Error('respawn requires <session>');

  const session = state.get(target);
  if (!session) throw new Error(`no tracked session "${target}"`);

  const agent = DEFAULT_AGENTS[session.agent];
  if (!agent) throw new Error(`unknown agent "${session.agent}" — cannot respawn`);
  if (!isAgentInstalled(agent)) {
    throw new Error(`agent "${session.agent}" is not installed (looked for: ${agent.cmd})`);
  }

  // If the session is still running, kill it first so respawn = restart
  // with the persisted config (parity with the web API's respawnSession).
  if (tmux.hasSession(target)) {
    tmux.killSession(target);
  }

  tmux.newSession({
    name: session.name,
    command: buildAgentCommand(agent, session.flags, session.resumeFrom),
    cwd: session.cwd,
    env: mergeSpawnEnv(agent, session.env, { LLMUX_SESSION: session.name, LLMUX_AGENT: session.agent }),
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
