// models.ts — model registry parsing and PATH-based self-selection.
//
// Reads data/crosstalk.yaml from the transport root.
//
//   providers:
//     <provider-name>:
//       env_file: <relpath>           # optional — dotenv file under transport
//       env:                          # optional — inline ${VAR} interpolation
//         <KEY>: ${HOST_VAR}
//       models:
//         <model-name>: <cli command string>
//
// alpha.8 introduced env_file (per-provider auth files). alpha.10 adds
// the inline env: block — same per-provider scoping, but the provider→
// credential mapping is visible in the yaml. Inline values MUST be
// `${VAR}` references; raw secrets are refused at parse time so the yaml
// stays committable. Spawn-time precedence (last-wins) in invoke.ts:
//   process.env → env_file → env (inline) → dispatch env
//
// ModelEntry is keyed by qualified form `provider/model` throughout the
// engine. resolve.ts handles bare-name auto-disambiguation at the call
// boundary; this module produces the canonical qualified-keyed registry
// plus a bareName → matches index that resolve.ts consumes.

import { existsSync, readFileSync, statSync } from 'fs';
import { join, delimiter, isAbsolute, resolve as pathResolve } from 'path';
import { parse as parseYaml } from 'yaml';

export interface ModelEntry {
  qualified: string;       // "google-personal/gemini-direct"
  provider: string;        // "google-personal"
  name: string;            // "gemini-direct"
  envFile: string | null;  // absolute path to provider's .env, or null
  inlineEnv: Record<string, string> | null;  // { KEY: "${HOST_VAR}" }, or null
  command: string;         // raw command-template string
  cli: string;             // first token — binary the dispatcher checks PATH for
  args: string[];          // remaining tokens (the body is appended at invocation time)
}

export interface ModelsRegistry {
  all:        Map<string, ModelEntry>;       // keyed by qualified
  byBareName: Map<string, ModelEntry[]>;     // bare model name → all matches (for resolver)
  claimed:    Map<string, ModelEntry>;       // qualified-keyed subset this dispatcher claims
}

export function crosstalkYamlPath(transportRoot: string): string {
  return join(transportRoot, 'data', 'crosstalk.yaml');
}

interface RawProvider {
  env_file?: unknown;
  env?: unknown;
  models?: unknown;
}

function resolveEnvFilePath(transportRoot: string, envFile: string): string {
  // Tolerate any path the operator writes (per V8-AUTH-DESIGN.md decision).
  // Absolute path: trust as-is. Relative: resolve against transport root.
  if (isAbsolute(envFile)) return envFile;
  return pathResolve(transportRoot, envFile);
}

// Inline env values must be `${VAR}` references — no raw secrets in the
// yaml. The regex matches a single VAR-form interpolation occupying the
// whole value. Mixed strings ("Bearer ${TOKEN}") are intentionally
// rejected for v7 simplicity; if the use case shows up, alpha.11+ can
// relax to full template-style interpolation.
const INLINE_ENV_REF_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function parseInlineEnv(
  providerName: string,
  raw: unknown,
): Record<string, string> | null {
  if (raw == null) return null;
  // F-LOG (alpha.14): inner throw messages no longer carry the
  // `crosstalk:` prefix — the outer skip-provider log wrapper at the
  // readModels() catch site is the single prefix-bearer. Mac caught
  // the doubled prefix during the alpha.13 beta-readiness sweep.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `provider '${providerName}' 'env:' must be a mapping ` +
      `(got ${Array.isArray(raw) ? 'array' : typeof raw})`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new Error(
        `provider '${providerName}' env.${key} must be a string ` +
        `(got ${typeof value})`,
      );
    }
    if (!INLINE_ENV_REF_RE.test(value)) {
      throw new Error(
        `provider '${providerName}' env.${key} = '${value}' is not a ` +
        `\${VAR} reference. Inline env values must be of the form \${HOST_VAR} ` +
        `so the yaml stays committable. Use env_file: <path> if you need raw values.`,
      );
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function readModels(transportRoot: string): {
  all: Map<string, ModelEntry>;
  byBareName: Map<string, ModelEntry[]>;
} {
  const path = crosstalkYamlPath(transportRoot);
  if (!existsSync(path)) {
    throw new Error(
      `crosstalk: data/crosstalk.yaml not found at ${path}. ` +
      `Run from a transport root, or regenerate via 'crosstalk transport init'.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error(`crosstalk: data/crosstalk.yaml parsed to non-object (got ${typeof parsed})`);
  }
  const root = parsed as Record<string, unknown>;
  const providers = root['providers'];
  if (providers === undefined) {
    throw new Error(
      `crosstalk: data/crosstalk.yaml missing top-level 'providers:' key. ` +
      `Schema is providers.<name>.{env_file?, models}. ` +
      `See transport/auth/README.md for the expected shape.`,
    );
  }

  const all = new Map<string, ModelEntry>();
  const byBareName = new Map<string, ModelEntry[]>();

  // Empty providers: (operator hasn't uncommented any yet). Valid — engine
  // boots with no claimed models; operators see this in `crosstalk status`.
  if (providers === null) return { all, byBareName };

  if (typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error(
      `crosstalk: data/crosstalk.yaml 'providers:' must be a mapping (got ${typeof providers})`,
    );
  }

  // N3 (alpha.11): per-provider try/catch so one typo doesn't tank the
  // whole registry. Bad providers are warned to stderr and skipped; the
  // rest of the registry loads. Operators still see the diagnostic via
  // `crosstalk logs` (stderr → docker logs) and the dispatcher continues
  // serving the agents that ARE valid. Before alpha.11, one
  // raw-value-instead-of-${VAR} mistake on a single provider produced
  // total_models:0 — every agent went dark.
  const errors: string[] = [];
  for (const [providerName, providerRaw] of Object.entries(providers as Record<string, unknown>)) {
    try {
      parseProvider(transportRoot, providerName, providerRaw, all, byBareName);
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(msg);
      console.error(`crosstalk: skipping provider '${providerName}': ${msg}`);
    }
  }

  return { all, byBareName };
}

function parseProvider(
  transportRoot: string,
  providerName: string,
  providerRaw: unknown,
  all: Map<string, ModelEntry>,
  byBareName: Map<string, ModelEntry[]>,
): void {
  if (providerRaw == null || typeof providerRaw !== 'object') {
    throw new Error(
      `data/crosstalk.yaml provider '${providerName}' is not a mapping`,
    );
  }
  const p = providerRaw as RawProvider;
  const envFile = (typeof p.env_file === 'string' && p.env_file.trim())
    ? resolveEnvFilePath(transportRoot, p.env_file.trim())
    : null;
  const inlineEnv = parseInlineEnv(providerName, p.env);
  const models = p.models;
  if (models == null || typeof models !== 'object') {
    throw new Error(`provider '${providerName}' has no 'models:' map`);
  }
  for (const [modelName, cmdRaw] of Object.entries(models as Record<string, unknown>)) {
    if (typeof cmdRaw !== 'string') {
      throw new Error(
        `provider '${providerName}' model '${modelName}' has non-string value ` +
        `(expected a command-template string, got ${typeof cmdRaw})`,
      );
    }
    const command = cmdRaw.trim();
    const tokens = command.split(/\s+/);
    if (tokens.length === 0 || tokens[0] === '') {
      throw new Error(
        `provider '${providerName}' model '${modelName}' has empty command`,
      );
    }
    const qualified = `${providerName}/${modelName}`;
    if (all.has(qualified)) {
      throw new Error(
        `duplicate model '${qualified}' in data/crosstalk.yaml`,
      );
    }
    const entry: ModelEntry = {
      qualified,
      provider: providerName,
      name: modelName,
      envFile,
      inlineEnv,
      command,
      cli: tokens[0]!,
      args: tokens.slice(1),
    };
    all.set(qualified, entry);
    const existing = byBareName.get(modelName) ?? [];
    existing.push(entry);
    byBareName.set(modelName, existing);
  }
}

// Resolve a model's `cli` token to an absolute, executable file path — or
// null if it can't be resolved. Absolute paths are stat'd directly so
// operators can point `cli:` at a wrapper anywhere under the persistent
// /crosstalk-root mount; relative tokens are looked up across $PATH
// (which already includes /crosstalk-root/.local/bin, the documented
// drop-in dir for operator-installed CLIs and wrappers).
export function resolveCli(binary: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(binary)) {
    try {
      if (existsSync(binary) && statSync(binary).isFile()) return binary;
    } catch {
      // unreadable, fall through
    }
    return null;
  }
  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // unreadable entry, skip
    }
  }
  return null;
}

export function isOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCli(binary, env) !== null;
}

// Walk every parsed model and decide which the local dispatcher can serve.
// Unclaimed models are logged to stderr with the specific reason —
// alpha.11 fixed the silent-drop for bad-provider parse errors; alpha.12
// extends the same diagnostic to the claim step so an operator with a
// wrapper at the wrong path (or a typo in the binary name) gets a clear
// line in `crosstalk logs` instead of a silently-missing model.
export function claimModels(
  all: Map<string, ModelEntry>,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, ModelEntry> {
  const claimed = new Map<string, ModelEntry>();
  for (const [qualified, entry] of all) {
    if (isOnPath(entry.cli, env)) {
      claimed.set(qualified, entry);
    } else {
      const reason = isAbsolute(entry.cli)
        ? `absolute path '${entry.cli}' is not an existing file`
        : `binary '${entry.cli}' not found on PATH (${env.PATH ?? ''})`;
      console.error(`crosstalk: skipping model '${qualified}': ${reason}`);
    }
  }
  return claimed;
}

export function loadRegistry(transportRoot: string): ModelsRegistry {
  const { all, byBareName } = readModels(transportRoot);
  const claimed = claimModels(all);
  return { all, byBareName, claimed };
}
