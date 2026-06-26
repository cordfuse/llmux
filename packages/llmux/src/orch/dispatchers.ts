// dispatchers.ts — the shared dispatcher registry.
//
// Each running dispatcher publishes its identity + claimed models to
// `data/dispatchers/<alias>.yaml` so workflow.ts can scope fanout
// sub-primitives across the actually-running dispatcher set instead of
// addressing every fanout to bare `<model>` and watching every claimant
// race for it.
//
// Lifecycle:
//   - dispatcher startup → writeRegistryEntry (committed alongside other
//     state changes by the next tick's gitCommitAndPush)
//   - dispatcher SIGTERM/SIGINT → removeRegistryEntry (committed same way)
//   - hard crash → entry stays; operator runs cleanup, or restarts
//
// Liveness is best-effort. v7.0.0-alpha.1 does NOT track per-tick
// heartbeats in the registry — the timestamp would force a commit every
// tick on every machine, which is far more push traffic than the system
// otherwise generates. Heartbeats live in the machine-local state dir
// (state.ts) for "is THIS dispatcher alive" checks; the registry answers
// "which dispatchers exist on the bus." A stale registry entry from a
// crashed dispatcher is an operator-cleanup concern, not a runtime concern.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface RegistryEntry {
  alias: string;
  claims: string[];        // model names this dispatcher has on PATH
  version: string;
}

export function registryDir(transportRoot: string): string {
  return join(transportRoot, 'data', 'dispatchers');
}

export function registryFile(transportRoot: string, alias: string): string {
  return join(registryDir(transportRoot), `${alias}.yaml`);
}

export function writeRegistryEntry(
  transportRoot: string,
  alias: string,
  claims: string[],
  version: string,
): void {
  mkdirSync(registryDir(transportRoot), { recursive: true });
  const entry: RegistryEntry = { alias, claims, version };
  writeFileSync(registryFile(transportRoot, alias), stringifyYaml(entry));
}

export function removeRegistryEntry(transportRoot: string, alias: string): void {
  try {
    unlinkSync(registryFile(transportRoot, alias));
  } catch { /* already gone */ }
}

export function readAllRegistry(transportRoot: string): RegistryEntry[] {
  const dir = registryDir(transportRoot);
  if (!existsSync(dir)) return [];
  const out: RegistryEntry[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const parsed = parseYaml(raw) as Partial<RegistryEntry> | null;
      if (
        !parsed ||
        typeof parsed.alias !== 'string' ||
        !Array.isArray(parsed.claims) ||
        typeof parsed.version !== 'string'
      ) continue;
      out.push({
        alias: parsed.alias,
        claims: parsed.claims.map(String),
        version: parsed.version,
      });
    } catch { /* skip malformed */ }
  }
  return out;
}

// Aliases of dispatchers currently claiming the given model, sorted for
// deterministic ordering — round-robin assignment becomes reproducible,
// which makes the test path predictable.
export function dispatchersForModel(transportRoot: string, modelName: string): string[] {
  return readAllRegistry(transportRoot)
    .filter((e) => e.claims.includes(modelName))
    .map((e) => e.alias)
    .sort();
}
