// Cherry-picked from cordfuse/crosstalk@v7.0.0-alpha.16 (engine/src/activation.ts).
// Unmodified — preserves wire-compatibility with crosstalk transport format
// and #1845 ephemeral-alias semantics.
//
// The activation rule — pure functions, no I/O, exhaustively unit-tested
// upstream:
//
//   A message wakes its addressee if it has no `re:` (a new task), or its
//   `re:` points at a message the addressee sent.
//
// `re:` is written by the runtime at send time, never inferred at read
// time. It is a string or a list: a reply that answers a batch of N
// messages records ALL N relPaths, so no answered message is ever lost to
// batching.
//
// llmux note: "actor" naming preserved for code parity with crosstalk; in
// llmux's public API surface this maps to "alias".

export interface ActivationMessage {
  from: string;
  to: string[];
  re?: string | string[];
}

export function recipients(toField: unknown): string[] {
  if (Array.isArray(toField)) return toField.map(String);
  if (typeof toField === 'string') return [toField];
  return [];
}

export function reList(reField: unknown): string[] {
  if (Array.isArray(reField)) return reField.map(String);
  if (typeof reField === 'string') return [reField];
  return [];
}

// A recipient is `actor` or `actor@host`.
export function extractActor(recipient: string): string {
  const at = recipient.indexOf('@');
  return at === -1 ? recipient : recipient.slice(0, at);
}

export function targetHost(recipient: string): string | null {
  const at = recipient.indexOf('@');
  return at === -1 ? null : recipient.slice(at + 1);
}

export interface RoutingResult {
  addressed: boolean;
  // Actor was named, but every instance targeted a different host — logged
  // by the dispatcher so wrong-host routes are visible, never silent.
  wrongHost: boolean;
}

export function matchRouting(
  recipientList: string[],
  actorName: string,
  thisHost: string,
): RoutingResult {
  let actorNamedAtAll = false;
  for (const r of recipientList) {
    if (r === 'all') return { addressed: true, wrongHost: false };
    if (extractActor(r) !== actorName) continue;
    actorNamedAtAll = true;
    const host = targetHost(r);
    if (host === null || host === thisHost) return { addressed: true, wrongHost: false };
  }
  return { addressed: false, wrongHost: actorNamedAtAll };
}

export type WakeDecision = 'wake' | 'skip' | 'wrong-host';

// `senderOf` resolves a channel relPath to the `from:` of the message there,
// or undefined if no such message exists. A dangling `re:` entry (target
// missing) wakes the addressee — fail open so a message is never silently
// dropped; no loop is possible because the reply to it carries a
// resolvable `re:`.
export function decideWake(
  msg: ActivationMessage,
  actorName: string,
  thisHost: string,
  senderOf: (relPath: string) => string | undefined,
): WakeDecision {
  const routing = matchRouting(msg.to, actorName, thisHost);
  if (!routing.addressed) return routing.wrongHost ? 'wrong-host' : 'skip';
  if (msg.from === actorName) return 'skip';
  const targets = reList(msg.re);
  if (targets.length === 0) return 'wake';
  for (const target of targets) {
    const asker = senderOf(target);
    if (asker === undefined || asker === actorName) return 'wake';
  }
  return 'skip';
}

// Split a channel's pending messages (already sorted by relPath) into
// contiguous batches sized for the actor's concurrency. Contiguous so each
// batch's highest relPath is monotone across batches — the cursor advances
// safely per batch. When pending fits within concurrency, every batch is a
// single message (parallel fan-out); when it exceeds, batches collapse into
// ~concurrency invocations (fan-in stays O(1) per actor).
export function splitForConcurrency<T>(msgs: T[], concurrency: number): T[][] {
  if (concurrency <= 1 || msgs.length <= 1) return [msgs];
  const chunkSize = Math.max(1, Math.ceil(msgs.length / concurrency));
  const out: T[][] = [];
  for (let i = 0; i < msgs.length; i += chunkSize) {
    out.push(msgs.slice(i, i + chunkSize));
  }
  return out;
}
