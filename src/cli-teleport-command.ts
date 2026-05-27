import { isAbsolute } from 'node:path';
import { runCommand } from './command-runner.js';
import type { CommandRunner } from './command-runner.js';
import { required, type ParsedArguments } from './cli-arguments.js';
import { resolveTaskId } from './cli-task-id.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { ScrumlordError } from './errors.js';
import { findWorktreeForBranch } from './git-status.js';
import type { TaskStore } from './types.js';

const successPath = (path: string, advisory: string): CliResult => ({
  exitCode: 0,
  stdout: `${path}\n`,
  stderr: advisory,
});

/**
 * One-line stderr advisory shown when teleport runs *without* `--print` and the
 * `tasks-teleport` shell function does not appear to be installed (its
 * `TASKS_TELEPORT_SHELL` marker is absent). The binary cannot change the parent
 * shell's directory itself; only the shell function can. The marker is advisory,
 * not proof — a false positive/negative just shows or hides this one line.
 */
const SHELL_FUNCTION_ADVISORY =
  'note: `tasks teleport` cannot change your shell directory itself. ' +
  'Use the `tasks-teleport` shell function (install it with `tasks setup --shell`), ' +
  'or `cd "$(tasks teleport <id> --print)"`.\n';

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
  advisory: string,
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

  return successPath(lookup.path, advisory);
};

/**
 * Locates the existing git worktree for a task and prints its absolute path on
 * stdout (path-only, newline-terminated) so a shell can `cd "$(…)"`.
 *
 * With `--print` the binary stays silent on stderr — this is the path the
 * installed `tasks-teleport` shell function consumes. Without `--print`, and
 * when the shell function's `TASKS_TELEPORT_SHELL` marker is absent, it adds a
 * one-line advisory on stderr: a child process cannot change the parent shell's
 * directory, so the shell function (or an explicit `cd "$(…)"`) is required. The
 * advisory never touches stdout, so `cd "$(…)"` and JSON consumers are
 * unaffected. Errors use the shared CLI output boundary (`--json` forces JSON).
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

  // When the caller passes an explicit environment, trust it exclusively (keeps
  // tests hermetic against an ambient marker); otherwise read the real env.
  const environment = options.environment ?? Bun.env;
  const shellFunctionInstalled = environment['TASKS_TELEPORT_SHELL'] !== undefined;
  const advisory =
    parsed.flags.has('print') || shellFunctionInstalled ? '' : SHELL_FUNCTION_ADVISORY;

  const runner: CommandRunner = options.runner ?? runCommand;
  return resolveWorktreePath(store.projectRoot, task.id, task.branch, runner, advisory);
};

export const TELEPORT_SHELL_SNIPPET = [
  '# Added by `tasks setup --shell`. Cd into the worktree for a task.',
  '# Marks the shell function as installed so the bare `tasks teleport` binary',
  "# skips its can't-change-your-directory advisory.",
  'export TASKS_TELEPORT_SHELL=1',
  'tasks-teleport() {',
  '  local destination',
  '  destination="$(command tasks teleport "$@" --print)" || return $?',
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
  '  destination="$(command tasks teleport "$task_id" --print 2>/dev/null)" || return $status',
  '  [ -n "$destination" ] && cd "$destination"',
  '  return $status',
  '}',
  '',
].join('\n');
