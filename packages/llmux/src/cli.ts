export type FlagKind = 'boolean' | 'string';

export interface FlagSpec {
  kind: FlagKind;
  alias?: string;
  description: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: readonly string[], specs: FlagSpecs): ParsedArgs {
  const aliasMap = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias) aliasMap.set(spec.alias, name);
  }

  const resolveName = (raw: string): string => aliasMap.get(raw) ?? raw;

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

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
          flags[name] = body.slice(eq + 1);
        } else {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('-')) {
            throw new Error(`--${rawName} requires a value`);
          }
          flags[name] = next;
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
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`-${body} requires a value`);
        }
        flags[name] = next;
        i++;
      }
      continue;
    }

    positional.push(token);
  }

  return { positional, flags };
}

export function renderFlagHelp(specs: FlagSpecs): string {
  const lines: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    const lead = spec.alias ? `-${spec.alias}, --${name}` : `    --${name}`;
    const value = spec.kind === 'string' ? ' <value>' : '';
    lines.push(`  ${(lead + value).padEnd(28)}${spec.description}`);
  }
  return lines.join('\n');
}

export function notImplemented(commandPath: string): never {
  console.error(`llmuxd ${commandPath}: not yet implemented (scaffold)`);
  process.exit(70);
}
