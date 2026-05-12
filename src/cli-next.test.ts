import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-next-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'init'], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('tasks next and remaining', () => {
  it('returns empty output when no task is available', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['next'], { cwd: root });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('returns a planned task before an unplanned task', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Unplanned high priority task', '--priority', '3'], {
      cwd: root,
    });
    const planned = await runTasksCli(
      [
        'create',
        '--title',
        'Planned low priority task',
        '--priority',
        '1',
        '--plan',
        'tmp/tasks/planned/PLAN.md',
      ],
      { cwd: root },
    );

    const result = await runTasksCli(['next'], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: JSON.parse(planned.stdout).id,
      title: 'Planned low priority task',
      plan: 'tmp/tasks/planned/PLAN.md',
    });
  });

  it('returns the remaining task count as a JSON integer', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Future task', '--start-date', '2026-05-12'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Active task', '--status', 'in-progress'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Done task', '--status', 'completed'], { cwd: root });

    const result = await runTasksCli(['remaining'], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBe(1);
  });
});
