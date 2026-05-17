import { isAbsolute } from 'node:path';
import { runCommand } from './command-runner.js';
import type { CommandRunner } from './command-runner.js';
import { required, type ParsedArguments } from './cli-arguments.js';
import { resolveTaskId } from './cli-task-id.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { ScrumlordError } from './errors.js';
import { findWorktreeForBranch } from './git-status.js';
import type { TaskStore } from './types.js';

const AGENT_ENV_VARS = ['CLAUDECODE', 'CODEX_MANAGED_BY_BUN'] as const;

const environmentValue = (
  options: Pick<CliOptions, 'environment'>,
  name: string,
): string | undefined => options.environment?.[name] ?? Bun.env[name];

const wantsJson = (parsed: ParsedArguments, options: CliOptions): boolean => {
  if (parsed.flags.has('json')) return true;
  return AGENT_ENV_VARS.some((name) => environmentValue(options, name) === '1');
};

const successPath = (path: string): CliResult => ({
  exitCode: 0,
  stdout: `${path}\n`,
  stderr: '',
});

const humanError = (message: string): CliResult => ({
  exitCode: 1,
  stdout: '',
  stderr: `${message}\n`,
});

const errorResult = (json: boolean, code: string, message: string): CliResult => {
  if (json) throw new ScrumlordError(code, message);
  return humanError(message);
};

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
  json: boolean,
): Promise<CliResult> => {
  const lookup = await findWorktreeForBranch(projectRoot, branch, runner);

  if (lookup.kind === 'failed') {
    const detail = normalizeStderr(lookup.stderr) || 'unknown error';
    return errorResult(
      json,
      'teleport_worktree_lookup_failed',
      `Could not list git worktrees: ${detail}`,
    );
  }

  if (lookup.kind === 'not_found') {
    return errorResult(
      json,
      'teleport_no_worktree',
      `No worktree found for task ${taskId} on branch ${branch}.`,
    );
  }

  // Defense: git porcelain reports absolute paths in practice, but we enforce
  // it. A relative path would silently work for `cd` but breaks the documented
  // contract and any consumer that records the path.
  if (!isAbsolute(lookup.path)) {
    return errorResult(
      json,
      'teleport_worktree_lookup_failed',
      `Could not list git worktrees: git returned a non-absolute path (${lookup.path}).`,
    );
  }

  return successPath(lookup.path);
};

/**
 * Locates the existing git worktree for a task and prints its absolute path.
 * On success, stdout is path-only (newline-terminated) so shells can
 * `cd "$(tasks teleport <id>)"`. On error, format follows the json flag or
 * agent env vars: --json or CLAUDECODE=1 / CODEX_MANAGED_BY_BUN=1 → JSON
 * envelope; otherwise human text on stderr.
 */
export const runTeleportCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const json = wantsJson(parsed, options);
  const input = required(parsed.positionals, 'task id');

  let taskId: string;
  try {
    taskId = await resolveTaskId(store, input);
  } catch (error) {
    if (!(error instanceof ScrumlordError) || json) throw error;
    return humanError(error.message);
  }

  const task = store.getTask(taskId);
  if (!task) {
    return errorResult(json, 'task_not_found', `Task ${taskId} was not found.`);
  }

  if (!task.branch) {
    return errorResult(json, 'teleport_no_branch', `Task ${task.id} has no branch set.`);
  }

  const runner: CommandRunner = options.runner ?? runCommand;
  return resolveWorktreePath(store.projectRoot, task.id, task.branch, runner, json);
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
].join('\n');
