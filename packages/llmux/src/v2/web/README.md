# v2 web pages — design consistency requirement

> **Load-bearing rule for v2 implementation:** every page in this
> directory MUST be visually consistent with the existing v1.x web
> screens (`pickerPage()` and `orchPage()` in
> `packages/llmux/src/daemon/web/server.ts`). Same palette, same fonts,
> same hamburger nav drawer with the same item set + behavior. New
> functionality lands as additional pages or panels — never as visual
> deviation.

## Why this matters

llmux's web is the operator's daily surface. A v2 wizard or admin page
that looks different from sessions/orch will signal "this is a separate
tool" — confusing operators and breaking the "any device, no terminal"
thesis. Visual consistency is the difference between "llmux got a setup
wizard" and "llmux now has two products glued together."

## Design tokens (source of truth)

These ALL come from `pickerPage()` — read that function before writing
any v2 page CSS. The shared tokens:

| Token | Value | Use |
|---|---|---|
| Background | `#0b0c10` | Body |
| Card / panel | `#11141a` | Forms, message containers, side panels |
| Border | `#1f2329`, `#262c34`, `#3a414b` | Subtle (lighter), medium, hover |
| Brand (LLMUX) | `#7cc4ff` | Brand mark, active-state borders, primary buttons |
| Host accent | `#a371f7` | Hostname in header |
| OK / human / success | `#7ee787` | Live claim badges, human-species chips, success toasts |
| Warn | `#f0883e` | Warnings, expired tokens |
| Danger | `#f85149` | Errors, revoke buttons, danger actions |
| Muted text | `#7a7f87`, `#9aa0a6` | Hints, secondary labels |
| Body text | `#c9d1d9`, `#e6e8eb` | Default, brighter |
| Inputs (bg) | `#0b0c10` | Form inputs share body bg, contrast via border |
| Font family | `ui-monospace, monospace` | Everywhere — no sans-serif |
| Base font size | `14px` | Body |
| Border radius | `6px` (small), `8px` (panels), `14px` (chips) | |

## Required nav drawer items (all v2 pages)

Identical to picker + orch — same six items, same icons, same labels:

```
▦ Sessions
⇄ Orchestration
⚿ Tokens
⌬ Agents
▤ Logs
⚙ Settings
ⓘ About
```

Plus v2-specific items injected when relevant (admin-only):
- `🛡 Users` (admin only) — only shown on the admin-users page or for admin sessions

The drawer's "active" state highlights the current page. For pages in
this directory, the relevant drawer item is `Settings` (account/login)
or a v2-specific item (admin/users).

## Pattern: page generators return HTML strings

Match `pickerPage()` / `orchPage()` shape:

```ts
function setupPage(banner?: string): string {
  const host = hostname();
  return `<!doctype html><html lang="en"><head>
    ... SAME head + style block as pickerPage ...
  </head><body>
    ... nav drawer (always present, identical items + drawer JS) ...
    ... header (brand · host · page-title) ...
    ... page content (the actual setup form) ...
    ... script (drawer toggle + page-specific JS) ...
  </body></html>`;
}
```

No build step, no React, no bundler. Vanilla HTML + JS, same as v1.x.

## Pre-flight checklist for any new v2 web page

Before merging a new page into the v2 web tree:

- [ ] Loaded `pickerPage()` in a browser side-by-side and confirmed
      colors / fonts / spacing match within 1-2px
- [ ] Hamburger drawer present + functional + same 6-7 items
- [ ] Header pattern: `LLMUX · host · <page-title>` exactly
- [ ] Form inputs use the `.about-card` / `#token-create-form` styling
      (background `#11141a`, border `#262c34`, focus border `#2d4a66`)
- [ ] Primary button: `color: #7cc4ff; border-color: #2d4a66`
- [ ] Danger button: `color: #f85149; border-color: #4a2329`
- [ ] Mobile responsive: tested at 360px width (Steve's primary phone form)
- [ ] No emoji icons beyond the existing drawer set (CSS-in-JS sneaks
      them in easily; resist)
- [ ] `Cache-Control: no-cache` set on the response (`sendHtml()` already
      does this)

## The four v2 pages

Stubs live alongside this README:

- `setup.ts` — first-run wizard (name + username + passphrase). Token-gated.
- `login.ts` — username + passphrase login form.
- `account.ts` — change name, change passphrase.
- `admin-users.ts` — admin-only user CRUD (list / create / delete / reset-passphrase).

Each stub currently throws `TODO(phase N)`. Implementation fills them
in following the pattern above.

## What NOT to do

- Don't add new color palette tokens. Reuse what `pickerPage()` defines.
- Don't add new fonts. Monospace everywhere.
- Don't introduce a frontend framework. Vanilla HTML + JS + inline CSS.
- Don't put auth state in URL fragments. Use cookies (matches v1.x).
- Don't render flash messages with `alert()`. Use the `.toast` pattern
  from `orchPage()`.
- Don't add a footer. Picker + orch don't have one; v2 pages shouldn't either.
- Don't add a logo image. The text "LLMUX" in `#7cc4ff` IS the brand.

## When this file should update

- If `pickerPage()` adds a new design token or pattern → update this README
  + back-port v2 pages once implementation lands
- If a v2 page needs a new pattern that picker doesn't have → add it to
  picker first (so v1.x consistency is preserved), then use here
