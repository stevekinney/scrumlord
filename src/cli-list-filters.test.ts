import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTasksCli } from './cli-runner';
import type { Task } from './types';

const writePlanFile = async (root: string, relativePlan: string): Promise<void> => {
  const absolute = join(root, relativePlan);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, '# Plan\n');
};

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-list-filters-'));
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

const isTask = (value: unknown): value is Task => {
  return typeof value === 'object' && value !== null && 'id' in value && 'plan' in value;
};

const parseTask = (value: string): Task => {
  const parsed: unknown = JSON.parse(value);
  if (!isTask(parsed)) throw new Error('Expected command output to be a task.');
  return parsed;
};

const parseTaskList = (value: string): Task[] => {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(isTask)) {
    throw new Error('Expected command output to be a task list.');
  }
  return parsed;
};

const parseCount = (value: string): number => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'number') throw new Error('Expected command output to be a number.');
  return parsed;
};

const expectSuccessfulCommand = async (root: string, command: string[]): Promise<Task> => {
  const result = await runTasksCli(command, { cwd: root });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return parseTask(result.stdout);
};

const createTask = async (root: string, title: string, flags: string[] = []): Promise<Task> => {
  return await expectSuccessfulCommand(root, ['create', '--title', title, ...flags]);
};

const addBlocker = async (root: string, taskId: string, blockerId: string): Promise<void> => {
  await expectSuccessfulCommand(root, ['add-blocker', taskId, blockerId]);
};

const readTaskList = async (root: string, command: string[]): Promise<Task[]> => {
  const result = await runTasksCli(command, { cwd: root });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return parseTaskList(result.stdout);
};

const readTaskCount = async (root: string, command: string[]): Promise<number> => {
  const result = await runTasksCli([...command, '--count'], { cwd: root });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  return parseCount(result.stdout);
};

const expectPlanFilter = async (root: string, command: string[]): Promise<void> => {
  const plannedTasks = await readTaskList(root, [...command, '--planned']);
  const unplannedTasks = await readTaskList(root, [...command, '--unplanned']);
  const allTasks = await readTaskList(root, command);
  const countedTasks = await readTaskCount(root, command);
  const countedPlannedTasks = await readTaskCount(root, [...command, '--planned']);
  const countedUnplannedTasks = await readTaskCount(root, [...command, '--unplanned']);

  expect(plannedTasks.length).toBeGreaterThan(0);
  expect(unplannedTasks.length).toBeGreaterThan(0);
  expect(plannedTasks.every((task) => task.plan !== null)).toBe(true);
  expect(unplannedTasks.every((task) => task.plan === null)).toBe(true);
  expect(countedTasks).toBe(allTasks.length);
  expect(countedPlannedTasks).toBe(plannedTasks.length);
  expect(countedUnplannedTasks).toBe(unplannedTasks.length);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('task listing plan filters', () => {
  it('filters every task array listing command by planned or unplanned tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await writePlanFile(root, 'tmp/tasks/planned-ready/PLAN.md');
    await writePlanFile(root, 'tmp/tasks/planned-blocked/PLAN.md');
    await writePlanFile(root, 'tmp/tasks/planned-completed/PLAN.md');
    const plannedReady = await createTask(root, 'Planned ready task', [
      '--priority',
      '3',
      '--plan',
      'tmp/tasks/planned-ready/PLAN.md',
      '--tags',
      'shared,filter',
      '--branch',
      'feature/plan-filters',
    ]);
    const unplannedReady = await createTask(root, 'Unplanned ready task', [
      '--priority',
      '3',
      '--tags',
      'shared,filter',
      '--branch',
      'feature/plan-filters',
    ]);
    const commonBlocker = await createTask(root, 'Common blocker');
    const plannedBlocked = await createTask(root, 'Planned blocked task', [
      '--plan',
      'tmp/tasks/planned-blocked/PLAN.md',
    ]);
    const unplannedBlocked = await createTask(root, 'Unplanned blocked task');
    const targetWithMixedBlockers = await createTask(root, 'Target with mixed blockers');
    await createTask(root, 'Planned completed task', [
      '--status',
      'completed',
      '--plan',
      'tmp/tasks/planned-completed/PLAN.md',
    ]);
    await createTask(root, 'Unplanned completed task', ['--status', 'completed']);

    await addBlocker(root, plannedBlocked.id, commonBlocker.id);
    await addBlocker(root, unplannedBlocked.id, commonBlocker.id);
    await addBlocker(root, targetWithMixedBlockers.id, plannedReady.id);
    await addBlocker(root, targetWithMixedBlockers.id, unplannedReady.id);

    const listingCommands = [
      ['available'],
      ['list'],
      ['list', '--all'],
      ['blocked'],
      ['completed'],
      ['with-tag', 'shared'],
      ['with-all-tags', 'shared', 'filter'],
      ['with-any-tag', 'shared', 'missing'],
      ['with-branch', 'feature/plan-filters'],
      ['blocked-by', targetWithMixedBlockers.id],
      ['blocking', commonBlocker.id],
      ['priority', '3'],
      ['with-priority', '3'],
    ];

    for (const command of listingCommands) await expectPlanFilter(root, command);
  });
});
