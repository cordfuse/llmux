// Per-message claim tracking. NEW for llmux (crosstalk had no concurrent-
// watcher model — single dispatcher per machine; concurrency was per-model
// claim, in-memory).
//
// llmux supports multiple watcher sessions all responding to the same alias
// (the "concurrent watcher" pattern in the design doc). When two watchers
// see the same broadcast message, only one should act. Claims arbitrate.
//
// On-disk layout, under the state dir (see state.ts):
//   claims/
//     <flattened-msg-id>            — JSON: { alias, claimedAt, heartbeatAt }
//
// `<flattened-msg-id>` replaces '/' with '__' so the filename is portable.
//
// Claim TTL: if heartbeatAt is older than CLAIM_TTL_MS, the claim is
// considered stale (the claiming watcher crashed or hung) and another
// watcher may steal it. llmuxd's background tick refreshes heartbeats for
// active sessions and reaps stale claims; that integration is phase 5.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync,
} from 'fs';
import { join } from 'path';
import { stateDir, logError } from './state.ts';

export const CLAIM_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const HEARTBEAT_INTERVAL_MS = 60 * 1000;          // 1 minute (informational; daemon refreshes on this cadence)

export interface ClaimRecord {
  alias: string;
  claimedAt: number;       // unix-ms
  heartbeatAt: number;     // unix-ms — refreshed by daemon for live claims
}

function claimsDir(transportRoot: string): string {
  const d = join(stateDir(transportRoot), 'claims');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function flattenMsgId(msgId: string): string {
  // msgId looks like 'YYYY/MM/DD/HHMMSSmmmZ-XXXXXXXX.md'
  return msgId.replace(/\//g, '__');
}

export function claimPath(transportRoot: string, msgId: string): string {
  return join(claimsDir(transportRoot), flattenMsgId(msgId));
}

export function readClaim(transportRoot: string, msgId: string): ClaimRecord | null {
  const p = claimPath(transportRoot, msgId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ClaimRecord;
  } catch (err) {
    logError(transportRoot, `claim parse failed for ${msgId}: ${(err as Error).message}`);
    return null;
  }
}

export function isClaimLive(record: ClaimRecord, now = Date.now()): boolean {
  return now - record.heartbeatAt < CLAIM_TTL_MS;
}

// Attempt to acquire a claim on `msgId` for `alias`. Returns true if the
// claim is now held by `alias`, false if another live claim blocks it.
// Single-host + filesystem write-then-check provides the atomicity we need
// for the rare race: two watchers calling claim at the same microsecond
// will both write; the second write wins on disk; the first watcher will
// re-read on its next inbox poll and see it's been taken.
//
// Steve note: this is a deliberately simple primitive. Multi-host (which
// llmux doesn't target) would need a stronger lock; single-host with one
// llmuxd as the funnel is fine.
export function acquireClaim(transportRoot: string, msgId: string, alias: string): boolean {
  const existing = readClaim(transportRoot, msgId);
  const now = Date.now();
  if (existing && existing.alias !== alias && isClaimLive(existing, now)) {
    return false;
  }
  const record: ClaimRecord = { alias, claimedAt: now, heartbeatAt: now };
  writeFileSync(claimPath(transportRoot, msgId), JSON.stringify(record) + '\n');
  return true;
}

// Refresh the heartbeat on an existing claim. Called periodically by
// llmuxd for sessions that are still alive. No-op if the claim doesn't
// exist or belongs to a different alias.
export function heartbeatClaim(transportRoot: string, msgId: string, alias: string): void {
  const existing = readClaim(transportRoot, msgId);
  if (!existing || existing.alias !== alias) return;
  existing.heartbeatAt = Date.now();
  writeFileSync(claimPath(transportRoot, msgId), JSON.stringify(existing) + '\n');
}

// Release a claim. Called on reply or explicit release. Silent if the
// claim doesn't exist or belongs to a different alias.
export function releaseClaim(transportRoot: string, msgId: string, alias: string): void {
  const existing = readClaim(transportRoot, msgId);
  if (!existing || existing.alias !== alias) return;
  try {
    unlinkSync(claimPath(transportRoot, msgId));
  } catch { /* race with another release; harmless */ }
}

// Sweep stale claims (heartbeat older than CLAIM_TTL_MS). Returns the
// count reaped. Called by llmuxd's background tick.
export function reapStaleClaims(transportRoot: string, now = Date.now()): number {
  const dir = claimsDir(transportRoot);
  let reaped = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let record: ClaimRecord;
    try {
      record = JSON.parse(readFileSync(p, 'utf-8')) as ClaimRecord;
    } catch {
      // Corrupt claim file → reap it.
      try { unlinkSync(p); reaped++; } catch { /* race */ }
      continue;
    }
    if (!isClaimLive(record, now)) {
      try { unlinkSync(p); reaped++; } catch { /* race */ }
    }
  }
  return reaped;
}

// Informational — the heartbeat cadence llmuxd should use.
export const HEARTBEAT_CADENCE_MS = HEARTBEAT_INTERVAL_MS;
