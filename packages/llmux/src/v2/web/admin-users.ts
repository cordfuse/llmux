// Admin-only user CRUD page.
//
// Trust context: SERVICE. Only admin tokens may load this page.
// Non-admin users get 403; the drawer item is hidden in their nav.
//
// Actions:
//   - List all users (table: username, display name, admin flag, createdAt, last seen)
//   - Create user (prompts new user's username + display name + initial passphrase)
//   - Delete user (with confirmation; cascades to token revocation + orch claim reaping)
//   - Reset another user's passphrase (admin override; no need to know old passphrase)
//
// VISUAL CONSISTENCY REQUIREMENT — read packages/llmux/src/v2/web/README.md
// before implementing. Match pickerPage() exactly.
//
// References:
//   V2-SYSTEM-AUTH-DESIGN.md § "Web UI (v2)" — /admin/users row
//   V2-SYSTEM-AUTH-DESIGN.md § "CLI surface (v2)" — llmux user create/delete/reset-passphrase parallel
//   packages/llmux/src/daemon/web/server.ts pickerPage() — visual source of truth (specifically
//     the #page-tokens table styling — the user list looks just like it)

/**
 * Render the /admin/users page HTML.
 *
 * Layout:
 *   - .tokens-toolbar at top with '+ new user' button (matches pattern)
 *   - Inline create-user form (opens in place, same as #token-create-form)
 *   - Table of users below: username | display name | admin | createdAt | actions
 *   - Actions column: edit name | reset passphrase | delete (danger)
 */
export function adminUsersPage(): string {
  // TODO(phase 7): implement
  //   - Same head/style/header/nav-drawer as pickerPage()
  //     (drawer item: '🛡 Users' added when current user is admin; 'active' here)
  //   - Reuse .tokens-toolbar / #token-create-form / #page-tokens table styling
  //     verbatim — these are the design's CRUD-table affordances
  //   - Create-user form: username, name, initial passphrase (operator gives it
  //     to the new user out-of-band), admin checkbox
  //   - Delete: red danger button + confirm modal (reuse #token-secret-modal pattern)
  //   - Reset passphrase: opens inline form for new passphrase + confirm; on submit,
  //     toast the new passphrase ONCE for the admin to relay to the user
  throw new Error('TODO(phase 7): see packages/llmux/src/v2/web/README.md for visual requirements');
}
