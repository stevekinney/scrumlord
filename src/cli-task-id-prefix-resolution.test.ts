import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-task-id-prefix-resolution-'));
  temporaryDirectories.push(directory);
  return directory;
};

const run = async (command: string[], cwd: string): Promise<void> => {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await run(['git', 'init'], root);
  return root;
};

const errorCode = async (args: string[], cwd: string): Promise<string> => {
  const result = await runTasksCli(args, { cwd });
  const parsed: unknown = JSON.parse(result.stderr);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'error' in parsed &&
    typeof parsed.error === 'object' &&
    parsed.error !== null &&
    'code' in parsed.error &&
    typeof parsed.error.code === 'string'
  ) {
    return parsed.error.code;
  }
  throw new Error('Expected task error JSON with a string error code.');
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('resolveTaskId — UUID prefixes', () => {
  it('get resolves a unique UUID prefix to the matching task', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    const fullId = '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      store.create({ id: fullId, title: 'Prefix target' });
      store.create({ id: '87654321-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Other task' });
    } finally {
      store.close();
    }

    const result = await runTasksCli(['get', '12345678'], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: fullId, title: 'Prefix target' });
  });

  it('updates the task resolved from a unique UUID prefix', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    const fullId = 'abcdef12-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    try {
      store.create({ id: fullId, title: 'Prefix target' });
      store.create({ id: 'fedcba98-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Other task' });
    } finally {
      store.close();
    }

    const result = await runTasksCli(['update', 'abcdef12', '--title', 'Renamed via prefix'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: fullId, title: 'Renamed via prefix' });
  });

  it('fails with task_id_ambiguous when a UUID prefix matches multiple tasks', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'First match' });
      store.create({ id: 'aaaaaaaa-2222-4222-8222-222222222222', title: 'Second match' });
    } finally {
      store.close();
    }

    expect(await errorCode(['get', 'aaaaaaaa'], root)).toBe('task_id_ambiguous');
  });

  it('create resolves --blocked-by from a unique UUID prefix', async () => {
    const root = await workspaceRoot();
    const blockerId = '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: blockerId, title: 'Blocker' });
      store.create({ id: '87654321-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Unrelated' });
    } finally {
      store.close();
    }

    const result = await runTasksCli(
      ['create', '--title', 'Needs blocker', '--blocked-by', '12345678'],
      { cwd: root },
    );
    const created = JSON.parse(result.stdout) as { blockedBy: { id: string }[] };
    expect(created.blockedBy.map((blocker) => blocker.id)).toEqual([blockerId]);
  });

  it('create --blocked-by surfaces task_id_ambiguous when the prefix matches multiple tasks', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'First match' });
      store.create({ id: 'aaaaaaaa-2222-4222-8222-222222222222', title: 'Second match' });
    } finally {
      store.close();
    }

    expect(
      await errorCode(['create', '--title', 'Needs blocker', '--blocked-by', 'aaaaaaaa'], root),
    ).toBe('task_id_ambiguous');
  });
});
