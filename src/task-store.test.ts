import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from './database-open';
import { ScrumlordError } from './errors';
import { next as nextTask, remaining as remainingTasks } from './index';
import type { Task, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const taskIds = (tasks: Task[]): string[] => tasks.map((task) => task.id);

const createSeededStore = async (): Promise<{
  root: string;
  store: TaskStore;
  blocker: Task;
  parent: Task;
  blocked: Task;
  future: Task;
  setCurrentDate: (date: Date) => void;
}> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  let currentDate = new Date('2026-05-11T12:00:00.000Z');
  const store = await createTaskStore({ cwd: root, now: () => currentDate });
  const blocker = store.create({
    id: 'blocker',
    title: 'Finish prerequisite',
    priority: 2,
    tags: ['Feature', 'frontend'],
  });
  const parent = store.create({
    id: 'parent',
    title: 'Parent task',
    tags: ['planning', 'frontend'],
  });
  const blocked = store.create({
    id: 'blocked',
    title: 'Blocked task',
    priority: 3,
    startDate: '2026-05-10',
    branch: 'feature/task-graph',
    plan: join(store.projectRoot, 'tmp', 'tasks', 'blocked', 'PLAN.md'),
    provider: 'codex',
    session: 'codex-session',
    parent,
    blockedBy: [blocker],
    tags: ['frontend', 'backend'],
  });
  const future = store.create({
    id: 'future',
    title: 'Future task',
    priority: 3,
    startDate: '2026-05-12',
  });

  return {
    root,
    store,
    blocker,
    parent,
    blocked,
    future,
    setCurrentDate(date: Date) {
      currentDate = date;
    },
  };
};

describe('createTaskStore', () => {
  it('reports a helpful error when the database directory cannot be created', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await Bun.write(join(root, 'tmp'), 'not a directory');

    try {
      await createTaskStore({ cwd: root });
      throw new Error('Expected createTaskStore to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
      expect(error).toHaveProperty('code', 'database_directory_failed');
    }
  });

  it('reports a helpful error when the database cannot be opened', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await mkdir(join(root, 'tmp', 'tasks.db'), { recursive: true });

    try {
      await createTaskStore({ cwd: root });
      throw new Error('Expected createTaskStore to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
      expect(error).toHaveProperty('code', 'database_open_failed');
    }
  });

  it('reports a helpful migration error when an existing database is corrupt', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await mkdir(join(root, 'tmp'), { recursive: true });
    await Bun.write(join(root, 'tmp', 'tasks.db'), 'not a sqlite database');

    try {
      await createTaskStore({ cwd: root });
      throw new Error('Expected createTaskStore to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
      expect(error).toHaveProperty('code', 'migration_failed');
    }
  });

  it('runs migrations and exposes graph queries', async () => {
    const { root, store, blocker, parent, blocked, future } = await createSeededStore();

    expect(store.getTask(blocked.id)).toMatchObject({
      id: 'blocked',
      parent: 'parent',
      branch: 'feature/task-graph',
      plan: 'tmp/tasks/blocked/PLAN.md',
      provider: 'codex',
      session: 'codex-session',
      tags: ['backend', 'frontend'],
      blockedBy: ['blocker'],
    });
    expect(store.getTask(parent.id)?.subtasks).toEqual(['blocked']);
    expect(store.getTask(blocker.id)?.blocking).toEqual(['blocked']);
    expect(taskIds(store.list())).toEqual(['blocked', 'future', 'blocker', 'parent']);
    expect(taskIds(store.available())).toEqual(['blocker', 'parent']);
    expect(taskIds(store.blocked())).toEqual(['blocked']);
    expect(taskIds(store.blockedBy(blocked))).toEqual(['blocker']);
    expect(taskIds(store.blocking(blocker))).toEqual(['blocked']);
    expect(taskIds(store.withTag('FRONTEND'))).toEqual(['blocked', 'blocker', 'parent']);
    expect(taskIds(store.withAllTags('frontend', 'backend'))).toEqual(['blocked']);
    expect(taskIds(store.withAnyTag('backend', 'planning'))).toEqual(['blocked', 'parent']);
    expect(taskIds(store.withPriority(3))).toEqual(['blocked', 'future']);
    expect(taskIds(store.withBranch('feature/task-graph'))).toEqual(['blocked']);
    expect(store.next()?.id).toBe('blocker');
    expect(nextTask(store)?.id).toBe('blocker');
    expect(store.remaining()).toBe(4);
    expect(remainingTasks(store)).toBe(4);

    const migrationDatabase = new Database(join(root, 'tmp', 'tasks.db'), { readonly: true });
    expect(
      migrationDatabase.query<{ version: number }, []>('SELECT version FROM task_migrations').all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    migrationDatabase.close();
    expect(future.id).toBe('future');
    store.close();
  });

  it('records chronological task progress with inherited session metadata', async () => {
    const { store, blocked, parent, setCurrentDate } = await createSeededStore();

    const first = store.addProgress(blocked.id, {
      id: 'progress-one',
      message: '  Wrote the failing regression test.  ',
    });
    expect(first).toEqual({
      id: 'progress-one',
      taskId: 'blocked',
      message: 'Wrote the failing regression test.',
      createdAt: '2026-05-11T12:00:00.000Z',
      provider: 'codex',
      session: 'codex-session',
    });

    setCurrentDate(new Date('2026-05-11T13:00:00.000Z'));
    expect(
      store.addProgress(blocked.id, {
        id: 'progress-two',
        message: 'Blocked on CI.',
        provider: null,
        session: null,
      }),
    ).toMatchObject({
      id: 'progress-two',
      provider: null,
      session: null,
    });

    expect(store.progress(blocked.id).map((entry) => entry.id)).toEqual([
      'progress-one',
      'progress-two',
    ]);
    expect(store.getTask(blocked.id)?.lastModifiedAt).toBe('2026-05-11T13:00:00.000Z');
    expect(() => store.addProgress(blocked.id, { message: '   ' })).toThrow(ScrumlordError);
    expect(() =>
      store.addProgress(parent.id, { message: 'Needs provider.', session: 'session-id' }),
    ).toThrow(ScrumlordError);
    expect(() => store.progress('missing')).toThrow(ScrumlordError);

    store.close();
  });

  it('moves draft and ready tasks to in-progress when recording progress', async () => {
    const { store, setCurrentDate } = await createSeededStore();
    const draft = store.create({ id: 'draft-progress', title: 'Draft progress', status: 'draft' });
    const ready = store.create({ id: 'ready-progress', title: 'Ready progress' });
    const inReview = store.create({
      id: 'review-progress',
      title: 'Review progress',
      status: 'in-review',
    });

    setCurrentDate(new Date('2026-05-11T14:00:00.000Z'));
    store.addProgress(draft.id, { message: 'Started draft work.' });
    store.addProgress(ready.id, { message: 'Started ready work.' });
    store.addProgress(inReview.id, { message: 'Still in review.' });

    expect(store.getTask(draft.id)).toMatchObject({
      status: 'in-progress',
      lastModifiedAt: '2026-05-11T14:00:00.000Z',
    });
    expect(store.getTask(ready.id)).toMatchObject({
      status: 'in-progress',
      lastModifiedAt: '2026-05-11T14:00:00.000Z',
    });
    expect(store.getTask(inReview.id)).toMatchObject({
      status: 'in-review',
      lastModifiedAt: '2026-05-11T14:00:00.000Z',
    });

    store.close();
  });

  it('updates optional task metadata and graph links', async () => {
    const { store, blocker, parent, blocked, future } = await createSeededStore();

    expect(store.update(blocked.id, { branch: ' feature/renamed ' })).toMatchObject({
      branch: 'feature/renamed',
      status: 'in-progress',
    });
    expect(store.withBranch('feature/task-graph')).toEqual([]);
    expect(taskIds(store.withBranch('feature/renamed'))).toEqual(['blocked']);
    expect(store.update(blocked.id, { branch: null }).branch).toBeNull();
    expect(store.setPlan(blocked.id, '../external-plan.md').plan).toBe(
      join(store.projectRoot, '..', 'external-plan.md'),
    );
    expect(store.setPlan(blocked.id, null).plan).toBeNull();
    expect(store.setSession(blocked.id, 'claude', 'claude-session')).toMatchObject({
      provider: 'claude',
      session: 'claude-session',
    });
    expect(taskIds(store.withSession('claude', 'claude-session'))).toEqual(['blocked']);
    expect(store.taskSession(blocked.id)).toEqual({
      taskId: 'blocked',
      provider: 'claude',
      session: 'claude-session',
      branch: null,
      plan: null,
    });
    expect(store.update(blocked.id, { provider: null, session: null })).toMatchObject({
      provider: null,
      session: null,
    });
    store.update(blocked.id, { status: 'ready' });

    store.update(blocker.id, { status: 'completed', description: 'Done', dueDate: null });
    expect(taskIds(store.completed())).toEqual(['blocker']);
    expect(store.blocked()).toEqual([]);
    expect(store.next()?.id).toBe('blocked');
    expect(store.remaining()).toBe(3);

    store.addTag(future.id, 'Backend');
    expect(store.getTask(future.id)?.tags).toEqual(['backend']);
    store.removeTag(future.id, 'backend');
    expect(store.getTask(future.id)?.tags).toEqual([]);
    store.setParent(future.id, parent.id);
    expect(store.getTask(future.id)?.parent).toBe(parent.id);
    store.clearParent(future.id);
    expect(store.getTask(future.id)?.parent).toBeNull();
    store.addBlocker(future.id, parent.id);
    expect(taskIds(store.blockedBy(future.id))).toEqual(['parent']);
    store.removeBlocker(future.id, parent.id);
    expect(store.blockedBy(future.id)).toEqual([]);

    expect(store.delete(future.id).deleted).toBe(true);
    expect(store.restore(future.id).deleted).toBe(false);
    expect(store.archive(future.id).archived).toBe(true);
    expect(taskIds(store.list())).not.toContain(future.id);
    expect(taskIds(store.list({ includeInactive: true }))).toContain(future.id);
    expect(store.restore(future.id).archived).toBe(false);
    store.close();
  });

  it('requires explicit blocker edges before dependency-gated tasks become ready', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({
      cwd: root,
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });

    const dependencyDescription = 'Add /.well-known/mcp.json route once live MCP server exists.';

    expect(() =>
      store.create({
        id: 'catalog',
        title: 'Add MCP catalog discovery metadata',
        description: dependencyDescription,
      }),
    ).toThrow(ScrumlordError);

    const server = store.create({
      id: 'server',
      title: 'Implement MCP server',
      status: 'in-progress',
    });
    const catalog = store.create({
      id: 'catalog',
      title: 'Add MCP catalog discovery metadata',
      status: 'draft',
      description: dependencyDescription,
    });

    expect(() => store.update(catalog.id, { status: 'ready' })).toThrow(ScrumlordError);

    store.addBlocker(catalog.id, server.id);
    expect(store.update(catalog.id, { status: 'ready' })).toMatchObject({
      id: 'catalog',
      blockedBy: ['server'],
      status: 'ready',
    });
    expect(taskIds(store.available())).toEqual([]);

    store.update(server.id, { status: 'completed' });
    expect(store.next()?.id).toBe('catalog');

    store.close();
  });

  it('moves draft and ready tasks to in-progress when assigning a branch', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({
      cwd: root,
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });

    const ready = store.create({ id: 'ready', title: 'Ready task' });
    const draft = store.create({ id: 'draft', title: 'Draft task', status: 'draft' });
    const review = store.create({ id: 'review', title: 'Review task', status: 'in-review' });
    const completed = store.create({
      id: 'completed',
      title: 'Completed task',
      status: 'completed',
    });
    const cleared = store.create({ id: 'cleared', title: 'Cleared branch task' });

    expect(store.update(ready.id, { branch: 'feature/ready' })).toMatchObject({
      branch: 'feature/ready',
      status: 'in-progress',
    });
    expect(store.update(draft.id, { branch: 'feature/draft' })).toMatchObject({
      branch: 'feature/draft',
      status: 'in-progress',
    });
    expect(store.update(review.id, { branch: 'feature/review' })).toMatchObject({
      branch: 'feature/review',
      status: 'in-review',
    });
    expect(store.update(completed.id, { branch: 'feature/completed' })).toMatchObject({
      branch: 'feature/completed',
      status: 'completed',
    });
    expect(store.update(cleared.id, { branch: null })).toMatchObject({
      branch: null,
      status: 'ready',
    });

    store.close();
  });

  it('rejects invalid storage inputs and cleans old completed tasks', async () => {
    const { store, blocker, parent, blocked, setCurrentDate } = await createSeededStore();

    expect(() => store.setParent(parent.id, blocked.id)).toThrow(ScrumlordError);
    expect(() => store.addBlocker(blocker.id, blocked.id)).toThrow(ScrumlordError);
    expect(() => store.update('missing', { title: 'Nope' })).toThrow(ScrumlordError);
    expect(() => store.create({ title: '   ' })).toThrow(ScrumlordError);
    expect(() => store.create({ id: 'blocked', title: 'Duplicate id' })).toThrow(ScrumlordError);
    expect(() => store.create({ title: 'Bad date', startDate: 'not-a-date' })).toThrow(
      ScrumlordError,
    );
    expect(() => store.create({ title: 'Bad provider', provider: 'vim' })).toThrow(ScrumlordError);
    expect(() => store.create({ title: 'Bad session', session: 'missing-provider' })).toThrow(
      ScrumlordError,
    );
    expect(() =>
      store.create({
        title: 'Bad date order',
        startDate: '2026-05-12',
        dueDate: '2026-05-11',
      }),
    ).toThrow(ScrumlordError);
    expect(() =>
      store.update(blocked.id, { startDate: '2026-05-12', dueDate: '2026-05-11' }),
    ).toThrow(ScrumlordError);
    expect(() => store.addTag(parent.id, '   ')).toThrow(ScrumlordError);
    expect(() => store.withAllTags()).toThrow(ScrumlordError);
    expect(() => store.withPriority(9)).toThrow(ScrumlordError);
    expect(() => store.cleanup(-1)).toThrow(ScrumlordError);

    setCurrentDate(new Date('2026-01-01T00:00:00.000Z'));
    store.create({ id: 'old-completed', title: 'Old completed', status: 'completed' });
    store.archive(store.create({ id: 'old-archived', title: 'Old archived' }).id);
    setCurrentDate(new Date('2026-05-11T12:00:00.000Z'));
    expect(store.cleanup(30)).toEqual({ deleted: 2 });
    expect(store.getTask('old-completed')).toBeNull();
    expect(store.getTask('old-archived')).toBeNull();
    store.close();
  });

  it('persists tasks after reopening and supports the default clock', async () => {
    const { root, store } = await createSeededStore();
    store.close();

    const reopened = await createTaskStore({
      cwd: root,
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });
    expect(reopened.getTask('blocked')?.title).toBe('Blocked task');
    reopened.close();

    const defaultClockStore = await createTaskStore({ cwd: root });
    expect(
      defaultClockStore.create({ id: 'default-clock', title: 'Default clock' }).createdAt,
    ).toContain('T');
    defaultClockStore.close();
  });

  it('counts active unfinished tasks as remaining, including future-start tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({
      cwd: root,
      now: () => new Date('2026-05-11T12:00:00.000Z'),
    });

    const ready = store.create({ id: 'ready', title: 'Ready task' });
    const future = store.create({
      id: 'future',
      title: 'Future task',
      startDate: '2026-05-12',
    });
    const review = store.create({ id: 'review', title: 'Review task', status: 'in-review' });
    store.create({ id: 'draft', title: 'Draft task', status: 'draft' });
    store.create({ id: 'active', title: 'Active task', status: 'in-progress' });
    store.create({ id: 'done', title: 'Done task', status: 'completed' });
    store.archive(store.create({ id: 'archived', title: 'Archived task' }).id);
    store.delete(store.create({ id: 'deleted', title: 'Deleted task' }).id);

    expect(store.remaining()).toBe(4);
    expect(remainingTasks(store)).toBe(4);
    expect(nextTask(store)?.id).toBe(ready.id);

    store.update(ready.id, { status: 'in-progress' });
    expect(store.remaining()).toBe(3);

    store.archive(future.id);
    expect(store.remaining()).toBe(2);

    store.update(review.id, { status: 'completed' });
    expect(store.remaining()).toBe(1);

    store.close();
  });
});
