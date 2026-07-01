// Shared header/nav-toggle/drawer chrome for llmux's web UIs.
//
// Both the picker (daemon/web/server.ts — a single SPA-style page) and the
// v2 auth pages (v2/web/*.ts via layout.ts) render a <header> + hamburger
// toggle + nav drawer that are supposed to look identical, but were two
// independent hand-copies that had already drifted (mismatched header vs
// hamburger background, a border on the hamburger, an untruncated header
// that wraps to multiple rows on narrow phones). This module is the one
// place that owns that CSS + the header markup so the two can't drift again.

/** header + hamburger toggle. Header gets the SAME background as the
 * toggle (so the toggle reads as part of one bar, not a floating chip) and
 * collapses to a single non-wrapping row: brand + ellipsis-truncated page
 * title, with any trailing status (metaHtml) pinned at the end. */
export function headerCss(): string {
  return `
  header{display:flex;align-items:center;gap:10px;margin-bottom:18px;background:#1c2128;border:1px solid #262c34;border-radius:8px;padding:10px 14px}
  h1{font-size:16px;margin:0;min-width:0;flex:1 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  h1 .brand{color:#7cc4ff;letter-spacing:.08em;font-weight:600}
  h1 .page-title{color:#a371f7;font-weight:500;margin-left:8px}
  #nav-toggle{background:#1c2128;color:#e6e8eb;border:none;border-radius:6px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;font-size:18px;line-height:1;flex:0 0 auto;transition:background 150ms ease}
  #nav-toggle:hover{background:#252b34}
  #nav-toggle:active{transform:scale(.94)}
  `;
}

/** Slide-in nav drawer chrome — identical between the picker and v2 pages
 * (only the item list + optional footer content differ per caller). */
export function drawerCss(): string {
  return `
  #nav-drawer{position:fixed;top:0;left:-300px;width:280px;height:100dvh;background:#0e1116;border-right:1px solid #1f2329;transition:left 220ms ease;z-index:55;padding:18px 0;box-sizing:border-box;display:flex;flex-direction:column}
  #nav-drawer.open{left:0}
  #nav-backdrop{position:fixed;inset:0;background:rgba(11,12,16,.55);z-index:54;opacity:0;visibility:hidden;transition:opacity 180ms ease,visibility 0s 180ms}
  #nav-backdrop.show{opacity:1;visibility:visible;transition:opacity 180ms ease}
  #nav-drawer .nav-header{padding:0 20px 16px;border-bottom:1px solid #1f2329;display:flex;flex-direction:column;gap:4px}
  #nav-drawer .nav-brand{color:#7cc4ff;font-weight:600;letter-spacing:.08em;font-size:15px}
  #nav-drawer .nav-host{color:#a371f7;font-size:12px}
  #nav-drawer nav{flex:1;display:flex;flex-direction:column;padding:8px 0;overflow-y:auto}
  #nav-drawer a{display:flex;align-items:center;gap:10px;padding:12px 20px;color:#c9d1d9;text-decoration:none;font-size:14px;border-left:3px solid transparent;cursor:pointer}
  #nav-drawer a:hover{background:#11141a;text-decoration:none}
  #nav-drawer a.active{border-left-color:#7cc4ff;color:#7cc4ff;background:#11141a}
  #nav-drawer a .nav-icon{font-size:16px;width:20px;text-align:center;color:inherit}
  #nav-drawer .nav-footer{padding:10px 20px 0;border-top:1px solid #1f2329;font-size:11px;color:#7a7f87;display:flex;justify-content:space-between;align-items:center}
  `;
}

export interface RenderHeaderOpts {
  /** Brand text, e.g. "LLMUX". */
  brand: string;
  /** Render the hamburger toggle. Pages with no drawer (setup, login) omit it. */
  withNavToggle: boolean;
  /** Raw inner HTML for the page-title segment, already escaped by the
   *  caller (may include an id, e.g. the picker's SPA-updated `#page-title`
   *  span). Omit for no page title. */
  pageTitleHtml?: string;
  /** Raw inner HTML for a trailing status slot (e.g. the picker's live/
   *  stale/error indicator). Omit for none — plain v2 pages have no
   *  equivalent live-status concept. */
  metaHtml?: string;
}

/** Render a single-row <header>: hamburger + brand + page title (never
 * wraps — truncates with an ellipsis instead) + optional trailing status. */
export function renderHeader(opts: RenderHeaderOpts): string {
  const toggle = opts.withNavToggle
    ? `<button id="nav-toggle" type="button" aria-label="open navigation" title="open navigation">☰</button>`
    : '';
  const titleSuffix = opts.pageTitleHtml ? ` <span class="page-title">· ${opts.pageTitleHtml}</span>` : '';
  const meta = opts.metaHtml ?? '';
  return `<header>
  ${toggle}
  <h1><span class="brand">${opts.brand}</span>${titleSuffix}</h1>
  ${meta}
</header>`;
}
