#!/usr/bin/env node
// v2 dev-server — boots the v2 daemon code in USER MODE for development.
//
// Run with:
//   LLMUX_USER_MODE=1 npx tsx packages/llmux/src/v2/bin/dev-server.ts
// Or:
//   npx tsx packages/llmux/src/v2/bin/dev-server.ts  (script sets the env var)
//
// What this does:
//   1. Loads system config — flips to userMode defaults so all paths live
//      under ~/.local/share/llmux/v2/ + ~/.config/llmux/v2/
//   2. Runs readiness checks (in userMode, only checks the worker spawner
//      helper + TLS files if configured — skips all system-only checks)
//   3. Calls dropToService — a no-op in userMode (or non-root)
//   4. Creates the user-mode directories if missing (first run)
//   5. Reports the bootable state — Phases 3+ will hook the actual HTTP
//      server, user store, setup wizard here
//
// IMPORTANT — user mode is the ONLY context in which v2 code touches a
// user's $HOME, and it does so because the daemon IS the operator in
// user mode (not a separate service user). System mode (the v2 default)
// NEVER reads or writes any /home/* path.

import { existsSync, mkdirSync } from 'node:fs';
import { loadSystemConfig, userModeDefaults, type SystemConfig } from '../system/config.ts';
import { dropToService, checkSystemModeReadiness } from '../system/privilege.ts';

function banner(line: string): void {
  console.log('\n' + '─'.repeat(65));
  console.log('  ' + line);
  console.log('─'.repeat(65));
}

async function main(): Promise<void> {
  banner('llmuxd v2 — dev-server (user mode, no sudo)');

  // Force user mode via env var. Single-source-of-truth entrypoint for
  // "boot v2 without sudo."
  process.env['LLMUX_USER_MODE'] = '1';
  const config: SystemConfig = process.env['LLMUX_V2_CONFIG']
    ? loadSystemConfig(process.env['LLMUX_V2_CONFIG'])
    : userModeDefaults();

  console.log('  config:');
  console.log('    userMode      :', config.userMode);
  console.log('    serviceUser   :', config.serviceUser);
  console.log('    listenHost:port:', `${config.listenHost}:${config.listenPort}`);
  console.log('    dataDir       :', config.dataDir);
  console.log('    transportDir  :', config.transportDir);
  console.log('    workerSpawner :', config.workerSpawner);

  banner('readiness check');
  const problems = checkSystemModeReadiness(config);
  if (problems.length === 0) {
    console.log('  ✓ ready');
  } else {
    console.log('  ⚠ ' + problems.length + ' problem(s):');
    for (const p of problems) console.log('    • ' + p);
    console.log('  (continuing anyway — user mode is forgiving)');
  }

  banner('first-run directory creation');
  for (const dir of [config.dataDir, config.transportDir]) {
    if (existsSync(dir)) {
      console.log('  ✓ ' + dir);
    } else {
      mkdirSync(dir, { recursive: true });
      console.log('  + created ' + dir);
    }
  }

  banner('privilege drop');
  const drop = dropToService(config);
  console.log('  ok           :', drop.ok);
  console.log('  ranAsRoot    :', drop.ranAsRoot);
  console.log('  effectiveUser:', drop.effectiveUser);
  if (drop.warning) console.log('  warning      :', drop.warning);
  if (drop.error) console.log('  error        :', drop.error);

  banner('boot path verified');
  console.log('  v2 daemon boot path works end-to-end without sudo.');
  console.log('  Next phases (3, 4, 6+) will plug the user store, token store, and HTTP server in here.');
  console.log('');
  console.log('  To verify what landed on disk:');
  console.log('    ls -la ' + config.dataDir);
  console.log('    ls -la ' + config.transportDir);
  console.log('');
}

main().catch((err) => {
  console.error('dev-server failed:', err);
  process.exit(1);
});
