/**
 * Detects a pending interactive option-list prompt (a CLI asking the
 * operator to pick one of several choices — Gemini CLI's `ask_user` tool is
 * the verified case) from the raw tmux pane text. These never reach a
 * structured transcript event until AFTER they're answered (confirmed live:
 * a pending `ask_user` call produces an assistant event with empty content
 * and no `toolCalls` at all — the question/options/answer only appear once
 * resolved), so this is the only way to surface them to the chat view while
 * they're still waiting on the operator.
 *
 * Deliberately NOT a full TUI parser — a narrow, content-signature-based
 * heuristic scoped to the one real shape verified against a live capture
 * (Gemini's Ink-rendered select list). Extending to another CLI's own
 * option-list chrome needs its own real capture to verify against; an
 * unrecognized shape should fall back to a raw-text banner rather than
 * silently doing nothing (see PendingPrompt.raw).
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

// Verified against a live Gemini CLI `ask_user` capture. Match loosely
// (just "to select") so minor wording drift across CLI versions doesn't
// silently stop matching.
const FOOTER_SIGNATURES: RegExp[] = [/to select/i];

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

/**
 * `paneText` is the plain-text output of `tmux capture-pane -p` (no ANSI —
 * confirmed the selection marker character survives plain capture, so
 * color/attribute capture isn't needed).
 */
export function detectPendingPrompt(paneText: string): PendingPrompt | undefined {
  const lines = paneText.split('\n');

  let footerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_SIGNATURES.some((re) => re.test(lines[i]!))) {
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
  let blockEnd = skipBorderUp(lines, footerIdx - 1); // last content line of the block
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
