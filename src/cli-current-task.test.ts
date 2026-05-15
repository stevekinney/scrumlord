import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-current-task-'));
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
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  await run(['git', 'init'], root);
  await run(['git', 'checkout', '-b', 'feature/current-task'], root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('tasks current', () => {
  it('returns the active task assigned to the current Git branch', async () => {
    const root = await workspaceRoot();
    await runTasksCli(['create', '--title', 'Other task', '--branch', 'feature/other'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Current task', '--branch', 'feature/current-task'], {
      cwd: root,
    });

    const result = await runTasksCli(['current'], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({
      title: 'Current task',
      branch: 'feature/current-task',
    });
  });

  it('returns null when no active task is assigned to the current Git branch', async () => {
    const result = await runTasksCli(['current'], { cwd: await workspaceRoot() });

    expect(JSON.parse(result.stdout)).toBeNull();
  });

  it('fails clearly when multiple active tasks match the current Git branch', async () => {
    const root = await workspaceRoot();
    await runTasksCli(['create', '--title', 'First task', '--branch', 'feature/current-task'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Second task', '--branch', 'feature/current-task'], {
      cwd: root,
    });

    const result = await runTasksCli(['current'], { cwd: root });
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'current_task_ambiguous',
      message: expect.stringContaining('Current branch matches multiple active tasks:'),
    });
  });
});
