// Actor loader. Reads `data/actors/<alias>.md` from the transport, parses
// frontmatter + body, resolves the `includes:` list (local files only in
// v1.0; `skills.sh/<slug>` resolution lands in v1.1).
//
// Actor file shape (see ORCHESTRATION-DESIGN.md "Actors live in the transport"):
//
//   ---
//   alias: bot-a
//   name: Bot A
//   description: Code reviewer specialised in TypeScript and bun
//   includes:
//     - ./skills/local/typescript-review.md
//   ---
//
//   # Persona
//   ...
//
// "actor = skills + personality" — personality lives in the body; skills
// are concatenated from the includes refs.

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { parseFrontmatter } from './frontmatter.ts';
import { logError } from './state.ts';

export interface ActorFrontmatter {
  alias: string;
  name?: string;
  description?: string;
  includes?: string[];
}

export interface LoadedActor {
  alias: string;
  name: string;
  description: string;
  /** Persona — the actor file's markdown body, unchanged. */
  persona: string;
  /** Skills — concatenation of each resolved `includes:` ref's body. */
  skills: string;
  /** Composed system prompt = persona + "\n\n" + skills (when skills non-empty). */
  systemPrompt: string;
  /** Refs that couldn't be resolved (logged + skipped). For diagnostics. */
  unresolvedIncludes: string[];
}

export function actorPath(transportRoot: string, alias: string): string {
  return join(transportRoot, 'data', 'actors', `${alias}.md`);
}

export function listActors(transportRoot: string): string[] {
  const dir = join(transportRoot, 'data', 'actors');
  if (!existsSync(dir)) return [];
  const aliases: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    if (name === '.gitkeep') continue;
    const stem = name.slice(0, -3);
    if (stem.length === 0) continue;
    aliases.push(stem);
  }
  return aliases.sort();
}

/**
 * Load and resolve an actor. Throws if the actor file is missing. Returns
 * a LoadedActor with the composed systemPrompt ready to hand to a session.
 *
 * v1.0 supports local-file `includes:` only. v1.1 will add
 * `skills.sh/<slug>` resolution at the same `includes:` site, no callers
 * need to change.
 */
export function loadActor(transportRoot: string, alias: string): LoadedActor {
  const path = actorPath(transportRoot, alias);
  if (!existsSync(path)) {
    throw new Error(`actor file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseFrontmatter<ActorFrontmatter>(raw);
  const fmAlias = parsed.data.alias;
  if (typeof fmAlias === 'string' && fmAlias !== alias) {
    logError(transportRoot, `actor ${alias}: frontmatter alias='${fmAlias}' does not match filename — using filename`);
  }
  const includes = Array.isArray(parsed.data.includes) ? parsed.data.includes : [];
  const persona = parsed.data.description ?? '';
  const personaBody = parsed.body;
  const { skills, unresolved } = resolveIncludes(transportRoot, path, includes);
  const systemPrompt = skills.length > 0
    ? `${personaBody.trimEnd()}\n\n${skills.trimEnd()}\n`
    : personaBody;
  return {
    alias,
    name: parsed.data.name ?? alias,
    description: persona,
    persona: personaBody,
    skills,
    systemPrompt,
    unresolvedIncludes: unresolved,
  };
}

interface ResolveResult {
  skills: string;
  unresolved: string[];
}

/**
 * Resolve each include ref to its content, concatenating with a blank
 * line between. Refs that look like `skills.sh/<slug>` are not yet
 * supported (v1.1 work) — recorded in `unresolved`. Refs starting with
 * './' or '../' are resolved relative to the actor file's directory.
 * Absolute paths are accepted but treated as transport-relative if they
 * start with `/data/`.
 */
function resolveIncludes(
  transportRoot: string,
  actorFilePath: string,
  refs: string[],
): ResolveResult {
  const actorDir = dirname(actorFilePath);
  const parts: string[] = [];
  const unresolved: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith('skills.sh/')) {
      logError(transportRoot, `actor include ${ref}: skills.sh resolver not implemented in v1.0 — skipping`);
      unresolved.push(ref);
      continue;
    }
    const candidate = ref.startsWith('/data/')
      ? join(transportRoot, ref)
      : resolve(actorDir, ref);
    if (!existsSync(candidate)) {
      logError(transportRoot, `actor include ${ref}: file not found at ${candidate}`);
      unresolved.push(ref);
      continue;
    }
    try {
      if (!statSync(candidate).isFile()) {
        logError(transportRoot, `actor include ${ref}: not a regular file`);
        unresolved.push(ref);
        continue;
      }
      parts.push(readFileSync(candidate, 'utf-8'));
    } catch (err) {
      logError(transportRoot, `actor include ${ref}: ${(err as Error).message}`);
      unresolved.push(ref);
    }
  }
  return { skills: parts.join('\n\n'), unresolved };
}
