// Per-alias message acknowledgement. Distinct from claims (claim = "I'm
// working on it") and reply (reply = "done, here's my answer"). An ack
// signals "I've processed this without sending a reply" — load-bearing
// for coordinator-shaped participants who receive terminal messages
// (replies from workers) and need to clear them from inbox without
// re-replying back up the chain.
//
// On-disk layout, under the state dir (see state.ts):
//   acks/<alias>/<flattened-msg-id>      — empty file; existence = acked
//
// Symmetric with claims/ in that it's per-(alias, msg-id) keyed and
// machine-local. The acks are append-only; there's no "un-ack."

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { stateDir } from './state.ts';

function acksDir(transportRoot: string, alias: string): string {
  const d = join(stateDir(transportRoot), 'acks', alias);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function flattenMsgId(msgId: string): string {
  return msgId.replace(/\//g, '__');
}

export function ackPath(transportRoot: string, alias: string, msgId: string): string {
  return join(acksDir(transportRoot, alias), flattenMsgId(msgId));
}

export function ackMessage(transportRoot: string, alias: string, msgId: string): void {
  writeFileSync(ackPath(transportRoot, alias, msgId), '');
}

export function isAcked(transportRoot: string, alias: string, msgId: string): boolean {
  return existsSync(ackPath(transportRoot, alias, msgId));
}

export function listAcked(transportRoot: string, alias: string): Set<string> {
  const dir = join(stateDir(transportRoot), 'acks', alias);
  if (!existsSync(dir)) return new Set();
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    // Reverse the flatten: '__' → '/'
    out.add(name.replace(/__/g, '/'));
  }
  return out;
}
