// Cherry-picked from cordfuse/crosstalk@v7.0.0-alpha.16 (engine/src/frontmatter.ts).
// Unmodified — preserves wire-compatibility with crosstalk transport format.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ParsedDocument<T = Record<string, unknown>> {
  data: T;
  body: string;
}

export function parseFrontmatter<T = Record<string, unknown>>(raw: string): ParsedDocument<T> {
  if (!raw.startsWith('---')) return { data: {} as T, body: raw };
  const lines = raw.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { end = i; break; }
  }
  if (end === -1) return { data: {} as T, body: raw };
  const yamlBlock = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  const data = (parseYaml(yamlBlock) as T) ?? ({} as T);
  return { data, body };
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringifyYaml(data).trimEnd();
  const trailing = body.endsWith('\n') ? '' : '\n';
  return `---\n${yaml}\n---\n\n${body}${trailing}`;
}
