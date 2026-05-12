import { describe, expect, it } from 'bun:test';
import type { CommandResult, CommandRunner } from './command-runner';
import { createTaskStore } from './database-open';
import { tasksOverview } from './tasks-overview';
import type { TaskStore } from './types';
import {
  checkRunsRestBody,
  commandResult,
  defaultReviewComments,
  expectGitHubError,
  failedCommand,
  includedResponse,
  pullRequestRestBody,
  pullRequestRestList,
  runnerWith,
  workspaceRoot,
} from './github-test-helpers';

const createOverviewTasks = (store: Pick<TaskStore, 'create'>): void => {
  store.create({
    id: 'task-overview',
    title: 'Build tasks overview',
    status: 'ready',
    branch: 'feature/tasks-overview',
  });
  store.create({
    id: 'task-documentation',
    title: 'Document the overview command',
    status: 'in-progress',
    branch: 'feature/tasks-overview',
  });
  store.create({
    id: 'task-unrelated',
    title: 'Unrelated work',
    status: 'ready',
    branch: 'feature/unrelated',
  });
};

const overviewResponses: Record<string, CommandResult> = {
  version: commandResult({ stdout: 'gh version 2.72.0\n' }),
  authentication: commandResult(),
  repository: commandResult({ stdout: 'owner/repository\n' }),
  list: includedResponse({
    body: pullRequestRestList([
      pullRequestRestBody({
        number: 42,
        headRefName: 'feature/tasks-overview',
        headSha: 'sha-overview',
        title: 'Build overview',
      }),
      pullRequestRestBody({
        number: 43,
        headRefName: 'feature/no-task',
        headSha: 'sha-no-task',
        title: 'No task',
        url: 'https://github.test/owner/repository/pull/43',
      }),
    ]),
  }),
  'review-42': commandResult({
    stdout:
      '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"comment-1","body":"Please fix this."}]}},{"isResolved":true,"comments":{"nodes":[{"id":"comment-2"}]}}]}}}}}',
  }),
  'review-43': defaultReviewComments,
  'checks-42': includedResponse({
    body: checkRunsRestBody([
      {
        name: 'test',
        status: 'in_progress',
        conclusion: null,
        html_url: 'https://github.test/checks/test',
        completed_at: null,
        check_suite: { app: { name: 'Validate' } },
      },
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.test/checks/build',
        completed_at: '2026-05-11T12:00:00Z',
        check_suite: { app: { name: 'Validate' } },
      },
    ]),
  }),
  'statuses-42': includedResponse({ body: '[]' }),
  'checks-43': includedResponse({
    body: checkRunsRestBody([
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.test/checks/lint',
        completed_at: '2026-05-11T12:01:00Z',
        check_suite: { app: { name: 'Validate' } },
      },
    ]),
  }),
  'statuses-43': includedResponse({ body: '[]' }),
};

const overviewMatchers = [
  { key: 'version', matches: (command: string[]) => command[1] === '--version' },
  { key: 'authentication', matches: (command: string[]) => command[1] === 'auth' },
  { key: 'repository', matches: (command: string[]) => command[1] === 'repo' },
  {
    key: 'list',
    matches: (command: string[]) =>
      command.some((part) => part === 'repos/owner/repository/pulls') &&
      command.includes('state=open') &&
      !command.some((part) => part.startsWith('head=')),
  },
  { key: 'review-42', matches: (command: string[]) => command.includes('number=42') },
  { key: 'review-43', matches: (command: string[]) => command.includes('number=43') },
  {
    key: 'checks-42',
    matches: (command: string[]) =>
      command.some((part) => part === 'repos/owner/repository/commits/sha-overview/check-runs'),
  },
  {
    key: 'statuses-42',
    matches: (command: string[]) =>
      command.some((part) => part === 'repos/owner/repository/commits/sha-overview/statuses'),
  },
  {
    key: 'checks-43',
    matches: (command: string[]) =>
      command.some((part) => part === 'repos/owner/repository/commits/sha-no-task/check-runs'),
  },
  {
    key: 'statuses-43',
    matches: (command: string[]) =>
      command.some((part) => part === 'repos/owner/repository/commits/sha-no-task/statuses'),
  },
];

const overviewCommandKey = (command: string[]): string | undefined => {
  return overviewMatchers.find((matcher) => matcher.matches(command))?.key;
};

const overviewRunner: CommandRunner = async (command) => {
  const key = overviewCommandKey(command);
  return key ? overviewResponses[key] : failedCommand(`Unexpected command: ${command.join(' ')}`);
};

describe('GitHub pull request overview', () => {
  it('returns an overview for all open pull requests and their branch-associated tasks', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({
      cwd: root,
      now: () => new Date('2026-05-11T00:00:00.000Z'),
    });
    createOverviewTasks(store);

    try {
      const overview = await tasksOverview(store, { runner: overviewRunner });

      expect(overview).toHaveLength(2);
      const firstOverviewItem = overview[0];
      const secondOverviewItem = overview[1];

      expect(firstOverviewItem.pullRequest).toEqual({
        number: 42,
        url: 'https://github.test/owner/repository/pull/42',
        headRefName: 'feature/tasks-overview',
        headSha: 'sha-overview',
        title: 'Build overview',
      });
      expect(firstOverviewItem.associatedTasks.map((item) => item.id)).toEqual([
        'task-documentation',
        'task-overview',
      ]);
      expect(firstOverviewItem.associatedTasks.map((item) => item.status)).toEqual([
        'in-review',
        'in-review',
      ]);
      expect(store.getTask('task-overview')?.status).toBe('in-review');
      expect(store.getTask('task-documentation')?.status).toBe('in-review');
      expect(store.getTask('task-unrelated')?.status).toBe('ready');
      expect(firstOverviewItem.reviewComments.unresolvedCount).toBe(1);
      expect(firstOverviewItem.continuousIntegration.status).toBe('pending');
      expect(firstOverviewItem.continuousIntegration.pendingCount).toBe(1);
      expect(firstOverviewItem.continuousIntegration.failedCount).toBe(0);
      expect(firstOverviewItem.readyToMerge).toBe(false);
      expect(secondOverviewItem.associatedTasks).toEqual([]);
      expect(secondOverviewItem.continuousIntegration.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('surfaces overview pull request lookup errors with stable codes', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });

    try {
      expect(
        await tasksOverview(store, {
          runner: runnerWith({ pullRequestList: includedResponse({ body: '[{"number":42}]' }) }),
        }),
      ).toEqual([]);
      await expectGitHubError(
        tasksOverview(store, {
          runner: runnerWith({ pullRequestList: failedCommand('overview lookup failed') }),
        }),
        'pull_request_lookup_failed',
      );
      await expectGitHubError(
        tasksOverview(store, {
          runner: runnerWith({
            pullRequestList: includedResponse({ body: '{"pullRequests":[]}' }),
          }),
        }),
        'pull_request_lookup_invalid',
      );
    } finally {
      store.close();
    }
  });
});
