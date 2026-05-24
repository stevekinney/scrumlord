import type { CommandRunner } from './command-runner.js';
import type { OrphanOutcome, OrphanSkip } from './orphan-recovery.js';
import { recoverOrphans } from './orphan-recovery.js';
import { buildCleanupPrompt } from './cleanup-prompt.js';
import { ScrumlordError } from './errors.js';
import type {
  AddTaskProgressInput,
  AgentProvider,
  CreateTaskInput,
  PersistedTaskSession,
  Task,
  TaskIdentifier,
  TaskProgress,
  TaskPriority,
  TaskReference,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';

export type CleanupTasksResult =
  | {
      mode: 'aged';
      hard: boolean;
      dryRun: boolean;
      deleted: number;
      wouldDelete: TaskIdentifier[];
    }
  | {
      mode: 'orphans-only';
      dryRun: boolean;
      orphans: OrphanOutcome[];
      skipped: OrphanSkip[];
    }
  | {
      mode: 'aged-and-orphans';
      hard: boolean;
      dryRun: boolean;
      deleted: number;
      wouldDelete: TaskIdentifier[];
      orphans: OrphanOutcome[];
      skipped: OrphanSkip[];
    }
  | {
      mode: 'prompt';
      prompt: string;
    };

export type TaskPlanFilter = 'planned' | 'unplanned';
export type TaskCompletionFilter = 'completed' | 'incomplete';

export type TaskListingOptions = {
  plan?: TaskPlanFilter;
};

export type CountTaskListingOptions = TaskListingOptions & {
  count: true;
};

export type ListTasksOptions = TaskListingOptions & {
  completion?: TaskCompletionFilter;
  includeInactive?: boolean;
};

export type CountListTasksOptions = ListTasksOptions & {
  count: true;
};

type TaskListingResultOptions = TaskListingOptions & {
  count?: boolean;
};

const filterTasksByPlan = <TaskValue extends Task>(
  tasks: TaskValue[],
  options: TaskListingOptions,
): TaskValue[] => {
  if (!options.plan) return tasks;
  return tasks.filter((task) =>
    options.plan === 'planned' ? task.plan !== null : task.plan === null,
  );
};

const filterTasksByCompletion = <TaskValue extends Task>(
  tasks: TaskValue[],
  completion: TaskCompletionFilter | undefined,
): TaskValue[] => {
  if (completion === 'completed') return tasks.filter((task) => task.status === 'completed');
  if (completion === 'incomplete') return tasks.filter((task) => task.status !== 'completed');
  return tasks;
};

const taskListingResult = <TaskValue extends Task>(
  tasks: TaskValue[],
  options: TaskListingResultOptions,
): TaskValue[] | number => {
  const filteredTasks = filterTasksByPlan(tasks, options);
  return options.count ? filteredTasks.length : filteredTasks;
};

/** Returns ready, unblocked tasks that can be started now. */
export function availableTasks(
  store: Pick<TaskStore, 'available'>,
  options: CountTaskListingOptions,
): number;
export function availableTasks(
  store: Pick<TaskStore, 'available'>,
  options?: TaskListingOptions,
): Task[];
export function availableTasks(
  store: Pick<TaskStore, 'available'>,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.available(), options);
}

/** Returns active tasks that still have incomplete blockers. */
export function blockedTasks(
  store: Pick<TaskStore, 'blocked'>,
  options: CountTaskListingOptions,
): number;
export function blockedTasks(
  store: Pick<TaskStore, 'blocked'>,
  options?: TaskListingOptions,
): Task[];
export function blockedTasks(
  store: Pick<TaskStore, 'blocked'>,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.blocked(), options);
}

/** Returns completed tasks that have not been deleted. */
export function completedTasks(
  store: Pick<TaskStore, 'completed'>,
  options: CountTaskListingOptions,
): number;
export function completedTasks(
  store: Pick<TaskStore, 'completed'>,
  options?: TaskListingOptions,
): Task[];
export function completedTasks(
  store: Pick<TaskStore, 'completed'>,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.completed(), options);
}

/** Returns a task by id or null when it does not exist. */
export const getTask = (store: Pick<TaskStore, 'getTask'>, id: TaskIdentifier): Task | null => {
  return store.getTask(id);
};

/** Returns tags for one task. */
export const taskTags = (store: Pick<TaskStore, 'getTask'>, id: TaskIdentifier): string[] => {
  const task = store.getTask(id);
  if (!task) throw new ScrumlordError('task_not_found', `Task ${id} not found.`);
  return task.tags;
};

/** Returns active tasks, or all tasks when inactive records are requested. */
export function listTasks(store: Pick<TaskStore, 'list'>, options: CountListTasksOptions): number;
export function listTasks(store: Pick<TaskStore, 'list'>, options?: ListTasksOptions): Task[];
export function listTasks(
  store: Pick<TaskStore, 'list'>,
  options: ListTasksOptions & { count?: boolean } = {},
): Task[] | number {
  const filteredTasks = filterTasksByCompletion(store.list(options), options.completion);
  return taskListingResult(filteredTasks, options);
}

/** Returns tasks with one normalized tag. */
export function tasksWithTag(
  store: Pick<TaskStore, 'withTag'>,
  tag: string,
  options: CountTaskListingOptions,
): number;
export function tasksWithTag(
  store: Pick<TaskStore, 'withTag'>,
  tag: string,
  options?: TaskListingOptions,
): Task[];
export function tasksWithTag(
  store: Pick<TaskStore, 'withTag'>,
  tag: string,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.withTag(tag), options);
}

/** Returns tasks that contain every supplied tag. */
export function tasksWithAllTags(
  store: Pick<TaskStore, 'withAllTags'>,
  options: CountTaskListingOptions,
  ...tags: string[]
): number;
export function tasksWithAllTags(
  store: Pick<TaskStore, 'withAllTags'>,
  options: TaskListingOptions,
  ...tags: string[]
): Task[];
export function tasksWithAllTags(store: Pick<TaskStore, 'withAllTags'>, ...tags: string[]): Task[];
export function tasksWithAllTags(
  store: Pick<TaskStore, 'withAllTags'>,
  firstOptionOrTag: TaskListingResultOptions | string = {},
  ...tags: string[]
): Task[] | number {
  const options = typeof firstOptionOrTag === 'string' ? {} : firstOptionOrTag;
  const resolvedTags = typeof firstOptionOrTag === 'string' ? [firstOptionOrTag, ...tags] : tags;
  return taskListingResult(store.withAllTags(...resolvedTags), options);
}

/** Returns tasks that contain any supplied tag. */
export function tasksWithAnyTags(
  store: Pick<TaskStore, 'withAnyTag'>,
  options: CountTaskListingOptions,
  ...tags: string[]
): number;
export function tasksWithAnyTags(
  store: Pick<TaskStore, 'withAnyTag'>,
  options: TaskListingOptions,
  ...tags: string[]
): Task[];
export function tasksWithAnyTags(store: Pick<TaskStore, 'withAnyTag'>, ...tags: string[]): Task[];
export function tasksWithAnyTags(
  store: Pick<TaskStore, 'withAnyTag'>,
  firstOptionOrTag: TaskListingResultOptions | string = {},
  ...tags: string[]
): Task[] | number {
  const options = typeof firstOptionOrTag === 'string' ? {} : firstOptionOrTag;
  const resolvedTags = typeof firstOptionOrTag === 'string' ? [firstOptionOrTag, ...tags] : tags;
  return taskListingResult(store.withAnyTag(...resolvedTags), options);
}

/** Returns tasks associated with one Git branch. */
export function tasksWithBranch(
  store: Pick<TaskStore, 'withBranch'>,
  branch: string,
  options: CountTaskListingOptions,
): number;
export function tasksWithBranch(
  store: Pick<TaskStore, 'withBranch'>,
  branch: string,
  options?: TaskListingOptions,
): Task[];
export function tasksWithBranch(
  store: Pick<TaskStore, 'withBranch'>,
  branch: string,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.withBranch(branch), options);
}

/** Returns tasks blocking the supplied task. */
export function tasksBlockedBy(
  store: Pick<TaskStore, 'blockedBy'>,
  taskOrId: TaskReference,
  options: CountTaskListingOptions,
): number;
export function tasksBlockedBy(
  store: Pick<TaskStore, 'blockedBy'>,
  taskOrId: TaskReference,
  options?: TaskListingOptions,
): Task[];
export function tasksBlockedBy(
  store: Pick<TaskStore, 'blockedBy'>,
  taskOrId: TaskReference,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.blockedBy(taskOrId), options);
}

/** Returns tasks blocked by the supplied task. */
export function tasksBlocking(
  store: Pick<TaskStore, 'blocking'>,
  taskOrId: TaskReference,
  options: CountTaskListingOptions,
): number;
export function tasksBlocking(
  store: Pick<TaskStore, 'blocking'>,
  taskOrId: TaskReference,
  options?: TaskListingOptions,
): Task[];
export function tasksBlocking(
  store: Pick<TaskStore, 'blocking'>,
  taskOrId: TaskReference,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.blocking(taskOrId), options);
}

/** Returns tasks with the supplied priority. */
export function tasksWithPriority(
  store: Pick<TaskStore, 'withPriority'>,
  priority: TaskPriority,
  options: CountTaskListingOptions,
): number;
export function tasksWithPriority(
  store: Pick<TaskStore, 'withPriority'>,
  priority: TaskPriority,
  options?: TaskListingOptions,
): Task[];
export function tasksWithPriority(
  store: Pick<TaskStore, 'withPriority'>,
  priority: TaskPriority,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.withPriority(priority), options);
}

/** Returns tasks with the supplied status. */
export function tasksWithStatus(
  store: Pick<TaskStore, 'withStatus'>,
  status: TaskStatus,
  options: CountTaskListingOptions,
): number;
export function tasksWithStatus(
  store: Pick<TaskStore, 'withStatus'>,
  status: TaskStatus,
  options?: TaskListingOptions,
): Task[];
export function tasksWithStatus(
  store: Pick<TaskStore, 'withStatus'>,
  status: TaskStatus,
  options: TaskListingResultOptions = {},
): Task[] | number {
  return taskListingResult(store.withStatus(status), options);
}

/** Creates a task. */
export const createTask = (store: Pick<TaskStore, 'create'>, input: CreateTaskInput): Task => {
  return store.create(input);
};

/** Updates a task. */
export const updateTask = (
  store: Pick<TaskStore, 'update'>,
  id: TaskIdentifier,
  input: UpdateTaskInput,
): Task => {
  return store.update(id, input);
};

/**
 * Marks one or more tasks as `completed`. Resolved identifiers are deduplicated
 * (preserving first-seen order) and read before any write: if any identifier is
 * missing, the whole batch throws and nothing is mutated. Soft-deleted tasks are
 * rejected; tasks already `completed` are returned unchanged without a write.
 */
export const completeTasks = (
  store: Pick<TaskStore, 'getTask' | 'update'>,
  ids: TaskIdentifier[],
): Task[] => {
  const uniqueIds = [...new Set(ids)];

  // Read-all-then-write: resolve every task first so a missing or deleted id
  // fails the whole batch before any status is changed.
  const tasks = uniqueIds.map((id) => {
    const task = store.getTask(id);
    if (!task) throw new ScrumlordError('task_not_found', `Task ${String(id)} not found.`);
    if (task.deleted)
      throw new ScrumlordError(
        'cannot_complete_deleted',
        `Task ${task.id} is deleted and cannot be completed.`,
      );
    return task;
  });

  return tasks.map((task) =>
    task.status === 'completed' ? task : store.update(task.id, { status: 'completed' }),
  );
};

/** Soft-deletes a task, or hard-deletes when options.hard is true. */
export const deleteTask = (
  store: Pick<TaskStore, 'delete'>,
  id: TaskIdentifier,
  options: { hard?: boolean } = {},
): Task | null => {
  return store.delete(id, options);
};

/** Adds a tag to a task. */
export const addTaskTag = (
  store: Pick<TaskStore, 'addTag'>,
  id: TaskIdentifier,
  tag: string,
): Task => {
  return store.addTag(id, tag);
};

/** Removes a tag from a task. */
export const removeTaskTag = (
  store: Pick<TaskStore, 'removeTag'>,
  id: TaskIdentifier,
  tag: string,
): Task => {
  return store.removeTag(id, tag);
};

/** Sets a task status to any supported lifecycle value. */
export const setTaskStatus = (
  store: Pick<TaskStore, 'update'>,
  id: TaskIdentifier,
  status: TaskStatus,
): Task => {
  return store.update(id, { status });
};

/** Sets the Git branch associated with a task. */
export const setTaskBranch = (
  store: Pick<TaskStore, 'update'>,
  id: TaskIdentifier,
  branch: string,
): Task => {
  return store.update(id, { branch });
};

/** Clears the Git branch associated with a task. */
export const clearTaskBranch = (store: Pick<TaskStore, 'update'>, id: TaskIdentifier): Task => {
  return store.update(id, { branch: null });
};

/** Adds a dependency blocker. */
export const addTaskBlocker = (
  store: Pick<TaskStore, 'addBlocker'>,
  id: TaskIdentifier,
  blockedBy: TaskReference,
): Task => {
  return store.addBlocker(id, blockedBy);
};

/** Removes a dependency blocker. */
export const removeTaskBlocker = (
  store: Pick<TaskStore, 'removeBlocker'>,
  id: TaskIdentifier,
  blockedBy: TaskReference,
): Task => {
  return store.removeBlocker(id, blockedBy);
};

/** Sets or clears the task plan path. */
export const setTaskPlan = (
  store: Pick<TaskStore, 'setPlan'>,
  id: TaskIdentifier,
  plan: string | null,
): Task => {
  return store.setPlan(id, plan);
};

/** Clears the task plan path. */
export const clearTaskPlan = (store: Pick<TaskStore, 'setPlan'>, id: TaskIdentifier): Task => {
  return store.setPlan(id, null);
};

/** Sets the provider session for a task. */
export const setTaskSession = (
  store: Pick<TaskStore, 'setSession'>,
  id: TaskIdentifier,
  provider: AgentProvider,
  session: string | null,
): Task => {
  return store.setSession(id, provider, session);
};

/** Clears provider and session metadata for a task. */
export const clearTaskSession = (store: Pick<TaskStore, 'update'>, id: TaskIdentifier): Task => {
  return store.update(id, { provider: null, session: null });
};

/** Returns active tasks with matching provider session metadata. */
export const tasksWithSession = (
  store: Pick<TaskStore, 'withSession'>,
  provider: AgentProvider,
  session: string,
): Task[] => {
  return store.withSession(provider, session);
};

/** Returns persisted session metadata for a task. */
export const persistedTaskSession = (
  store: Pick<TaskStore, 'taskSession'>,
  id: TaskIdentifier,
): PersistedTaskSession => {
  return store.taskSession(id);
};

/** Returns progress entries for one task in chronological order. */
export const taskProgress = (
  store: Pick<TaskStore, 'progress'>,
  id: TaskIdentifier,
): TaskProgress[] => {
  return store.progress(id);
};

/** Appends a progress entry to a task and starts draft or ready tasks. */
export const addTaskProgress = (
  store: Pick<TaskStore, 'addProgress'>,
  id: TaskIdentifier,
  input: AddTaskProgressInput,
): TaskProgress => {
  return store.addProgress(id, input);
};

export type CleanupTasksMode = 'aged' | 'orphans-only' | 'aged-and-orphans' | 'prompt';

type CleanupTasksBaseOptions = {
  hard?: boolean;
  dryRun?: boolean;
  runner?: CommandRunner;
  projectRoot?: string;
  now?: () => Date;
};

export type CleanupTasksOptions =
  | (CleanupTasksBaseOptions & { mode: 'aged' | 'aged-and-orphans'; days: number })
  | (CleanupTasksBaseOptions & { mode: 'orphans-only' | 'prompt' });

/** Orchestrates cleanup based on mode: aged-delete, orphan recovery, or prompt emission. */
type CleanupStore = Pick<
  TaskStore,
  | 'cleanup'
  | 'previewCleanup'
  | 'inProgress'
  | 'recoverOrphan'
  | 'countInProgress'
  | 'countBranched'
>;

const runAgedCleanup = (
  store: Pick<CleanupStore, 'cleanup' | 'previewCleanup'>,
  days: number,
  hard: boolean,
  dryRun: boolean,
): { deleted: number; wouldDelete: TaskIdentifier[] } => {
  if (dryRun) {
    const { wouldDelete } = store.previewCleanup(days, { hard });
    return { deleted: 0, wouldDelete };
  }
  const { deleted } = store.cleanup(days, { hard });
  return { deleted, wouldDelete: [] };
};

const requireRunner = (
  runner: CommandRunner | undefined,
  projectRoot: string | undefined,
): { runner: CommandRunner; projectRoot: string } => {
  if (!runner || !projectRoot)
    throw new ScrumlordError(
      'missing_runner',
      'runner and projectRoot are required for this cleanup mode',
    );
  return { runner, projectRoot };
};

/** Narrows `options` to aged modes and returns the required `days` field.
 * The caller guarantees this is only called after narrowing out `prompt` and `orphans-only`. */
const daysFrom = (options: CleanupTasksOptions): number => {
  if (options.mode !== 'aged' && options.mode !== 'aged-and-orphans') {
    throw new ScrumlordError('unexpected_error', 'daysFrom called on non-aged cleanup mode');
  }
  return options.days;
};

export const cleanupTasks = async (
  store: CleanupStore,
  options: CleanupTasksOptions,
): Promise<CleanupTasksResult> => {
  const hard = options.hard ?? false;
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? (() => new Date());

  if (options.mode === 'prompt') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const prompt = await buildCleanupPrompt({ store, projectRoot, runner, now });
    return { mode: 'prompt', prompt };
  }

  if (options.mode === 'orphans-only') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const { orphans, skipped } = await recoverOrphans(store, projectRoot, runner, { dryRun });
    return { mode: 'orphans-only', dryRun, orphans, skipped };
  }

  if (options.mode === 'aged-and-orphans') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const { deleted, wouldDelete } = runAgedCleanup(store, daysFrom(options), hard, dryRun);
    const { orphans, skipped } = await recoverOrphans(store, projectRoot, runner, { dryRun });
    return { mode: 'aged-and-orphans', hard, dryRun, deleted, wouldDelete, orphans, skipped };
  }

  // options.mode === 'aged'
  const { deleted, wouldDelete } = runAgedCleanup(store, daysFrom(options), hard, dryRun);
  return { mode: 'aged', hard, dryRun, deleted, wouldDelete };
};
