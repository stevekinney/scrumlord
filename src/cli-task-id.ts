import { currentBranchTask } from './current-branch-task.js';
import { ScrumlordError } from './errors.js';
import type { TaskStore } from './types.js';

export const TASK_ID_TOKENS = ['current', 'next'] as const;

const resolveTaskIdPrefix = (store: Pick<TaskStore, 'list'>, input: string): string => {
  const ids = store.list({ includeInactive: true }).map((task) => task.id);
  if (ids.includes(input)) return input;

  const matches = ids.filter((id) => id.startsWith(input));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ScrumlordError(
      'task_id_ambiguous',
      `Task id prefix ${input} matches multiple tasks.`,
    );
  }
  return input;
};

/**
 * Resolves a `<task-id>` argument to a concrete task id.
 * Accepts a task UUID, a unique UUID prefix, the literal `current`, or the literal `next`.
 * Tokens are case-sensitive and lowercase only.
 * Throws when the token cannot be resolved — no silent fallback.
 */
export const resolveTaskId = async (
  store: Pick<TaskStore, 'projectRoot' | 'withBranch' | 'next' | 'list'>,
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
  return resolveTaskIdPrefix(store, input);
};
