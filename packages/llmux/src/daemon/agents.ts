import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
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
  return true;
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
};

const which = (cmd: string): boolean => {
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
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

export const DEFAULT_AGENTS: Record<string, AgentDefinition> = {
  claude:   { key: 'claude',   displayName: 'Claude Code',         cmd: 'claude',       flags: '--dangerously-skip-permissions',     readyPrompt: '^>', installHint: 'curl -fsSL https://claude.ai/install.sh | bash', docsUrl: 'https://docs.claude.com/en/docs/claude-code/overview', history: claudeHistory },
  codex:    { key: 'codex',    displayName: 'Codex CLI',           cmd: 'codex',        flags: '--dangerously-bypass-approvals-and-sandbox',     readyPrompt: '^>', installHint: 'npm install -g @openai/codex',                    docsUrl: 'https://github.com/openai/codex', history: codexHistory },
  agy:      { key: 'agy',      displayName: 'Antigravity CLI',     cmd: 'agy',          flags: '--dangerously-skip-permissions',  readyPrompt: '^agy>', installHint: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', docsUrl: 'https://antigravity.google/docs/cli-install', history: agyHistory },
  gemini:   { key: 'gemini',   displayName: 'Gemini CLI',          cmd: 'gemini',       flags: '--yolo',     readyPrompt: '^>', installHint: 'npm install -g @google/gemini-cli',               docsUrl: 'https://github.com/google-gemini/gemini-cli', history: geminiHistory },
  qwen:     { key: 'qwen',     displayName: 'Qwen Code',           cmd: 'qwen',         flags: '--yolo',     readyPrompt: '^>', installHint: 'npm install -g @qwen-code/qwen-code',             docsUrl: 'https://github.com/QwenLM/qwen-code', history: qwenHistory },
  // OpenCode's --dangerously-skip-permissions only applies to `opencode run`
  // (one-shot). The TUI default mode rejects it and exits — danger mode in
  // the TUI is controlled via OPENCODE_YOLO=1 instead.
  // No model flag set — OpenCode honors the operator's own config at
  // ~/.config/opencode/opencode.json (provider + default model). Operator
  // overrides per-spawn via the flags field if they want a specific model
  // (e.g. `-m openrouter/anthropic/claude-sonnet-4.6` or
  // `-m ollama/qwen2.5-coder:14b`).
  opencode: { key: 'opencode', displayName: 'OpenCode',            cmd: 'opencode',     readyPrompt: '^>', installHint: 'curl -fsSL https://opencode.ai/install | bash',   docsUrl: 'https://opencode.ai',          envDefaults: { OPENCODE_YOLO: '1' }, history: opencodeHistory },
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

