// Side-effecting bootstrap: must be the first import in any entry point.
//
// Loads `$XDG_CONFIG_HOME/llmux/.env` (fallback `~/.config/llmux/.env`)
// into process.env BEFORE any other module reads env vars. Process env
// always wins — `.env` only fills gaps, never overrides an exported
// shell var.

import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const envPath = join(xdgConfig, 'llmux', '.env');

if (existsSync(envPath)) {
  const result = config({ path: envPath, override: false, quiet: true });
  if (result.error) {
    process.stderr.write(`llmux: failed to load ${envPath}: ${result.error.message}\n`);
    process.exit(1);
  }
}
