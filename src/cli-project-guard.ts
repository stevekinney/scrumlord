import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { assertProjectMatchesWorkingTree } from './project-identity.js';
import type { TaskStore } from './types.js';

/**
 * Commands that touch the filesystem or git for the *current* working tree
 * (plan paths, worktrees, PR state, agent launches). Running these with a
 * `--project` selector that points at a different repository would mutate one
 * project's task rows while operating on another's filesystem, so they are
 * guarded by {@link guardProjectWorkingTree}.
 */
const filesystemDependentCommands = new Set([
  'start',
  'pipeline',
  'locate',
  'resolve',
  'sync',
  'audit',
  'merge',
]);

const filesystemDependentByFlag: Array<[command: string, flag: string]> = [
  ['plan', 'start'],
  ['cleanup', 'worktrees'],
  ['pr', 'sync'],
  ['overview', 'sync'],
  ['complete', 'sync'],
];

const isFilesystemDependent = (parsed: ParsedArguments): boolean => {
  if (parsed.command && filesystemDependentCommands.has(parsed.command)) return true;
  return filesystemDependentByFlag.some(
    ([command, flag]) => parsed.command === command && parsed.flags.has(flag),
  );
};

/**
 * Rejects a `--project` selector that points at a different working tree than
 * the current directory for filesystem/git-dependent commands. Database-only
 * commands (list, get, update, …) are unaffected and may target any project.
 */
export const guardProjectWorkingTree = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<void> => {
  if (options.projectFlag === undefined || !isFilesystemDependent(parsed)) return;
  await assertProjectMatchesWorkingTree(
    {
      status: 'resolved',
      id: 0,
      nameWithOwner: options.projectFlag,
      gitCommonDir: store.projectGitCommonDir,
    },
    options.cwd ?? process.cwd(),
  );
};

/**
 * Appends a stderr notice when a read command ran against an unresolved
 * project, so callers can tell "no project here" apart from "this project has
 * no tasks". Stdout is left untouched (parsers and raw-string forms are
 * unaffected) and the exit code stays as-is.
 */
export const withUnresolvedProjectNotice = (result: CliResult, store: TaskStore): CliResult => {
  if (store.projectResolved || result.exitCode !== 0) return result;
  const notice = 'project: unresolved (no git repository here; pass --project to scope)';
  return { ...result, stderr: result.stderr ? `${result.stderr}\n${notice}` : notice };
};
