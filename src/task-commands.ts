import type { CommandRunner } from './command-runner.js';
import type { OrphanOutcome, OrphanSkip } from './orphan-recovery.js';
import { recoverOrphans } from './orphan-recovery.js';
import { buildCleanupPrompt } from './cleanup-prompt.js';
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

export type TaskListingOptions = {
  plan?: TaskPlanFilter;
};

export type CountTaskListingOptions = TaskListingOptions & {
  count: true;
};

export type ListTasksOptions = TaskListingOptions & {
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

/** Returns active tasks, or all tasks when inactive records are requested. */
export function listTasks(store: Pick<TaskStore, 'list'>, options: CountListTasksOptions): number;
export function listTasks(store: Pick<TaskStore, 'list'>, options?: ListTasksOptions): Task[];
export function listTasks(
  store: Pick<TaskStore, 'list'>,
  options: ListTasksOptions & { count?: boolean } = {},
): Task[] | number {
  return taskListingResult(store.list(options), options);
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

export type CleanupTasksOptions = {
  mode: CleanupTasksMode;
  hard?: boolean;
  dryRun?: boolean;
  runner?: CommandRunner;
  projectRoot?: string;
  now?: () => Date;
};

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
  if (!runner || !projectRoot) throw new Error('runner and projectRoot are required');
  return { runner, projectRoot };
};

export const cleanupTasks = async (
  store: CleanupStore,
  options: CleanupTasksOptions & { days?: number },
): Promise<CleanupTasksResult> => {
  const { mode, hard = false, dryRun = false, now = () => new Date() } = options;

  if (mode === 'prompt') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const prompt = await buildCleanupPrompt({ store, projectRoot, runner, now });
    return { mode: 'prompt', prompt };
  }

  if (mode === 'orphans-only') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const { orphans, skipped } = await recoverOrphans(store, projectRoot, runner, { dryRun });
    return { mode: 'orphans-only', dryRun, orphans, skipped };
  }

  const days = options.days!;

  if (mode === 'aged-and-orphans') {
    const { runner, projectRoot } = requireRunner(options.runner, options.projectRoot);
    const { deleted, wouldDelete } = runAgedCleanup(store, days, hard, dryRun);
    const { orphans, skipped } = await recoverOrphans(store, projectRoot, runner, { dryRun });
    return { mode: 'aged-and-orphans', hard, dryRun, deleted, wouldDelete, orphans, skipped };
  }

  // mode === 'aged'
  const { deleted, wouldDelete } = runAgedCleanup(store, days, hard, dryRun);
  return { mode: 'aged', hard, dryRun, deleted, wouldDelete };
};
