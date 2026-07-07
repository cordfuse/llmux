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
 * against a live capture. Two verified so far:
 *   - Gemini CLI's `ask_user` tool (Ink-rendered, numbered, boxed, with
 *     per-option description lines).
 *   - Antigravity CLI (`agy`)'s `/model` switcher (plain marker list, no
 *     numbering, no box, no descriptions — genuinely different chrome even
 *     though both are Google/Gemini-family CLIs).
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
  return detectNumberedList(lines, paneText) ?? detectPlainMarkerList(lines, paneText);
}

// ---------------------------------------------------------------------------
// Shape 1: Gemini CLI's `ask_user` — numbered, boxed, per-option description.
// ---------------------------------------------------------------------------

// Verified against a live Gemini CLI `ask_user` capture. Match loosely
// (just "to select") so minor wording drift across CLI versions doesn't
// silently stop matching.
const NUMBERED_FOOTER_RE = /to select/i;

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

/** Skip blank/border-only lines walking upward from `from`; returns the index of the first non-blank line, or -1. */
function skipBorderUp(lines: string[], from: number): number {
  let i = from;
  while (i >= 0 && BORDER_ONLY_RE.test(lines[i]!)) i--;
  return i;
}

function detectNumberedList(lines: string[], paneText: string): PendingPrompt | undefined {
  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (NUMBERED_FOOTER_RE.test(lines[i]!)) {
      footerIdx = i;
      break;
    }
  }
  if (footerIdx < 0) return undefined;

  // Find the option block's bounds by walking upward from the footer: skip
  // the bottom border, then keep consuming option/description/blank lines
  // until we hit something that's neither — that's blockStart (exclusive).
  //
  // DESCRIPTION_LINE_RE alone can't tell an option's description apart from
  // the question line above the block — both are just "indented text". Gate
  // it on `sawOptionish`: only accept a description/border line while we're
  // still inside (or at the top edge of) a run that started at a real
  // option line; once a border-only line appears with nothing option-ish
  // below it, that flag drops so the NEXT indented text line (the question)
  // correctly stops the scan instead of being swallowed as a description.
  const blockEnd = skipBorderUp(lines, footerIdx - 1); // last content line of the block
  let cursor = blockEnd;
  let sawOptionish = true; // blockEnd is already real block content (skipBorderUp landed past the ▼ spacer)
  while (cursor >= 0) {
    const raw = lines[cursor]!;
    if (OPTION_LINE_RE.test(raw)) {
      sawOptionish = true;
      cursor--;
      continue;
    }
    if (sawOptionish && DESCRIPTION_LINE_RE.test(raw)) {
      cursor--;
      continue;
    }
    if (sawOptionish && BORDER_ONLY_RE.test(raw)) {
      sawOptionish = false; // consume one spacer run (e.g. the ▲ line), but don't keep assuming past it
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
    const optMatch = raw.match(OPTION_LINE_RE);
    if (optMatch) {
      options.push({ label: optMatch[3]!.trim() });
      if (optMatch[1]) selectedIndex = options.length - 1;
      continue;
    }
    if (BORDER_ONLY_RE.test(raw)) continue;
    const descMatch = raw.match(DESCRIPTION_LINE_RE);
    if (descMatch && options.length > 0) {
      options[options.length - 1]!.description = descMatch[1]!.trim();
    }
  }
  if (options.length === 0) return undefined;

  const questionIdx = skipBorderUp(lines, blockStart - 1);
  const question = questionIdx >= 0 ? stripBorder(lines[questionIdx]!) : '';
  if (!question) return undefined;

  const headerIdx = skipBorderUp(lines, questionIdx - 1);
  const header = headerIdx >= 0 ? stripBorder(lines[headerIdx]!) || undefined : undefined;

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
