import { required, type ParsedArguments } from './cli-arguments.js';
import { currentBranchTask } from './current-branch-task.js';
import { ScrumlordError } from './errors.js';
import type { TaskStore } from './types.js';

export const hasExplicitTaskId = (parsed: ParsedArguments, trailingArgumentCount = 0): boolean =>
  parsed.positionals.length > trailingArgumentCount;

export const taskCommandArguments = (
  parsed: ParsedArguments,
  trailingArgumentCount: number,
): string[] =>
  hasExplicitTaskId(parsed, trailingArgumentCount)
    ? parsed.positionals.slice(1)
    : parsed.positionals;

export const requiredTaskCommandArgument = (
  parsed: ParsedArguments,
  trailingArgumentCount: number,
  name: string,
  index = 0,
): string => required(taskCommandArguments(parsed, trailingArgumentCount).slice(index), name);

export const taskIdFromArguments = async (
  store: TaskStore,
  parsed: ParsedArguments,
  trailingArgumentCount = 0,
): Promise<string> => {
  if (hasExplicitTaskId(parsed, trailingArgumentCount)) {
    return required(parsed.positionals, 'task id');
  }

  const task = await currentBranchTask(store);
  if (!task) {
    throw new ScrumlordError(
      'current_task_not_found',
      'No active task is assigned to the current Git branch.',
    );
  }
  return task.id;
};
