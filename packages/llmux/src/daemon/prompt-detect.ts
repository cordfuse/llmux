/**
 * Detects a pending interactive option-list prompt (a CLI asking the
 * operator to pick one of several choices) from the raw tmux pane text.
 * These never reach a structured transcript event until AFTER they're
 * answered (confirmed live: a pending call produces an assistant event with
 * empty content and no tool-call info at all — the question/options/answer
 * only appear once resolved), so this is the only way to surface them to
 * the chat view while they're still waiting on the operator.
 *
 * Deliberately NOT a full TUI parser — a small set of narrow, content-
 * signature-based shape detectors, each scoped to a real shape verified
 * against a live capture. Verified so far:
 *   - Gemini CLI's `ask_user` tool AND its own `/model` picker (Ink-
 *     rendered, numbered, boxed, ●-marker, per-option description lines —
 *     same shape, different footer text).
 *   - Antigravity CLI (`agy`)'s `/model` switcher (plain marker list, no
 *     numbering, no box, no descriptions — genuinely different chrome even
 *     though both are Google/Gemini-family CLIs).
 *   - Codex CLI's AND Claude Code's own `/model` pickers (no box border,
 *     digit+dot options with the description mashed onto the same line
 *     after a 2+-space gap, descriptions wrapping onto further indented
 *     lines — same shape, different marker char and footer text).
 *   - OpenCode's shared "Select X" picker (used by both `/model` and
 *     `/agent`, confirmed by directly testing both live — a "Select
 *     <noun> ... esc" title line, a "Search" box, plain ●-marker options
 *     with no numbering). Genuinely harder than the other shapes: `/model`
 *     alone spans 50+ entries across provider groups, confirmed by two
 *     live captures showing entirely different visible entries — there's
 *     no ▲/▼ scroll indicator or any other reliable signal for whether a
 *     given capture shows the complete list or a scrolled slice, so this
 *     one ALWAYS attaches PendingPrompt.note advising the operator that
 *     more options may exist beyond what's shown, rather than guessing.
 * Extending to another CLI's own option-list chrome needs its own real
 * capture to verify against; an unrecognized shape returns undefined rather
 * than guessing — no raw-text fallback for those yet (see the shipping
 * commit's notes on why that's deliberately deferred).
 */

export interface PendingPromptOption {
  label: string;
  description?: string | undefined;
}

export interface PendingPrompt {
  header?: string | undefined;
  question: string;
  options: PendingPromptOption[];
  /** 0-based index of the option currently marked selected in the pane, if determinable. */
  selectedIndex?: number | undefined;
  /**
   * Free-text advisory shown alongside the options in the chat UI — e.g. a
   * caveat that this shape may be a scrolled/searchable list whose full
   * contents don't fit in one capture (see detectOpencodeSelectList).
   */
  note?: string | undefined;
  /** Raw captured pane text this was derived from — used for the client's raw-text fallback and change-detection. */
  raw: string;
}

/**
 * `paneText` is the plain-text output of `tmux capture-pane -p` (no ANSI —
 * confirmed the selection marker character survives plain capture, so
 * color/attribute capture isn't needed).
 */
export function detectPendingPrompt(paneText: string): PendingPrompt | undefined {
  const lines = paneText.split('\n');
  return (
    detectNumberedList(lines, paneText) ??
    detectPlainMarkerList(lines, paneText) ??
    detectInlineOptionList(lines, paneText) ??
    detectOpencodeSelectList(lines, paneText)
  );
}

// ---------------------------------------------------------------------------
// Shape 1: Gemini CLI's `ask_user` — numbered, boxed, per-option description.
// ---------------------------------------------------------------------------

// Verified against two real, distinct Gemini CLI dialogs that share this
// same boxed/numbered/●-marker/description shape: the `ask_user` tool
// ("Enter to select · ↑/↓ to navigate · Esc to cancel") and the CLI's own
// `/model` picker, which has no "to select" text at all — it closes with
// "(Press Esc to close)" instead. Kept as a list (not one looser regex) so
// each addition stays traceable to the real capture that justified it.
const NUMBERED_FOOTER_PATTERNS: RegExp[] = [/to select/i, /press esc/i];

// A numbered option line, allowing for a leading box-drawing border (│) and/or
// a selection marker (●, •, ❯, >) before the digit. \s+ (not a fixed count)
// after the dot since the exact gap is an Ink rendering detail, not load-bearing.
const OPTION_LINE_RE = /^[│\s]*([●•❯>])?\s*(\d+)\.\s+(.+?)\s*[│\s]*$/;
// A continuation/description line: indented text with no leading digit marker.
const DESCRIPTION_LINE_RE = /^[│\s]{2,}([^\s│].*?)\s*[│\s]*$/;
const BORDER_ONLY_RE = /^[\s│╭╮╰╯─▲▼]*$/;

function stripBorder(line: string): string {
  return line.replace(/^[│\s]+/, '').replace(/[│\s]+$/, '');
}

const TOP_BORDER_RE = /^╭─+╮?\s*$/;
const BOTTOM_BORDER_RE = /^╰─+╯?\s*$/;

/**
 * Forward-scan from the box's top border, not backward from the footer.
 * Verified necessary against a real capture: Gemini's `/model` picker has
 * freeform hint text ("Remember model for future sessions...", "> To use a
 * specific...") sitting BETWEEN the option list and the footer — content
 * `ask_user`'s simpler shape doesn't have. A backward scan from the footer
 * has no way to tell that hint text apart from a real option description
 * (both are just indented text); scanning forward and stopping the option
 * block at the first blank/border-only line after collecting ≥1 option
 * sidesteps the ambiguity entirely, and still correctly excludes anything
 * after that gap regardless of what it looks like.
 */
function detectNumberedList(lines: string[], paneText: string): PendingPrompt | undefined {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NUMBERED_FOOTER_PATTERNS.some((re) => re.test(lines[i]!))) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return undefined;

  // The footer is inside the box; find its bottom border at/after it, then
  // the matching top border above that (bounded — a real dialog is never
  // hundreds of lines tall, and an unbounded backward scan risks running
  // into an unrelated older box further up the scrollback).
  let bottomIdx = -1;
  for (let i = footerIdx; i < Math.min(lines.length, footerIdx + 6); i++) {
    if (BOTTOM_BORDER_RE.test(lines[i]!)) { bottomIdx = i; break; }
  }
  if (bottomIdx < 0) return undefined;
  let topIdx = -1;
  for (let i = bottomIdx - 1; i >= Math.max(0, bottomIdx - 80); i--) {
    if (TOP_BORDER_RE.test(lines[i]!)) { topIdx = i; break; }
  }
  if (topIdx < 0) return undefined;

  // First non-blank content line is the title. If a SECOND distinct
  // non-blank, non-option line follows before any option appears, the first
  // is a header and the second is the real question (ask_user's shape);
  // otherwise there's just one title line and it fills `question` alone
  // (the /model picker's shape — no separate header/question split).
  let i = topIdx + 1;
  while (i < bottomIdx && BORDER_ONLY_RE.test(lines[i]!)) i++;
  if (i >= bottomIdx) return undefined;
  let header: string | undefined;
  let question = stripBorder(lines[i]!);
  i++;
  while (i < bottomIdx && BORDER_ONLY_RE.test(lines[i]!)) i++;
  if (i < bottomIdx && !OPTION_LINE_RE.test(lines[i]!)) {
    header = question;
    question = stripBorder(lines[i]!);
    i++;
    while (i < bottomIdx && BORDER_ONLY_RE.test(lines[i]!)) i++;
  }
  if (!question) return undefined;

  // Collect options forward from here; stop at the first blank/border-only
  // line once at least one option has been found (see function docstring —
  // this is what correctly excludes the /model picker's trailing hint text
  // without needing to recognize it specifically).
  const options: PendingPromptOption[] = [];
  let selectedIndex: number | undefined;
  for (; i < bottomIdx; i++) {
    const raw = lines[i]!;
    const optMatch = raw.match(OPTION_LINE_RE);
    if (optMatch) {
      options.push({ label: optMatch[3]!.trim() });
      if (optMatch[1]) selectedIndex = options.length - 1;
      continue;
    }
    if (options.length > 0 && (BORDER_ONLY_RE.test(raw) || raw.trim() === '')) break;
    if (BORDER_ONLY_RE.test(raw)) continue;
    // A continuation/description line — some dialogs wrap an option's
    // description across more than one line (verified: Gemini's /model
    // "Auto" option), so append rather than overwrite.
    const descMatch = raw.match(DESCRIPTION_LINE_RE);
    if (descMatch && options.length > 0) {
      const last = options[options.length - 1]!;
      last.description = last.description ? `${last.description} ${descMatch[1]!.trim()}` : descMatch[1]!.trim();
    }
  }
  if (options.length === 0) return undefined;

  return { header, question, options, selectedIndex, raw: paneText };
}

// ---------------------------------------------------------------------------
// Shape 2: Antigravity CLI (agy)'s `/model` switcher — plain marker list, no
// numbering, no box border, no per-option description, blank-line-delimited.
// ---------------------------------------------------------------------------

// Verified against a live agy `/model` capture: "Keyboard: ↑/↓ Navigate  enter
// Select  esc Go Back". Require both words rather than one exact phrase —
// same reasoning as the numbered-list footer, minor wording drift shouldn't
// silently break this.
const PLAIN_FOOTER_RE = (line: string): boolean => /navigate/i.test(line) && /select/i.test(line);

// A marker (●, •, ❯, >) OR at least one leading space distinguishes an
// option line from a flush-left header line like "Switch Model" (zero
// indent) — that's the only structural signal this shape offers, there's no
// digit numbering or box border to lean on.
const PLAIN_OPTION_RE = /^([●•❯>])?(\s+)(.+?)\s*$/;

function detectPlainMarkerList(lines: string[], paneText: string): PendingPrompt | undefined {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PLAIN_FOOTER_RE(lines[i]!)) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return undefined;

  let cursor = footerIdx - 1;
  while (cursor >= 0 && lines[cursor]!.trim() === '') cursor--; // skip the blank spacer below the block
  const blockEnd = cursor;
  while (cursor >= 0) {
    const raw = lines[cursor]!;
    if (raw.trim() === '' || PLAIN_OPTION_RE.test(raw)) {
      cursor--;
      continue;
    }
    break;
  }
  const blockStart = cursor + 1;
  if (blockStart > blockEnd) return undefined;

  const options: PendingPromptOption[] = [];
  let selectedIndex: number | undefined;
  for (let j = blockStart; j <= blockEnd; j++) {
    const raw = lines[j]!;
    if (raw.trim() === '') continue;
    const m = raw.match(PLAIN_OPTION_RE);
    if (!m) continue;
    options.push({ label: m[3]!.trim() });
    if (m[1]) selectedIndex = options.length - 1;
  }
  if (options.length === 0) return undefined;

  let questionIdx = blockStart - 1;
  while (questionIdx >= 0 && lines[questionIdx]!.trim() === '') questionIdx--;
  const question = questionIdx >= 0 ? lines[questionIdx]!.trim() : '';
  if (!question) return undefined;

  return { question, options, selectedIndex, raw: paneText };
}

// ---------------------------------------------------------------------------
// Shape 3: Codex CLI's and Claude Code's own `/model` pickers — no box
// border, digit+dot options with the description mashed onto the same line
// (separated by a 2+-space gap) instead of a separate line, descriptions
// wrapping onto further plain-indented lines. Genuinely the same shape
// across both CLIs — different marker char (› vs ❯) and footer wording only.
// ---------------------------------------------------------------------------

// Verified against real captures of both. Kept as a list, same reasoning as
// the other shapes' footer patterns — one entry per real capture that
// justified it, not a looser catch-all.
const INLINE_FOOTER_PATTERNS: RegExp[] = [/press enter to confirm/i, /enter to set as default/i];

// No box border here (unlike Shape 1), and the label/description share one
// line separated by a 2+-space gap rather than living on separate lines —
// group 3 is non-greedy so the optional group 4 gets everything after the
// FIRST such gap.
const INLINE_OPTION_RE = /^\s*([❯›])?\s*(\d+)\.\s+(\S.*?)(?:\s{2,}(\S.*?))?\s*$/;
// A wrapped continuation of the PREVIOUS option's description: indented
// text with no digit marker. Same ambiguity as Shape 1's description lines
// (can't be told apart from unrelated indented text by shape alone) — the
// forward-scan-stop-at-first-blank-after-an-option rule below is what
// actually excludes non-option content (verified necessary: Claude's own
// /model has a non-option settings row — "● High effort... ←/→ to adjust"
// — sitting between the options and the footer, structurally identical to
// a continuation line otherwise).
const INLINE_CONTINUATION_RE = /^\s{2,}(\S.*?)\s*$/;

function detectInlineOptionList(lines: string[], paneText: string): PendingPrompt | undefined {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (INLINE_FOOTER_PATTERNS.some((re) => re.test(lines[i]!))) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return undefined;

  // No box border to anchor a top boundary on (unlike Shape 1) — instead,
  // search a generous bounded window above the footer for the FIRST option
  // line, which marks where the title/subtitle preamble ends.
  const windowStart = Math.max(0, footerIdx - 30);
  let firstOptIdx = -1;
  for (let i = windowStart; i < footerIdx; i++) {
    if (INLINE_OPTION_RE.test(lines[i]!)) { firstOptIdx = i; break; }
  }
  if (firstOptIdx < 0) return undefined;

  // Title + subtitle: scan backward from the first option, skipping the
  // blank separator, then collect the contiguous non-blank run above that —
  // both real captures have a short title immediately followed by a wrapped
  // instructional subtitle with no blank line between them, so there's no
  // reliable header/question split here (contrast Shape 1, which uses a
  // blank line as that signal). A horizontal-rule line (verified: Claude's
  // own /model opens with one, marking where its output starts) counts as
  // a separator too, same as blank — otherwise it gets swept into the
  // preamble along with whatever unrelated conversation sits above it.
  const isBoundary = (l: string) => l.trim() === '' || /^─+$/.test(l.trim());
  let i = firstOptIdx - 1;
  while (i >= windowStart && isBoundary(lines[i]!)) i--;
  const preambleEnd = i;
  while (i >= windowStart && !isBoundary(lines[i]!)) i--;
  const preambleStart = i + 1;
  if (preambleStart > preambleEnd) return undefined;
  const preamble = lines
    .slice(preambleStart, preambleEnd + 1)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ');
  if (!preamble) return undefined;

  const options: PendingPromptOption[] = [];
  let selectedIndex: number | undefined;
  for (let i = firstOptIdx; i < footerIdx; i++) {
    const raw = lines[i]!;
    const optMatch = raw.match(INLINE_OPTION_RE);
    if (optMatch) {
      options.push({ label: optMatch[3]!.trim(), description: optMatch[4]?.trim() });
      if (optMatch[1]) selectedIndex = options.length - 1;
      continue;
    }
    if (raw.trim() === '') break; // see INLINE_CONTINUATION_RE docstring — this is what excludes trailing non-option content
    const contMatch = raw.match(INLINE_CONTINUATION_RE);
    if (contMatch && options.length > 0) {
      const last = options[options.length - 1]!;
      last.description = last.description ? `${last.description} ${contMatch[1]!.trim()}` : contMatch[1]!.trim();
    }
  }
  if (options.length === 0) return undefined;

  return { question: preamble, options, selectedIndex, raw: paneText };
}

// ---------------------------------------------------------------------------
// Shape 4: OpenCode's shared "Select X" picker — used by both `/model` and
// `/agent` (confirmed by directly testing both live). Title line anchors
// this one (not a footer — the footer text differs per command, e.g.
// `/model`'s "Connect provider ctrl+a  Favorite ctrl+f" doesn't apply to
// `/agent`). Plain ●-marker options, no numbering, category-grouped for
// `/model` with blank-line separators BETWEEN groups (not just at the
// block's edges like every other shape here) — so a blank line can NOT be
// used to end the scan the way it does elsewhere; see OPENCODE_STOP_RE.
//
// OpenCode also renders a persistent tooltip/hint overlay (confirmed real
// and reproducible on a live capture, not a transient glitch) that bleeds
// "┃"/box-drawing fragments and stray text into the LEFT edge of several
// rows — including genuinely valid option rows, corrupting them if read as
// whole lines. The fix: every row in this picker — title, "Search" label,
// and every option — is left-padded to the SAME column (verified: "Select"
// and both real option labels "build native"/"plan native" all start at
// the identical column in a real capture). So every line gets sliced from
// the title's own content column onward before matching anything, which
// cleanly discards the overlay regardless of what it contains, rather than
// trying to pattern-match around it.
// ---------------------------------------------------------------------------

// Verified against real captures of both "Select model" and "Select agent".
const OPENCODE_TITLE_RE = /^(\s*)(Select\s+\S+)\s+esc\s*$/i;
const OPENCODE_SEARCH_RE = /^\s*Search\s*$/i;
// Marks the end of the option block: a keyboard-shortcut footer hint.
// Varies per command, but real examples all use "ctrl+X" — verified
// unlikely to collide with an actual model/agent name. Deliberately NOT
// also matching box-drawing chars here (an earlier version did, and broke
// on a real capture: the tooltip overlay's right edge trails "▀" onto
// otherwise-valid option rows, e.g. "Hy3 Free ... Free    ▀▀▀▀▀▀▀▀", which
// isn't the end of the list at all — see the trailing-strip below instead.
const OPENCODE_STOP_RE = /ctrl\+/;
// The overlay also contaminates the right edge of some rows with trailing
// box-drawing fragments or stray text bleeding in from the idle-mode
// footer (verified real: "...Free    commands"). Strip from the first
// box-drawing char onward — real labels don't contain these.
const OPENCODE_TRAILING_JUNK_RE = /[┃╹▀╭╮╰╯│].*$/;
// Bound the scan generously — this list can be long (verified: `/model`
// spans 50+ entries) — but still finite, as a safety backstop.
const OPENCODE_MAX_ROWS = 100;

function detectOpencodeSelectList(lines: string[], paneText: string): PendingPrompt | undefined {
  let titleIdx = -1;
  let question = '';
  let contentCol = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(OPENCODE_TITLE_RE);
    if (m) {
      titleIdx = i;
      contentCol = m[1]!.length;
      question = m[2]!.trim();
      break;
    }
  }
  if (titleIdx < 0) return undefined;

  const sliceContent = (line: string): string => (line.length > contentCol ? line.slice(contentCol) : '');
  // The ● marker sits in a narrow "gutter" just BEFORE the content column,
  // not inside it (verified: on a real capture, contentCol landed one
  // column after the marker's own position) — slicing at contentCol alone
  // would cleanly extract the label but silently drop the marker. Checked
  // separately, in a small window ending right at contentCol.
  const OPENCODE_GUTTER_WIDTH = 4;
  const hasMarker = (line: string): boolean =>
    line.slice(Math.max(0, contentCol - OPENCODE_GUTTER_WIDTH), contentCol).includes('●');

  let i = titleIdx + 1;
  // Skip blank lines and the "Search" box label between the title and the
  // first real row.
  while (i < lines.length) {
    const sliced = sliceContent(lines[i]!);
    if (sliced.trim() === '' || OPENCODE_SEARCH_RE.test(sliced)) { i++; continue; }
    break;
  }

  const options: PendingPromptOption[] = [];
  let selectedIndex: number | undefined;
  for (; i < lines.length && options.length < OPENCODE_MAX_ROWS; i++) {
    const raw = lines[i]!;
    const sliced = sliceContent(raw);
    if (OPENCODE_STOP_RE.test(sliced)) break;
    // Real rows right-pad a pricing badge far out with runs of spaces
    // (verified: "Hy3 Free                                        Free" —
    // model name, then a separate "Free"-tier badge) — collapse for
    // display rather than showing a huge internal gap.
    const label = sliced.replace(OPENCODE_TRAILING_JUNK_RE, '').trim().replace(/\s+/g, ' ');
    if (!label) continue; // blank, or a row fully consumed by the overlay — either way, not a real row
    options.push({ label });
    if (hasMarker(raw)) selectedIndex = options.length - 1;
  }
  if (options.length === 0) return undefined;

  return {
    question,
    options,
    selectedIndex,
    note: 'More options may be available in Terminal — this list can scroll and supports typing to search.',
    raw: paneText,
  };
}
