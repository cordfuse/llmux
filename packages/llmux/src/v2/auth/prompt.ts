// Interactive prompts for the CLI auth verbs.
//
// Trust context: CLIENT (runs in the operator's terminal).
//
// readPassphrase reads from the TTY in raw mode and never echoes the
// passphrase. Falls back to noop if stdin isn't a TTY (CI / scripted use
// — in that case the caller should be passing --passphrase or
// LLMUX_PASSPHRASE rather than relying on stdin).

export async function readPassphrase(prompt: string = 'Passphrase: '): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new Error('passphrase required: pass --passphrase or set LLMUX_PASSPHRASE (stdin is not a TTY)');
  }
  stdout.write(prompt);

  return new Promise((resolve, reject) => {
    const chars: string[] = [];
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        switch (ch) {
          case '\r':
          case '\n':
            cleanup();
            resolve(chars.join(''));
            return;
          case '': // Ctrl-C
            cleanup();
            reject(new Error('passphrase entry cancelled'));
            return;
          case '': // Backspace
          case '\b':
            if (chars.length > 0) chars.pop();
            break;
          default:
            if (ch >= ' ') chars.push(ch);
            break;
        }
      }
    };
    stdin.on('data', onData);
  });
}
