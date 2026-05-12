import type { CommandRunner } from './command-runner.js';
import { currentGitBranch } from './git-status.js';
import { ScrumlordError } from './errors.js';
import type { Task, TaskStore } from './types.js';

export type CurrentBranchTaskOptions = {
  runner?: CommandRunner;
};

const activeTask = (task: Task): boolean => {
  return !task.deleted && !task.archived && task.status !== 'completed';
};

/** Returns the single active task assigned to the current Git branch. */
export const currentBranchTask = async (
  store: Pick<TaskStore, 'projectRoot' | 'withBranch'>,
  options: CurrentBranchTaskOptions = {},
): Promise<Task | null> => {
  const branch = await currentGitBranch(store.projectRoot, options.runner);
  const tasks = store.withBranch(branch).filter(activeTask);
  if (tasks.length === 0) return null;
  if (tasks.length === 1) return tasks[0] ?? null;
  throw new ScrumlordError(
    'current_task_ambiguous',
    `Current branch matches multiple active tasks: ${tasks.map((task) => task.id).join(', ')}.`,
  );
};
