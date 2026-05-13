import { describe, expect, it } from 'bun:test';
import {
  addTaskBlocker,
  addTaskTag,
  archiveTask,
  availableTasks,
  blockedTasks,
  cleanupTasks,
  clearTaskParent,
  completedTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  next,
  persistedTaskSession,
  remaining,
  removeTaskBlocker,
  removeTaskTag,
  restoreTask,
  setTaskParent,
  setTaskPlan,
  setTaskSession,
  tasksBlockedBy,
  tasksBlocking,
  tasksWithAllTags,
  tasksWithAnyTags,
  tasksWithBranch,
  tasksWithPriority,
  tasksWithSession,
  tasksWithTag,
  updateTask,
} from './index';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskReference, TaskStore } from './index';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  archived: false,
  deleted: false,
  ...overrides,
});

const referenceId = (reference: TaskReference): string => {
  return typeof reference === 'string' ? reference : reference.id;
};

const firstTask = (tasks: Task[]): Task => {
  const [first] = tasks;
  if (!first) throw new Error('Expected at least one task.');
  return first;
};

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create(input) {
    calls.push(`create:${input.title}`);
    return task('created', { title: input.title });
  },
  update(id, input) {
    calls.push(`update:${id}:${input.title ?? ''}`);
    return task(id, input);
  },
  delete(id) {
    calls.push(`delete:${id}`);
    return task(id, { deleted: true });
  },
  archive(id) {
    calls.push(`archive:${id}`);
    return task(id, { archived: true });
  },
  restore(id) {
    calls.push(`restore:${id}`);
    return task(id);
  },
  getTask(id) {
    calls.push(`getTask:${id}`);
    return task(id);
  },
  list(options) {
    calls.push(`list:${options?.includeInactive ? 'all' : 'active'}`);
    return [task('list')];
  },
  available() {
    calls.push('available');
    return [task('available')];
  },
  blocked() {
    calls.push('blocked');
    return [task('blocked')];
  },
  completed() {
    calls.push('completed');
    return [task('completed')];
  },
  withTag(tag) {
    calls.push(`withTag:${tag}`);
    return [task('with-tag')];
  },
  withAllTags(...tags) {
    calls.push(`withAllTags:${tags.join(',')}`);
    return [task('with-all-tags')];
  },
  withAnyTag(...tags) {
    calls.push(`withAnyTag:${tags.join(',')}`);
    return [task('with-any-tags')];
  },
  withBranch(branch) {
    calls.push(`withBranch:${branch}`);
    return [task('with-branch')];
  },
  blockedBy(taskOrId) {
    calls.push(`blockedBy:${referenceId(taskOrId)}`);
    return [task('blocked-by')];
  },
  blocking(taskOrId) {
    calls.push(`blocking:${referenceId(taskOrId)}`);
    return [task('blocking')];
  },
  withPriority(priority) {
    calls.push(`withPriority:${priority}`);
    return [task('priority')];
  },
  next() {
    calls.push('next');
    return task('next');
  },
  remaining() {
    calls.push('remaining');
    return 3;
  },
  cleanup(days) {
    calls.push(`cleanup:${days}`);
    return { deleted: days };
  },
  addTag(id, tag) {
    calls.push(`addTag:${id}:${tag}`);
    return task(id, { tags: [tag] });
  },
  removeTag(id, tag) {
    calls.push(`removeTag:${id}:${tag}`);
    return task(id);
  },
  setParent(id, parent) {
    calls.push(`setParent:${id}:${referenceId(parent)}`);
    return task(id, { parent: referenceId(parent) });
  },
  clearParent(id) {
    calls.push(`clearParent:${id}`);
    return task(id);
  },
  addBlocker(id, blockedBy) {
    calls.push(`addBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  removeBlocker(id, blockedBy) {
    calls.push(`removeBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  setPlan(id, plan) {
    calls.push(`setPlan:${id}:${plan ?? ''}`);
    return task(id, { plan });
  },
  setSession(id, provider, session) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id, { provider, session });
  },
  withSession(provider, session) {
    calls.push(`withSession:${provider}:${session}`);
    return [task('with-session', { provider, session })];
  },
  taskSession(id) {
    calls.push(`taskSession:${id}`);
    return {
      taskId: id,
      provider: 'codex',
      session: 'codex-session',
      branch: 'feature/task-graph',
      plan: 'tmp/tasks/task-id/PLAN.md',
    };
  },
  ...emptyProgressStoreMethods,
  close() {
    calls.push('close');
  },
});

describe('library task command methods', () => {
  it('routes task command helpers through the task store API', () => {
    const calls: string[] = [];
    const store = fakeStore(calls);

    expect(firstTask(availableTasks(store)).id).toBe('available');
    expect(firstTask(blockedTasks(store)).id).toBe('blocked');
    expect(firstTask(completedTasks(store)).id).toBe('completed');
    expect(getTask(store, 'task-id')?.id).toBe('task-id');
    expect(firstTask(listTasks(store)).id).toBe('list');
    expect(firstTask(listTasks(store, { includeInactive: true })).id).toBe('list');
    expect(firstTask(tasksWithTag(store, 'frontend')).id).toBe('with-tag');
    expect(firstTask(tasksWithAllTags(store, 'frontend', 'backend')).id).toBe('with-all-tags');
    expect(firstTask(tasksWithAnyTags(store, 'frontend', 'backend')).id).toBe('with-any-tags');
    expect(firstTask(tasksWithBranch(store, 'feature/task-graph')).id).toBe('with-branch');
    expect(firstTask(tasksBlockedBy(store, 'task-id')).id).toBe('blocked-by');
    expect(firstTask(tasksBlocking(store, 'task-id')).id).toBe('blocking');
    expect(firstTask(tasksWithPriority(store, 3)).id).toBe('priority');
    expect(availableTasks(store, { count: true })).toBe(1);
    expect(blockedTasks(store, { count: true })).toBe(1);
    expect(completedTasks(store, { count: true })).toBe(1);
    expect(availableTasks(store, { plan: 'planned', count: true })).toBe(0);
    expect(availableTasks(store, { plan: 'unplanned', count: true })).toBe(1);
    expect(listTasks(store, { count: true })).toBe(1);
    expect(listTasks(store, { includeInactive: true, count: true })).toBe(1);
    expect(tasksWithTag(store, 'frontend', { count: true })).toBe(1);
    expect(tasksWithAllTags(store, { count: true }, 'frontend', 'backend')).toBe(1);
    expect(tasksWithAnyTags(store, { count: true }, 'frontend', 'backend')).toBe(1);
    expect(tasksWithBranch(store, 'feature/task-graph', { count: true })).toBe(1);
    expect(tasksBlockedBy(store, 'task-id', { count: true })).toBe(1);
    expect(tasksBlocking(store, 'task-id', { count: true })).toBe(1);
    expect(tasksWithPriority(store, 3, { count: true })).toBe(1);
    expect(next(store)?.id).toBe('next');
    expect(remaining(store)).toBe(3);
    expect(createTask(store, { title: 'Created task' }).title).toBe('Created task');
    expect(updateTask(store, 'task-id', { title: 'Updated task' }).title).toBe('Updated task');
    expect(deleteTask(store, 'task-id').deleted).toBe(true);
    expect(archiveTask(store, 'task-id').archived).toBe(true);
    expect(restoreTask(store, 'task-id').id).toBe('task-id');
    expect(addTaskTag(store, 'task-id', 'frontend').tags).toEqual(['frontend']);
    expect(removeTaskTag(store, 'task-id', 'frontend').id).toBe('task-id');
    expect(setTaskParent(store, 'task-id', 'parent-id').parent).toBe('parent-id');
    expect(clearTaskParent(store, 'task-id').id).toBe('task-id');
    expect(addTaskBlocker(store, 'task-id', 'blocker-id').id).toBe('task-id');
    expect(removeTaskBlocker(store, 'task-id', 'blocker-id').id).toBe('task-id');
    expect(setTaskPlan(store, 'task-id', 'tmp/tasks/task-id/PLAN.md').plan).toBe(
      'tmp/tasks/task-id/PLAN.md',
    );
    expect(setTaskSession(store, 'task-id', 'codex', 'session').session).toBe('session');
    expect(firstTask(tasksWithSession(store, 'codex', 'session')).session).toBe('session');
    expect(persistedTaskSession(store, 'task-id').session).toBe('codex-session');
    expect(cleanupTasks(store, 30)).toEqual({ deleted: 30 });

    expect(calls).toContain('available');
    expect(calls).toContain('list:active');
    expect(calls).toContain('list:all');
    expect(calls).toContain('withAllTags:frontend,backend');
    expect(calls).toContain('setSession:task-id:codex:session');
    expect(calls).toContain('cleanup:30');
  });
});
