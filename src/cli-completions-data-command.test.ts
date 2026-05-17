import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';
import type { TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-completions-data-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  await process.exited;
};

const createStore = async (): Promise<{ root: string; store: TaskStore }> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  const store = await createTaskStore({ cwd: root });
  return { root, store };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('tasks completions-data ids', () => {
  it('returns non-deleted task IDs sorted ascending', async () => {
    const { root, store } = await createStore();
    // Insert in reverse order so the test only passes with ORDER BY id
    store.create({ id: 'zzz', title: 'Task Z' });
    store.create({ id: 'aaa', title: 'Task A' });
    store.create({ id: 'mmm', title: 'Task M' });
    store.delete('mmm');
    store.close();

    const result = await runTasksCli(['completions-data', 'ids'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('aaa\nzzz\n');
  });

  it('returns empty stdout for empty store', async () => {
    const { root, store } = await createStore();
    store.close();

    const result = await runTasksCli(['completions-data', 'ids'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('excludes soft-deleted tasks', async () => {
    const { root, store } = await createStore();
    store.create({ id: 'task-1', title: 'Task 1' });
    store.create({ id: 'task-2', title: 'Task 2' });
    store.delete('task-1');
    store.close();

    const result = await runTasksCli(['completions-data', 'ids'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('task-2\n');
  });
});

describe('tasks completions-data tags', () => {
  it('returns sorted unique tag names', async () => {
    const { root, store } = await createStore();
    store.create({ id: 'task-1', title: 'T1', tags: ['beta', 'alpha'] });
    store.create({ id: 'task-2', title: 'T2', tags: ['alpha', 'gamma'] });
    store.close();

    const result = await runTasksCli(['completions-data', 'tags'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('alpha\nbeta\ngamma\n');
  });

  it('returns empty stdout for store with no tags', async () => {
    const { root, store } = await createStore();
    store.create({ id: 'task-1', title: 'No tags' });
    store.close();

    const result = await runTasksCli(['completions-data', 'tags'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('returns empty stdout for empty store', async () => {
    const { root, store } = await createStore();
    store.close();

    const result = await runTasksCli(['completions-data', 'tags'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('handles tags with spaces, quotes, dollar signs, and backticks', async () => {
    const { root, store } = await createStore();
    store.create({
      id: 'task-1',
      title: 'Special tags',
      tags: ['tag with space', "tag'quote", 'tag$dollar', 'tag`backtick'],
    });
    store.close();

    const result = await runTasksCli(['completions-data', 'tags'], { cwd: root });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean).toSorted();
    expect(lines).toContain('tag with space');
    expect(lines).toContain("tag'quote");
    expect(lines).toContain('tag$dollar');
    expect(lines).toContain('tag`backtick');
  });

  it('excludes tags from soft-deleted tasks', async () => {
    const { root, store } = await createStore();
    store.create({ id: 'task-1', title: 'T1', tags: ['keep'] });
    store.create({ id: 'task-2', title: 'T2', tags: ['gone'] });
    store.delete('task-2');
    store.close();

    const result = await runTasksCli(['completions-data', 'tags'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('keep\n');
  });
});

describe('tasks completions-data unknown target', () => {
  it('returns exit 1 for unknown target', async () => {
    const { root, store } = await createStore();
    store.close();

    const result = await runTasksCli(['completions-data', 'bogus'], { cwd: root });
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stderr);
    expect(error.error.code).toBe('unknown_completions_data_target');
  });
});
