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
  await expectSuccessfulCommand(root, ['blockers', 'add', taskId, blockerId]);
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

const errorCode = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('error' in value)) return undefined;
  const { error } = value as { error: unknown };
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
};

const expectError = async (
  root: string,
  command: string[],
  expectedCode: string,
): Promise<void> => {
  const result = await runTasksCli(command, { cwd: root });
  expect(result.exitCode).toBe(1);
  const parsed: unknown = JSON.parse(result.stderr);
  expect(errorCode(parsed)).toBe(expectedCode);
};

describe('tasks search', () => {
  it('returns matching tasks as JSON', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await createTask(root, 'Authentication service fix');
    await createTask(root, 'Unrelated feature');

    const tasks = await readTaskList(root, ['search', 'authentication']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Authentication service fix');
  });

  it('returns exit 1 with missing_search_query when no query is provided', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search'], 'missing_search_query');
  });

  it('works with --title flag only (no positional)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await createTask(root, 'Login service');
    await createTask(root, 'Unrelated task');

    const tasks = await readTaskList(root, ['search', '--title', 'login']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Login service');
  });

  it('intersects --title and --description flags', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await createTask(root, 'Login fix');
    await createTask(root, 'Login page', ['--description', 'timeout in mobile browser']);

    const tasks = await readTaskList(root, [
      'search',
      '--title',
      'login',
      '--description',
      'timeout',
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Login page');
  });

  it('returns exit 1 with search_query_conflict when positional and field flag are combined', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search', 'foo', '--title', 'bar'], 'search_query_conflict');
  });

  it('returns exit 1 with missing_flag_value when --title has no value token', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search', '--title'], 'missing_flag_value');
  });

  it('returns exit 1 with empty_search_query when --title is whitespace-only', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search', '--title', '   '], 'empty_search_query');
  });

  it('returns exit 1 with empty_search_query when --description is whitespace-only', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search', '--description', '   '], 'empty_search_query');
  });

  it('returns exit 1 with plan_filter_conflict when --planned and --unplanned are combined', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['search', 'foo', '--planned', '--unplanned'], 'plan_filter_conflict');
  });

  it('returns a number with --count', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await createTask(root, 'Authentication fix');
    await createTask(root, 'Authentication improvements');

    const count = await readTaskCount(root, ['search', 'authentication']);
    expect(count).toBe(2);
  });

  it('includes soft-deleted tasks with --all', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const task = await createTask(root, 'Authentication fix');

    // Soft-delete the task
    await runTasksCli(['delete', task.id], { cwd: root });

    const without = await readTaskList(root, ['search', 'authentication']);
    expect(without).toHaveLength(0);

    const withAll = await readTaskList(root, ['search', 'authentication', '--all']);
    expect(withAll.map((t) => t.id)).toContain(task.id);
  });

  it('returns tasks in correct ranked order', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    // Create three tasks: exact match (best), typo (medium), different (no match expected)
    const exact = await createTask(root, 'Authentication service', ['--priority', '1']);
    const typo = await createTask(root, 'Authenticaton issues', ['--priority', '3']);
    await createTask(root, 'Unrelated task', ['--priority', '3']);

    const tasks = await readTaskList(root, ['search', 'authentication']);
    const ids = tasks.map((t) => t.id);
    // Exact match should rank first; unrelated should be absent
    expect(ids[0]).toBe(exact.id);
    expect(ids).not.toContain('unrelated');
    // Both matching tasks should appear; exact before typo
    expect(ids.indexOf(exact.id)).toBeLessThan(ids.indexOf(typo.id));
  });
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
      ['tagged', 'shared'],
      ['tagged', 'shared', 'filter', '--all'],
      ['tagged', 'shared', 'missing'],
      ['with-branch', 'feature/plan-filters'],
      ['blocked-by', targetWithMixedBlockers.id],
      ['blocking', commonBlocker.id],
      ['priority', '3'],
      ['status', 'ready'],
    ];

    for (const command of listingCommands) await expectPlanFilter(root, command);
  });
});

describe('tasks list completion filters', () => {
  it('filters output by exact task status', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const ready = await createTask(root, 'Ready task');
    const inProgress = await createTask(root, 'In progress task', ['--status', 'in-progress']);
    await createTask(root, 'Completed task', ['--status', 'completed']);

    const inProgressTasks = await readTaskList(root, ['status', 'in-progress']);
    const readyCount = await readTaskCount(root, ['status', 'ready']);

    expect(inProgressTasks.map((task) => task.id)).toEqual([inProgress.id]);
    expect(readyCount).toBe(1);
    expect(ready.id).not.toBe(inProgress.id);
  });

  it('rejects invalid task status queries', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['status', 'later'], 'invalid_status');
  });

  it('filters list output by completed and incomplete tasks', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const ready = await createTask(root, 'Ready task');
    const inProgress = await createTask(root, 'In progress task', ['--status', 'in-progress']);
    const completed = await createTask(root, 'Completed task', ['--status', 'completed']);

    const completedTasks = await readTaskList(root, ['list', '--completed']);
    const incompleteTasks = await readTaskList(root, ['list', '--incomplete']);

    expect(completedTasks.map((task) => task.id)).toEqual([completed.id]);
    expect(incompleteTasks.map((task) => task.id).toSorted()).toEqual(
      [inProgress.id, ready.id].toSorted(),
    );
  });

  it('combines completion filters with --all and --count', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const completed = await createTask(root, 'Completed task', ['--status', 'completed']);
    await runTasksCli(['delete', completed.id], { cwd: root });

    expect(await readTaskCount(root, ['list', '--completed'])).toBe(0);
    expect(await readTaskCount(root, ['list', '--all', '--completed'])).toBe(1);
  });

  it('returns exit 1 when --completed and --incomplete are combined', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await expectError(root, ['list', '--completed', '--incomplete'], 'completion_filter_conflict');
  });
});
