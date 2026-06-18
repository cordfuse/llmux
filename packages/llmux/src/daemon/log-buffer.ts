/**
 * In-process ring buffer of recent log lines, surfaced via /api/logs and
 * /api/logs/stream so operators on the Logs web screen can tail the
 * daemon's own console output without shell access to the host.
 *
 * Wraps console.log / .info / .warn / .error at module-load time. Each call
 * still goes to the original stdout/stderr (preserving normal terminal
 * behavior); we just additionally capture the formatted string into the
 * buffer and notify subscribers.
 *
 * Buffer is fixed-size (latest LOG_BUFFER_MAX lines kept). Multi-line
 * messages are split per newline so each visible line becomes its own
 * LogEntry — keeps the timeline tidy.
 */

const LOG_BUFFER_MAX = 500;

export interface LogEntry {
  /** ISO-8601 UTC timestamp at the moment of the console call. */
  ts: string;
  /** Severity: 'info' (.log/.info), 'warn' (.warn), 'error' (.error). */
  level: 'info' | 'warn' | 'error';
  /** Single line of text. Multi-line messages produce multiple entries. */
  text: string;
}

type Subscriber = (entry: LogEntry) => void;

const buffer: LogEntry[] = [];
const subscribers = new Set<Subscriber>();
let installed = false;

function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  if (a === null || a === undefined) return String(a);
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

function push(level: LogEntry['level'], args: unknown[]): void {
  const text = args.map(formatArg).join(' ');
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) continue;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      text: rawLine,
    };
    buffer.push(entry);
    if (buffer.length > LOG_BUFFER_MAX) buffer.shift();
    for (const sub of subscribers) {
      try {
        sub(entry);
      } catch {
        // subscriber errors don't propagate
      }
    }
  }
}

/**
 * Wrap console at module-load time. Idempotent — second call is a no-op.
 * The wrapped functions still call the original implementations so the
 * operator's terminal sees the output unchanged.
 */
export function install(): void {
  if (installed) return;
  installed = true;
  const origLog = console.log.bind(console);
  const origInfo = console.info.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: unknown[]): void => {
    push('info', args);
    origLog(...args);
  };
  console.info = (...args: unknown[]): void => {
    push('info', args);
    origInfo(...args);
  };
  console.warn = (...args: unknown[]): void => {
    push('warn', args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]): void => {
    push('error', args);
    origError(...args);
  };
}

/** Snapshot the current buffer contents (newest at the end). */
export function getBuffer(): LogEntry[] {
  return buffer.slice();
}

/**
 * Register a callback that fires on every new entry. Returns an
 * unsubscribe function. Used by the SSE endpoint to stream live tails.
 */
export function subscribe(sub: Subscriber): () => void {
  subscribers.add(sub);
  return () => {
    subscribers.delete(sub);
  };
}

/** Buffer cap surfaced for the client so the UI can hint about retention. */
export function getCapacity(): number {
  return LOG_BUFFER_MAX;
}
