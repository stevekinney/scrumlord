import { required, type ParsedArguments } from './cli-arguments.js';
import { currentBranchTask } from './current-branch-task.js';
import { ScrumlordError } from './errors.js';
import type { TaskStore } from './types.js';

export const TASK_ID_TOKENS = ['current', 'next'] as const;

/**
 * Resolves a `<task-id>` argument to a concrete task id.
 * Accepts a task UUID, the literal `current`, or the literal `next`.
 * Tokens are case-sensitive and lowercase only.
 * Throws when the token cannot be resolved — no silent fallback.
 */
export const resolveTaskId = async (
  store: Pick<TaskStore, 'projectRoot' | 'withBranch' | 'next'>,
  input: string,
): Promise<string> => {
  if (!input) throw new ScrumlordError('missing_argument', 'task id is required.');
  if (input === 'current') {
    const task = await currentBranchTask(store);
    if (!task) {
      throw new ScrumlordError(
        'current_task_not_found',
        'No active task is assigned to the current Git branch.',
      );
    }
    return task.id;
  }
  if (input === 'next') {
    const task = store.next();
    if (!task) {
      throw new ScrumlordError('next_task_not_found', 'No next task is available.');
    }
    return task.id;
  }
  return input;
};

export const taskCommandArguments = (parsed: ParsedArguments): string[] =>
  parsed.positionals.slice(1);

export const requiredTaskCommandArgument = (
  parsed: ParsedArguments,
  name: string,
  index = 0,
): string => required(taskCommandArguments(parsed).slice(index), name);
