import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { flag, type ParsedArguments } from './cli-arguments.js';
import {
  generateBashCompletions,
  generateZshCompletions,
  defaultInstallPath,
} from './completions.js';
import { ScrumlordError } from './errors.js';
import type { CliOptions, CliResult } from './cli-types.js';

const getGenerator = (shell: string): (() => string) => {
  if (shell === 'bash') return generateBashCompletions;
  if (shell === 'zsh') return generateZshCompletions;
  throw new ScrumlordError(
    'unsupported_shell',
    `Unsupported shell: ${shell}. Supported shells: bash, zsh.`,
  );
};

const resolveInstallPath = (
  shell: string,
  customPath: string | undefined,
  env: Record<string, string | undefined>,
): string => {
  if (customPath) return customPath;
  if (shell !== 'bash' && shell !== 'zsh') {
    throw new ScrumlordError('unsupported_shell', `Unsupported shell: ${shell}.`);
  }
  try {
    return defaultInstallPath(shell, env);
  } catch {
    throw new ScrumlordError(
      'no_install_path',
      `Cannot determine install path for ${shell}. Set HOME or XDG_DATA_HOME, or pass --path.`,
    );
  }
};

/** Handles the `tasks completions <shell> [--install [--path <p>] [--force]]` command. */
export const runCompletionsBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const shell = parsed.positionals[0] ?? '';
  const install = parsed.flags.has('install');
  const force = parsed.flags.has('force');
  const customPath = flag(parsed.flags, 'path');

  if (customPath && !install) {
    throw new ScrumlordError('path_requires_install', '--path requires --install.');
  }
  if (force && !install) {
    throw new ScrumlordError('force_requires_install', '--force requires --install.');
  }

  const generator = getGenerator(shell);
  const script = generator();

  if (!install) {
    return { exitCode: 0, stdout: script, stderr: '' };
  }

  const env = options.environment ?? process.env;
  const installPath = resolveInstallPath(shell, customPath, env);

  if (!force && existsSync(installPath)) {
    throw new ScrumlordError(
      'completion_file_exists',
      `Completion file already exists: ${installPath}. Use --force to overwrite.`,
    );
  }

  await mkdir(dirname(installPath), { recursive: true });
  await writeFile(installPath, script, 'utf-8');

  return {
    exitCode: 0,
    stdout: `Completion script written to: ${installPath}\nSource it in your shell configuration to enable completions.\n`,
    stderr: '',
  };
};
