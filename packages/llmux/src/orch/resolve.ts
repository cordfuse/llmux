// resolve.ts — model reference resolution.
//
// Operator-facing references can be either:
//   - qualified:  "google-personal/gemini-direct" (provider/model form)
//   - bare:       "gemini-direct" (model name only)
//
// Qualified references are looked up against the FULL parsed registry
// — including models declared in data/crosstalk.yaml but NOT locally
// claimed by this dispatcher. This is the cross-machine routing surface:
// the sender's API resolves the reference to its canonical qualified
// form and writes a commit; whichever peer dispatcher claims the model
// picks it up at its next tick (per PROTOCOL.md addressing rules).
// Restricting qualified lookups to `claimed` blocked cross-machine
// asymmetric dispatch — F-CROSS, caught in the alpha.14 capstone gate.
//
// Bare references still resolve via auto-disambiguation against the
// CLAIMED registry. Cross-machine bare-name dispatch is intentionally
// out of scope for v7.0 — the byBareName index can't pick a global
// unique across providers, and the disambiguation pick-list UX is
// rooted in "what's actually claimed here". Operators wanting cross-
// machine routing should use the qualified form (or `bare@machine`,
// which currently still requires the bare name to resolve locally; an
// alpha.15+ enhancement could lift that).
//
//   - qualified, in registry      → ok
//   - qualified, not in registry  → unknown
//   - bare, 1 claimed match       → ok
//   - bare, 2+ claimed matches    → ambiguous (pick-list)
//   - bare, 0 claimed matches     → unknown
//
// Same rule applies in every place a model is referenced: --to flag,
// frontmatter `to:` field, workflow PLAN.json targets, activation
// matching. resolve.ts is the single source of truth so the semantics
// are uniform.

import type { ModelEntry, ModelsRegistry } from './models.ts';

export type ResolutionResult =
  | { kind: 'ok'; model: ModelEntry }
  | { kind: 'unknown'; ref: string }
  | { kind: 'ambiguous'; ref: string; candidates: string[] };

export function resolveModelRef(ref: string, registry: ModelsRegistry): ResolutionResult {
  const trimmed = ref.trim();
  if (trimmed === '') return { kind: 'unknown', ref };
  if (trimmed.includes('/')) {
    // F-CROSS (alpha.15): look in the full registry, not just claimed.
    // Sender's API resolves cross-machine references too; the per-tick
    // claim check on each peer dispatcher is the correct enforcement
    // point for "who actually handles this".
    const m = registry.all.get(trimmed);
    return m ? { kind: 'ok', model: m } : { kind: 'unknown', ref: trimmed };
  }
  // Bare name: scan byBareName, filter to claimed entries.
  const matches = (registry.byBareName.get(trimmed) ?? [])
    .filter((m) => registry.claimed.has(m.qualified));
  if (matches.length === 1) return { kind: 'ok', model: matches[0]! };
  if (matches.length === 0) return { kind: 'unknown', ref: trimmed };
  return {
    kind: 'ambiguous',
    ref: trimmed,
    candidates: matches.map((m) => m.qualified).sort(),
  };
}

export function formatResolutionError(r: Exclude<ResolutionResult, { kind: 'ok' }>): string {
  if (r.kind === 'unknown') {
    return `unknown model '${r.ref}'`;
  }
  return (
    `'${r.ref}' is ambiguous (${r.candidates.length} matches). Specify one:\n  ` +
    r.candidates.join('\n  ')
  );
}

// Resolve a `to:` field value that may carry an `@host` suffix. The host
// suffix is split off, the actor part resolved, then re-attached. This
// lets workflow scoping (`model@cachy`) work uniformly with bare or
// qualified model references.
export interface ToResolution {
  kind: 'ok' | 'unknown' | 'ambiguous' | 'reserved';
  qualified?: string;   // for 'ok' or 'reserved' — full `<provider>/<model>[@host]`
  error?: string;       // for 'unknown' | 'ambiguous'
}

// Reserved recipient names that are not models — workflow markers, etc.
// These pass through unchanged.
const RESERVED_RECIPIENTS = new Set(['workflow', 'all']);

export function resolveToField(toRaw: string, registry: ModelsRegistry): ToResolution {
  const at = toRaw.indexOf('@');
  const actorPart = at === -1 ? toRaw : toRaw.slice(0, at);
  const hostSuffix = at === -1 ? '' : toRaw.slice(at);
  if (RESERVED_RECIPIENTS.has(actorPart)) {
    return { kind: 'reserved', qualified: toRaw };
  }
  const r = resolveModelRef(actorPart, registry);
  if (r.kind === 'ok') return { kind: 'ok', qualified: r.model.qualified + hostSuffix };
  return { kind: r.kind, error: formatResolutionError(r) };
}
