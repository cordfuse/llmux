#!/usr/bin/env node
// Workaround for node-pty's published tarball shipping the macOS
// `spawn-helper` binaries at mode 0644 instead of 0755. macOS uses
// posix_spawnp on this helper to open a pty, and posix_spawnp on a
// non-executable file fails — every WS terminal attach dies with
// "posix_spawnp failed" surfaced to the operator as the misleading
// "session ended" overlay.
//
// Linux is unaffected (forkpty, no helper exec), so this is a quiet
// no-op there.
//
// Runs as a `postinstall` hook from `package.json` after npm installs
// node-pty. Intentionally defensive: any failure is swallowed —
// install must NEVER fail because of a permissions touch-up.
//
// Reference: mac-side reproduction logged in the v0.21.3 testing
// feedback; cross-platform gap because cachy (Linux) never sees it.

import { createRequire } from 'node:module';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

try {
  const ptyPkg = require.resolve('node-pty/package.json');
  const ptyRoot = dirname(ptyPkg);
  const targets = [
    join(ptyRoot, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    join(ptyRoot, 'prebuilds', 'darwin-x64', 'spawn-helper'),
  ];
  for (const t of targets) {
    if (!existsSync(t)) continue;
    try {
      chmodSync(t, 0o755);
    } catch {
      // read-only filesystem, permissions, lockfiles — none are fatal.
    }
  }
} catch {
  // node-pty isn't installed (unusual — it's a runtime dep) or its
  // package.json moved. Silent: the postinstall hook must not break
  // the install. macOS terminal attach will still fail if this branch
  // hits, but the operator can chmod by hand per the v0.21.3 thread.
}
