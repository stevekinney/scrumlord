import { describe, expect, it } from 'bun:test';
import type { CommandResult, CommandRunner } from './command-runner';
import { createTaskStore } from './database-open';
import { workspaceRoot } from './github-test-helpers';
import {
  tasksCompleteSync,
  type CompleteSyncGitHub,
  type CompleteSyncOptions,
} from './tasks-complete-sync';
import type { PullRequestOverviewItem } from './tasks-overview';
import type { Task, TaskStore } from './types';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: '', stderr });

const overviewItem = (
  overrides: Partial<PullRequestOverviewItem> = {},
): PullRequestOverviewItem => ({
  pullRequest: {
    number: 1,
    url: 'https://example/pr/1',
    headRefName: 'feature/one',
    headSha: 'sha1',
    title: 'One',
    state: 'OPEN',
    baseRefName: 'main',
    mergedAt: null,
    body: null,
    mergeable: null,
    mergeStateStatus: null,
  },
  associatedTasks: [],
  reviewComments: { unresolvedCount: 0 },
  continuousIntegration: { status: 'success', pendingCount: 0, failedCount: 0, checks: [] },
  readyToMerge: true,
  ...overrides,
});

const fakeGitHub = (items: PullRequestOverviewItem[]): CompleteSyncGitHub => ({
  tasksOverview: async () => items,
});

const recordingRunner = (
  responses: (command: string[]) => CommandResult,
): { runner: CommandRunner; commands: string[][] } => {
  const commands: string[][] = [];
  const runner: CommandRunner = async (command) => {
    commands.push(command);
    return responses(command);
  };
  return { runner, commands };
};

const withStore = async (
  seed: (store: TaskStore) => Task[],
  run: (store: TaskStore, tasks: Task[]) => Promise<void>,
): Promise<void> => {
  const store = await createTaskStore({ cwd: await workspaceRoot() });
  try {
    await run(store, seed(store));
  } finally {
    store.close();
  }
};

const baseOptions = (overrides: Partial<CompleteSyncOptions>): CompleteSyncOptions => ({
  apply: false,
  all: false,
  ...overrides,
});

describe('tasksCompleteSync', () => {
  it('dry-run plans without merging or completing', async () => {
    await withStore(
      (store) => [store.create({ title: 'Linked', status: 'in-progress', branch: 'feature/one' })],
      async (store, [task]) => {
        const item = overviewItem({ associatedTasks: [task] });
        const { runner, commands } = recordingRunner(() => ok());

        const result = await tasksCompleteSync(store, fakeGitHub([item]), baseOptions({ runner }));

        expect(result.applied).toBe(false);
        expect(result.planned).toEqual([{ number: 1, outcome: 'merge', taskIds: [task.id] }]);
        expect(result.merged).toEqual([]);
        expect(commands).toEqual([]); // no merge command ran
        expect(store.getTask(task.id)?.status).toBe('in-progress'); // unchanged
      },
    );
  });

  it('apply merges ready linked PRs and completes their tasks', async () => {
    await withStore(
      (store) => [store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' })],
      async (store, [task]) => {
        const item = overviewItem({ associatedTasks: [task] });
        const { runner, commands } = recordingRunner((command) =>
          command.includes('merge') ? ok('') : ok(),
        );

        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );

        expect(result.applied).toBe(true);
        expect(result.merged).toEqual([
          { number: 1, outcome: 'merged', completedTaskIds: [task.id] },
        ]);
        expect(result.failed).toEqual([]);
        expect(store.getTask(task.id)?.status).toBe('completed');
        expect(commands.some((command) => command.includes('merge'))).toBe(true);
      },
    );
  });

  it('skips unlinked PRs by default but merges them with --all under mergedWithoutTasks', async () => {
    await withStore(
      () => [],
      async (store) => {
        const item = overviewItem();
        const { runner } = recordingRunner((command) => (command.includes('merge') ? ok() : ok()));

        const skipped = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );
        expect(skipped.skipped).toEqual([{ number: 1, reason: 'no_associated_task' }]);
        expect(skipped.mergedWithoutTasks).toEqual([]);

        const all = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, all: true, runner }),
        );
        expect(all.mergedWithoutTasks).toEqual([{ number: 1, outcome: 'merged' }]);
      },
    );
  });

  it('skips not-ready PRs', async () => {
    await withStore(
      () => [],
      async (store) => {
        const item = overviewItem({ readyToMerge: false });
        const { runner } = recordingRunner(() => ok());
        const result = await tasksCompleteSync(store, fakeGitHub([item]), baseOptions({ runner }));
        expect(result.skipped).toEqual([{ number: 1, reason: 'not_ready' }]);
      },
    );
  });

  it('skips PRs linked only to soft-deleted tasks', async () => {
    await withStore(
      (store) => {
        const task = store.create({ title: 'Gone', status: 'ready', branch: 'feature/one' });
        const deleted = store.delete(task.id);
        return deleted ? [deleted] : [];
      },
      async (store, [deletedTask]) => {
        const item = overviewItem({ associatedTasks: [deletedTask] });
        const { runner, commands } = recordingRunner(() => ok());
        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );
        expect(result.skipped).toEqual([{ number: 1, reason: 'no_completable_associated_task' }]);
        expect(commands).toEqual([]);
      },
    );
  });

  it('merges a PR linked only to already-completed tasks with empty completedTaskIds', async () => {
    await withStore(
      (store) => {
        const task = store.create({ title: 'Done', status: 'ready', branch: 'feature/one' });
        return [store.update(task.id, { status: 'completed' })];
      },
      async (store, [completed]) => {
        const item = overviewItem({ associatedTasks: [completed] });
        const { runner } = recordingRunner((command) => (command.includes('merge') ? ok() : ok()));
        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );
        expect(result.merged).toEqual([{ number: 1, outcome: 'merged', completedTaskIds: [] }]);
      },
    );
  });

  it('records already-merged PRs and still completes their tasks', async () => {
    await withStore(
      (store) => [store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' })],
      async (store, [task]) => {
        const item = overviewItem({
          associatedTasks: [task],
          pullRequest: { ...overviewItem().pullRequest, state: 'MERGED' },
        });
        // mergeIfNeeded no-ops for MERGED state, so the runner is never called.
        const { runner, commands } = recordingRunner(() => fail('should not run'));
        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );
        expect(result.merged).toEqual([
          { number: 1, outcome: 'already_merged', completedTaskIds: [task.id] },
        ]);
        expect(commands).toEqual([]);
        expect(store.getTask(task.id)?.status).toBe('completed');
      },
    );
  });

  it('records merged_but_completion_failed when completion throws after a successful merge', async () => {
    await withStore(
      (store) => [store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' })],
      async (store, [task]) => {
        const item = overviewItem({ associatedTasks: [task] });
        // The merge succeeds, but the task is soft-deleted as a side effect of the
        // merge command, so the subsequent completion rejects it.
        const runner: CommandRunner = async (command) => {
          if (command.includes('merge')) {
            store.delete(task.id);
            return ok('');
          }
          return ok();
        };

        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );

        expect(result.merged).toEqual([]);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]?.number).toBe(1);
        expect(result.failed[0]?.reason).toContain('merged_but_completion_failed');
        expect(result.failed[0]?.taskIds).toEqual([task.id]);
      },
    );
  });

  it('records a failed merge and leaves tasks uncompleted', async () => {
    await withStore(
      (store) => [store.create({ title: 'Linked', status: 'in-review', branch: 'feature/one' })],
      async (store, [task]) => {
        const item = overviewItem({ associatedTasks: [task] });
        const { runner } = recordingRunner((command) =>
          command.includes('merge') ? fail('merge conflict') : ok(),
        );
        const result = await tasksCompleteSync(
          store,
          fakeGitHub([item]),
          baseOptions({ apply: true, runner }),
        );
        expect(result.failed).toEqual([{ number: 1, reason: 'merge conflict' }]);
        expect(result.merged).toEqual([]);
        expect(store.getTask(task.id)?.status).toBe('in-review');
      },
    );
  });
});
