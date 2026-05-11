import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner';
import {
  continuousIntegrationStatus,
  pullRequestStatus,
  pullRequestUrl,
  unresolvedReviewComments,
} from './github';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-gh-direct-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const expectGitHubError = async (operation: Promise<unknown>, code: string): Promise<void> => {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    const errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code;
    expect(errorCode).toBe(code);
  }
};

const commandResult = ({
  exitCode = 0,
  stdout = '',
  stderr = '',
}: Partial<CommandResult> = {}): CommandResult => ({ exitCode, stdout, stderr });

const failedCommand = (stderr = 'failed'): CommandResult => commandResult({ exitCode: 1, stderr });

type GitHubRunnerResponses = {
  ghVersion?: CommandResult;
  authentication?: CommandResult;
  branch?: CommandResult;
  repository?: CommandResult;
  pullRequestList?: CommandResult;
  reviewComments?: CommandResult;
  checks?: CommandResult;
  open?: CommandResult;
};

const pullRequestList = commandResult({
  stdout:
    '[{"number":42,"url":"https://github.test/owner/repository/pull/42","headRefName":"feature/task-graph"}]',
});

const defaultReviewComments = commandResult({
  stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}',
});

const defaultChecks = commandResult({
  stdout:
    '[{"bucket":"pass","completedAt":"2026-05-11T12:00:00Z","link":"https://github.test/checks/build","name":"build","state":"SUCCESS","workflow":"Validate"}]',
});

const commandMatchers = [
  { key: 'gh-version', signature: ['gh', '--version'] },
  { key: 'gh-authentication', signature: ['gh', 'auth'] },
  { key: 'git-branch', signature: ['git', 'branch'] },
  { key: 'gh-repository', signature: ['gh', 'repo'] },
  { key: 'pull-request-list', signature: ['gh', 'pr', 'list'] },
  { key: 'review-comments', signature: ['gh', 'api'] },
  { key: 'checks', signature: ['gh', 'pr', 'checks'] },
  { key: 'open', signature: ['open'] },
];

const commandKey = (command: string[]): string => {
  return (
    commandMatchers.find(({ signature }) =>
      signature.every((value, index) => command[index] === value),
    )?.key ?? 'unknown'
  );
};

const responseFor = (
  key: string,
  command: string[],
  responses: GitHubRunnerResponses,
): CommandResult => {
  const handlers: Record<string, () => CommandResult> = {
    'gh-version': () => responses.ghVersion ?? commandResult({ stdout: 'gh version 2.72.0\n' }),
    'gh-authentication': () => responses.authentication ?? commandResult(),
    'git-branch': () => responses.branch ?? commandResult({ stdout: 'feature/task-graph\n' }),
    'gh-repository': () => responses.repository ?? commandResult({ stdout: 'owner/repository\n' }),
    'pull-request-list': () => responses.pullRequestList ?? pullRequestList,
    'review-comments': () => responses.reviewComments ?? defaultReviewComments,
    checks: () => responses.checks ?? defaultChecks,
    open: () => responses.open ?? commandResult(),
    unknown: () => failedCommand(`Unexpected command: ${command.join(' ')}`),
  };
  return handlers[key]?.() ?? handlers['unknown']();
};

const runnerWith = (responses: GitHubRunnerResponses = {}): CommandRunner => {
  return async (command) => responseFor(commandKey(command), command, responses);
};

describe('GitHub helper functions', () => {
  it('builds a detailed pull request status report directly from gh data', async () => {
    const root = await workspaceRoot();
    const runner = runnerWith({
      reviewComments: commandResult({
        stdout:
          '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"id":"PRRC_kwDOExample","path":"src/github.ts","line":123,"body":"Please summarize failed checks.","author":{"login":"reviewer"},"url":"https://github.test/comment"},{"body":"missing id"}]}},{"isResolved":false,"comments":{}},{"isResolved":true,"comments":{"nodes":[{"id":"resolved-comment"}]}}]}}}}}',
      }),
      checks: commandResult({
        stdout:
          '[{"bucket":"pending","completedAt":null,"link":"https://github.test/checks/test","name":"test","state":"IN PROGRESS","workflow":"Validate"},{"bucket":"fail","completedAt":"2026-05-11T12:00:00Z","link":"https://github.test/checks/lint","name":"lint","state":"FAILURE","workflow":"Validate"},{"bucket":"mystery","completedAt":null,"link":null,"name":"unknown","state":"MYSTERY","workflow":null},{"bucket":"pass","completedAt":"2026-05-11T12:02:00Z","link":"https://github.test/checks/build","name":"build","state":"SUCCESS","workflow":"Validate"},{"state":"SUCCESS"}]',
      }),
    });
    const options = { runner };

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
        state: 'IN PROGRESS',
        bucket: 'pending',
        workflow: 'Validate',
        url: 'https://github.test/checks/test',
        completedAt: null,
      },
      {
        name: 'lint',
        state: 'FAILURE',
        bucket: 'fail',
        workflow: 'Validate',
        url: 'https://github.test/checks/lint',
        completedAt: '2026-05-11T12:00:00Z',
      },
      {
        name: 'unknown',
        state: 'MYSTERY',
        bucket: 'mystery',
        workflow: null,
        url: null,
        completedAt: null,
      },
      {
        name: 'build',
        state: 'SUCCESS',
        bucket: 'pass',
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
        state: 'FAILURE',
        bucket: 'fail',
        workflow: 'Validate',
        url: 'https://github.test/checks/lint',
        completedAt: '2026-05-11T12:00:00Z',
        conclusion: 'failed',
        synopsis: 'Validate: lint failed with state FAILURE.',
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
        runner: runnerWith({ pullRequestList: commandResult({ stdout: 'not-json' }) }),
      }),
      'github_json_parse_failed',
    );
    await expectGitHubError(
      pullRequestUrl(root, false, {
        runner: runnerWith({ pullRequestList: commandResult({ stdout: '[]' }) }),
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
        runner: runnerWith({ checks: failedCommand('checks failed') }),
      }),
      'ci_status_failed',
    );
    await expectGitHubError(
      continuousIntegrationStatus(root, {
        runner: runnerWith({ checks: commandResult({ stdout: '{"checks":[]}' }) }),
      }),
      'ci_status_invalid',
    );
    await expectGitHubError(
      pullRequestUrl(root, true, { runner: runnerWith({ open: failedCommand() }) }),
      'browser_open_failed',
    );
  });
});
