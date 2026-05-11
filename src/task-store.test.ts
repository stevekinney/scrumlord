import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from './database';
import { ScrumlordError } from './errors';

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

describe('createTaskStore', () => {
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

  it('runs migrations, persists tasks, and exposes graph queries', async () => {
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

    expect(store.getTask(blocked.id)).toMatchObject({
      id: 'blocked',
      parent: 'parent',
      branch: 'feature/task-graph',
      tags: ['backend', 'frontend'],
      blockedBy: ['blocker'],
    });
    expect(store.getTask(parent.id)?.subtasks).toEqual(['blocked']);
    expect(store.getTask(blocker.id)?.blocking).toEqual(['blocked']);
    expect(store.available().map((task) => task.id)).toEqual(['blocker', 'parent']);
    expect(store.blocked().map((task) => task.id)).toEqual(['blocked']);
    expect(store.blockedBy(blocked).map((task) => task.id)).toEqual(['blocker']);
    expect(store.blocking(blocker).map((task) => task.id)).toEqual(['blocked']);
    expect(store.withTag('FRONTEND').map((task) => task.id)).toEqual([
      'blocked',
      'blocker',
      'parent',
    ]);
    expect(store.withAllTags('frontend', 'backend').map((task) => task.id)).toEqual(['blocked']);
    expect(store.withAnyTag('backend', 'planning').map((task) => task.id)).toEqual([
      'blocked',
      'parent',
    ]);
    expect(store.withPriority(3).map((task) => task.id)).toEqual(['blocked', 'future']);
    expect(store.withBranch('feature/task-graph').map((task) => task.id)).toEqual(['blocked']);
    expect(store.next()?.id).toBe('blocker');

    expect(store.update(blocked.id, { branch: ' feature/renamed ' }).branch).toBe(
      'feature/renamed',
    );
    expect(store.withBranch('feature/task-graph')).toEqual([]);
    expect(store.withBranch('feature/renamed').map((task) => task.id)).toEqual(['blocked']);
    expect(store.update(blocked.id, { branch: null }).branch).toBeNull();

    store.update(blocker.id, { status: 'completed', description: 'Done', dueDate: null });
    expect(store.completed().map((task) => task.id)).toEqual(['blocker']);
    expect(store.blocked()).toEqual([]);
    expect(store.next()?.id).toBe('blocked');

    store.addTag(future.id, 'Backend');
    expect(store.getTask(future.id)?.tags).toEqual(['backend']);
    store.removeTag(future.id, 'backend');
    expect(store.getTask(future.id)?.tags).toEqual([]);
    store.setParent(future.id, parent.id);
    expect(store.getTask(future.id)?.parent).toBe(parent.id);
    store.clearParent(future.id);
    expect(store.getTask(future.id)?.parent).toBeNull();
    store.addBlocker(future.id, parent.id);
    expect(store.blockedBy(future.id).map((task) => task.id)).toEqual(['parent']);
    store.removeBlocker(future.id, parent.id);
    expect(store.blockedBy(future.id)).toEqual([]);

    expect(() => store.setParent(parent.id, blocked.id)).toThrow(ScrumlordError);
    expect(() => store.addBlocker(blocker.id, blocked.id)).toThrow(ScrumlordError);
    expect(() => store.update('missing', { title: 'Nope' })).toThrow(ScrumlordError);
    expect(() => store.create({ title: '   ' })).toThrow(ScrumlordError);
    expect(() => store.create({ id: 'blocked', title: 'Duplicate id' })).toThrow(ScrumlordError);
    expect(() => store.create({ title: 'Bad date', startDate: 'not-a-date' })).toThrow(
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

    expect(store.delete(future.id).deleted).toBe(true);
    expect(store.restore(future.id).deleted).toBe(false);
    expect(store.archive(future.id).archived).toBe(true);
    expect(store.restore(future.id).archived).toBe(false);

    currentDate = new Date('2026-01-01T00:00:00.000Z');
    store.create({ id: 'old-completed', title: 'Old completed', status: 'completed' });
    store.archive(store.create({ id: 'old-archived', title: 'Old archived' }).id);
    currentDate = new Date('2026-05-11T12:00:00.000Z');
    expect(store.cleanup(30)).toEqual({ deleted: 2 });
    expect(store.getTask('old-completed')).toBeNull();
    expect(store.getTask('old-archived')).toBeNull();

    const migrationDatabase = new Database(join(root, 'tmp', 'tasks.db'), { readonly: true });
    expect(
      migrationDatabase.query<{ version: number }, []>('SELECT version FROM task_migrations').all(),
    ).toEqual([{ version: 1 }, { version: 2 }]);
    migrationDatabase.close();
    store.close();

    const reopened = await createTaskStore({ cwd: root, now: () => currentDate });
    expect(reopened.getTask('blocked')?.title).toBe('Blocked task');
    reopened.close();

    const defaultClockStore = await createTaskStore({ cwd: root });
    expect(
      defaultClockStore.create({ id: 'default-clock', title: 'Default clock' }).createdAt,
    ).toContain('T');
    defaultClockStore.close();
  });
});
