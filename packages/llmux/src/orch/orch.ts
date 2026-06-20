// Public orch API. The CLI verbs (`llmux orch send / inbox / next / reply /
// release`) wrap these functions; llmuxd integration uses them directly.
// Stateless — each call is a self-contained read or write against the
// transport on disk.
//
// All functions take `transportRoot` (path to the git repo) as their first
// argument. The default `transportRoot` lookup ($XDG_DATA_HOME/llmux/
// orchestration/) is the CLI's concern, not this module's.

import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import {
  messageFilename, now as nowTimestamp, type Timestamp,
} from './filenames.ts';
import { serializeFrontmatter } from './frontmatter.ts';
import {
  type ChannelMessage,
  listChannelMessages,
  gitCommit,
  asyncBackupPush,
} from './transport.ts';
import {
  decideWake, recipients, type ActivationMessage, type WakeDecision,
} from './activation.ts';
import {
  acquireClaim, releaseClaim, readClaim, isClaimLive, CLAIM_TTL_MS, type ClaimRecord,
} from './claims.ts';
import { stateDir } from './state.ts';

/**
 * A message as exposed to CLI/daemon callers — flattens transport's
 * relPath-based ChannelMessage into something easier to consume from
 * outside.
 */
export interface OrchMessage {
  id: string;              // 'YYYY/MM/DD/HHMMSSmmmZ-XXXXXXXX.md' — the relPath
  channel: string;
  from: string;
  to: string | string[];
  re?: string | string[];
  timestamp: string;
  body: string;
  claimed?: { alias: string; claimedAt: number; heartbeatAt: number };
}

function toOrchMessage(channel: string, m: ChannelMessage, transportRoot?: string): OrchMessage {
  const out: OrchMessage = {
    id: m.relPath,
    channel,
    from: String(m.data['from']),
    to: m.data['to'] as string | string[],
    timestamp: String(m.data['timestamp']),
    body: m.body,
  };
  if (m.data['re'] !== undefined) out.re = m.data['re'] as string | string[];
  if (transportRoot) {
    const c = readClaim(transportRoot, m.relPath);
    if (c && isClaimLive(c)) out.claimed = c;
  }
  return out;
}

/**
 * Single-host this-host name. Crosstalk used kernel hostname for
 * @host routing; llmux single-host has no cross-host routing, so we use
 * a constant. Kept as a constant rather than empty string so activation
 * rule's `actor@host` matching still works the same way (it just always
 * matches when host is omitted from recipients).
 */
export const ORCH_HOST = 'local';

// ── send / reply ─────────────────────────────────────────────────────────

export interface SendInput {
  from: string;
  to: string | string[];
  body: string;
  channel?: string;        // default 'main'
  re?: string | string[];  // when this send is a reply
}

export interface SendResult {
  ok: true;
  id: string;
}

export function send(transportRoot: string, input: SendInput): SendResult {
  const channel = input.channel ?? 'main';
  const ts: Timestamp = nowTimestamp();
  const filename = messageFilename(ts);
  const relPath = `${ts.pathDate}/${filename}`;
  const fullPath = join(transportRoot, 'data', 'channels', channel, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });

  const data: Record<string, unknown> = {
    from: input.from,
    to: input.to,
    timestamp: ts.iso,
  };
  if (input.re !== undefined) data['re'] = input.re;

  writeFileSync(fullPath, serializeFrontmatter(data, input.body));

  const commitMsg = input.re !== undefined
    ? `reply: ${input.from} -> ${formatRecipients(input.to)} (${relPath})`
    : `send: ${input.from} -> ${formatRecipients(input.to)} (${relPath})`;
  gitCommit(transportRoot, commitMsg);
  asyncBackupPush(transportRoot);

  return { ok: true, id: relPath };
}

function formatRecipients(to: string | string[]): string {
  return Array.isArray(to) ? to.join(',') : to;
}

/**
 * Reply to a previously-claimed message. Commits the reply and releases
 * the claim. Caller-supplied `alias` must match the claim's alias or the
 * release is silently skipped (the reply still ships, but the orphan
 * claim will be reaped on TTL).
 */
export function reply(
  transportRoot: string,
  msgId: string,
  alias: string,
  body: string,
  channel = 'main',
): SendResult {
  // Look up the parent message to pick up sender for the reply's `to:`.
  const messages = listChannelMessages(transportRoot, channel);
  const parent = messages.find((m) => m.relPath === msgId);
  if (!parent) {
    throw new Error(`reply: unknown message ${msgId} in channel ${channel}`);
  }
  const parentFrom = String(parent.data['from']);
  const result = send(transportRoot, {
    from: alias,
    to: parentFrom,
    body,
    channel,
    re: msgId,
  });
  releaseClaim(transportRoot, msgId, alias);
  return result;
}

// ── inbox / claim / release ──────────────────────────────────────────────

export interface InboxOptions {
  channel?: string;        // default 'main'
  limit?: number;          // default 50
  /** Include messages that are currently claimed by ANOTHER alias. Default false. */
  includeClaimedByOthers?: boolean;
}

/**
 * Read-only — messages addressed to `alias` (or 'all') in the channel,
 * filtered by activation rule (skips self-sent + skips re:-targets that
 * weren't sent by this alias).
 *
 * Does NOT claim anything and does NOT advance the cursor. For pickup,
 * call claimNext.
 */
export function inbox(
  transportRoot: string,
  alias: string,
  opts: InboxOptions = {},
): OrchMessage[] {
  const channel = opts.channel ?? 'main';
  const limit = opts.limit ?? 50;
  const includeClaimed = opts.includeClaimedByOthers ?? false;
  const messages = listChannelMessages(transportRoot, channel);

  const senderOf = (relPath: string): string | undefined => {
    const m = messages.find((x) => x.relPath === relPath);
    return m ? String(m.data['from']) : undefined;
  };

  const filtered: OrchMessage[] = [];
  for (const m of messages) {
    const activationMsg: ActivationMessage = {
      from: String(m.data['from']),
      to: recipients(m.data['to']),
    };
    if (m.data['re'] !== undefined) {
      activationMsg.re = m.data['re'] as string | string[];
    }
    const decision: WakeDecision = decideWake(activationMsg, alias, ORCH_HOST, senderOf);
    if (decision !== 'wake') continue;
    if (!includeClaimed) {
      const c = readClaim(transportRoot, m.relPath);
      if (c && c.alias !== alias && isClaimLive(c)) continue;
    }
    filtered.push(toOrchMessage(channel, m, transportRoot));
    if (filtered.length >= limit) break;
  }
  return filtered;
}

/**
 * Atomically claim the oldest unclaimed inbox message for `alias`.
 * Returns the message (with claim metadata) or null if the inbox is
 * empty or every message is held by a live claim from another alias.
 */
export function claimNext(
  transportRoot: string,
  alias: string,
  opts: InboxOptions = {},
): OrchMessage | null {
  // Get the unclaimed-by-others inbox; try to acquire each in order until
  // one sticks. Filesystem race-loss falls through to the next message.
  const candidates = inbox(transportRoot, alias, opts);
  for (const candidate of candidates) {
    if (acquireClaim(transportRoot, candidate.id, alias)) {
      const claim = readClaim(transportRoot, candidate.id);
      if (claim) candidate.claimed = claim;
      return candidate;
    }
  }
  return null;
}

/**
 * Release a claim without replying. Useful for graceful shutdown or
 * "I decided not to handle this." Silent no-op if the claim doesn't
 * exist or belongs to another alias.
 */
export function release(transportRoot: string, msgId: string, alias: string): void {
  releaseClaim(transportRoot, msgId, alias);
}

// ── status / introspection ───────────────────────────────────────────────

export interface OrchStatus {
  transportRoot: string;
  channels: string[];
  liveClaims: number;
}

export function status(transportRoot: string): OrchStatus {
  const channelsDir = join(transportRoot, 'data', 'channels');
  const channels: string[] = existsSync(channelsDir)
    ? readdirSync(channelsDir).filter((n) => statSync(join(channelsDir, n)).isDirectory())
    : [];
  return { transportRoot, channels, liveClaims: countLiveClaims(transportRoot) };
}

function countLiveClaims(transportRoot: string): number {
  const dir = join(stateDir(transportRoot), 'claims');
  if (!existsSync(dir)) return 0;
  let live = 0;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as ClaimRecord;
      if (now - record.heartbeatAt < CLAIM_TTL_MS) live++;
    } catch { /* skip corrupt */ }
  }
  return live;
}
