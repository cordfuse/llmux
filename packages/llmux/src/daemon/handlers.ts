import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import qrcodeTerminal from 'qrcode-terminal';
import { DEFAULT_AGENTS, isAgentInstalled, type AgentDefinition } from './agents.ts';
import { loadConfig } from './config.ts';
import * as logBuffer from './log-buffer.ts';
import * as state from './state.ts';
import * as tmux from './tmux.ts';
import * as authStore from './auth-store.ts';
import { startServer, printBanner, buildAgentCommand, parseEnvText, mergeSpawnEnv, editSession } from './web/server.ts';
import * as turnqIntegration from './turnq-integration.ts';
import { hostname } from 'node:os';
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

/**
 * Wait for the agent's TUI to render its "ready for input" prompt, then
 * fire each init prompt in turn (with Enter at end, 500ms gap between).
 *
 * Ready detection: if the agent has a `readyPrompt` regex, poll
 * tmux capture-pane every 200ms until the regex matches the tail of the
 * pane content OR we hit the timeout. If no regex is set, fall back to
 * a 2-second sleep — close enough for most CLIs that boot in under that.
 *
 * On timeout (10s) we WARN and fire anyway. Hanging forever would leave
 * an operator's `session start` blocked on an unmatched regex.
 */
async function fireInitPrompts(
  sessionName: string,
  agent: AgentDefinition,
  prompts: readonly string[],
): Promise<void> {
  if (prompts.length === 0) return;
  const readyRegex = agent.readyPrompt ? new RegExp(agent.readyPrompt, 'm') : null;
  if (!readyRegex) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  } else {
    const start = Date.now();
    const TIMEOUT_MS = 10_000;
    let matched = false;
    while (Date.now() - start < TIMEOUT_MS) {
      try {
        const pane = tmux.capturePane(sessionName, 15);
        const tail = pane.trimEnd().split('\n').slice(-3).join('\n');
        if (readyRegex.test(tail)) {
          matched = true;
          break;
        }
      } catch {
        // session may not be live yet; keep polling
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    if (!matched) {
      console.warn(
        `[llmux] init-prompts: timed out waiting for ${agent.readyPrompt} on ${sessionName}; firing anyway`,
      );
    }
  }
  for (const prompt of prompts) {
    try {
      tmux.sendKeys(sessionName, prompt, { enter: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[llmux] init-prompts: send-keys failed on ${sessionName}: ${msg}`);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Compose the final init-prompts list for a session. Daemon-wide prompts
 * (from `.llmux.yaml`) fire FIRST, then the session-specific ones. The
 * result is what gets persisted on `session.initPrompts` so respawns
 * fire the same context exactly once each.
 */
function composeInitPrompts(daemonPrompts: readonly string[] | undefined, sessionPrompts: readonly string[] | undefined): string[] | undefined {
  const merged: string[] = [];
  if (daemonPrompts) merged.push(...daemonPrompts);
  if (sessionPrompts) merged.push(...sessionPrompts);
  return merged.length > 0 ? merged : undefined;
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

export async function handleSpawn(args: ParsedArgs): Promise<void> {
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
  const cliInitPrompts = Array.isArray(args.flags.init) ? (args.flags.init as string[]) : undefined;
  const skipInit = Boolean(args.flags['skip-init']);
  const orchAlias = args.flags['orch-alias'] as string | undefined;

  const agents = expandAgentList(spec);

  if (name && agents.length > 1) {
    throw new Error('--name is only valid with a single agent');
  }
  if (resumeFrom !== undefined && agents.length > 1) {
    throw new Error('--resume-from is only valid with a single agent');
  }

  // Daemon-wide init prompts come from .llmux.yaml — fire on every newly
  // spawned session, before per-session prompts. Resume case sidesteps
  // this path entirely (it goes through the resume handler).
  const cfg = loadConfig();
  const daemonInitPrompts = cfg.initPrompts ?? [];
  const turnqEnabled = Boolean(cfg.turnq?.enabled);

  const parent = process.env.LLMUX_SESSION ?? null;
  const created: string[] = [];

  for (const agent of agents) {
    const sessionName = name ?? (prefix ? `${prefix}${agent.key}` : agent.key);
    if (state.get(sessionName) || tmux.hasSession(sessionName)) {
      throw new Error(`session "${sessionName}" already exists`);
    }
    const effectiveResume = resumeFrom && agent.history ? resumeFrom : undefined;
    // Init prompts: compose daemon + CLI flags. The persisted list is what
    // respawns will re-fire — so the daemon's contribution is "baked in"
    // at spawn time. If .llmux.yaml changes later, existing sessions stick
    // with the snapshot they spawned under (intentional: change is opt-in
    // per session via `session edit --init`).
    //
    // When turnq is on, generate a per-session marker and append a built-in
    // marker-emission prompt as the LAST init prompt — LLM recency bias
    // means the freshest context the agent has when the first real prompt
    // lands is "remember to emit the marker."
    const marker = turnqEnabled ? turnqIntegration.generateMarker() : undefined;
    const operatorPrompts = composeInitPrompts(daemonInitPrompts, cliInitPrompts);
    const composedInitPrompts = marker
      ? [...(operatorPrompts ?? []), turnqIntegration.buildMarkerPrompt(marker)]
      : operatorPrompts;
    const llmuxEnv: Record<string, string> = { LLMUX_SESSION: sessionName, LLMUX_AGENT: agent.key };
    if (orchAlias) llmuxEnv['LLMUX_ORCH_ALIAS'] = orchAlias;
    agent.preSpawn?.({ cwd });
    tmux.newSession({
      name: sessionName,
      command: buildAgentCommand(agent, flagsOverride, effectiveResume),
      cwd,
      env: mergeSpawnEnv(agent, envOverride, llmuxEnv),
    });
    state.record({
      name: sessionName,
      agent: agent.key,
      cwd,
      ...(flagsOverride !== undefined ? { flags: flagsOverride } : {}),
      ...(envOverride !== undefined ? { env: envOverride } : {}),
      ...(effectiveResume !== undefined ? { resumeFrom: effectiveResume } : {}),
      ...(composedInitPrompts !== undefined && composedInitPrompts.length > 0 ? { initPrompts: composedInitPrompts } : {}),
      ...(marker !== undefined ? { turnqMarker: marker } : {}),
      ...(orchAlias !== undefined ? { orchAlias } : {}),
      createdAt: new Date().toISOString(),
      parent,
      restart: 'on-failure',
    });
    created.push(sessionName);
    console.log(`spawned ${sessionName} (agent: ${agent.key}, cwd: ${cwd})`);
    if (composedInitPrompts && composedInitPrompts.length > 0 && !skipInit) {
      console.log(`  firing ${composedInitPrompts.length} init prompt${composedInitPrompts.length === 1 ? '' : 's'}...`);
      await fireInitPrompts(sessionName, agent, composedInitPrompts);
    }
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

export async function handleSend(args: ParsedArgs): Promise<void> {
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
  const skipTurnq = Boolean(args.flags['no-turnq']);
  const cfg = loadConfig();
  await turnqIntegration.sendWithTurn(session.name, prompt, { enter, skipTurnq, turnqConfig: cfg.turnq });
  console.log(`sent ${prompt.length} bytes → ${session.name}${enter ? '' : ' (no-enter)'}`);
}

export async function handleBroadcast(args: ParsedArgs): Promise<void> {
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
  const skipTurnq = Boolean(args.flags['no-turnq']);
  const cfg = loadConfig();
  let n = 0;
  // Broadcast fires per-name in parallel — each session has its own turnq
  // channel so they're independent. If turnq is off, sendWithTurn falls
  // through to plain sendKeys.
  const results = await Promise.all(sessions.map(async (s) => {
    if (!tmux.hasSession(s.name)) return { name: s.name, sent: false };
    await turnqIntegration.sendWithTurn(s.name, prompt, { enter: true, skipTurnq, turnqConfig: cfg.turnq });
    return { name: s.name, sent: true };
  }));
  for (const r of results) {
    if (r.sent) {
      console.log(`sent → ${r.name}`);
      n++;
    }
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
 *   CLI --port > LLMUXD_PORT > LLMUX_PORT (legacy) > config.server.port > 3001
 * The CLI flag is consulted via the caller — pass `args.flags.port` as the
 * `explicitPort` argument when invoking.
 */
function endpointPort(explicitPort?: string): number {
  const cfg = loadConfig();
  const raw =
    explicitPort ??
    process.env.LLMUXD_PORT ??
    process.env.LLMUX_PORT ??
    String(cfg.server.port ?? 3001);
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

async function respawnOne(target: string, opts: { skipInit?: boolean } = {}): Promise<void> {
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

  agent.preSpawn?.({ cwd: session.cwd });
  tmux.newSession({
    name: session.name,
    command: buildAgentCommand(agent, session.flags, session.resumeFrom),
    cwd: session.cwd,
    env: mergeSpawnEnv(agent, session.env, { LLMUX_SESSION: session.name, LLMUX_AGENT: session.agent }),
  });
  state.record({ ...session, createdAt: new Date().toISOString() });
  console.log(`respawned ${target} (agent: ${session.agent}, cwd: ${session.cwd})`);

  // Re-fire the persisted init prompts so the restart re-establishes the
  // same operator-context the original spawn set up. Resume case does NOT
  // re-fire (the prompts are already in the conversation history).
  if (!opts.skipInit && session.initPrompts && session.initPrompts.length > 0) {
    console.log(`  firing ${session.initPrompts.length} init prompt${session.initPrompts.length === 1 ? '' : 's'}...`);
    await fireInitPrompts(target, agent, session.initPrompts);
  }
}

export async function handleRespawn(args: ParsedArgs): Promise<void> {
  tmux.requireTmux();
  const targets = args.positional;
  if (targets.length === 0) throw new Error('restart requires one or more <session> names');
  const skipInit = Boolean(args.flags['skip-init']);
  // Variadic: respawn each named session in turn. On a per-target failure
  // the remaining ones still attempt — operators bulk-restarting a queue
  // shouldn't lose every late session because the first one's tmux pane
  // already died.
  const errors: string[] = [];
  for (const t of targets) {
    try {
      await respawnOne(t, { skipInit });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`respawn ${t} failed: ${msg}`);
      errors.push(t);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${errors.length} of ${targets.length} respawn calls failed`);
  }
}

function killOne(target: string): void {
  const session = state.get(target);
  if (!session) throw new Error(`no tracked session "${target}"`);
  tmux.killSession(target);
  state.forget(target);
  console.log(`killed ${target}`);
}

export function handleKill(args: ParsedArgs): void {
  tmux.requireTmux();
  const targets = args.positional;
  if (targets.length === 0) throw new Error('stop/kill requires one or more <session> names, or `all`');
  const cascade = Boolean(args.flags.cascade);

  // `all` keyword — kill every tracked session. Only meaningful as the
  // sole positional; mixing with names would be ambiguous.
  if (targets.length === 1 && targets[0] === 'all') {
    const all = state.list();
    for (const s of all) {
      tmux.killSession(s.name);
      state.forget(s.name);
      console.log(`killed ${s.name}`);
    }
    if (all.length === 0) console.log('no sessions to kill');
    return;
  }

  // Cascade only applies to a single explicit target — descendants of N
  // targets at once would be a weird semantic.
  if (cascade) {
    if (targets.length !== 1) throw new Error('--cascade only valid with a single target');
    const target = targets[0]!;
    const session = state.get(target);
    if (!session) throw new Error(`no tracked session "${target}"`);
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

  // Variadic: kill each named session. Continue on per-target errors so a
  // typo or missing record in the middle doesn't abort the rest of the batch.
  const errors: string[] = [];
  for (const t of targets) {
    try {
      killOne(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`kill ${t} failed: ${msg}`);
      errors.push(t);
    }
  }
  if (errors.length > 0) {
    throw new Error(`${errors.length} of ${targets.length} kill calls failed`);
  }
}

export async function handleSessionEdit(args: ParsedArgs): Promise<void> {
  tmux.requireTmux();
  const target = args.positional[0];
  if (!target) throw new Error('edit requires <session>');
  const patch: { name?: string; cwd?: string; flags?: string; env?: string; initPrompts?: string[] } = {};
  if (typeof args.flags.name === 'string') patch.name = args.flags.name;
  if (typeof args.flags.cwd === 'string') patch.cwd = args.flags.cwd;
  if (typeof args.flags.flags === 'string') patch.flags = args.flags.flags as string;
  if (typeof args.flags.env === 'string') patch.env = args.flags.env as string;
  if (Array.isArray(args.flags.init)) patch.initPrompts = args.flags.init as string[];
  if (Object.keys(patch).length === 0) {
    throw new Error('edit requires at least one of --name, --cwd, --flags, --env, --init');
  }
  // The shared editSession only knows about name/cwd/flags/env. Patch the
  // initPrompts directly against the state record after the main edit
  // settles. Stays in lock-step with the web path because the web Edit
  // modal patches over PATCH /api/sessions and writes initPrompts there
  // (added in the same release).
  const result = editSession(target, patch);
  if (!result.ok) throw new Error(result.error);
  if (patch.initPrompts !== undefined) {
    const rec = state.get(result.session.name);
    if (rec) {
      const next: state.SessionState = {
        ...rec,
        ...(patch.initPrompts.length > 0 ? { initPrompts: patch.initPrompts } : {}),
      };
      if (patch.initPrompts.length === 0) delete next.initPrompts;
      state.record(next);
    }
  }
  console.log(`edited ${result.session.name} (agent: ${result.session.agent}, cwd: ${result.session.cwd})`);
  if (result.session.flags !== undefined) console.log(`  flags: ${result.session.flags}`);
  if (result.session.env !== undefined && Object.keys(result.session.env).length > 0) {
    console.log('  env:');
    for (const [k, v] of Object.entries(result.session.env)) console.log(`    ${k}=${v}`);
  }
  if (patch.initPrompts !== undefined) {
    console.log(`  init prompts: ${patch.initPrompts.length}`);
  }
  if (args.flags.apply) {
    await respawnOne(result.session.name);
  } else {
    console.log('(restart the session to apply: `llmux session restart ' + result.session.name + '`)');
  }
}

export function handleLogsList(args: ParsedArgs): void {
  const limitFlag = args.flags.limit as string | undefined;
  const limit = limitFlag ? Math.max(1, Number(limitFlag)) : undefined;
  const json = Boolean(args.flags.json);
  const entries = logBuffer.getBuffer();
  const slice = limit !== undefined ? entries.slice(-limit) : entries;
  if (json) {
    console.log(JSON.stringify(slice, null, 2));
    return;
  }
  for (const e of slice) {
    console.log(`${e.ts}  ${e.level.toUpperCase().padEnd(5)}  ${e.text}`);
  }
}

export async function handleLogsTail(args: ParsedArgs): Promise<void> {
  // Print the initial buffer (so the operator sees recent context), then
  // subscribe to live entries until Ctrl-C. The subscription is in-process,
  // so this verb is local-mode only — remote tailing goes through the SSE
  // client in client.ts.
  const since = args.flags.since as string | undefined;
  const sinceMs = since ? Date.parse(since) : 0;
  const initial = logBuffer.getBuffer().filter((e) => !since || Date.parse(e.ts) >= sinceMs);
  for (const e of initial) {
    console.log(`${e.ts}  ${e.level.toUpperCase().padEnd(5)}  ${e.text}`);
  }
  await new Promise<void>((resolve) => {
    const unsubscribe = logBuffer.subscribe((entry) => {
      console.log(`${entry.ts}  ${entry.level.toUpperCase().padEnd(5)}  ${entry.text}`);
    });
    const onSig = () => {
      unsubscribe();
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });
}

export function handleSettingsShow(args: ParsedArgs): void {
  const cfg = loadConfig();
  let yamlText = '';
  if (cfg.sourcePath) {
    try {
      yamlText = readFileSync(cfg.sourcePath, 'utf8');
    } catch {
      yamlText = '(failed to read config file)';
    }
  }
  let tmuxAvailable = false;
  try {
    tmux.requireTmux();
    tmuxAvailable = true;
  } catch {
    tmuxAvailable = false;
  }
  const payload = {
    host: hostname(),
    configSource: cfg.sourcePath ?? null,
    yamlText,
    stateDir: state.stateDir(),
    tmuxAvailable,
    port: Number(process.env.LLMUXD_PORT ?? process.env.LLMUX_PORT ?? cfg.server.port ?? 3001),
    listenHost: process.env.LLMUXD_HOST ?? '0.0.0.0',
    env: {
      LLMUXD_PORT: process.env.LLMUXD_PORT ?? null,
      LLMUXD_HOST: process.env.LLMUXD_HOST ?? null,
      LLMUX_PORT: process.env.LLMUX_PORT ?? null,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? null,
    },
  };
  if (args.flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`host           ${payload.host}`);
  console.log(`config source  ${payload.configSource ?? '(no .llmux.yaml found)'}`);
  console.log(`state dir      ${payload.stateDir}`);
  console.log(`tmux           ${payload.tmuxAvailable ? 'available' : 'NOT FOUND on PATH'}`);
  console.log(`port           ${payload.port}`);
  console.log(`listen host    ${payload.listenHost}`);
  console.log('environment:');
  for (const [k, v] of Object.entries(payload.env)) {
    console.log(`  ${k.padEnd(16)} ${v ?? '(unset)'}`);
  }
  if (yamlText) {
    console.log('');
    console.log(`---  ${payload.configSource}  ---`);
    console.log(yamlText.trimEnd());
  }
}
