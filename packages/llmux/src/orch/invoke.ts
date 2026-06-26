// invoke.ts — model invocation, persona loading, reply writing.
//
// Called from dispatch.ts when a message wakes a claimed model. Composes
// the system prompt (PROTOCOL.md + optional actor persona), invokes the
// model CLI from data/crosstalk.yaml, captures stdout, writes a reply
// message back into the same channel (success or failed:true).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { now, messageFilename } from './filenames.ts';
import { serializeFrontmatter } from './frontmatter.ts';
import type { ModelEntry } from './models.ts';
import type { ChannelMessage } from './transport.ts';

// Parse a .env-style file: KEY=value per line, # comments ignored, blank
// lines ignored. No shell expansion, no escaping. First `=` splits the
// key from the value; trailing/leading whitespace trimmed on both.
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  const raw = readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;  // no key, or starts with `=`
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return out;
}

export interface InvokeResult {
  status: number;
  stdout: string;
  stderr: string;
}

// 10 minutes — orchestrator-persona workflows can take 3-5 minutes
// of model thinking before the first tool call. v6's 5-minute timeout
// was tight for any orchestrator pattern.
const CLI_TIMEOUT_MS = 10 * 60_000;
const ARGV_PROMPT_LIMIT = 64 * 1024;

export function loadProtocolPrompt(transportRoot: string): string {
  const p = join(transportRoot, 'PROTOCOL.md');
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : '';
}

export function loadActorPersona(transportRoot: string, actorName: string | undefined): string {
  if (!actorName) return '';
  const p = join(transportRoot, 'local', 'actors', `${actorName}.md`);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8').trim();
}

export function composeSystemPrompt(parts: string[]): string {
  return parts.filter((p) => p && p.length > 0).join('\n\n---\n\n');
}

export function messageSender(msg: ChannelMessage): string {
  return typeof msg.data['from'] === 'string' ? (msg.data['from'] as string) : 'unknown';
}

// Resolve a provider's inline `env:` block against the host process env.
// Each value is a `${VAR}` reference (validated at parse time in models.ts).
// Undefined host vars are dropped silently — agent CLI surfaces its own
// auth error and the failure path captures both streams (alpha.9 F1 fix).
// This matches env_file semantics where a missing file contributes nothing
// rather than crashing the spawn.
function resolveInlineEnv(
  inlineEnv: Record<string, string> | null,
  hostEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  if (inlineEnv == null) return {};
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(inlineEnv)) {
    const varName = ref.slice(2, -1);  // strip `${` and `}` — parse-time validated
    const value = hostEnv[varName];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

// Pass the prompt as the CLI's last argv entry. Every modern agent CLI
// (Claude --print, codex exec, gemini -p, qwen --yolo, opencode -p,
// agy -p) reads its prompt from the trailing positional, so appending
// works universally. Fallback to stdin when the prompt would exceed a
// safe argv size — ARG_MAX is ~128 KB on Linux and ~256 KB on macOS.
//
// Env merge precedence at spawn (last-wins via spread order):
//   1. process.env       — container baseline (PATH, IS_SANDBOX, etc.)
//   2. provider env_file — model's provider auth from a dotenv file
//   3. provider env      — model's provider auth from inline ${VAR} refs
//                          (alpha.10 — overrides env_file per-key when both
//                          set, so an operator can bulk-load from a file
//                          and override one key inline)
//   4. dispatchEnv       — per-spawn dispatch metadata (CROSSTALK_DISPATCH_*)
// Dispatch wins because per-spawn truth must override per-provider config;
// provider wins over baseline because auth varies per model.
export function invokeModelCli(
  model: ModelEntry,
  systemPrompt: string,
  userMessage: string,
  dispatchEnv: Record<string, string>,
): Promise<InvokeResult> {
  return new Promise((res) => {
    const fullPrompt = systemPrompt.length > 0
      ? `${systemPrompt}\n\n---\n\n${userMessage}`
      : userMessage;
    const useStdin = Buffer.byteLength(fullPrompt, 'utf-8') > ARGV_PROMPT_LIMIT;
    const argv = useStdin ? [...model.args] : [...model.args, fullPrompt];
    const envFileEnv = model.envFile ? readEnvFile(model.envFile) : {};
    const inlineProviderEnv = resolveInlineEnv(model.inlineEnv, process.env);
    // detached: new process group, so the timeout SIGKILL takes the model's
    // children with it — orphans writing to the transport after a timeout
    // was an observed v5/v6 hazard.
    const child = spawn(model.cli, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...envFileEnv, ...inlineProviderEnv, ...dispatchEnv },
    });
    let stdout = '';
    let stderr = '';
    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }
      res({ status: 124, stdout, stderr: stderr + '\n[timeout]' });
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      res({ status: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      res({ status: 1, stdout, stderr: stderr + '\n' + err.message });
    });
    child.stdin.on('error', () => { /* child closed stdin */ });
    if (useStdin) {
      try { child.stdin.write(fullPrompt); } catch { /* same */ }
    }
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

export function formatBatchedUserMessage(msgs: ChannelMessage[]): string {
  if (msgs.length === 1) return msgs[0]!.body;
  const parts = [`You have ${msgs.length} new messages in this channel. Process them collectively and reply once.`];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const ts = typeof m.data['timestamp'] === 'string' ? `, ts: ${m.data['timestamp']}` : '';
    parts.push(`--- Message ${i + 1} of ${msgs.length} (from: ${messageSender(m)}, ref: ${m.relPath}${ts}) ---`);
    parts.push(m.body);
  }
  return parts.join('\n\n');
}

export interface ReplyOpts {
  transportRoot: string;
  channelUuid: string;
  fromModel: string;     // e.g. "sonnet@cachy"
  to: string;            // the requester
  re: string | string[];
  body: string;
  failed?: { error: string };
}

export function writeReply(opts: ReplyOpts): string {
  const ts = now();
  const dir = join(opts.transportRoot, 'data', 'channels', opts.channelUuid, ts.pathDate);
  mkdirSync(dir, { recursive: true });
  const fm: Record<string, unknown> = {
    from: opts.fromModel,
    to: opts.to,
    timestamp: ts.iso,
    re: opts.re,
  };
  if (opts.failed) {
    fm['failed'] = true;
    fm['error'] = opts.failed.error.slice(0, 2000);
  }
  const filename = messageFilename(ts);
  writeFileSync(join(dir, filename), serializeFrontmatter(fm, opts.body));
  return join(ts.pathDate, filename);
}
