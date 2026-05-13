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

export type CleanupTasksResult = {
  deleted: number;
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

/** Soft-deletes a task. */
export const deleteTask = (store: Pick<TaskStore, 'delete'>, id: TaskIdentifier): Task => {
  return store.delete(id);
};

/** Archives a task. */
export const archiveTask = (store: Pick<TaskStore, 'archive'>, id: TaskIdentifier): Task => {
  return store.archive(id);
};

/** Restores a deleted or archived task. */
export const restoreTask = (store: Pick<TaskStore, 'restore'>, id: TaskIdentifier): Task => {
  return store.restore(id);
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

/** Assigns a parent task. */
export const setTaskParent = (
  store: Pick<TaskStore, 'setParent'>,
  id: TaskIdentifier,
  parent: TaskReference,
): Task => {
  return store.setParent(id, parent);
};

/** Clears a task parent. */
export const clearTaskParent = (
  store: Pick<TaskStore, 'clearParent'>,
  id: TaskIdentifier,
): Task => {
  return store.clearParent(id);
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

/** Permanently removes old completed or archived tasks. */
export const cleanupTasks = (
  store: Pick<TaskStore, 'cleanup'>,
  days: number,
): CleanupTasksResult => {
  return store.cleanup(days);
};
