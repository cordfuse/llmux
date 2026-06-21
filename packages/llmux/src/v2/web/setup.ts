// First-run setup wizard page.
//
// Trust context: SERVICE. Served only when userStore.isEmpty() AND the
// presented setup token is valid (see auth/setup.ts setupGate()).
//
// VISUAL CONSISTENCY REQUIREMENT — read packages/llmux/src/v2/web/README.md
// before implementing. This page MUST match pickerPage() exactly in
// palette, fonts, and nav drawer.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Setup wizard — what invokes it (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "The wizard"
//   packages/llmux/src/daemon/web/server.ts pickerPage() — visual source of truth

/**
 * Render the /setup wizard HTML.
 *
 * Form fields:
 *   - Name (display name)
 *   - Username (must match an OS user on the host; validated server-side
 *     in handleSetupSubmit; client-side helper text explains the constraint)
 *   - Passphrase (+ confirm)
 *
 * POSTs to /api/setup with the setup-token query param preserved.
 *
 * Pre-conditions enforced by setupGate before this page is served:
 *   - userStore.isEmpty() === true
 *   - presented setup token matches the active one
 */
export function setupPage(_setupToken: string): string {
  // TODO(phase 6): implement
  //   - Copy the head/style block from pickerPage() VERBATIM (same palette,
  //     fonts, nav drawer skeleton — though nav items are limited to a
  //     subset since most pages require auth that doesn't exist yet)
  //   - Hide the nav drawer entirely on /setup (no other pages are reachable
  //     until setup completes) — keep the header so the brand is still present
  //   - Form panel uses the .about-card styling (#11141a bg, #262c34 border)
  //   - Submit button: primary (color #7cc4ff border #2d4a66)
  //   - Show inline validation: username regex (^[a-z0-9_-]+$), passphrase
  //     length, passphrase match
  //   - On submit: POST /api/setup?token=<setupToken>; show .toast on error
  //     (use the toast pattern from orchPage())
  //   - On success: redirect to / (cookie set by the API)
  throw new Error('TODO(phase 6): see packages/llmux/src/v2/web/README.md for visual requirements');
}
