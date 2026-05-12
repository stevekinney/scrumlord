import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTaskProgress, createTaskStore, taskProgress } from './index';
import type { AddTaskProgressInput, TaskProgress } from './index';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-library-progress-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

type PublicProgressTypes = {
  input: AddTaskProgressInput;
  progress: TaskProgress;
};

const acceptsPublicProgressTypes = (_value: Partial<PublicProgressTypes>): boolean => true;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('library progress helpers', () => {
  it('exports progress helpers and companion types', async () => {
    expect(acceptsPublicProgressTypes({})).toBe(true);

    const store = await createTaskStore({ cwd: await workspaceRoot() });
    const task = store.create({
      title: 'Library progress task',
      provider: 'codex',
      session: 'codex-session',
    });

    expect(addTaskProgress(store, task.id, { message: 'Recorded progress.' })).toMatchObject({
      taskId: task.id,
      message: 'Recorded progress.',
      provider: 'codex',
      session: 'codex-session',
    });
    expect(taskProgress(store, task.id)).toEqual([
      expect.objectContaining({ taskId: task.id, message: 'Recorded progress.' }),
    ]);

    store.close();
  });
});
