import { describe, expect, it } from 'bun:test';
import {
  checksForPullRequest,
  continuousIntegrationStatus,
  currentPullRequest,
  openPullRequests,
  pullRequestStatus,
  pullRequestUrl,
  repositoryName,
  repositoryUrl,
  reviewCommentsForPullRequest,
  unresolvedReviewComments,
} from './github';
import { pullRequestPollStatus } from './github-poll';
import {
  checksForPullRequest as libraryChecksForPullRequest,
  continuousIntegrationStatus as libraryContinuousIntegrationStatus,
  currentPullRequest as libraryCurrentPullRequest,
  openPullRequests as libraryOpenPullRequests,
  pullRequestPollStatus as libraryPullRequestPollStatus,
  pullRequestStatus as libraryPullRequestStatus,
  pullRequestUrl as libraryPullRequestUrl,
  repositoryName as libraryRepositoryName,
  repositoryUrl as libraryRepositoryUrl,
  reviewCommentsForPullRequest as libraryReviewCommentsForPullRequest,
  tasksOverview as libraryTasksOverview,
  unresolvedReviewComments as libraryUnresolvedReviewComments,
} from './index';
import { tasksOverview } from './tasks-overview';
import {
  checkRunsRestBody,
  commandResult,
  expectGitHubError,
  failedCommand,
  includedResponse,
  runnerWith,
  workspaceRoot,
} from './github-test-helpers';

describe('GitHub helper functions', () => {
  it('exports pull request, overview, comments, and check methods from the package root', () => {
    expect(libraryCurrentPullRequest).toBe(currentPullRequest);
    expect(libraryPullRequestUrl).toBe(pullRequestUrl);
    expect(libraryRepositoryName).toBe(repositoryName);
    expect(libraryRepositoryUrl).toBe(repositoryUrl);
    expect(libraryPullRequestStatus).toBe(pullRequestStatus);
    expect(libraryPullRequestPollStatus).toBe(pullRequestPollStatus);
    expect(libraryOpenPullRequests).toBe(openPullRequests);
    expect(libraryReviewCommentsForPullRequest).toBe(reviewCommentsForPullRequest);
    expect(libraryUnresolvedReviewComments).toBe(unresolvedReviewComments);
    expect(libraryChecksForPullRequest).toBe(checksForPullRequest);
    expect(libraryContinuousIntegrationStatus).toBe(continuousIntegrationStatus);
    expect(libraryTasksOverview).toBe(tasksOverview);
  });

  it('builds a detailed pull request status report directly from gh data', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      reviewComments: commandResult({
        stdout:
          '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"PRRC_kwDOExample","path":"src/github.ts","line":123,"body":"Please summarize failed checks.","author":{"login":"reviewer"},"url":"https://github.test/comment"},{"body":"missing id"}]}},{"isResolved":false,"comments":{}},{"isResolved":true,"comments":{"nodes":[{"id":"resolved-comment"}]}}]}}}}}',
      }),
      checkRuns: includedResponse({
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
            name: 'lint',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.test/checks/lint',
            completed_at: '2026-05-11T12:00:00Z',
            check_suite: { app: { name: 'Validate' } },
          },
          {
            name: 'unknown',
            status: 'mystery',
            conclusion: null,
            html_url: null,
            completed_at: null,
            check_suite: {},
          },
          {
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.test/checks/build',
            completed_at: '2026-05-11T12:02:00Z',
            check_suite: { app: { name: 'Validate' } },
          },
          { status: 'completed', conclusion: 'success' },
        ]),
      }),
    });
    const options = { runner };

    expect(await repositoryName(root, options)).toBe('owner/repository');
    expect(await repositoryUrl(root, options)).toBe('https://github.com/owner/repository');
    expect(await pullRequestUrl(root, true, options)).toEqual({
      url: 'https://github.test/owner/repository/pull/42',
    });
    expect(await unresolvedReviewComments(root, options)).toEqual([
      {
        id: 'PRRC_kwDOExample',
        url: 'https://github.test/comment',
        path: 'src/github.ts',
        line: 123,
        body: 'Please summarize failed checks.',
        author: 'reviewer',
        isResolved: false,
      },
    ]);
    expect(await continuousIntegrationStatus(root, options)).toEqual([
      {
        name: 'test',
        state: 'in_progress',
        bucket: 'in_progress',
        workflow: 'Validate',
        url: 'https://github.test/checks/test',
        completedAt: null,
      },
      {
        name: 'lint',
        state: 'failure',
        bucket: 'failure',
        workflow: 'Validate',
        url: 'https://github.test/checks/lint',
        completedAt: '2026-05-11T12:00:00Z',
      },
      {
        name: 'unknown',
        state: 'mystery',
        bucket: 'mystery',
        workflow: null,
        url: null,
        completedAt: null,
      },
      {
        name: 'build',
        state: 'success',
        bucket: 'success',
        workflow: 'Validate',
        url: 'https://github.test/checks/build',
        completedAt: '2026-05-11T12:02:00Z',
      },
    ]);

    const report = await pullRequestStatus(root, options);
    expect(report.readyToMerge).toBe(false);
    expect(report.reviewComments.unresolvedCount).toBe(1);
    expect(report.continuousIntegration.pending.map((check) => check.name)).toEqual([
      'test',
      'unknown',
    ]);
    expect(report.continuousIntegration.failed).toEqual([
      {
        name: 'lint',
        state: 'failure',
        bucket: 'failure',
        workflow: 'Validate',
        url: 'https://github.test/checks/lint',
        completedAt: '2026-05-11T12:00:00Z',
        conclusion: 'failed',
        synopsis: 'Validate: lint failed with state failure.',
      },
    ]);
    expect(report.continuousIntegration.checks.at(-1)).toMatchObject({
      name: 'build',
      conclusion: 'successful',
      synopsis: 'Validate: build passed.',
    });
  });

  it('prefers html_url (the browser PR page) over the api url field', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      reviewComments: commandResult({
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{}}}}}',
      }),
      // Real GitHub REST returns both: `url` is the api.github.com JSON endpoint
      // and `html_url` is the page a human should open.
      pullRequestList: includedResponse({
        body: JSON.stringify([
          {
            number: 149,
            url: 'https://api.github.com/repos/owner/repository/pulls/149',
            html_url: 'https://github.com/owner/repository/pull/149',
            title: 'Test',
            head: { ref: 'feature/task-graph', sha: 'abc123' },
            base: { ref: 'main' },
            state: 'open',
          },
        ]),
      }),
    });

    const report = await pullRequestStatus(root, { runner });
    expect(report.pullRequest.url).toBe('https://github.com/owner/repository/pull/149');
  });

  it('marks a pull request as ready when direct gh data has no unresolved comments or failing checks', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      reviewComments: commandResult({
        stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{}}}}}',
      }),
    });

    const report = await pullRequestStatus(root, { runner });

    expect(report.readyToMerge).toBe(true);
    expect(report.reviewComments.allResolved).toBe(true);
    expect(report.continuousIntegration.allGreen).toBe(true);
  });

  it('surfaces direct gh helper errors with stable codes', async () => {
    const root = await workspaceRoot();

    await expectGitHubError(
      pullRequestUrl(root, false, { runner: runnerWith({ ghVersion: failedCommand() }) }),
      'gh_not_found',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, { runner: runnerWith({ authentication: failedCommand() }) }),
      'gh_not_authenticated',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, { runner: runnerWith({ branch: failedCommand() }) }),
      'git_branch_not_found',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, { runner: runnerWith({ repository: failedCommand() }) }),
      'github_repository_not_found',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, {
        runner: runnerWith({ pullRequestList: failedCommand('lookup failed') }),
      }),
      'pull_request_lookup_failed',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, {
        runner: runnerWith({ pullRequestList: includedResponse({ body: 'not-json' }) }),
      }),
      'github_json_parse_failed',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, {
        runner: runnerWith({ pullRequestList: includedResponse({ body: '[]' }) }),
      }),
      'pull_request_not_found',
    );
  });

  it('surfaces direct pull request detail errors with stable codes', async () => {
    const root = await workspaceRoot();

    await expectGitHubError(
      unresolvedReviewComments(root, {
        runner: runnerWith({ repository: commandResult({ stdout: 'owner-only\n' }) }),
      }),
      'invalid_repository',
    );
    await expectGitHubError(
      unresolvedReviewComments(root, {
        runner: runnerWith({ reviewComments: failedCommand('review failed') }),
      }),
      'review_comments_failed',
    );
    await expectGitHubError(
      continuousIntegrationStatus(root, {
        runner: runnerWith({ checkRuns: failedCommand('checks failed') }),
      }),
      'ci_status_failed',
    );
    await expectGitHubError(
      continuousIntegrationStatus(root, {
        runner: runnerWith({ checkRuns: includedResponse({ body: '{"checks":[]}' }) }),
      }),
      'ci_status_invalid',
    );
    await expectGitHubError(
      pullRequestUrl(root, true, { runner: runnerWith({ open: failedCommand() }) }),
      'browser_open_failed',
    );
  });

  it('pullRequestPollStatus resolves immediately when readyToMerge with known mergeability', async () => {
    const root = await workspaceRoot();
    const sleepCalls: number[] = [];
    const runner = runnerWith({
      // Provide a PR with explicit MERGEABLE state so mergeabilityPending is false
      pullRequestList: includedResponse({
        body: JSON.stringify([
          {
            number: 42,
            html_url: 'https://github.test/owner/repository/pull/42',
            title: 'Test',
            head: { ref: 'feature/task-graph', sha: 'abc123' },
            base: { ref: 'main' },
            state: 'open',
            mergeable: true,
            merge_state_status: 'CLEAN',
          },
        ]),
      }),
    });

    const report = await pullRequestPollStatus(root, {
      runner,
      maxPolls: 5,
      pollIntervalSeconds: 1,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(report.poll.polls).toBe(1);
    expect(report.poll.pollsExhausted).toBe(false);
    expect(report.poll.maxPolls).toBe(5);
    expect(report.poll.pollIntervalSeconds).toBe(1);
    expect(report.poll.mergeabilityPending).toBe(false);
    // No sleep after the last (and only) iteration
    expect(sleepCalls).toHaveLength(0);
  });

  it('pullRequestPollStatus exhausts polls when never ready', async () => {
    const root = await workspaceRoot();
    const sleepCalls: number[] = [];
    const runner = runnerWith({
      // Unresolved review comment keeps readyToMerge false
      reviewComments: commandResult({
        stdout:
          '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"PRRC_pending","body":"still open","url":null,"path":null,"line":null,"author":null}]}}]}}}}}',
      }),
    });

    const report = await pullRequestPollStatus(root, {
      runner,
      maxPolls: 3,
      pollIntervalSeconds: 0.1,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(report.poll.polls).toBe(3);
    expect(report.poll.pollsExhausted).toBe(true);
    expect(report.readyToMerge).toBe(false);
    // Sleep between fetches but not after the last one: maxPolls - 1 sleeps
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0]).toBe(100);
  });

  it('pullRequestPollStatus sets botsPending when a pending check matches the pattern', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      checkRuns: includedResponse({
        body: checkRunsRestBody([
          {
            name: 'copilot/review',
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.test/checks/copilot',
            completed_at: null,
            check_suite: { app: { name: 'Copilot' } },
          },
        ]),
      }),
    });

    const report = await pullRequestPollStatus(root, {
      runner,
      maxPolls: 1,
      sleep: async () => {},
    });

    expect(report.poll.botsPending).toBe(true);
  });

  it('pullRequestPollStatus derives mergeabilityPending from UNKNOWN mergeable', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      // Inject a pull request with mergeable=null (not present in response — simulates unknown)
      pullRequestList: includedResponse({
        body: JSON.stringify([
          {
            number: 42,
            html_url: 'https://github.test/owner/repository/pull/42',
            title: 'Test',
            head: { ref: 'feature/poll', sha: 'abc123' },
            base: { ref: 'main' },
            state: 'open',
            // No mergeable field → null → UNKNOWN → mergeabilityPending: true
          },
        ]),
      }),
    });

    const report = await pullRequestPollStatus(root, {
      runner,
      maxPolls: 1,
      sleep: async () => {},
    });

    expect(report.poll.mergeabilityPending).toBe(true);
  });

  it('pullRequestPollStatus sets hasMergeConflict when mergeStateStatus is DIRTY', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      pullRequestList: includedResponse({
        body: JSON.stringify([
          {
            number: 42,
            html_url: 'https://github.test/owner/repository/pull/42',
            title: 'Test',
            head: { ref: 'feature/poll', sha: 'abc123' },
            base: { ref: 'main' },
            state: 'open',
            mergeable: true,
            merge_state_status: 'DIRTY',
          },
        ]),
      }),
    });

    const report = await pullRequestPollStatus(root, {
      runner,
      maxPolls: 1,
      sleep: async () => {},
    });

    expect(report.poll.hasMergeConflict).toBe(true);
  });
});
