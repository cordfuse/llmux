// Login page — username + passphrase form.
//
// Trust context: SERVICE. Served when an unauthenticated request hits
// any non-public path AND users.json is NOT empty (if it's empty, setup
// gate wins and serves /setup instead).
//
// VISUAL CONSISTENCY REQUIREMENT — read packages/llmux/src/v2/web/README.md
// before implementing. Match pickerPage() exactly.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Operator workflows (v2)"
//   V2-SYSTEM-AUTH-DESIGN.md § "Web UI (v2)" — /login row
//   packages/llmux/src/daemon/web/server.ts sendGate() — current auth page (v1.x token gate)
//   packages/llmux/src/daemon/web/server.ts pickerPage() — visual source of truth

/**
 * Render the /login page HTML.
 *
 * Form fields:
 *   - Username
 *   - Passphrase
 *
 * POSTs to /api/login. On success: server sets session cookie + redirects.
 * On failure: in-page error message (use .toast pattern from orchPage()).
 *
 * If a `return-to` query param is present, the cookie redirects there
 * after success; otherwise to /.
 */
export function loginPage(_returnToUrl?: string): string {
  // TODO(phase 7): implement
  //   - Same head/style block as pickerPage() VERBATIM
  //   - Hide nav drawer (operator isn't auth'd yet)
  //   - Show centered .about-card with form (matches token-create-form pattern)
  //   - Form: username + passphrase + submit
  //   - On submit: POST /api/login with credentials
  //   - On 401: toast 'invalid credentials' (red — color #f85149)
  //   - On success: read Location header from response, navigate
  //   - Include a small footer hint: "Forgot passphrase? Run `llmux user reset-passphrase <username>` from the daemon host."
  throw new Error('TODO(phase 7): see packages/llmux/src/v2/web/README.md for visual requirements');
}
