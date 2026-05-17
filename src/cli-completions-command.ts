import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  shell: 'bash' | 'zsh',
  customPath: string | undefined,
  env: Record<string, string | undefined>,
): string => {
  if (customPath) return customPath;
  try {
    return defaultInstallPath(shell, env);
  } catch {
    throw new ScrumlordError(
      'no_install_path',
      `Cannot determine install path for ${shell}. Set HOME or XDG_DATA_HOME, or pass --path.`,
    );
  }
};

const installSuccessMessage = (shell: 'bash' | 'zsh', installPath: string): string => {
  if (shell === 'zsh') {
    return (
      `Completion script written to: ${installPath}\n` +
      `\n` +
      `To enable completions, ensure the directory is in your $fpath and compinit is loaded.\n` +
      `Add to ~/.zshrc if not already present:\n` +
      `\n` +
      `  fpath=(${dirname(installPath)} $fpath)\n` +
      `  autoload -Uz compinit && compinit\n`
    );
  }
  return (
    `Completion script written to: ${installPath}\n` +
    `\n` +
    `To enable completions, add to ~/.bashrc:\n` +
    `  source ${installPath}\n` +
    `\n` +
    `Or if bash-completion v2 is installed, it may load automatically from that location.\n`
  );
};

const writeScriptFile = async (
  installPath: string,
  script: string,
  force: boolean,
): Promise<void> => {
  if (force) {
    await writeFile(installPath, script, 'utf-8');
    return;
  }
  // Use exclusive open to avoid TOCTOU race — throws EEXIST if file already exists
  let fileHandle;
  try {
    fileHandle = await open(installPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ScrumlordError(
        'completion_file_exists',
        `Completion file already exists: ${installPath}. Use --force to overwrite.`,
      );
    }
    throw error;
  }
  try {
    await fileHandle.writeFile(script, 'utf-8');
  } finally {
    await fileHandle.close();
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

  const validatedShell = shell as 'bash' | 'zsh';
  const env = options.environment ?? process.env;
  const installPath = resolveInstallPath(validatedShell, customPath, env);

  await mkdir(dirname(installPath), { recursive: true });
  await writeScriptFile(installPath, script, force);

  return {
    exitCode: 0,
    stdout: installSuccessMessage(validatedShell, installPath),
    stderr: '',
  };
};
