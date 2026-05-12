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
import {
  checksForPullRequest as libraryChecksForPullRequest,
  continuousIntegrationStatus as libraryContinuousIntegrationStatus,
  currentPullRequest as libraryCurrentPullRequest,
  openPullRequests as libraryOpenPullRequests,
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
});
