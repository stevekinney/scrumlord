import { afterEach, expect } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner';

const temporaryDirectories: string[] = [];

export const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-gh-direct-'));
  temporaryDirectories.push(directory);
  return directory;
};

export const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  // Initialize git so the shared-database store resolves a stable project for
  // this workspace (the project scope is keyed on the git common dir).
  const gitInit = Bun.spawn(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  await gitInit.exited;
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

export const expectGitHubError = async (
  operation: Promise<unknown>,
  code: string,
): Promise<void> => {
  try {
    await operation;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    const errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code;
    expect(errorCode).toBe(code);
  }
};

export const expectGitHubErrorSync = (operation: () => unknown, code: string): void => {
  try {
    operation();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    const errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code;
    expect(errorCode).toBe(code);
  }
};

export const commandResult = ({
  exitCode = 0,
  stdout = '',
  stderr = '',
}: Partial<CommandResult> = {}): CommandResult => ({ exitCode, stdout, stderr });

export const failedCommand = (stderr = 'failed'): CommandResult =>
  commandResult({ exitCode: 1, stderr });

export const includedResponse = ({
  status = 200,
  headers = { etag: '"fixture-etag"' },
  body = '[]',
}: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
} = {}): CommandResult => {
  const headerText = Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n');
  return commandResult({
    stdout: `HTTP/2  ${status} fixture\r\n${headerText}\r\n\r\n${body ?? ''}`,
  });
};

export const pullRequestRestBody = ({
  number = 42,
  headRefName = 'feature/task-graph',
  headSha = 'abc123',
  title = 'Task graph',
  url = 'https://github.test/owner/repository/pull/42',
}: {
  number?: number;
  headRefName?: string;
  headSha?: string;
  title?: string;
  url?: string;
} = {}): string => {
  return JSON.stringify({
    number,
    html_url: url,
    title,
    head: { ref: headRefName, sha: headSha },
  });
};

export const pullRequestRestList = (items: string[]): string => `[${items.join(',')}]`;

export const checkRunsRestBody = (items: unknown[]): string =>
  JSON.stringify({ check_runs: items });

export type GitHubRunnerResponses = {
  ghVersion?: CommandResult;
  authentication?: CommandResult;
  branch?: CommandResult;
  repository?: CommandResult;
  pullRequestList?: CommandResult;
  pullRequestDetails?: CommandResult;
  reviewComments?: CommandResult;
  checkRuns?: CommandResult;
  statuses?: CommandResult;
  open?: CommandResult;
};

const pullRequestList = commandResult({
  stdout: includedResponse({
    body: pullRequestRestList([pullRequestRestBody()]),
  }).stdout,
});

export const defaultReviewComments = commandResult({
  stdout: '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}',
});

const defaultCheckRuns = includedResponse({
  body: checkRunsRestBody([
    {
      name: 'build',
      conclusion: 'success',
      status: 'completed',
      html_url: 'https://github.test/checks/build',
      completed_at: '2026-05-11T12:00:00Z',
      check_suite: { app: { name: 'Validate' } },
    },
  ]),
});

const defaultStatuses = includedResponse({
  body: '[]',
});

const commandMatchers = [
  { key: 'gh-version', signature: ['gh', '--version'] },
  { key: 'gh-authentication', signature: ['gh', 'auth'] },
  { key: 'git-branch', signature: ['git', 'branch'] },
  { key: 'gh-repository', signature: ['gh', 'repo'] },
  { key: 'review-comments', signature: ['gh', 'api', 'graphql'] },
  { key: 'open', signature: ['open'] },
];

const endpointCommandKey = (endpoint: string | undefined): string | undefined => {
  if (endpoint?.endsWith('/check-runs')) return 'check-runs';
  if (endpoint?.endsWith('/statuses')) return 'statuses';
  if (/\/pulls\/\d+$/.test(endpoint ?? '')) return 'pull-request-details';
  if (endpoint?.endsWith('/pulls')) return 'pull-request-list';
  return undefined;
};

const commandKey = (command: string[]): string => {
  const endpoint = command.find((part) => part.startsWith('repos/'));
  return (
    endpointCommandKey(endpoint) ??
    commandMatchers.find(({ signature }) =>
      signature.every((value, index) => command[index] === value),
    )?.key ??
    'unknown'
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
    'pull-request-details': () =>
      responses.pullRequestDetails ?? includedResponse({ body: pullRequestRestBody() }),
    'review-comments': () => responses.reviewComments ?? defaultReviewComments,
    'check-runs': () => responses.checkRuns ?? defaultCheckRuns,
    statuses: () => responses.statuses ?? defaultStatuses,
    open: () => responses.open ?? commandResult(),
    unknown: () => failedCommand(`Unexpected command: ${command.join(' ')}`),
  };
  return (handlers[key] ?? (() => failedCommand(`Unexpected command: ${command.join(' ')}`)))();
};

export const runnerWith = (responses: GitHubRunnerResponses = {}): CommandRunner => {
  return async (command) => responseFor(commandKey(command), command, responses);
};
