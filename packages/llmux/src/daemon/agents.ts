import { accessSync, appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export interface Conversation {
  id: string;
  title: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
}

/**
 * A normalized, render-ready fragment of a conversation turn. The chat view
 * (daemon/web/server.ts → chatPage) consumes these instead of each CLI's raw
 * on-disk transcript schema, so the frontend stays agent-agnostic.
 */
export type TranscriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id?: string | undefined; name: string; input: unknown }
  | { kind: 'tool_result'; forId?: string | undefined; text: string; isError?: boolean | undefined };

export interface TranscriptTurn {
  /** Stable id for client-side de-dup when the snapshot + live tail overlap. */
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** ISO timestamp of the source event, when the transcript records one. */
  ts?: string | undefined;
  parts: TranscriptPart[];
}

export interface AgentHistoryAdapter {
  /** Past conversations for this agent in this cwd, newest-first. */
  listConversations(cwd: string): Conversation[];
  /**
   * Fast count of past conversations for this agent in this cwd. Used by
   * the session-list view's badge so a render doesn't have to parse every
   * transcript file just to display a number. Defaults to
   * listConversations(cwd).length if an adapter doesn't override — but
   * Claude Code transcripts can run hundreds of MB, so claudeHistory
   * overrides this with a directory-only count.
   */
  countConversations?(cwd: string): number;
  /**
   * Fast single-conversation title lookup for the "↻ resumed: X" badge
   * the session-list view renders under a bound session's name. Should
   * NOT walk the whole conversation set — each adapter implements the
   * most direct lookup it can (open the one file by id, SQL by id, etc.).
   * Returns undefined when the conversation was deleted / archived /
   * never existed; the UI falls back to a truncated id.
   */
  lookupTitle?(cwd: string, conversationId: string): string | undefined;
  /** Build the launch flag fragment to resume a specific conversation. */
  resumeFlag(conversationId: string): string;
  /**
   * Absolute path of the agent's CURRENTLY ACTIVE transcript file for this
   * cwd, or undefined if none / unsupported. The chat view tails this file
   * to render the live conversation. Optional — an agent without it simply
   * has no chat-GUI view (the terminal view still works).
   *
   * `sessionId`, when passed, is this session's own pinned/resumed id
   * (`resumeFrom` if resumed, else the id passed to the CLI's own
   * `sessionIdFlag` at spawn, if the agent has one) — adapters that can map
   * an id directly to its exact transcript file should prefer that over
   * mtime-guessing, which is only ever a same-cwd heuristic and is WRONG
   * whenever two sessions share a cwd (see `sessionIdFlag`'s docstring).
   * Sessions spawned before an adapter supported this have no persisted id
   * and fall back to the mtime guess same as before.
   */
  currentTranscript?(cwd: string, sessionId?: string): string | undefined;
  /** Parse a whole transcript file into normalized chat turns (snapshot). */
  readTranscript?(path: string): TranscriptTurn[];
  /**
   * Parse ONE transcript line into 0..n normalized turns. Used by the live
   * tailer as lines are appended. A single source event can yield more than
   * one turn (e.g. a Claude `user` event carrying both a real prompt and a
   * tool_result block).
   */
  parseTranscriptLine?(line: string): TranscriptTurn[];
}

/**
 * Codex gates every spawn in a new cwd with an interactive y/n trust
 * prompt and provides no CLI flag to skip it. The `-c` config override
 * is parsed too late to win against the gate. Persisted trust in
 * `~/.codex/config.toml` IS honored.
 *
 * This hook reads the current config (creating the file if missing),
 * checks for the section, and appends a `[projects."<cwd>"]` entry
 * with `trust_level = "trusted"` if absent. Idempotent — string-
 * matches the literal section header before writing.
 *
 * Trust context: client/operator (preSpawn runs in the daemon process,
 * which in v1.x + v2 user mode is the operator. In v2 system mode it's
 * the `llmux` service user managing its own ~llmux/.codex/, not
 * reaching into operator homes — see V2-SYSTEM-AUTH-DESIGN.md $HOME
 * principle).
 */
function codexPreSpawnTrust(ctx: { cwd: string }): void {
  try {
    const dir = join(homedir(), '.codex');
    const path = join(dir, 'config.toml');
    const sectionHeader = `[projects."${ctx.cwd}"]`;
    const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    if (content.includes(sectionHeader)) return; // already trusted
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry = (content.endsWith('\n') || content.length === 0 ? '' : '\n') +
      `\n${sectionHeader}\ntrust_level = "trusted"\n`;
    if (existsSync(path)) appendFileSync(path, entry);
    else writeFileSync(path, entry, { mode: 0o600 });
  } catch (err) {
    console.warn(`[llmux] codex preSpawn trust write failed (proceeding): ${(err as Error).message}`);
  }
}

export interface AgentDefinition {
  /** Key under `agents:` in .llmux.yaml; default tmux-session name. */
  key: string;
  /** Human-readable name shown in UI surfaces (picker dropdown, etc.). */
  displayName: string;
  /** Executable to launch in the tmux pane. */
  cmd: string;
  /** Default args appended after `cmd`. */
  flags?: string;
  /**
   * Regex (as a JS string) matched against the bottom of the pane to detect
   * "agent is ready to receive input". Used by the init-prompts feature to
   * wait for the agent's TUI to render its prompt before firing the first
   * scripted prompt. Optional — if unset, the firing logic falls back to a
   * fixed 2-second sleep.
   */
  readyPrompt?: string;
  /** Custom install detection (overrides the default PATH lookup). */
  detectInstalled?: () => boolean;
  /** One-line install command (shell). Shown in the agent-help modal. */
  installHint?: string;
  /** Homepage / docs URL. Shown alongside installHint as a fallback. */
  docsUrl?: string;
  /** Environment variables baked in at spawn time. Per-session env overrides win. */
  envDefaults?: Record<string, string>;
  /** Conversation-history adapter — enables the "resume past conversation" picker. */
  history?: AgentHistoryAdapter;
  /**
   * One-shot side effects to run BEFORE tmux spawns the agent. Use for
   * preparing per-cwd config the agent CLI requires on startup — e.g.,
   * codex's per-directory trust gate that would otherwise block every
   * spawn in a new cwd with a y/n prompt and no automation override.
   *
   * Must be idempotent — invoked on every spawn (and respawn). Failures
   * are logged + swallowed; spawn proceeds without the side effect.
   */
  preSpawn?: (ctx: { cwd: string }) => void;
  /**
   * Builds the CLI flag fragment that pins a fresh, caller-generated session
   * id at spawn time (e.g. Claude Code's `--session-id <uuid>`). Only set
   * for agents whose CLI supports it — used exclusively on FRESH (non-
   * resumed) spawns, so `currentTranscript` can look up the exact transcript
   * file deterministically instead of guessing by mtime.
   *
   * That guess is provably wrong whenever two sessions share a cwd: verified
   * live on this machine — llmux's OWN dev session and a separately-tracked
   * `tmux-claude` session both had cwd `~/Repos`, and the dev session's
   * constantly-refreshing mtime permanently shadowed the other one's actual
   * transcript in its Chat view, even though the sessions were completely
   * unrelated.
   */
  sessionIdFlag?: (id: string) => string;
  /**
   * Fallback for agents with NO sessionIdFlag equivalent (no way to choose
   * an id ahead of time) — discovers the id of a just-spawned FRESH
   * session by watching for its conversation-history file to appear,
   * instead of guessing by mtime later. Called fire-and-forget right after
   * a non-resumed spawn; resolves once the new file is found (or undefined
   * on timeout), so the caller can persist it as `externalSessionId`
   * exactly like a sessionIdFlag-generated id.
   *
   * Only meaningful together with `history` — this exists specifically to
   * close the fresh-spawn half of the same cross-session-shadowing risk
   * sessionIdFlag closes for the resumed half, for CLIs that can't be
   * given an id upfront (e.g. Codex has no --session-id equivalent).
   */
  detectFreshSessionId?: (ctx: { cwd: string }) => Promise<string | undefined>;
  /**
   * Literal text sent (as a real prompt, not a special key) to start a new
   * conversation within the SAME running process. Verified live against
   * each CLI's own slash-command listing, not assumed — claude/gemini/agy
   * only have `/clear`; codex and opencode have both `/new` and `/clear`
   * (picked `/new` for those two, functionally identical either way).
   * Every agent with this set also needs detectFreshSessionId (or is agy,
   * whose existing pinning-free design already tolerates it) — sending
   * this command without a re-pin plan would let Chat view go stale the
   * same way the Codex cross-session bug did.
   */
  newChatCommand?: string;
}

/**
 * Claude Code stores each conversation as a `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
 * file. The encoding is a literal `/`-to-`-` substitution. Each line is a JSON
 * event; the first user message defines the conversation's title, and the
 * event timestamps frame `startedAt` / `lastMessageAt`. Synthetic events
 * (permission-mode, local-command-stdout, /resume command stubs) are skipped
 * when picking the title so the picker shows the actual conversation opener.
 */
function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Shared by every *DetectFreshSessionId function below. 10 minutes, not 60s
 * — 60s already replaced an earlier 15s after confirming THAT wasn't
 * enough (Codex doesn't create its new rollout file the moment `/new`
 * runs, only once the operator sends their first real message in the
 * fresh conversation), and 60s STILL wasn't enough: confirmed live on a
 * real phone, typing a short follow-up after tapping New Chat — thinking
 * + mobile keyboard pace alone can exceed 60s, and detection had already
 * given up by the time the message landed, even though the file appeared
 * correctly right after. There's no reliable upper bound on "how long
 * until the operator sends their next message" short of just not
 * guessing — cheap to be generous here regardless of the exact number,
 * since this is a detached/fire-and-forget background poll either way
 * (see armFreshSessionIdDetection), never something a caller blocks on.
 */
const FRESH_SESSION_ID_DETECT_TIMEOUT_MS = 600000;

/**
 * Claude Code's sessionIdFlag only pins an id at SPAWN time. Mid-session
 * `/clear` ("Start a new session with empty context") creates a genuinely
 * NEW <uuid>.jsonl in the same per-cwd directory — confirmed live: sent
 * /clear to a disposable test session, watched a brand-new file appear
 * distinct from the pinned externalSessionId. Without re-detecting and
 * re-pinning after that, Chat view would keep showing the pre-clear
 * conversation forever. Same snapshot-then-poll shape as
 * codexDetectFreshSessionId, simpler here since the per-cwd directory
 * already does the cwd-filtering — no need to parse file content to check.
 */
async function claudeDetectFreshSessionId(ctx: { cwd: string }): Promise<string | undefined> {
  const dir = join(homedir(), '.claude', 'projects', encodeClaudeCwd(ctx.cwd));
  const listDir = (): string[] => {
    try {
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    } catch {
      return [];
    }
  };
  const before = new Set(listDir());
  const deadline = Date.now() + FRESH_SESSION_ID_DETECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const f of listDir()) {
      if (before.has(f)) continue;
      return f.slice(0, -'.jsonl'.length);
    }
  }
  return undefined;
}

function extractClaudeUserText(msg: unknown): string | undefined {
  if (typeof msg !== 'object' || msg === null) return undefined;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
      }
    }
  }
  return undefined;
}

function looksLikeRealUserMessage(text: string): boolean {
  if (!text) return false;
  if (text.startsWith('<local-command')) return false;
  if (text.startsWith('<command-name>')) return false;
  if (text.startsWith('<command-message>')) return false;
  if (text.startsWith('<system-reminder>')) return false;
  if (text.startsWith('<task-notification>')) return false;
  return true;
}

/** Flatten a Claude tool_result block's `content` (string | block[]) to text. */
function extractClaudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') texts.push(block);
      else if (typeof block === 'object' && block !== null) {
        const b = block as { type?: string; text?: string };
        if (typeof b.text === 'string') texts.push(b.text);
      }
    }
    return texts.join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Map one parsed Claude JSONL event to 0..n normalized chat turns. Subagent
 * (sidechain) and meta/command-stub events are dropped so the chat view shows
 * the human-visible conversation. A `user` event can split into a `tool` turn
 * (tool_result blocks) plus a `user` turn (a real typed prompt).
 */
/**
 * A `local_command`'s content wraps the slash command in an XML-ish stub:
 * `<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>`.
 * Pull just the name back out for display.
 */
function extractClaudeLocalCommandName(content: string): string {
  const m = content.match(/<command-name>([^<]*)<\/command-name>/);
  return m?.[1]?.trim() || 'command';
}

function normalizeClaudeEvent(evt: {
  type?: string;
  subtype?: string;
  content?: unknown;
  timestamp?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: unknown;
}): TranscriptTurn[] {
  if (evt.isSidechain || evt.isMeta) return [];
  const ts = evt.timestamp;
  const uuid = evt.uuid ?? `${evt.type}-${ts ?? ''}`;
  const msg = evt.message;
  const content = (typeof msg === 'object' && msg !== null) ? (msg as { content?: unknown }).content : undefined;

  if (evt.type === 'system') {
    // `turn_duration` is pure telemetry (durationMs/messageCount, no
    // user-facing text) — the only subtype with nothing to show. Every
    // other subtype (informational, away_summary, bridge_status,
    // compact_boundary, scheduled_task_fire, and anything future) carries a
    // real `content` string worth surfacing — rendered as a tool-shaped
    // card (bare, non-bubble) rather than a chat bubble, since these
    // aren't conversational turns.
    if (evt.subtype === 'turn_duration') return [];
    const text = typeof evt.content === 'string' ? evt.content.trim() : '';
    if (evt.subtype === 'local_command') {
      // Two on-disk shapes observed across Claude Code versions: older
      // clients (verified against a 2.1.131 session) put <command-name>
      // directly on THIS event; newer ones (2.1.202) move it to a
      // preceding user-role event instead (see the `<command-name>`
      // branch above) and this event only ever carries stdout, wrapped in
      // <local-command-stdout> — empty for most commands (/clear, /exit).
      if (text.includes('<command-name>')) {
        return [{ id: uuid, role: 'system', ts, parts: [{ kind: 'tool_use', name: extractClaudeLocalCommandName(text), input: undefined }] }];
      }
      const m = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      const stdout = m?.[1]?.trim() ?? '';
      return stdout ? [{ id: uuid, role: 'system', ts, parts: [{ kind: 'tool_result', forId: uuid, text: stdout }] }] : [];
    }
    if (!text) return [];
    return [{ id: uuid, role: 'system', ts, parts: [{ kind: 'tool_use', name: (evt.subtype ?? 'system').replace(/_/g, ' '), input: text }] }];
  }

  if (evt.type === 'assistant') {
    const parts: TranscriptPart[] = [];
    if (typeof content === 'string') {
      if (content.trim()) parts.push({ kind: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          parts.push({ kind: 'text', text: b.text });
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          parts.push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
        // thinking / redacted_thinking blocks are intentionally dropped
      }
    }
    return parts.length ? [{ id: uuid, role: 'assistant', ts, parts }] : [];
  }

  if (evt.type === 'user') {
    if (typeof content === 'string') {
      // The slash command's NAME lives here (a synthetic user-role event),
      // not on the system/local_command event that follows it — that one
      // only carries the command's stdout (often empty). Surface this as
      // the "a command ran" signal instead of dropping it as synthetic.
      if (content.startsWith('<command-name>')) {
        return [{ id: uuid, role: 'system', ts, parts: [{ kind: 'tool_use', name: extractClaudeLocalCommandName(content), input: undefined }] }];
      }
      return looksLikeRealUserMessage(content)
        ? [{ id: uuid, role: 'user', ts, parts: [{ kind: 'text', text: content }] }]
        : [];
    }
    if (Array.isArray(content)) {
      const userParts: TranscriptPart[] = [];
      const toolParts: TranscriptPart[] = [];
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as { type?: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type === 'text' && typeof b.text === 'string' && looksLikeRealUserMessage(b.text)) {
          userParts.push({ kind: 'text', text: b.text });
        } else if (b.type === 'tool_result') {
          toolParts.push({ kind: 'tool_result', forId: b.tool_use_id, text: extractClaudeToolResultText(b.content), isError: b.is_error });
        }
      }
      const turns: TranscriptTurn[] = [];
      if (toolParts.length) turns.push({ id: `${uuid}:tool`, role: 'tool', ts, parts: toolParts });
      if (userParts.length) turns.push({ id: `${uuid}:user`, role: 'user', ts, parts: userParts });
      return turns;
    }
  }

  return [];
}

const claudeHistory: AgentHistoryAdapter = {
  listConversations(cwd: string): Conversation[] {
    const dir = join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd));
    if (!existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return [];
    }
    const out: Conversation[] = [];
    for (const fname of entries) {
      const id = fname.slice(0, -'.jsonl'.length);
      const fpath = join(dir, fname);
      try {
        const raw = readFileSync(fpath, 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        let title: string | undefined;
        let firstTs: string | undefined;
        let lastTs: string | undefined;
        for (const line of lines) {
          let evt: { type?: string; timestamp?: string; message?: unknown };
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.timestamp) {
            if (!firstTs) firstTs = evt.timestamp;
            lastTs = evt.timestamp;
          }
          if (!title && evt.type === 'user') {
            const text = extractClaudeUserText(evt.message);
            if (text && looksLikeRealUserMessage(text)) {
              title = text.split('\n')[0]!.slice(0, 100).trim();
            }
          }
        }
        const stat = statSync(fpath);
        out.push({
          id,
          title: title ?? '(no opener)',
          startedAt: firstTs ?? new Date(stat.ctimeMs).toISOString(),
          lastMessageAt: lastTs ?? new Date(stat.mtimeMs).toISOString(),
          messageCount: lines.length,
        });
      } catch {
        // skip unreadable / malformed files
      }
    }
    return out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  },
  countConversations(cwd: string): number {
    // Fast directory-only count — does NOT parse any transcript file.
    // The session-list view calls this on every poll; parsing was reading
    // hundreds of MB per render before, blocking the event loop for
    // seconds and timing the page out.
    const dir = join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd));
    if (!existsSync(dir)) return 0;
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
    } catch {
      return 0;
    }
  },
  lookupTitle(cwd: string, id: string): string | undefined {
    // Direct file open by id — claude's encoded-cwd dir + `<id>.jsonl`.
    const fpath = join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd), `${id}.jsonl`);
    if (!existsSync(fpath)) return undefined;
    try {
      const raw = readFileSync(fpath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let evt: { type?: string; message?: unknown };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'user') {
          const text = extractClaudeUserText(evt.message);
          if (text && looksLikeRealUserMessage(text)) {
            return text.split('\n')[0]!.slice(0, 100).trim();
          }
        }
      }
    } catch {
      // unreadable
    }
    return undefined;
  },
  resumeFlag(id: string): string {
    return `--resume ${id}`;
  },
  currentTranscript(cwd: string, sessionId?: string): string | undefined {
    const dir = join(homedir(), '.claude', 'projects', encodeClaudeCwd(cwd));
    if (!existsSync(dir)) return undefined;
    // A pinned/resumed session id maps deterministically to its own file —
    // prefer it over the mtime guess below, which is only ever a heuristic
    // and is wrong whenever two same-cwd sessions are both active (verified
    // live: this exact daemon's own dev session shadowed a genuinely
    // unrelated tmux-claude session sharing the same cwd).
    if (sessionId) {
      const pinned = join(dir, `${sessionId}.jsonl`);
      if (existsSync(pinned)) return pinned;
    }
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return undefined;
    }
    let best: string | undefined;
    let bestMtime = -1;
    for (const f of files) {
      const fpath = join(dir, f);
      try {
        const m = statSync(fpath).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = fpath;
        }
      } catch {
        // skip
      }
    }
    return best;
  },
  readTranscript(path: string): TranscriptTurn[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const turns: TranscriptTurn[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let evt: Parameters<typeof normalizeClaudeEvent>[0];
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      for (const t of normalizeClaudeEvent(evt)) turns.push(t);
    }
    return turns;
  },
  parseTranscriptLine(line: string): TranscriptTurn[] {
    if (!line) return [];
    let evt: Parameters<typeof normalizeClaudeEvent>[0];
    try {
      evt = JSON.parse(line);
    } catch {
      return [];
    }
    return normalizeClaudeEvent(evt);
  },
};

/**
 * Codex CLI stores each session as
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. The
 * directory tree is global (not partitioned by cwd), so we have to open
 * each .jsonl to discover its cwd from the first event (`session_meta`
 * with `payload.cwd`). `countConversations` opens the first line only;
 * `listConversations` reads the whole file to extract title + boundary
 * timestamps + message count.
 *
 * Synthetic user messages (`<environment_context>...`, `<permissions...`,
 * developer system prompts) are skipped when picking the title so the
 * picker shows the real conversation opener.
 *
 * Resume flag: `resume <id>` (codex CLI uses subcommand-style resume).
 * Validated that the agent's default global flag accepts trailing
 * subcommand: `codex --dangerously-bypass-approvals-and-sandbox resume <id>`.
 */
function readFirstNonEmptyLine(fpath: string): string | undefined {
  // Read chunks until the first newline is found. Codex .jsonl session
  // files are big (full transcripts) but the leading session_meta event
  // itself can be ~20-35KB once the base_instructions blob is embedded.
  // We chunk-read up to 256KB and bail if we still haven't seen a \n
  // (something is wrong with the file — likely not really JSONL).
  try {
    const fd = openSync(fpath, 'r');
    try {
      const chunkSize = 65536;
      const maxBytes = 262144;
      let acc = '';
      let offset = 0;
      const buf = Buffer.alloc(chunkSize);
      while (offset < maxBytes) {
        const n = readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        acc += buf.subarray(0, n).toString('utf8');
        const nl = acc.indexOf('\n');
        if (nl >= 0) return acc.slice(0, nl);
        offset += n;
      }
      return acc.length > 0 ? acc : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function walkCodexSessionFiles(): string[] {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && name.startsWith('rollout-') && name.endsWith('.jsonl')) {
          files.push(full);
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return files;
}

function codexSessionCwd(fpath: string): string | undefined {
  const first = readFirstNonEmptyLine(fpath);
  if (!first) return undefined;
  try {
    const evt = JSON.parse(first) as { type?: string; payload?: { cwd?: string } };
    if (evt.type === 'session_meta' && typeof evt.payload?.cwd === 'string') {
      return evt.payload.cwd;
    }
  } catch {
    // not parseable
  }
  return undefined;
}

/**
 * Codex has no --session-id-equivalent flag, so a fresh spawn's id can't be
 * chosen ahead of time the way Claude Code's sessionIdFlag does. Instead:
 * snapshot the existing rollout files right before spawn, then poll for a
 * NEW one to appear whose session_meta.cwd matches — that new file's id is
 * the just-spawned session's id, discovered instead of guessed. Once the
 * file exists, session_meta is its very first line, so no need to wait for
 * further content to identify it — BUT the file itself doesn't come into
 * existence right away. Confirmed live: after `/new` (or a fresh spawn),
 * nothing appears on disk until the operator's next real message — this is
 * exactly what FRESH_SESSION_ID_DETECT_TIMEOUT_MS's generous window
 * protects against.
 */
async function codexDetectFreshSessionId(ctx: { cwd: string }): Promise<string | undefined> {
  const before = new Set(walkCodexSessionFiles());
  const deadline = Date.now() + FRESH_SESSION_ID_DETECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const fpath of walkCodexSessionFiles()) {
      if (before.has(fpath)) continue;
      const first = readFirstNonEmptyLine(fpath);
      if (!first) continue;
      try {
        const evt = JSON.parse(first) as { type?: string; payload?: { cwd?: string; id?: string } };
        if (evt.type === 'session_meta' && evt.payload?.cwd === ctx.cwd && typeof evt.payload.id === 'string') {
          return evt.payload.id;
        }
      } catch {
        // not parseable yet (file created but first line not fully written) — try again next poll
      }
    }
  }
  return undefined;
}

function isCodexSyntheticUserText(text: string): boolean {
  // Codex prepends several synthetic "user" messages at session start +
  // mid-session that aren't real operator input:
  //   - `# AGENTS.md instructions for <path>` — auto-injected AGENTS.md
  //   - `<environment_context>...</environment_context>` — cwd / shell
  //   - `<permissions>...` — sandbox profile recap
  //   - `<user_instructions>...` — user_instructions config blob
  //   - `<turn_aborted>...` — user Ctrl+C signal recap
  return text.startsWith('<environment_context>') ||
         text.startsWith('<permissions') ||
         text.startsWith('<user_instructions>') ||
         text.startsWith('<turn_aborted>') ||
         text.startsWith('# AGENTS.md instructions');
}

/**
 * Deterministic per-line id for codex response_item events that carry no
 * uuid of their own (unlike Claude's per-event uuid). Must be a pure
 * function of the line's own bytes so readTranscript's snapshot and
 * parseTranscriptLine's live tail produce the SAME id for the same event —
 * that's what lets the client de-dup the overlap where the tail catches up
 * to the snapshot.
 */
function codexLineId(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

/**
 * Flatten a codex function_call_output's `output` string. Shape varies by
 * tool: exec_command emits a plain "Chunk ID / Wall time / Output:" string;
 * MCP-backed tools emit a JSON-encoded content-block array
 * (`[{"type":"text","text":"..."}]`, the OpenAI tool-output convention).
 */
function extractCodexFunctionOutputText(output: unknown): string {
  if (typeof output !== 'string') return output == null ? '' : String(output);
  const trimmed = output.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const texts = parsed
          .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : undefined))
          .filter((t): t is string => t !== undefined);
        if (texts.length) return texts.join('\n');
      }
    } catch {
      // not JSON — fall through to the raw string
    }
  }
  return output;
}

/**
 * exec_command results carry no explicit success flag, just a trailing
 * "Process exited with code N" line — a nonzero N is the only error signal
 * available. MCP-backed tool outputs have no equivalent convention, so they
 * default to not-an-error (matches Claude tool_results with no is_error set).
 */
function codexOutputIsError(output: unknown): boolean {
  if (typeof output !== 'string') return false;
  const m = output.match(/Process exited with code (\d+)/);
  return m ? m[1] !== '0' : false;
}

/**
 * Map one parsed codex response_item event to 0..1 normalized chat turns.
 * `reasoning` and `web_search_call` payloads are intentionally dropped —
 * same convention as claudeHistory dropping thinking/redacted_thinking
 * blocks. `developer`-role messages (permissions/collaboration-mode system
 * text) are dropped too; only user/assistant `message` payloads and
 * function_call/function_call_output pairs render in the chat view.
 */
function normalizeCodexEvent(
  evt: {
    type?: string;
    timestamp?: string;
    payload?: {
      type?: string;
      role?: string;
      content?: unknown;
      name?: string;
      arguments?: string;
      call_id?: string;
      output?: unknown;
    };
  },
  lineId: string,
): TranscriptTurn[] {
  if (evt.type !== 'response_item' || !evt.payload) return [];
  const p = evt.payload;
  const ts = evt.timestamp;

  if (p.type === 'message') {
    if (p.role !== 'user' && p.role !== 'assistant') return []; // developer / system — not shown
    const wantBlockType = p.role === 'user' ? 'input_text' : 'output_text';
    const blocks = Array.isArray(p.content) ? p.content : [];
    const texts: string[] = [];
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: string; text?: string };
      if (b.type !== wantBlockType || typeof b.text !== 'string') continue;
      if (p.role === 'user' && isCodexSyntheticUserText(b.text)) continue;
      if (b.text.trim()) texts.push(b.text);
    }
    if (!texts.length) return [];
    return [{ id: `${lineId}:${p.role}`, role: p.role, ts, parts: [{ kind: 'text', text: texts.join('\n\n') }] }];
  }

  if (p.type === 'function_call' && typeof p.name === 'string' && typeof p.call_id === 'string') {
    let input: unknown = p.arguments;
    if (typeof p.arguments === 'string') {
      try { input = JSON.parse(p.arguments); } catch { input = p.arguments; }
    }
    return [{ id: `call:${p.call_id}`, role: 'tool', ts, parts: [{ kind: 'tool_use', id: p.call_id, name: p.name, input }] }];
  }

  if (p.type === 'function_call_output' && typeof p.call_id === 'string') {
    return [{
      id: `output:${p.call_id}`,
      role: 'tool',
      ts,
      parts: [{ kind: 'tool_result', forId: p.call_id, text: extractCodexFunctionOutputText(p.output), isError: codexOutputIsError(p.output) }],
    }];
  }

  return [];
}

const codexHistory: AgentHistoryAdapter = {
  listConversations(cwd: string): Conversation[] {
    const files = walkCodexSessionFiles();
    const out: Conversation[] = [];
    for (const fpath of files) {
      let raw: string;
      try {
        raw = readFileSync(fpath, 'utf8');
      } catch {
        continue;
      }
      const lines = raw.split('\n').filter((l) => l.length > 0);
      if (lines.length === 0) continue;
      let id: string | undefined;
      let sessionCwd: string | undefined;
      let title: string | undefined;
      let firstTs: string | undefined;
      let lastTs: string | undefined;
      for (const line of lines) {
        let evt: {
          type?: string;
          timestamp?: string;
          payload?: { cwd?: string; id?: string; role?: string; content?: unknown };
        };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.timestamp) {
          if (!firstTs) firstTs = evt.timestamp;
          lastTs = evt.timestamp;
        }
        if (evt.type === 'session_meta' && evt.payload) {
          if (typeof evt.payload.cwd === 'string') sessionCwd = evt.payload.cwd;
          if (typeof evt.payload.id === 'string') id = evt.payload.id;
        }
        if (!title && evt.type === 'response_item' && evt.payload?.role === 'user') {
          const c = evt.payload.content;
          if (Array.isArray(c)) {
            for (const block of c) {
              if (typeof block === 'object' && block !== null) {
                const b = block as { type?: string; text?: string };
                if (typeof b.text === 'string' && !isCodexSyntheticUserText(b.text)) {
                  title = b.text.split('\n')[0]!.slice(0, 100).trim();
                  break;
                }
              }
            }
          }
        }
      }
      if (!sessionCwd || sessionCwd !== cwd || !id) continue;
      const stat = statSync(fpath);
      out.push({
        id,
        title: title ?? '(no opener)',
        startedAt: firstTs ?? new Date(stat.ctimeMs).toISOString(),
        lastMessageAt: lastTs ?? new Date(stat.mtimeMs).toISOString(),
        messageCount: lines.length,
      });
    }
    return out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  },
  countConversations(cwd: string): number {
    // Open first line only of each file — codex jsonl can be huge but the
    // session_meta is always the first event. Avoids parsing transcripts
    // on every session-list poll.
    const files = walkCodexSessionFiles();
    let count = 0;
    for (const fpath of files) {
      if (codexSessionCwd(fpath) === cwd) count++;
    }
    return count;
  },
  lookupTitle(_cwd: string, id: string): string | undefined {
    // Codex session filenames carry the uuid as suffix
    // (rollout-<ts>-<uuid>.jsonl), so we can find the file by walking
    // and matching the basename without needing the cwd filter — id
    // alone is unique.
    const files = walkCodexSessionFiles();
    const target = files.find((f) => f.endsWith(`-${id}.jsonl`));
    if (!target) return undefined;
    try {
      const raw = readFileSync(target, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let evt: { type?: string; payload?: { role?: string; content?: unknown } };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === 'response_item' && evt.payload?.role === 'user' && Array.isArray(evt.payload.content)) {
          for (const block of evt.payload.content) {
            if (typeof block === 'object' && block !== null) {
              const b = block as { type?: string; text?: string };
              if (typeof b.text === 'string' && !isCodexSyntheticUserText(b.text)) {
                return b.text.split('\n')[0]!.slice(0, 100).trim();
              }
            }
          }
        }
      }
    } catch {
      // unreadable
    }
    return undefined;
  },
  resumeFlag(id: string): string {
    return `resume ${id}`;
  },
  currentTranscript(cwd: string, sessionId?: string): string | undefined {
    // Codex has no --session-id-equivalent flag to pin a FRESH spawn's id
    // ahead of time (unlike Claude Code's sessionIdFlag) — but a RESUMED
    // session's id is already known deterministically (session.resumeFrom),
    // and the server already threads it through as `sessionId` here. Same
    // cross-session-shadowing risk as the Claude Code bug this mirrors:
    // the cwd+mtime guess below has zero correlation to which tmux session
    // it's actually for whenever two sessions share a cwd. Filenames carry
    // the uuid as a suffix (rollout-<ts>-<uuid>.jsonl — same trick as
    // lookupTitle), so a pinned id can be resolved exactly instead of
    // guessed, whenever one is available.
    const files = walkCodexSessionFiles();
    if (sessionId) {
      const pinned = files.find((f) => f.endsWith(`-${sessionId}.jsonl`));
      if (pinned) return pinned;
    }
    let best: string | undefined;
    let bestMtime = -1;
    for (const fpath of files) {
      if (codexSessionCwd(fpath) !== cwd) continue;
      try {
        const m = statSync(fpath).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = fpath;
        }
      } catch {
        // skip
      }
    }
    return best;
  },
  readTranscript(path: string): TranscriptTurn[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const turns: TranscriptTurn[] = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let evt: Parameters<typeof normalizeCodexEvent>[0];
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      for (const t of normalizeCodexEvent(evt, codexLineId(line))) turns.push(t);
    }
    return turns;
  },
  parseTranscriptLine(line: string): TranscriptTurn[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let evt: Parameters<typeof normalizeCodexEvent>[0];
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return normalizeCodexEvent(evt, codexLineId(trimmed));
  },
};

/**
 * Antigravity CLI (`agy`) writes a single file at
 * `~/.gemini/antigravity-cli/history.jsonl` — every interactive prompt
 * from every session appends one line: `{display, timestamp, workspace,
 * conversationId?}`. Conversations are reconstructed by grouping lines
 * with the same `conversationId` and matching `workspace`. The first
 * recorded line without a `conversationId` is a one-off (no
 * conversation row).
 *
 * Resume flag: `--conversation <id>`. `agy -c` for the most recent
 * conversation also exists but isn't surfaced here — the picker is
 * always by-id.
 */
interface AgyHistoryLine {
  display?: string;
  timestamp?: number;
  workspace?: string;
  conversationId?: string;
}

function readAgyHistory(): AgyHistoryLine[] {
  const fpath = join(homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
  if (!existsSync(fpath)) return [];
  let raw: string;
  try {
    raw = readFileSync(fpath, 'utf8');
  } catch {
    return [];
  }
  const out: AgyHistoryLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as AgyHistoryLine);
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * A live agy conversation additionally logs every completed step (one JSON
 * object per line) to `~/.gemini/antigravity-cli/brain/<conversationId>/
 * .system_generated/logs/transcript.jsonl` — unlike history.jsonl (prompts
 * only), this file carries the full back-and-forth: user turns, assistant
 * replies (+ dropped `thinking`), and tool operations. Confirmed against
 * the CLI's own internal SQLite `conversations/<id>.db` step_payload blobs,
 * which reference this exact path as their "full untruncated conversation"
 * log.
 *
 * agy bundles a tool call and its result into ONE completed-step event
 * (unlike Claude/Codex's separate call/output pair) — there is no
 * intermediate "pending call" line to correlate against. So each such event
 * renders as a synthetic tool_use (named after the event's `type`) paired
 * with its tool_result in the same turn. System bookkeeping event types
 * (CONVERSATION_HISTORY / EPHEMERAL_MESSAGE / CHECKPOINT / SYSTEM_MESSAGE)
 * are dropped — same convention as Claude's meta/sidechain filtering.
 */
interface AgyTranscriptEvent {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  error?: string;
  thinking?: string;
}

const AGY_SKIP_TRANSCRIPT_TYPES = new Set(['CONVERSATION_HISTORY', 'EPHEMERAL_MESSAGE', 'CHECKPOINT', 'SYSTEM_MESSAGE']);
// USER_INPUT content wraps the real prompt in <USER_REQUEST> alongside
// <ADDITIONAL_METADATA>/<USER_SETTINGS_CHANGE> noise appended after it.
const AGY_USER_REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;

function agyLineId(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

function agyTranscriptPath(conversationId: string): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

function walkAgyBrainTranscripts(): string[] {
  const root = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
  if (!existsSync(root)) return [];
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const id of ids) {
    const p = agyTranscriptPath(id);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

function normalizeAgyTranscriptEvent(evt: AgyTranscriptEvent, lineId: string): TranscriptTurn[] {
  const type = evt.type;
  if (!type || AGY_SKIP_TRANSCRIPT_TYPES.has(type)) return [];
  const ts = evt.created_at;

  if (type === 'USER_INPUT') {
    const raw = evt.content ?? '';
    const m = raw.match(AGY_USER_REQUEST_RE);
    const text = (m ? m[1]! : raw).trim();
    if (!text) return [];
    return [{ id: lineId, role: 'user', ts, parts: [{ kind: 'text', text }] }];
  }

  if (type === 'PLANNER_RESPONSE') {
    // `thinking` intentionally dropped — same convention as claudeHistory's
    // thinking/redacted_thinking and codexHistory's reasoning blocks.
    const text = (evt.content ?? '').trim();
    if (!text) return [];
    return [{ id: lineId, role: 'assistant', ts, parts: [{ kind: 'text', text }] }];
  }

  if (type === 'ERROR_MESSAGE') {
    const text = evt.content ?? evt.error ?? '';
    if (!text) return [];
    return [{ id: lineId, role: 'tool', ts, parts: [{ kind: 'tool_result', forId: lineId, text, isError: true }] }];
  }

  // Every other type is a bundled tool call + result (RUN_COMMAND, VIEW_FILE,
  // GREP_SEARCH, LIST_DIRECTORY, ASK_QUESTION, CODE_ACTION, GENERIC, and any
  // tool type agy adds later — deliberately not an exhaustive allowlist).
  const text = evt.content ?? '';
  if (!text) return [];
  return [{
    id: lineId,
    role: 'tool',
    ts,
    parts: [
      { kind: 'tool_use', id: `${lineId}:call`, name: type.toLowerCase(), input: undefined },
      { kind: 'tool_result', forId: `${lineId}:call`, text },
    ],
  }];
}

const agyHistory: AgentHistoryAdapter = {
  listConversations(cwd: string): Conversation[] {
    const lines = readAgyHistory();
    const groups = new Map<string, AgyHistoryLine[]>();
    for (const line of lines) {
      if (line.workspace !== cwd) continue;
      if (!line.conversationId) continue;
      const arr = groups.get(line.conversationId) ?? [];
      arr.push(line);
      groups.set(line.conversationId, arr);
    }
    const out: Conversation[] = [];
    for (const [id, items] of groups) {
      const sorted = items.slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const firstTs = first.timestamp ? new Date(first.timestamp).toISOString() : new Date(0).toISOString();
      const lastTs = last.timestamp ? new Date(last.timestamp).toISOString() : firstTs;
      const title = (first.display ?? '(no opener)').split('\n')[0]!.slice(0, 100).trim();
      out.push({
        id,
        title: title || '(no opener)',
        startedAt: firstTs,
        lastMessageAt: lastTs,
        messageCount: items.length,
      });
    }
    return out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  },
  countConversations(cwd: string): number {
    // Single-file scan, count distinct conversationIds matching cwd.
    const lines = readAgyHistory();
    const ids = new Set<string>();
    for (const line of lines) {
      if (line.workspace === cwd && line.conversationId) ids.add(line.conversationId);
    }
    return ids.size;
  },
  lookupTitle(_cwd: string, id: string): string | undefined {
    // Single-file scan for the first display with the matching id.
    const lines = readAgyHistory();
    let earliest: AgyHistoryLine | undefined;
    for (const line of lines) {
      if (line.conversationId !== id) continue;
      if (!earliest || (line.timestamp ?? 0) < (earliest.timestamp ?? 0)) earliest = line;
    }
    if (!earliest?.display) return undefined;
    return earliest.display.split('\n')[0]!.slice(0, 100).trim();
  },
  resumeFlag(id: string): string {
    return `--conversation ${id}`;
  },
  currentTranscript(_cwd: string): string | undefined {
    // Deliberately ignores cwd. history.jsonl's workspace->conversationId
    // mapping (and agy's own cache/last_conversations.json) both turned out
    // to be unreliable for THIS: verified live against a real running agy
    // session where neither had recorded the conversationId actually in
    // use (confirmed by cross-checking the process's own inotify-watched
    // directory via /proc/<pid>/fdinfo). What IS reliable: the file agy is
    // actively appending to is unambiguously the newest by mtime — in a
    // real comparison the live transcript's mtime was ~11 days newer than
    // the next-newest candidate. So: newest-mtime-wins, globally, no cwd
    // filter. Known limitation: if two agy sessions in different cwds are
    // both live at once, both chat views resolve to the same (most recent)
    // one until the older session produces new output of its own.
    let best: string | undefined;
    let bestMtime = -1;
    for (const p of walkAgyBrainTranscripts()) {
      try {
        const m = statSync(p).mtimeMs;
        if (m > bestMtime) {
          bestMtime = m;
          best = p;
        }
      } catch {
        // skip unreadable
      }
    }
    return best;
  },
  readTranscript(path: string): TranscriptTurn[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return [];
    }
    const turns: TranscriptTurn[] = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let evt: AgyTranscriptEvent;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      for (const t of normalizeAgyTranscriptEvent(evt, agyLineId(line))) turns.push(t);
    }
    return turns;
  },
  parseTranscriptLine(line: string): TranscriptTurn[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let evt: AgyTranscriptEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return normalizeAgyTranscriptEvent(evt, agyLineId(trimmed));
  },
};

/**
 * Gemini CLI stores each session as
 * `~/.gemini/tmp/<project-basename>/chats/session-<timestamp>-<short>.jsonl`.
 * The directory basename is a UI nicety, not load-bearing — the leading
 * `session_meta` line carries the source-of-truth `projectHash`, which
 * equals `sha256(cwd)`. Adapter walks every `chats/` subdir and matches
 * by projectHash so non-default directory naming (or multiple cwds
 * sharing a basename) doesn't break filtering.
 *
 * Resume flag: `--session-file <path>`. Gemini's `--resume` takes a
 * numeric index from `--list-sessions`, NOT a session id — indexes shift
 * when sessions get added/deleted, so they're not stable for llmux's
 * id-based picker. `--session-file` loads any jsonl path directly,
 * which is what we want.
 */
function sha256OfPath(p: string): string {
  return createHash('sha256').update(p).digest('hex');
}

function walkSessionJsonlFiles(tmpRoot: string): string[] {
  if (!existsSync(tmpRoot)) return [];
  const files: string[] = [];
  let outer: string[];
  try {
    outer = readdirSync(tmpRoot);
  } catch {
    return [];
  }
  for (const projectDir of outer) {
    const chats = join(tmpRoot, projectDir, 'chats');
    if (!existsSync(chats)) continue;
    let inner: string[];
    try {
      inner = readdirSync(chats);
    } catch {
      continue;
    }
    for (const f of inner) {
      if (f.startsWith('session-') && f.endsWith('.jsonl')) {
        files.push(join(chats, f));
      }
    }
  }
  return files;
}

interface GeminiSessionMeta {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  kind?: string;
}

function parseGeminiSessionMeta(fpath: string): GeminiSessionMeta | undefined {
  const first = readFirstNonEmptyLine(fpath);
  if (!first) return undefined;
  try {
    return JSON.parse(first) as GeminiSessionMeta;
  } catch {
    return undefined;
  }
}

/**
 * Shared by Gemini CLI and Qwen Code (both built on makeGeminiLikeAdapter).
 * Unlike Claude/Codex, currentTranscript here has NEVER accepted a pinned
 * sessionId at all — pure cwd-hash+mtime guess, the same latent cross-
 * session-shadowing risk Codex had before it was fixed, just not yet
 * reported for these two. `/clear` ("Clear the screen and start a new
 * session") creates a new file the same way Claude's does, so New Chat
 * needs the same detect-and-repin treatment. Same snapshot-then-poll
 * shape as claudeDetectFreshSessionId/codexDetectFreshSessionId.
 */
async function geminiLikeDetectFreshSessionId(tmpRoot: () => string, ctx: { cwd: string }): Promise<string | undefined> {
  const cwdHash = sha256OfPath(ctx.cwd);
  const before = new Set(walkSessionJsonlFiles(tmpRoot()));
  const deadline = Date.now() + FRESH_SESSION_ID_DETECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const fpath of walkSessionJsonlFiles(tmpRoot())) {
      if (before.has(fpath)) continue;
      const meta = parseGeminiSessionMeta(fpath);
      if (meta?.projectHash === cwdHash && meta.sessionId) return meta.sessionId;
    }
  }
  return undefined;
}

function geminiLineId(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

interface GeminiChatEvent {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  toolCalls?: Array<{ id?: string; name?: string; args?: unknown; result?: unknown }>;
}

/** Extract text from either a plain string (gemini/error/info events) or an array of {text} parts (user events). */
function extractGeminiText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.length ? content : undefined;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string') {
        texts.push((part as { text: string }).text);
      }
    }
    return texts.length ? texts.join('\n\n') : undefined;
  }
  return undefined;
}

function geminiContentHasFunctionResponse(content: unknown): boolean {
  return Array.isArray(content) && content.some((p) => typeof p === 'object' && p !== null && 'functionResponse' in (p as object));
}

/**
 * A toolCall's `result` is Gemini's own functionResponse envelope
 * (`[{ functionResponse: { response: { output } } }]`), not a plain string —
 * unwrap it the same way extractCodexFunctionOutputText unwraps codex's
 * MCP-style output arrays.
 */
function geminiToolResultText(result: unknown): string {
  if (Array.isArray(result)) {
    const texts: string[] = [];
    for (const part of result) {
      const fr = (typeof part === 'object' && part !== null ? (part as { functionResponse?: { response?: unknown } }).functionResponse : undefined);
      const output = fr && typeof fr.response === 'object' && fr.response !== null ? (fr.response as { output?: unknown }).output : undefined;
      if (typeof output === 'string') texts.push(output);
      else texts.push(typeof part === 'string' ? part : JSON.stringify(part));
    }
    return texts.join('\n');
  }
  if (result == null) return '';
  return typeof result === 'string' ? result : JSON.stringify(result);
}

/**
 * Map one line of a gemini/qwen session jsonl to 0..n normalized chat turns.
 * `$set`-only lines (mid-stream metadata patches) and the leading
 * session_meta line carry no `type` and are dropped. `info` events are UI
 * chrome (dropped); `error` events are real, user-visible failures and
 * render as an error card. A `user` event whose content is ONLY
 * functionResponse parts is dropped — that's the same tool result already
 * bundled into the originating `gemini` event's own `toolCalls[].result`,
 * so rendering both would double the tool card. `thoughts` (gemini's
 * thinking) are intentionally dropped, same convention as Claude/Codex.
 */
function normalizeGeminiChatEvent(evt: GeminiChatEvent, lineId: string): TranscriptTurn[] {
  const type = evt.type;
  if (!type) return [];
  const ts = evt.timestamp;

  if (type === 'user') {
    if (geminiContentHasFunctionResponse(evt.content)) return [];
    const text = extractGeminiText(evt.content)?.trim();
    if (!text) return [];
    return [{ id: lineId, role: 'user', ts, parts: [{ kind: 'text', text }] }];
  }

  if (type === 'gemini') {
    const turns: TranscriptTurn[] = [];
    const text = extractGeminiText(evt.content)?.trim();
    if (text) turns.push({ id: lineId, role: 'assistant', ts, parts: [{ kind: 'text', text }] });
    if (Array.isArray(evt.toolCalls)) {
      for (const call of evt.toolCalls) {
        if (!call || typeof call.name !== 'string') continue;
        const callId = call.id ?? `${lineId}:${call.name}`;
        turns.push({
          id: `${lineId}:${callId}`,
          role: 'tool',
          ts,
          parts: [
            { kind: 'tool_use', id: callId, name: call.name, input: call.args },
            { kind: 'tool_result', forId: callId, text: geminiToolResultText(call.result) },
          ],
        });
      }
    }
    return turns;
  }

  if (type === 'error') {
    const text = typeof evt.content === 'string' ? evt.content : '';
    if (!text) return [];
    return [{ id: lineId, role: 'tool', ts, parts: [{ kind: 'tool_result', forId: lineId, text, isError: true }] }];
  }

  if (type === 'info') {
    // Neither gemini nor qwen log a distinct "slash command ran" event —
    // verified against real sessions, genuinely absent (unlike Claude,
    // where it's a real system/local_command event). `info` is the
    // closest useful signal that exists: auth-flow prompts, update
    // notices, request-cancelled — worth surfacing, especially for a
    // remote/mobile operator who can't see the terminal.
    const text = typeof evt.content === 'string' ? evt.content.trim() : '';
    if (!text) return [];
    return [{ id: lineId, role: 'system', ts, parts: [{ kind: 'tool_use', name: 'info', input: text }] }];
  }

  return []; // any future type — UI chrome, not conversation.
}

function makeGeminiLikeAdapter(opts: {
  tmpRoot: () => string;
  resumeFlag: (id: string, fpath: string) => string;
}): AgentHistoryAdapter {
  return {
    listConversations(cwd: string): Conversation[] {
      const cwdHash = sha256OfPath(cwd);
      const files = walkSessionJsonlFiles(opts.tmpRoot());
      const out: Conversation[] = [];
      for (const fpath of files) {
        let raw: string;
        try {
          raw = readFileSync(fpath, 'utf8');
        } catch {
          continue;
        }
        const lines = raw.split('\n').filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        let meta: GeminiSessionMeta | undefined;
        try {
          meta = JSON.parse(lines[0]!) as GeminiSessionMeta;
        } catch {
          continue;
        }
        if (!meta?.projectHash || meta.projectHash !== cwdHash || !meta.sessionId) continue;
        // Title — first event after the session_meta whose content is a
        // user message we'd actually surface. Gemini events carry
        // `type: 'user'` with `content` strings, but also synthetic
        // `info` and tool events we want to skip.
        let title: string | undefined;
        for (let i = 1; i < lines.length && !title; i++) {
          try {
            const evt = JSON.parse(lines[i]!) as { type?: string; content?: unknown };
            if (evt.type !== 'user') continue;
            // Gemini/qwen events carry content either as a string or as
            // an array of {text} parts. Extract the first text fragment.
            let text: string | undefined;
            if (typeof evt.content === 'string') {
              text = evt.content;
            } else if (Array.isArray(evt.content)) {
              for (const part of evt.content) {
                if (typeof part === 'object' && part !== null) {
                  const p = part as { text?: unknown };
                  if (typeof p.text === 'string') { text = p.text; break; }
                }
              }
            }
            if (text && text.length > 0) {
              title = text.split('\n')[0]!.slice(0, 100).trim();
            }
          } catch {
            // skip malformed line
          }
        }
        out.push({
          id: meta.sessionId,
          title: title ?? '(no opener)',
          startedAt: meta.startTime ?? new Date(statSync(fpath).ctimeMs).toISOString(),
          lastMessageAt: meta.lastUpdated ?? meta.startTime ?? new Date(statSync(fpath).mtimeMs).toISOString(),
          messageCount: lines.length,
          // The resume verb needs the file path for gemini, so smuggle it
          // through the `id` field's downstream lookup by stashing it
          // alongside. We use a simple convention: when resumeFlag is
          // called, we map back from sessionId to fpath via a scan.
        });
      }
      return out.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    },
    countConversations(cwd: string): number {
      const cwdHash = sha256OfPath(cwd);
      const files = walkSessionJsonlFiles(opts.tmpRoot());
      let count = 0;
      for (const fpath of files) {
        const meta = parseGeminiSessionMeta(fpath);
        if (meta?.projectHash === cwdHash) count++;
      }
      return count;
    },
    lookupTitle(_cwd: string, id: string): string | undefined {
      // Find the one session matching sessionId, then walk its lines for
      // the first real user message. Same title extractor as
      // listConversations, just scoped to a single file.
      const files = walkSessionJsonlFiles(opts.tmpRoot());
      for (const fpath of files) {
        const meta = parseGeminiSessionMeta(fpath);
        if (meta?.sessionId !== id) continue;
        let raw: string;
        try {
          raw = readFileSync(fpath, 'utf8');
        } catch {
          return undefined;
        }
        const lines = raw.split('\n').filter((l) => l.length > 0);
        for (let i = 1; i < lines.length; i++) {
          try {
            const evt = JSON.parse(lines[i]!) as { type?: string; content?: unknown };
            if (evt.type !== 'user') continue;
            let text: string | undefined;
            if (typeof evt.content === 'string') text = evt.content;
            else if (Array.isArray(evt.content)) {
              for (const part of evt.content) {
                if (typeof part === 'object' && part !== null) {
                  const p = part as { text?: unknown };
                  if (typeof p.text === 'string') { text = p.text; break; }
                }
              }
            }
            if (text && text.length > 0) return text.split('\n')[0]!.slice(0, 100).trim();
          } catch {
            // skip
          }
        }
        return undefined;
      }
      return undefined;
    },
    resumeFlag(id: string): string {
      // We need the file path for gemini's --session-file; for qwen we
      // accept the sessionId directly. Caller-provided `opts.resumeFlag`
      // decides the syntax. For path lookup, we re-scan the tmp tree.
      const files = walkSessionJsonlFiles(opts.tmpRoot());
      for (const fpath of files) {
        const meta = parseGeminiSessionMeta(fpath);
        if (meta?.sessionId === id) return opts.resumeFlag(id, fpath);
      }
      // Fall back to the id-only form if we somehow can't find the file
      // (file deleted between list and resume). Better to attempt than
      // silently fail.
      return opts.resumeFlag(id, '');
    },
    currentTranscript(cwd: string, sessionId?: string): string | undefined {
      // Unlike agy, projectHash is embedded directly in each file's own
      // first line (sha256 of cwd, written once at session creation) —
      // no lossy external cache to join through, so newest-mtime-among-
      // cwd-matched-files is reliable here (same pattern as codex).
      const cwdHash = sha256OfPath(cwd);
      const files = walkSessionJsonlFiles(opts.tmpRoot());
      // A pinned id (from detectFreshSessionId, e.g. after New Chat) maps
      // deterministically — prefer it over the mtime guess below, which is
      // wrong whenever two same-cwd sessions of this agent are both active
      // (same cross-session-shadowing risk the Claude Code / Codex fixes
      // closed — this adapter never had pinning at all until now).
      if (sessionId) {
        for (const fpath of files) {
          const meta = parseGeminiSessionMeta(fpath);
          if (meta?.sessionId === sessionId) return fpath;
        }
      }
      let best: string | undefined;
      let bestMtime = -1;
      for (const fpath of files) {
        const meta = parseGeminiSessionMeta(fpath);
        if (meta?.projectHash !== cwdHash) continue;
        try {
          const m = statSync(fpath).mtimeMs;
          if (m > bestMtime) {
            bestMtime = m;
            best = fpath;
          }
        } catch {
          // skip unreadable
        }
      }
      return best;
    },
    readTranscript(path: string): TranscriptTurn[] {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        return [];
      }
      const turns: TranscriptTurn[] = [];
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let evt: GeminiChatEvent;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        for (const t of normalizeGeminiChatEvent(evt, geminiLineId(line))) turns.push(t);
      }
      return turns;
    },
    parseTranscriptLine(line: string): TranscriptTurn[] {
      const trimmed = line.trim();
      if (!trimmed) return [];
      let evt: GeminiChatEvent;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        return [];
      }
      return normalizeGeminiChatEvent(evt, geminiLineId(trimmed));
    },
  };
}

const geminiHistory: AgentHistoryAdapter = makeGeminiLikeAdapter({
  tmpRoot: () => join(homedir(), '.gemini', 'tmp'),
  resumeFlag: (_id, fpath) => fpath ? `--session-file ${fpath}` : '',
});

const qwenHistory: AgentHistoryAdapter = makeGeminiLikeAdapter({
  tmpRoot: () => join(homedir(), '.qwen', 'tmp'),
  resumeFlag: (id, _fpath) => `--resume ${id}`,
});

/**
 * OpenCode stores sessions in a sqlite DB at
 * `~/.local/share/opencode/opencode.db` (XDG_DATA_HOME-respecting, same
 * path on macOS + Linux). The `session` table joins to cwd via the
 * `directory` column (raw string match — no path encoding); the
 * `message` table holds per-message rows.
 *
 * Uses `better-sqlite3` — synchronous (fits the adapter interface),
 * battle-tested, ships prebuilt binaries for the common targets via
 * prebuild-install. We swapped from `node:sqlite` in v0.33.3 because:
 *
 *   - `node:sqlite` is stable from node 22.5 only. On node 20.x and
 *     22.0-22.4 the prior try/catch fallback left a silent feature gap
 *     (opencode would just have no resume picker with no signal).
 *   - `node:sqlite` emits an `ExperimentalWarning: SQLite is an
 *     experimental feature and might change at any time` on every
 *     module load, which leaked into the operator's CLI output on
 *     `session resume`.
 *   - better-sqlite3 has no F6-class risk — no separately-exec'd
 *     helper binary like node-pty's `spawn-helper`; just a single
 *     `dlopen`'d `.node` addon.
 *
 * `engines.node` stays `>=20`.
 *
 * The DB is opened read-only with `fileMustExist: true` on every call.
 * DB-level WAL handles concurrent reads with opencode's writer cleanly;
 * open + close per call is ms-scale and safer than caching a
 * connection across daemon lifetime.
 *
 * Filtering rationale (per mac's verified spec):
 *   - `s.directory = ?` matches llmux's session cwd exactly
 *   - `s.time_archived IS NULL` skips archived sessions
 *   - `s.parent_id IS NULL` keeps only top-level sessions (skips forks)
 *
 * Resume flag: `--session <id>`. Verified that opencode accepts an
 * unknown session id with "Session not found: <id>" (i.e. it parses
 * the flag and tries to load by id), so the syntax is correct.
 */
function opencodeDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(xdg, 'opencode', 'opencode.db');
}

interface OpencodeRow {
  id: string;
  title: string;
  time_created: number | bigint;
  time_updated: number | bigint;
  message_count: number | bigint;
}

function epochMsToIso(v: number | bigint): string {
  return new Date(Number(v)).toISOString();
}

function openOpencodeDb(): InstanceType<typeof Database> | undefined {
  const path = opencodeDbPath();
  if (!existsSync(path)) return undefined;
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return undefined;
  }
}

/**
 * OpenCode's currentTranscript never accepted a pinned sessionId at all —
 * pure cwd+time_updated guess, same latent cross-session-shadowing risk
 * Codex had before it was fixed. `/new` ("New session") creates a genuinely
 * new row in the session table, so New Chat needs the same detect-and-repin
 * treatment as the other agents. Same snapshot-then-poll shape, querying
 * the session table instead of walking files.
 */
async function opencodeDetectFreshSessionId(ctx: { cwd: string }): Promise<string | undefined> {
  const snapshot = (): Set<string> => {
    const db = openOpencodeDb();
    if (!db) return new Set();
    try {
      const rows = db.prepare(`SELECT id FROM session WHERE directory = ?`).all(ctx.cwd) as { id: string }[];
      return new Set(rows.map((r) => r.id));
    } catch {
      return new Set();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  };
  const before = snapshot();
  const deadline = Date.now() + FRESH_SESSION_ID_DETECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const id of snapshot()) {
      if (!before.has(id)) return id;
    }
  }
  return undefined;
}

// Never a real filesystem path — a marker the SSE handler checks for to
// pick the poll-only branch (see currentTranscript's docstring below).
const OPENCODE_SYNTHETIC_PREFIX = 'opencode-session:';

function opencodeSyntheticPath(sessionId: string): string {
  return `${OPENCODE_SYNTHETIC_PREFIX}${sessionId}`;
}

function opencodeSessionIdFromPath(path: string): string | undefined {
  return path.startsWith(OPENCODE_SYNTHETIC_PREFIX) ? path.slice(OPENCODE_SYNTHETIC_PREFIX.length) : undefined;
}

interface OpencodeMessagePartRow {
  message_id: string;
  message_data: string;
  part_id: string;
  part_data: string;
}

interface OpencodeToolState {
  status?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

function opencodeToolResultText(state: OpencodeToolState): string {
  if (typeof state.output === 'string') return state.output;
  if (state.output != null) return JSON.stringify(state.output);
  if (typeof state.error === 'string') return state.error;
  if (state.error != null) return JSON.stringify(state.error);
  return '';
}

/**
 * Map one `part` row to 0..1 normalized turns. `reasoning` (thinking
 * equivalent), `step-start`/`step-finish` (turn bookkeeping), and `patch`
 * (file-diff snapshot marker for /undo — verified real: {hash, files}, no
 * conversational content) are all intentionally dropped, same convention
 * as every other adapter's non-content event types.
 */
function normalizeOpencodePart(part: unknown, role: 'user' | 'assistant', id: string): TranscriptTurn[] {
  if (typeof part !== 'object' || part === null) return [];
  const p = part as { type?: string; text?: string; tool?: string; callID?: string; state?: OpencodeToolState };
  if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
    return [{ id, role, parts: [{ kind: 'text', text: p.text }] }];
  }
  if (p.type === 'tool') {
    const name = typeof p.tool === 'string' ? p.tool : 'tool';
    const state = p.state ?? {};
    return [{
      id,
      role: 'tool',
      parts: [
        { kind: 'tool_use', id: p.callID, name, input: state.input },
        { kind: 'tool_result', forId: p.callID, text: opencodeToolResultText(state), isError: state.status === 'error' },
      ],
    }];
  }
  return [];
}

const opencodeHistory: AgentHistoryAdapter = {
  listConversations(cwd: string): Conversation[] {
    const db = openOpencodeDb();
    if (!db) return [];
    try {
      const rows = db.prepare(
        `SELECT s.id AS id, s.title AS title, s.time_created AS time_created,
                s.time_updated AS time_updated, COUNT(m.id) AS message_count
         FROM session s
         LEFT JOIN message m ON m.session_id = s.id
         WHERE s.directory = ? AND s.time_archived IS NULL AND s.parent_id IS NULL
         GROUP BY s.id
         ORDER BY s.time_updated DESC`
      ).all(cwd) as unknown as OpencodeRow[];
      return rows.map((r) => ({
        id: r.id,
        title: r.title || '(no title)',
        startedAt: epochMsToIso(r.time_created),
        lastMessageAt: epochMsToIso(r.time_updated),
        messageCount: Number(r.message_count),
      }));
    } catch {
      return [];
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  },
  countConversations(cwd: string): number {
    const db = openOpencodeDb();
    if (!db) return 0;
    try {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM session
         WHERE directory = ? AND time_archived IS NULL AND parent_id IS NULL`
      ).get(cwd) as { n: number | bigint } | undefined;
      return row ? Number(row.n) : 0;
    } catch {
      return 0;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  },
  lookupTitle(_cwd: string, id: string): string | undefined {
    const db = openOpencodeDb();
    if (!db) return undefined;
    try {
      const row = db.prepare(`SELECT title FROM session WHERE id = ? LIMIT 1`).get(id) as { title?: string } | undefined;
      return row?.title ?? undefined;
    } catch {
      return undefined;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  },
  resumeFlag(id: string): string {
    return `--session ${id}`;
  },
  // OpenCode stores conversations in SQLite (WAL mode, confirmed via the
  // .db-wal/.db-shm files present alongside opencode.db) — the existing
  // file-tailing SSE mechanism (byte-offset draining + fs.watch on a
  // growing text file) fundamentally doesn't apply: WAL writes often don't
  // touch the main .db file's size at all, and even when they do, new bytes
  // are B-tree page data, not JSON-per-line. So there's no parseTranscriptLine
  // here at all (intentionally omitted, not stubbed) — the chat GUI's SSE
  // handler treats an adapter with currentTranscript+readTranscript but no
  // parseTranscriptLine as "poll-only": it just re-runs readTranscript on
  // the existing 2s interval and resends the tail, relying on the client's
  // own per-turn-id dedup (already in place for the file-tailing case) to
  // skip anything already rendered. currentTranscript returns a synthetic
  // `opencode-session:<id>` identifier (never a real path) precisely so
  // that branch can detect this case instead of trying to fs.watch it.
  currentTranscript(cwd: string, sessionId?: string): string | undefined {
    const db = openOpencodeDb();
    if (!db) return undefined;
    try {
      // A pinned id (from detectFreshSessionId, e.g. after New Chat) maps
      // deterministically — prefer it over the mtime guess below, which is
      // wrong whenever two same-cwd sessions of this agent are both active
      // (same cross-session-shadowing risk the Claude Code / Codex fixes
      // closed — this adapter never had pinning at all until now).
      if (sessionId) {
        const pinned = db.prepare(
          `SELECT id FROM session WHERE id = ? AND directory = ? AND time_archived IS NULL`
        ).get(sessionId, cwd) as { id: string } | undefined;
        if (pinned) return opencodeSyntheticPath(pinned.id);
      }
      const row = db.prepare(
        `SELECT id FROM session
         WHERE directory = ? AND time_archived IS NULL AND parent_id IS NULL
         ORDER BY time_updated DESC LIMIT 1`
      ).get(cwd) as { id: string } | undefined;
      return row ? opencodeSyntheticPath(row.id) : undefined;
    } catch {
      return undefined;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  },
  readTranscript(path: string): TranscriptTurn[] {
    const sessionId = opencodeSessionIdFromPath(path);
    if (!sessionId) return [];
    const db = openOpencodeDb();
    if (!db) return [];
    try {
      const rows = db.prepare(
        `SELECT m.id AS message_id, m.data AS message_data, p.id AS part_id, p.data AS part_data
         FROM message m JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
         ORDER BY m.time_created ASC, p.id ASC`
      ).all(sessionId) as unknown as OpencodeMessagePartRow[];
      const turns: TranscriptTurn[] = [];
      for (const row of rows) {
        let msg: { role?: string };
        let part: unknown;
        try {
          msg = JSON.parse(row.message_data) as { role?: string };
          part = JSON.parse(row.part_data);
        } catch {
          continue;
        }
        const role: 'user' | 'assistant' = msg.role === 'user' ? 'user' : 'assistant';
        for (const t of normalizeOpencodePart(part, role, `${row.message_id}:${row.part_id}`)) turns.push(t);
      }
      return turns;
    } catch {
      return [];
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  },
};

/**
 * WSL2 mounts the Windows filesystem under /mnt (C: → /mnt/c, …) and marks
 * every file there world-executable. A bare PATH scan therefore "finds"
 * Windows binaries (e.g. an npm-global `codex` shim under
 * /mnt/c/Users/.../.npm-global) that CANNOT run as a Linux interactive agent
 * in a tmux pane. Reporting one is a false positive: the picker offers the
 * agent, then the spawn produces a broken pane. Detect WSL once and ignore
 * PATH entries under the Windows mount root so detection stays honest — no
 * config needed from the operator. No-op off WSL.
 */
const IS_WSL = (() => {
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
})();

const isWindowsMount = (dir: string): boolean => dir === '/mnt' || dir.startsWith('/mnt/');

const which = (cmd: string): boolean => {
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    if (IS_WSL && isWindowsMount(dir)) continue; // Windows binaries can't drive a Linux pty
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // not in this dir
    }
  }
  return false;
};

const copilotInstalled = (): boolean => {
  // `gh copilot` is a built-in subcommand of gh 2.92+ (not an extension), and
  // the actual Copilot CLI binary is downloaded on first invocation to
  // ~/.local/share/gh/copilot. Treat the binary's presence as the install
  // signal — `gh extension list` no longer surfaces copilot.
  return existsSync(join(homedir(), '.local/share/gh/copilot'));
};

const claudeInstalled = (): boolean => {
  // Claude Code ships two ways and we must detect either. which() is WSL-aware,
  // so a Windows-only claude under /mnt is correctly ignored (not a false hit).
  //   1) Node / npm-global  — `npm install -g @anthropic-ai/claude-code` drops a
  //                           `claude` executable on PATH (npm/nvm bin dir).
  //   2) Native installer   — `curl … claude.ai/install.sh | bash` symlinks
  //                           ~/.local/bin/claude → ~/.local/share/claude/versions/<v>.
  // The native-dir check is a fallback for when ~/.local/bin isn't on PATH
  // (login vs non-login shell), so a freshly-native-installed claude is still
  // found without the operator fixing their PATH first.
  if (which('claude')) return true;                                              // node global, or native symlink on PATH
  return existsSync(join(homedir(), '.local', 'share', 'claude', 'versions'));   // native install, even if off PATH
};

export const DEFAULT_AGENTS: Record<string, AgentDefinition> = {
  claude:   { key: 'claude',   displayName: 'Claude Code',         cmd: 'claude',       flags: '--dangerously-skip-permissions',     readyPrompt: '^>', detectInstalled: claudeInstalled, installHint: 'curl -fsSL https://claude.ai/install.sh | bash', docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview', history: claudeHistory, sessionIdFlag: (id) => `--session-id ${id}`, detectFreshSessionId: claudeDetectFreshSessionId, newChatCommand: '/clear' },
  codex:    { key: 'codex',    displayName: 'Codex CLI',           cmd: 'codex',        flags: '--dangerously-bypass-approvals-and-sandbox',     readyPrompt: '^>', installHint: 'npm install -g @openai/codex',                    docsUrl: 'https://github.com/openai/codex', history: codexHistory, preSpawn: codexPreSpawnTrust, detectFreshSessionId: codexDetectFreshSessionId, newChatCommand: '/new' },
  agy:      { key: 'agy',      displayName: 'Antigravity CLI',     cmd: 'agy',          flags: '--dangerously-skip-permissions',  readyPrompt: '^agy>', installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', docsUrl: 'https://antigravity.google/docs/cli-install', history: agyHistory, newChatCommand: '/clear' },
  gemini:   { key: 'gemini',   displayName: 'Gemini CLI',          cmd: 'gemini',       flags: '--yolo',     readyPrompt: '^>', installHint: 'npm install -g @google/gemini-cli',               docsUrl: 'https://github.com/google-gemini/gemini-cli', history: geminiHistory, detectFreshSessionId: (ctx) => geminiLikeDetectFreshSessionId(() => join(homedir(), '.gemini', 'tmp'), ctx), newChatCommand: '/clear' },
  qwen:     { key: 'qwen',     displayName: 'Qwen Code',           cmd: 'qwen',         flags: '--yolo',     readyPrompt: '^>', installHint: 'npm install -g @qwen-code/qwen-code',             docsUrl: 'https://github.com/QwenLM/qwen-code', history: qwenHistory, detectFreshSessionId: (ctx) => geminiLikeDetectFreshSessionId(() => join(homedir(), '.qwen', 'tmp'), ctx), newChatCommand: '/clear' },
  // OpenCode's --dangerously-skip-permissions only applies to `opencode run`
  // (one-shot). The TUI default mode rejects it and exits — danger mode in
  // the TUI is controlled via OPENCODE_YOLO=1 instead.
  // No model flag set — OpenCode honors the operator's own config at
  // ~/.config/opencode/opencode.json (provider + default model). Operator
  // overrides per-spawn via the flags field if they want a specific model
  // (e.g. `-m openrouter/anthropic/claude-sonnet-4.6` or
  // `-m ollama/qwen2.5-coder:14b`).
  opencode: { key: 'opencode', displayName: 'OpenCode',            cmd: 'opencode',     readyPrompt: '^>', installHint: 'curl -fsSL https://opencode.ai/install | bash',   docsUrl: 'https://opencode.ai',          envDefaults: { OPENCODE_YOLO: '1' }, history: opencodeHistory, detectFreshSessionId: opencodeDetectFreshSessionId, newChatCommand: '/new' },
  amp:      { key: 'amp',      displayName: 'Sourcegraph Amp',     cmd: 'amp',          flags: '--dangerously-allow-all',     readyPrompt: '^>', installHint: 'npm install -g @sourcegraph/amp',                 docsUrl: 'https://ampcode.com/manual' },
  grok:     { key: 'grok',     displayName: 'Grok Build CLI',      cmd: 'grok',         flags: '--always-approve', readyPrompt: '^grok>', installHint: 'curl -fsSL https://x.ai/cli/install.sh | bash',   docsUrl: 'https://x.ai/cli' },
  aider:    { key: 'aider',    displayName: 'Aider',               cmd: 'aider',        flags: '--yes-always --model claude-opus-4-6',   readyPrompt: '^> $', installHint: 'python -m pip install aider-chat',                docsUrl: 'https://aider.chat' },
  continue: { key: 'continue', displayName: 'Continue CLI',        cmd: 'cn',           flags: '--auto',     readyPrompt: '^>', installHint: 'npm install -g @continuedev/cli',                 docsUrl: 'https://docs.continue.dev/guides/cli' },
  kiro:     { key: 'kiro',     displayName: 'Kiro CLI',            cmd: 'kiro-cli',     flags: '--trust-all-tools',     readyPrompt: '^>', installHint: 'brew install kiro  # or see docs for Linux/Windows', docsUrl: 'https://kiro.dev/docs/cli/installation/' },
  cursor:   { key: 'cursor',   displayName: 'Cursor CLI',          cmd: 'cursor-agent',     readyPrompt: '^>', installHint: 'curl https://cursor.com/install -fsSL | bash',    docsUrl: 'https://cursor.com/docs/cli/installation' },
  plandex:  { key: 'plandex',  displayName: 'Plandex',             cmd: 'plandex',     readyPrompt: '^>', installHint: 'curl -fsSL https://plandex.ai/install.sh | bash', docsUrl: 'https://docs.plandex.ai' },
  // goose has no launch flag — auto-approve is controlled via GOOSE_MODE=auto.
  goose:    { key: 'goose',    displayName: 'Goose',               cmd: 'goose', readyPrompt: 'Goose❯', installHint: 'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', docsUrl: 'https://block.github.io/goose', envDefaults: { GOOSE_MODE: 'auto' } },
  copilot:  { key: 'copilot',  displayName: 'GitHub Copilot CLI',  cmd: 'gh copilot',      detectInstalled: copilotInstalled, readyPrompt: '●', installHint: 'gh copilot suggest "hi"  # gh prerequisite; first run downloads', docsUrl: 'https://docs.github.com/en/copilot/how-tos/use-copilot-in-the-cli' },
};

export function isAgentInstalled(agent: AgentDefinition): boolean {
  if (agent.detectInstalled) return agent.detectInstalled();
  // For multi-word commands, check only the first token.
  const head = agent.cmd.split(/\s+/)[0]!;
  return which(head);
}

