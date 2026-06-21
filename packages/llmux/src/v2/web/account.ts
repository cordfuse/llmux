// Account page — change name + passphrase for the logged-in user.
//
// Trust context: SERVICE. Authenticated users only. Action handlers
// require the user to re-prompt their current passphrase before
// changing anything (defense-in-depth per V2-SYSTEM-AUTH-DESIGN.md
// § "Sensitive actions — when re-prompting is OK").
//
// VISUAL CONSISTENCY REQUIREMENT — read packages/llmux/src/v2/web/README.md
// before implementing. Match pickerPage() exactly. This page lives
// under the same nav drawer as sessions/orch/tokens/etc., so the drawer
// is present and the user can navigate away.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Web UI (v2)" — /account row
//   V2-SYSTEM-AUTH-DESIGN.md § "CLI surface (v2)" — llmux auth passwd parallel
//   packages/llmux/src/daemon/web/server.ts pickerPage() — visual source of truth

/**
 * Render the /account page HTML.
 *
 * Sections (each in its own .about-card):
 *   1. Profile — display name + username (username read-only; rename
 *      means delete + recreate, not exposed here)
 *   2. Change passphrase — old + new + confirm. Re-prompts old passphrase
 *      on every change (defense-in-depth).
 *   3. Active tokens — list of tokens owned by this user, with revoke
 *      buttons. Reuses the token-actions pattern from pickerPage's
 *      tokens page.
 *
 * POSTs to /api/account/profile, /api/account/passphrase,
 * /api/tokens/:id (DELETE).
 */
export function accountPage(_currentUsername: string): string {
  // TODO(phase 7): implement
  //   - Same head/style/header/nav-drawer as pickerPage() (drawer 'active' on Settings)
  //   - Three .about-card panels stacked
  //   - Profile card: kv list of {Display name, Username (read-only)}
  //     with an inline 'edit' on the display name that swaps to an input + save
  //   - Passphrase card: form with old/new/confirm; on submit POSTs to
  //     /api/account/passphrase; toast success/failure
  //   - Tokens card: reuse the token table styling from #page-tokens;
  //     show only the current user's tokens; revoke action with confirmation
  throw new Error('TODO(phase 7): see packages/llmux/src/v2/web/README.md for visual requirements');
}
