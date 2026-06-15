#!/usr/bin/env bun
import { clientCommands, type ClientCommand } from './client.ts';

const VERSION = '0.0.0';

function printRootHelp(): void {
  const lines: string[] = [];
  lines.push('llmux — HTTP client for llmuxd');
  lines.push('');
  lines.push(`Version: ${VERSION}`);
  lines.push('');
  lines.push('Usage:');
  lines.push('  llmux <command> [options]');
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...Object.keys(clientCommands).map((k) => k.length));
  for (const [name, cmd] of Object.entries(clientCommands)) {
    lines.push(`  ${name.padEnd(width + 2)}${cmd.summary}`);
  }
  lines.push('');
  lines.push('Environment:');
  lines.push('  LLMUX_SERVER     Base URL of llmuxd (e.g. http://host:3000)');
  lines.push('  LLMUX_TOKEN      SAS token for authenticated requests');
  lines.push('');
  lines.push('Run `llmux <command> --help` for command-specific options.');
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printRootHelp();
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return;
  }

  const name = argv[0]!;
  const rest = argv.slice(1);
  const command: ClientCommand | undefined = clientCommands[name];

  if (!command) {
    console.error(`llmux: unknown command "${name}"`);
    console.error('Run `llmux --help` to see available commands.');
    process.exit(64);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(command.help());
    return;
  }

  try {
    await command.run(rest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`llmux ${name}: ${msg}`);
    process.exit(1);
  }
}

void main();
