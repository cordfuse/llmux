#!/usr/bin/env bun
import { parseArgs, type ParsedArgs } from './cli.ts';
import { commands, defaultDaemon, type Command } from './commands.ts';

const VERSION = '0.0.0';

function printRootHelp(): void {
  const lines: string[] = [];
  lines.push('llmuxd — tmux-based AI agent session manager (daemon)');
  lines.push('');
  lines.push(`Version: ${VERSION}`);
  lines.push('');
  lines.push('Usage:');
  lines.push('  llmuxd <command> [options]');
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  for (const [name, cmd] of Object.entries(commands)) {
    lines.push(`  ${name.padEnd(width + 2)}${cmd.summary}`);
  }
  lines.push('');
  lines.push('Global flags:');
  lines.push('  --config <path>   Use a specific .llmux.yaml file');
  lines.push('  --help, -h        Show help for a command');
  lines.push('  --version, -v     Print version and exit');
  lines.push('');
  lines.push('Run `llmuxd <command> --help` for command-specific options.');
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === '--help' || argv[0] === '-h') {
    printRootHelp();
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return;
  }

  // Bare `llmuxd` (no subcommand) or `llmuxd --config x` runs the local daemon.
  if (argv.length === 0 || argv[0]!.startsWith('-')) {
    const parsed: ParsedArgs = parseArgs(argv, defaultDaemon.flags);
    await defaultDaemon.run(parsed);
    return;
  }

  const name = argv[0]!;
  const rest = argv.slice(1);
  const command: Command | undefined = commands[name];

  if (!command) {
    console.error(`llmuxd: unknown command "${name}"`);
    console.error('Run `llmuxd --help` to see available commands.');
    process.exit(64);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(command.help());
    return;
  }

  const parsed: ParsedArgs = parseArgs(rest, command.flags);

  try {
    await command.run(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`llmuxd ${name}: ${msg}`);
    process.exit(1);
  }
}

void main();
