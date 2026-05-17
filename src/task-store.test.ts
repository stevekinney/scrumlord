/* eslint-disable max-lines */
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
  await mkdir(join(root, 'tmp', 'tasks', 'blocked'), { recursive: true });
  await Bun.write(join(root, 'tmp', 'tasks', 'blocked', 'PLAN.md'), '# Plan\n');
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
      branch: 'feature/task-graph',
      plan: join(store.projectRoot, 'tmp', 'tasks', 'blocked', 'PLAN.md'),
      provider: 'codex',
      session: 'codex-session',
      tags: ['backend', 'frontend'],
      blockedBy: ['blocker'],
    });
    expect(parent.id).toBe('parent');
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
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ]);
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
      event: null,
      tool: null,
      cwd: null,
      transcriptPath: null,
      commitSha: null,
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
    // Create a plan file outside the project root and verify it's stored as an absolute path.
    const externalRoot = await temporaryDirectory();
    const externalPlan = join(externalRoot, 'external-plan.md');
    await Bun.write(externalPlan, '# Plan\n');
    expect(store.setPlan(blocked.id, externalPlan).plan).toBe(externalPlan);
    // Missing file throws.
    expect(() => store.setPlan(blocked.id, '../does-not-exist.md')).toThrow(ScrumlordError);
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
    store.addBlocker(future.id, parent.id);
    expect(taskIds(store.blockedBy(future.id))).toEqual(['parent']);
    store.removeBlocker(future.id, parent.id);
    expect(store.blockedBy(future.id)).toEqual([]);

    const softDeleted = store.delete(future.id);
    expect(softDeleted?.deleted).toBe(true);
    store.update(future.id, { deleted: false });
    expect(taskIds(store.list({ includeInactive: true }))).toContain(future.id);
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
    const alreadyDeleted = store.create({ id: 'old-deleted', title: 'Old deleted' });
    store.delete(alreadyDeleted.id);
    setCurrentDate(new Date('2026-05-11T12:00:00.000Z'));
    expect(store.cleanup(30)).toEqual({ deleted: 1 });
    expect(store.getTask('old-completed')?.deleted).toBe(true);
    // hard cleanup uses last_modified_at < cutoff. old-completed was just
    // soft-deleted with last_modified_at = now, so it is OUTSIDE the cutoff.
    // Only old-deleted (last_modified_at = 2026-01-01) is physically removed.
    expect(store.cleanup(30, { hard: true })).toEqual({ deleted: 1 });
    expect(store.getTask('old-completed')?.deleted).toBe(true);
    expect(store.getTask('old-deleted')).toBeNull();
    // After enough time passes, old-completed becomes hard-deletable too.
    setCurrentDate(new Date('2027-01-01T00:00:00.000Z'));
    expect(store.cleanup(30, { hard: true })).toEqual({ deleted: 1 });
    expect(store.getTask('old-completed')).toBeNull();
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
    store.delete(store.create({ id: 'deleted', title: 'Deleted task' }).id);

    expect(store.remaining()).toBe(4);
    expect(remainingTasks(store)).toBe(4);
    expect(nextTask(store)?.id).toBe(ready.id);

    store.update(ready.id, { status: 'in-progress' });
    expect(store.remaining()).toBe(3);

    store.delete(future.id);
    expect(store.remaining()).toBe(2);

    store.update(review.id, { status: 'completed' });
    expect(store.remaining()).toBe(1);

    store.close();
  });

  it('touches both task and blocker when adding or removing a blocker edge', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let currentDate = new Date('2026-05-11T12:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => currentDate });
    const task = store.create({ id: 'task', title: 'Task' });
    const blocker = store.create({ id: 'blocker', title: 'Blocker' });
    const modifiedAt = (id: string): string => store.getTask(id)!.lastModifiedAt;
    const taskBefore = modifiedAt(task.id);
    const blockerBefore = modifiedAt(blocker.id);

    currentDate = new Date('2026-05-12T00:00:00.000Z');
    store.addBlocker(task.id, blocker.id);
    expect(modifiedAt(task.id)).not.toBe(taskBefore);
    expect(modifiedAt(blocker.id)).not.toBe(blockerBefore);
    expect(modifiedAt(blocker.id)).toBe(modifiedAt(task.id));

    currentDate = new Date('2026-05-13T00:00:00.000Z');
    const taskMid = modifiedAt(task.id);
    const blockerMid = modifiedAt(blocker.id);
    store.removeBlocker(task.id, blocker.id);
    expect(modifiedAt(task.id)).not.toBe(taskMid);
    expect(modifiedAt(blocker.id)).not.toBe(blockerMid);

    store.close();
  });

  it('cleans dependency edges and touches surviving neighbors on soft delete', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let currentDate = new Date('2026-05-11T12:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => currentDate });
    const a = store.create({ id: 'a', title: 'A' });
    const b = store.create({ id: 'b', title: 'B' });
    const c = store.create({ id: 'c', title: 'C' });
    store.addBlocker(b.id, a.id);
    store.addBlocker(c.id, a.id);

    currentDate = new Date('2026-05-12T00:00:00.000Z');
    const bBefore = store.getTask(b.id)?.lastModifiedAt;
    const cBefore = store.getTask(c.id)?.lastModifiedAt;
    const deleted = store.delete(a.id);
    expect(deleted?.deleted).toBe(true);
    expect(store.blockedBy(b.id)).toEqual([]);
    expect(store.blockedBy(c.id)).toEqual([]);
    expect(store.getTask(b.id)?.lastModifiedAt).not.toBe(bBefore);
    expect(store.getTask(c.id)?.lastModifiedAt).not.toBe(cBefore);

    store.close();
  });

  it('soft cleanup clears dependency edges and touches surviving neighbors', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let currentDate = new Date('2026-01-01T00:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => currentDate });
    const blocker = store.create({
      id: 'aged',
      title: 'Aged',
      status: 'completed',
    });
    const downstream = store.create({ id: 'downstream', title: 'Downstream' });
    store.addBlocker(downstream.id, blocker.id);

    currentDate = new Date('2026-05-11T00:00:00.000Z');
    const downstreamBefore = store.getTask(downstream.id)!.lastModifiedAt;
    expect(store.cleanup(30)).toEqual({ deleted: 1 });
    expect(store.getTask(blocker.id)?.deleted).toBe(true);
    expect(store.blockedBy(downstream.id)).toEqual([]);
    expect(store.getTask(downstream.id)!.lastModifiedAt).not.toBe(downstreamBefore);

    store.close();
  });

  it('hard cleanup removes rows via cascade and touches surviving neighbors', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let currentDate = new Date('2026-01-01T00:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => currentDate });
    const aged = store.create({ id: 'aged', title: 'Aged', status: 'completed' });
    const downstream = store.create({ id: 'downstream', title: 'Downstream' });
    store.addBlocker(downstream.id, aged.id);

    currentDate = new Date('2026-05-11T00:00:00.000Z');
    const downstreamBefore = store.getTask(downstream.id)!.lastModifiedAt;
    store.cleanup(30, { hard: true });
    expect(store.getTask(aged.id)).toBeNull();
    expect(store.getTask(downstream.id)).not.toBeNull();
    expect(store.blockedBy(downstream.id)).toEqual([]);
    expect(store.getTask(downstream.id)!.lastModifiedAt).not.toBe(downstreamBefore);

    store.close();
  });

  it('hard delete removes the row and touches surviving neighbors via FK cascade', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let currentDate = new Date('2026-05-11T12:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => currentDate });
    const a = store.create({ id: 'a', title: 'A' });
    const b = store.create({ id: 'b', title: 'B' });
    store.addBlocker(b.id, a.id);

    currentDate = new Date('2026-05-12T00:00:00.000Z');
    const bBefore = store.getTask(b.id)?.lastModifiedAt;
    expect(store.delete(a.id, { hard: true })).toBeNull();
    expect(store.getTask(a.id)).toBeNull();
    expect(store.blockedBy(b.id)).toEqual([]);
    expect(store.getTask(b.id)?.lastModifiedAt).not.toBe(bBefore);

    store.close();
  });
});

describe('previewCleanup', () => {
  it('returns IDs of tasks that would be soft-deleted without mutating anything', async () => {
    const { store, setCurrentDate } = await createSeededStore();
    store.update('blocked', { status: 'completed' });

    // Advance the clock so the completed task is older than the cutoff
    setCurrentDate(new Date('2026-05-12T12:00:00.000Z'));

    const preview = store.previewCleanup(0);
    expect(preview.wouldDelete).toContain('blocked');

    // Task still exists with deleted=0
    const stillThere = store.getTask('blocked');
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deleted).toBe(false);

    store.close();
  });

  it('returns same set as hard cleanup selection for hard mode', async () => {
    const { store, setCurrentDate } = await createSeededStore();
    store.update('blocked', { status: 'completed' });
    store.delete('parent');

    // Advance the clock so the tasks are older than the cutoff
    setCurrentDate(new Date('2026-05-12T12:00:00.000Z'));

    const softPreview = store.previewCleanup(0, { hard: false });
    const hardPreview = store.previewCleanup(0, { hard: true });

    // Hard should include soft-deleted (parent) + completed (blocked)
    expect(hardPreview.wouldDelete).toContain('blocked');
    expect(hardPreview.wouldDelete).toContain('parent');
    expect(softPreview.wouldDelete).toContain('blocked');
    expect(softPreview.wouldDelete).not.toContain('parent');

    store.close();
  });
});

describe('inProgress, countInProgress, countBranched', () => {
  it('inProgress returns only in-progress non-deleted tasks', async () => {
    const { store } = await createSeededStore();
    store.update('blocked', { status: 'in-progress' });
    store.update('parent', { status: 'in-progress' });
    store.delete('parent');

    const tasks = store.inProgress();
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain('blocked');
    expect(ids).not.toContain('parent'); // deleted

    store.close();
  });

  it('countInProgress returns count of in-progress non-deleted tasks', async () => {
    const { store } = await createSeededStore();
    store.update('blocked', { status: 'in-progress' });
    expect(store.countInProgress()).toBe(1);

    store.close();
  });

  it('countBranched returns count of non-deleted tasks with non-empty branch', async () => {
    const { store } = await createSeededStore();
    // blocked already has branch 'feature/task-graph'
    expect(store.countBranched()).toBe(1);

    store.update('parent', { branch: '' });
    expect(store.countBranched()).toBe(1); // empty branch not counted

    store.delete('blocked'); // soft-delete the branched task
    expect(store.countBranched()).toBe(0);

    store.close();
  });
});

describe('recoverOrphan', () => {
  it('happy path: returns applied with cleared branch/session and bumped lastModifiedAt', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let now = new Date('2026-05-11T12:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => now });

    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/x' });
    store.update('t1', { provider: 'claude', session: 'sess123' });

    now = new Date('2026-05-11T13:00:00.000Z');
    const result = store.recoverOrphan('t1', {
      previousBranch: 'task/x',
      previousSession: 'sess123',
      reason: 'branch-not-in-git',
    });

    expect(result.outcome).toBe('applied');
    if (result.outcome !== 'applied') return;

    expect(result.task.status).toBe('ready');
    expect(result.task.branch).toBeNull();
    expect(result.task.session).toBeNull();
    expect(result.task.lastModifiedAt).toBe('2026-05-11T13:00:00.000Z');
    expect(result.progress.message).toContain('[cleanup] orphan recovered');
    expect(result.progress.message).toContain('branch-not-in-git');

    store.close();
  });

  it('stale-state on status change: returns stale-state with no writes', async () => {
    const { store } = await createSeededStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/x' });

    // Change status before recovery
    store.update('t1', { status: 'in-review' });

    const before = store.getTask('t1');
    const result = store.recoverOrphan('t1', {
      previousBranch: 'task/x',
      previousSession: null,
      reason: 'branch-not-in-git',
    });

    expect(result.outcome).toBe('stale-state');
    if (result.outcome !== 'stale-state') return;
    expect(result.actual.status).toBe('in-review');

    // No write occurred
    const after = store.getTask('t1');
    expect(after?.lastModifiedAt).toBe(before?.lastModifiedAt);

    store.close();
  });

  it('stale-state on branch drift: returns stale-state when branch changed', async () => {
    const { store } = await createSeededStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/x' });
    store.update('t1', { branch: 'task/y' });

    const result = store.recoverOrphan('t1', {
      previousBranch: 'task/x',
      previousSession: null,
      reason: 'branch-not-in-git',
    });

    expect(result.outcome).toBe('stale-state');

    store.close();
  });
});

describe('TaskStore.allIds()', () => {
  it('returns empty array for empty store', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    expect(store.allIds()).toEqual([]);
    store.close();
  });

  it('returns non-deleted IDs sorted ascending (insertion order is reverse alphabetical)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 'zzz', title: 'Task Z' });
    store.create({ id: 'aaa', title: 'Task A' });
    store.create({ id: 'mmm', title: 'Task M' });
    expect(store.allIds()).toEqual(['aaa', 'mmm', 'zzz']);
    store.close();
  });

  it('excludes soft-deleted tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 'task-keep', title: 'Keep' });
    store.create({ id: 'task-gone', title: 'Gone' });
    store.delete('task-gone');
    expect(store.allIds()).toEqual(['task-keep']);
    store.close();
  });
});

describe('TaskStore.allTags()', () => {
  it('returns empty array for empty store', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    expect(store.allTags()).toEqual([]);
    store.close();
  });

  it('returns sorted unique tag names across tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 't1', title: 'T1', tags: ['beta', 'alpha'] });
    store.create({ id: 't2', title: 'T2', tags: ['alpha', 'gamma'] });
    expect(store.allTags()).toEqual(['alpha', 'beta', 'gamma']);
    store.close();
  });

  it('excludes tags from soft-deleted tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 't1', title: 'T1', tags: ['keep'] });
    store.create({ id: 't2', title: 'T2', tags: ['gone'] });
    store.delete('t2');
    expect(store.allTags()).toEqual(['keep']);
    store.close();
  });

  it('filters out tags containing newlines via the newline-filter', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 't1', title: 'T1', tags: ['normal', 'also-normal'] });
    const ids = store.allIds();
    expect(ids).toEqual(['t1']);
    const tags = store.allTags();
    expect(tags).toEqual(['also-normal', 'normal']);
    expect(tags.every((tag) => !tag.includes('\n'))).toBe(true);
    store.close();
  });
});
