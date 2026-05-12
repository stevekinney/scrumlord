import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-progress-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

const taskIdFromOutput = (output: string): string => {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'id' in parsed &&
    typeof parsed.id === 'string'
  ) {
    return parsed.id;
  }
  throw new Error('Expected task JSON with a string id.');
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('task progress CLI commands', () => {
  it('records and lists progress entries for a task', async () => {
    const root = await workspaceRoot();
    const created = await runTasksCli(
      ['create', '--title', 'Progress task', '--provider', 'codex', '--session', 'codex-session'],
      { cwd: root },
    );
    const taskId = taskIdFromOutput(created.stdout);

    const recorded = await runTasksCli(
      ['add-progress', taskId, '--message', '  Wrote regression coverage.  '],
      { cwd: root },
    );
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      taskId,
      message: 'Wrote regression coverage.',
      provider: 'codex',
      session: 'codex-session',
    });

    const progress = await runTasksCli(['progress', taskId], { cwd: root });
    expect(JSON.parse(progress.stdout)).toEqual([
      expect.objectContaining({ taskId, message: 'Wrote regression coverage.' }),
    ]);
  });

  it('moves draft and ready tasks to in-progress when progress is recorded', async () => {
    const root = await workspaceRoot();
    const draft = await runTasksCli(['create', '--title', 'Draft task', '--draft'], { cwd: root });
    const ready = await runTasksCli(['create', '--title', 'Ready task'], { cwd: root });
    const draftId = taskIdFromOutput(draft.stdout);
    const readyId = taskIdFromOutput(ready.stdout);

    await runTasksCli(['add-progress', draftId, '--message', 'Started draft work.'], { cwd: root });
    await runTasksCli(['add-progress', readyId, '--message', 'Started ready work.'], { cwd: root });

    const fetchedDraft = await runTasksCli(['get', draftId], { cwd: root });
    const fetchedReady = await runTasksCli(['get', readyId], { cwd: root });

    expect(JSON.parse(fetchedDraft.stdout)).toMatchObject({
      id: draftId,
      status: 'in-progress',
    });
    expect(JSON.parse(fetchedReady.stdout)).toMatchObject({
      id: readyId,
      status: 'in-progress',
    });
  });

  it('renders progress help and validates progress input before opening a store', async () => {
    const progressHelp = await runTasksCli(['progress', '--help'], { colorMode: 'never' });
    expect(progressHelp.stdout).toContain('tasks progress [task-id]');
    expect(progressHelp.stdout).toContain('chronological progress entries');

    const addProgressHelp = await runTasksCli(['add-progress', '--help'], { colorMode: 'never' });
    expect(addProgressHelp.stdout).toContain('tasks add-progress [task-id] --message <markdown>');
    expect(addProgressHelp.stdout).toContain('--message');

    let createStoreCalls = 0;
    const result = await runTasksCli(['add-progress', 'task-id'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('Store should not open.');
      },
    });

    expect(JSON.parse(result.stderr).error.code).toBe('missing_progress_message');
    expect(createStoreCalls).toBe(0);
  });
});
