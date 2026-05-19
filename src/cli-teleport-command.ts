import { isAbsolute } from 'node:path';
import { runCommand } from './command-runner.js';
import type { CommandRunner } from './command-runner.js';
import { required, type ParsedArguments } from './cli-arguments.js';
import { resolveTaskId } from './cli-task-id.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { ScrumlordError } from './errors.js';
import { findWorktreeForBranch } from './git-status.js';
import type { TaskStore } from './types.js';

const successPath = (path: string): CliResult => ({
  exitCode: 0,
  stdout: `${path}\n`,
  stderr: '',
});

/** Collapses whitespace, trims, and strips trailing punctuation from git stderr. */
const normalizeStderr = (raw: string): string =>
  raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?:;]+$/, '');

const resolveWorktreePath = async (
  projectRoot: string,
  taskId: string,
  branch: string,
  runner: CommandRunner,
): Promise<CliResult> => {
  const lookup = await findWorktreeForBranch(projectRoot, branch, runner);

  if (lookup.kind === 'failed') {
    const detail = normalizeStderr(lookup.stderr) || 'unknown error';
    throw new ScrumlordError(
      'teleport_worktree_lookup_failed',
      `Could not list git worktrees: ${detail}`,
    );
  }

  if (lookup.kind === 'not_found') {
    throw new ScrumlordError(
      'teleport_no_worktree',
      `No worktree found for task ${taskId} on branch ${branch}.`,
    );
  }

  // Defense: git porcelain reports absolute paths in practice, but we enforce
  // it. A relative path would silently work for `cd` but breaks the documented
  // contract and any consumer that records the path.
  if (!isAbsolute(lookup.path)) {
    throw new ScrumlordError(
      'teleport_worktree_lookup_failed',
      `Could not list git worktrees: git returned a non-absolute path (${lookup.path}).`,
    );
  }

  return successPath(lookup.path);
};

/**
 * Locates the existing git worktree for a task and prints its absolute path.
 * On success, stdout is path-only (newline-terminated) so shells can
 * `cd "$(tasks teleport <id>)"`. On error, formatting is handled by the
 * shared CLI output boundary.
 */
export const runTeleportCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const input = required(parsed.positionals, 'task id');
  const taskId = await resolveTaskId(store, input);

  const task = store.getTask(taskId);
  if (!task) {
    throw new ScrumlordError('task_not_found', `Task ${taskId} was not found.`);
  }

  if (!task.branch) {
    throw new ScrumlordError('teleport_no_branch', `Task ${task.id} has no branch set.`);
  }

  const runner: CommandRunner = options.runner ?? runCommand;
  return resolveWorktreePath(store.projectRoot, task.id, task.branch, runner);
};

export const TELEPORT_SHELL_SNIPPET = [
  '# Added by `tasks setup --shell`. Cd into the worktree for a task.',
  'tasks-teleport() {',
  '  local destination',
  '  destination="$(command tasks teleport "$@")" || return $?',
  '  [ -n "$destination" ] || return 1',
  '  cd "$destination"',
  '}',
  '# Optional convenience alias — uncomment if you want it:',
  "# alias tt='tasks-teleport'",
  '',
  '# Wraps `tasks start` so the shell follows the agent into the task worktree.',
  '# After the agent exits, cds into the worktree (when one exists).',
  'tasks-start() {',
  '  command tasks start "$@"',
  '  local status=$?',
  '  local task_id="${@: -1}"',
  '  local destination',
  '  destination="$(command tasks teleport "$task_id" 2>/dev/null)" || return $status',
  '  [ -n "$destination" ] && cd "$destination"',
  '  return $status',
  '}',
  '',
].join('\n');
