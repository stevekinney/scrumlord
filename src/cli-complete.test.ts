import { describe, expect, it } from 'bun:test';
import type { CommandResult, CommandRunner } from './command-runner';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';
import { workspaceRoot } from './github-test-helpers';
import type { PullRequestOverviewItem } from './tasks-overview';
import type { Task, TaskStore } from './types';

type CliOptions = Parameters<typeof runTasksCli>[1];

const withCli = async (
  run: (store: TaskStore, options: CliOptions) => Promise<void>,
): Promise<void> => {
  const store = await createTaskStore({ cwd: await workspaceRoot() });
  // runTasksCli closes the store it is handed. Intercept close() so the test can
  // keep inspecting state after the command returns; the real close runs in the
  // finally block below.
  const originalClose = store.close.bind(store);
  const handed: TaskStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'close') return () => {};
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    await run(store, { createStore: async () => handed, colorMode: 'never' });
  } finally {
    originalClose();
  }
};

const parseTasks = (stdout: string): Task[] => JSON.parse(stdout) as Task[];

describe('tasks complete (batch)', () => {
  it('completes multiple tasks by id and returns them as JSON', async () => {
    await withCli(async (store, options) => {
      const first = store.create({ title: 'First', status: 'ready' });
      const second = store.create({ title: 'Second', status: 'in-progress' });

      const result = await runTasksCli(['complete', first.id, second.id, '--json'], options);

      expect(result.exitCode).toBe(0);
      const tasks = parseTasks(result.stdout);
      expect(tasks.map((task) => task.status)).toEqual(['completed', 'completed']);
      expect(store.getTask(first.id)?.status).toBe('completed');
      expect(store.getTask(second.id)?.status).toBe('completed');
    });
  });

  it('resolves a uuid prefix', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Prefixed', status: 'ready' });

      const result = await runTasksCli(['complete', task.id.slice(0, 8), '--json'], options);

      expect(result.exitCode).toBe(0);
      expect(store.getTask(task.id)?.status).toBe('completed');
    });
  });

  it('rejects combining task ids with --sync', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Task', status: 'ready' });
      const result = await runTasksCli(['complete', task.id, '--sync'], options);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('invalid_complete_flags');
    });
  });

  it('rejects --apply without --sync', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Task', status: 'ready' });
      const result = await runTasksCli(['complete', task.id, '--apply'], options);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('invalid_complete_flags');
    });
  });

  it('rejects --all without --sync', async () => {
    await withCli(async (_store, options) => {
      const result = await runTasksCli(['complete', '--all'], options);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('invalid_complete_flags');
    });
  });

  it('requires at least one id when not syncing', async () => {
    await withCli(async (_store, options) => {
      const result = await runTasksCli(['complete'], options);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('missing_task_id');
    });
  });
});

const overviewItem = (number: number, branch: string, tasks: Task[]): PullRequestOverviewItem => ({
  pullRequest: {
    number,
    url: `https://example/pr/${number}`,
    headRefName: branch,
    headSha: `sha${number}`,
    title: `PR ${number}`,
    state: 'OPEN',
    baseRefName: 'main',
    mergedAt: null,
    body: null,
    mergeable: null,
    mergeStateStatus: null,
  },
  associatedTasks: tasks,
  reviewComments: { unresolvedCount: 0 },
  continuousIntegration: { status: 'success', pendingCount: 0, failedCount: 0, checks: [] },
  readyToMerge: true,
});

const syncGithub = (items: PullRequestOverviewItem[]) =>
  ({
    pullRequestStatus: async () => {
      throw new Error('unused');
    },
    pullRequestUrl: async () => ({ url: '' }),
    allReviewComments: async () => [],
    resolvedReviewComments: async () => [],
    unresolvedReviewComments: async () => [],
    tasksOverview: async () => items,
    repositoryName: async () => 'owner/repository',
    repositoryUrl: async () => '',
  }) as unknown as NonNullable<CliOptions>['github'];

const mergeRunner =
  (outcome: CommandResult): CommandRunner =>
  async () =>
    outcome;

describe('tasks complete --sync', () => {
  it('dry-run reports planned merges as pretty text and exits 0 without merging', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' });
      const result = await runTasksCli(['complete', '--sync'], {
        ...options,
        outputMode: 'pretty',
        github: syncGithub([overviewItem(7, 'feature/one', [task])]),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[dry-run]');
      expect(result.stdout).toContain('Would merge PR #7');
      expect(store.getTask(task.id)?.status).toBe('in-review');
    });
  });

  it('--apply merges and completes, emitting JSON when requested', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' });
      const result = await runTasksCli(['complete', '--sync', '--apply', '--json'], {
        ...options,
        outputMode: 'json',
        github: syncGithub([overviewItem(7, 'feature/one', [task])]),
        runner: mergeRunner({ exitCode: 0, stdout: '', stderr: '' }),
      });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.applied).toBe(true);
      expect(parsed.merged).toEqual([
        { number: 7, outcome: 'merged', completedTaskIds: [task.id] },
      ]);
      expect(store.getTask(task.id)?.status).toBe('completed');
    });
  });

  it('exits non-zero when a merge fails', async () => {
    await withCli(async (store, options) => {
      const task = store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' });
      const result = await runTasksCli(['complete', '--sync', '--apply'], {
        ...options,
        outputMode: 'pretty',
        github: syncGithub([overviewItem(7, 'feature/one', [task])]),
        runner: mergeRunner({ exitCode: 1, stdout: '', stderr: 'conflict' }),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Failed PR #7');
      expect(store.getTask(task.id)?.status).toBe('in-review');
    });
  });
});
