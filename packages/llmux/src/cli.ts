/**
 * `string-array` is for flags that can repeat — each occurrence appends
 * to an array on `flags[name]`. Existing single-shot kinds (`boolean`,
 * `string`) work exactly the same as before.
 */
export type FlagKind = 'boolean' | 'string' | 'string-array';

export interface FlagSpec {
  kind: FlagKind;
  alias?: string;
  description: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const aliasMap = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias) aliasMap.set(spec.alias, name);
  }

  const resolveName = (raw: string): string => aliasMap.get(raw) ?? raw;

  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  function setStringValue(name: string, value: string, spec: FlagSpec): void {
    if (spec.kind === 'string-array') {
      const existing = flags[name];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        flags[name] = [value];
      }
    } else {
      flags[name] = value;
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;

    if (token === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      const rawName = eq >= 0 ? body.slice(0, eq) : body;
      const name = resolveName(rawName);
      const spec = specs[name];
      if (!spec) {
        throw new Error(`unknown flag --${rawName}`);
      }
      if (spec.kind === 'boolean') {
        flags[name] = eq >= 0 ? body.slice(eq + 1) !== 'false' : true;
      } else {
        if (eq >= 0) {
          setStringValue(name, body.slice(eq + 1), spec);
        } else {
          // Space form: `--flag value`. Consume next argv as value regardless
          // of whether it starts with `-` — `--flags "--model opus"` is a
          // documented use case for the per-spawn flag pass-through. Old
          // behavior (reject `-`-prefixed next as "requires a value") broke
          // the documented form; only `--flag=value` worked.
          const next = argv[i + 1];
          if (next === undefined) {
            throw new Error(`--${rawName} requires a value`);
          }
          setStringValue(name, next, spec);
          i++;
        }
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const name = resolveName(body);
      const spec = specs[name];
      if (!spec) {
        throw new Error(`unknown flag -${body}`);
      }
      if (spec.kind === 'boolean') {
        flags[name] = true;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new Error(`-${body} requires a value`);
        }
        setStringValue(name, next, spec);
        i++;
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

