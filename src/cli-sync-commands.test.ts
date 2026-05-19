import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { PullRequestOverviewItem } from './tasks-overview';
import type { Task, TaskStore } from './types';

const task = (id: string): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  blocked: false,
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  deleted: false,
});

const fakeStore = (calls: string[]): TaskStore =>
  ({
    projectRoot: '/project',
    databasePath: '/project/tmp/tasks.db',
    create: () => task('created'),
    update: (id: string) => task(id),
    delete: (id: string) => task(id),
    getTask: (id: string) => task(id),
    list: () => [],
    available: () => [],
    blocked: () => [],
    completed: () => [],
    withTag: () => [],
    withAllTags: () => [],
    withAnyTag: () => [],
    withBranch: () => [],
    withSession: () => [],
    blockedBy: () => [],
    blocking: () => [],
    withPriority: () => [],
    next: () => task('next'),
    remaining: () => 0,
    cleanup: () => ({ deleted: 0 }),
    addTag: (id: string) => task(id),
    removeTag: (id: string) => task(id),
    addBlocker: (id: string) => task(id),
    removeBlocker: (id: string) => task(id),
    setPlan: (id: string) => task(id),
    setSession: (id: string) => task(id),
    taskSession: (id: string) => ({
      taskId: id,
      provider: null,
      session: null,
      branch: null,
      plan: null,
    }),
    ...emptyProgressStoreMethods,
    close() {
      calls.push('close');
    },
  }) as unknown as TaskStore;

const noopGithub = {
  pullRequestStatus: async () => {
    throw Object.assign(new Error('no pr'), { code: 'pull_request_not_found' });
  },
  pullRequestUrl: async () => ({ url: '' }),
  allReviewComments: async () => [],
  resolvedReviewComments: async () => [],
  unresolvedReviewComments: async () => [],
  tasksOverview: async () => [],
  repositoryName: async () => '',
  repositoryUrl: async () => '',
};

const overviewItem = (): PullRequestOverviewItem => ({
  pullRequest: {
    number: 7,
    url: 'https://example.test/pull/7',
    headRefName: 'feature/watch',
    headSha: 'sha',
    title: 'Watch dashboard',
    state: 'OPEN',
    baseRefName: 'main',
    mergedAt: null,
    body: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  },
  associatedTasks: [task('task-watch')],
  reviewComments: { unresolvedCount: 0 },
  continuousIntegration: {
    status: 'success',
    pendingCount: 0,
    failedCount: 0,
    checks: [],
  },
  readyToMerge: true,
});

describe('tasks pr --sync', () => {
  it('--quiet returns empty success and runs syncGitStatus', async () => {
    const calls: string[] = [];
    const result = await runTasksCli(['pr', '--sync', '--quiet'], {
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [] };
      },
      github: noopGithub,
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(calls).toContain('syncGitStatus');
  });

  it('without --quiet returns { pullRequest, sync }', async () => {
    const calls: string[] = [];
    const prStatus = { number: 42, title: 'Test', state: 'open', readyToMerge: false };
    const result = await runTasksCli(['pr', '--sync'], {
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [] };
      },
      github: { ...noopGithub, pullRequestStatus: async () => prStatus },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('pullRequest');
    expect(parsed).toHaveProperty('sync');
    expect(calls).toContain('syncGitStatus');
  });

  it('without --sync does not call syncGitStatus', async () => {
    const calls: string[] = [];
    await runTasksCli(['pr', '--url'], {
      github: { ...noopGithub, pullRequestUrl: async () => ({ url: 'https://example.com' }) },
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [] };
      },
    });
    expect(calls).not.toContain('syncGitStatus');
  });
});

describe('tasks overview --sync', () => {
  it('wraps output as { items, sync }', async () => {
    const calls: string[] = [];
    const result = await runTasksCli(['overview', '--sync'], {
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [] };
      },
      github: { ...noopGithub, tasksOverview: async () => [task('pr-task')] },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('items');
    expect(parsed).toHaveProperty('sync');
    expect(calls).toContain('syncGitStatus');
  });

  it('without --sync returns array without sync wrapper', async () => {
    const calls: string[] = [];
    const result = await runTasksCli(['overview'], {
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [] };
      },
      github: { ...noopGithub, tasksOverview: async () => [task('pr-task')] },
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(calls).not.toContain('syncGitStatus');
  });

  it('--watch refreshes the pretty dashboard every 30 seconds', async () => {
    const writes: string[] = [];
    const sleeps: number[] = [];
    let overviewCalls = 0;

    const result = await runTasksCli(['overview', '--watch'], {
      createStore: async () => fakeStore([]),
      github: {
        ...noopGithub,
        tasksOverview: async () => {
          overviewCalls += 1;
          return [overviewItem()];
        },
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      writeStdout: (text) => writes.push(text),
      watchIterations: 2,
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(overviewCalls).toBe(2);
    expect(sleeps).toEqual([30_000]);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toStartWith('\u001B[2J\u001B[H');
    expect(writes[0]).toContain('feature/watch');
  });

  it('--watch rejects --json', async () => {
    const result = await runTasksCli(['overview', '--watch', '--json'], {
      createStore: async () => fakeStore([]),
      github: { ...noopGithub, tasksOverview: async () => [overviewItem()] },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('overview_watch_json_unsupported');
  });
});
