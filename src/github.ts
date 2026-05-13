import { runCommand, type CommandResult, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import {
  checkRunsFrom,
  commitStatusesFrom,
  reportForCheck,
  type PullRequestCheck,
  type PullRequestCheckReport,
} from './github-checks.js';
import { runGitHubRestGet } from './github-rest.js';
export {
  reportForCheck,
  type PullRequestCheck,
  type PullRequestCheckConclusion,
  type PullRequestCheckReport,
} from './github-checks.js';
export { parseIncludedGitHubApiResponse, type IncludedGitHubApiResponse } from './github-rest.js';

export type PullRequest = {
  number: number;
  url: string;
  headRefName: string;
  headSha: string | null;
  title: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: string;
  mergedAt: string | null;
};

export type ReviewComment = {
  id: string;
  url: string | null;
  path: string | null;
  line: number | null;
  body: string;
  author: string | null;
};

export type PullRequestStatusReport = {
  pullRequest: PullRequest;
  reviewComments: {
    allResolved: boolean;
    unresolvedCount: number;
    unresolved: ReviewComment[];
  };
  continuousIntegration: {
    allGreen: boolean;
    pendingCount: number;
    failedCount: number;
    checks: PullRequestCheckReport[];
    pending: PullRequestCheckReport[];
    failed: PullRequestCheckReport[];
  };
  readyToMerge: boolean;
};

export type GitHubOptions = {
  runner?: CommandRunner;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const stringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
};

const pullRequestUrlFrom = (record: Record<string, unknown>): string | null => {
  return stringOrNull(record['url']) ?? stringOrNull(record['html_url']);
};

const pullRequestHeadRefNameFrom = (
  record: Record<string, unknown>,
  head: Record<string, unknown> | undefined,
): string | null => {
  return stringOrNull(record['headRefName']) ?? stringOrNull(head?.['ref']);
};

const pullRequestStateFrom = (value: Record<string, unknown>): 'OPEN' | 'CLOSED' | 'MERGED' => {
  if (value['merged_at'] || value['mergedAt']) return 'MERGED';
  const raw = value['state'];
  if (raw === 'closed') return 'CLOSED';
  if (raw === 'open') return 'OPEN';
  if (raw === 'OPEN' || raw === 'CLOSED' || raw === 'MERGED') return raw;
  return 'OPEN';
};

const pullRequestBaseRefFrom = (value: Record<string, unknown>): string => {
  const base = nestedRecord(value, 'base');
  if (base && typeof base['ref'] === 'string') return base['ref'];
  if (typeof value['baseRefName'] === 'string') return value['baseRefName'];
  return '';
};

const pullRequestFrom = (value: unknown): PullRequest | undefined => {
  if (!isRecord(value) || typeof value['number'] !== 'number') return undefined;
  const head = nestedRecord(value, 'head');
  const url = pullRequestUrlFrom(value);
  const headRefName = pullRequestHeadRefNameFrom(value, head);
  if (!url || !headRefName) {
    return undefined;
  }

  return {
    number: value['number'],
    url,
    headRefName,
    headSha: stringOrNull(value['headSha']) ?? stringOrNull(head?.['sha']),
    title: stringOrNull(value['title']),
    state: pullRequestStateFrom(value),
    baseRefName: pullRequestBaseRefFrom(value),
    mergedAt: stringOrNull(value['mergedAt']) ?? stringOrNull(value['merged_at']),
  };
};

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const numberOrNull = (value: unknown): number | null => {
  return typeof value === 'number' ? value : null;
};

const reviewCommentFrom = (value: unknown): ReviewComment | undefined => {
  if (!isRecord(value) || typeof value['id'] !== 'string') return undefined;
  const author = nestedRecord(value, 'author');
  return {
    id: value['id'],
    url: stringOrNull(value['url']),
    path: stringOrNull(value['path']),
    line: numberOrNull(value['line']),
    body: typeof value['body'] === 'string' ? value['body'] : '',
    author: stringOrNull(author?.['login']),
  };
};

const unresolvedCommentsFrom = (response: unknown): ReviewComment[] => {
  const data = isRecord(response) ? nestedRecord(response, 'data') : undefined;
  const repository = nestedRecord(data, 'repository');
  const pullRequest = nestedRecord(repository, 'pullRequest');
  const reviewThreads = nestedRecord(pullRequest, 'reviewThreads');
  const nodes = reviewThreads?.['nodes'];
  if (!Array.isArray(nodes)) return [];

  return nodes.flatMap((thread) => {
    if (!isRecord(thread) || thread['isResolved'] !== false) return [];
    const comments = nestedRecord(thread, 'comments');
    if (!Array.isArray(comments?.['nodes'])) return [];
    return comments['nodes'].flatMap((comment) => {
      const parsedComment = reviewCommentFrom(comment);
      return parsedComment ? [parsedComment] : [];
    });
  });
};

const execute = async (
  command: string[],
  cwd: string,
  options: GitHubOptions | undefined,
): Promise<CommandResult> => {
  return await (options?.runner ?? runCommand)(command, cwd);
};

export const requireGh = async (cwd: string, options?: GitHubOptions): Promise<void> => {
  const result = await execute(['gh', '--version'], cwd, options);
  if (result.exitCode !== 0) {
    throw new ScrumlordError('gh_not_found', 'The GitHub CLI (`gh`) is required for this command.');
  }

  const authentication = await execute(['gh', 'auth', 'status'], cwd, options);
  if (authentication.exitCode !== 0) {
    throw new ScrumlordError(
      'gh_not_authenticated',
      'The GitHub CLI (`gh`) is installed but not authenticated.',
    );
  }
};

const currentBranch = async (cwd: string, options?: GitHubOptions): Promise<string> => {
  const result = await execute(['git', 'branch', '--show-current'], cwd, options);
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch)
    throw new ScrumlordError('git_branch_not_found', 'Could not resolve the current Git branch.');
  return branch;
};

export const repositoryName = async (cwd: string, options?: GitHubOptions): Promise<string> => {
  const result = await execute(
    ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    cwd,
    options,
  );
  const repository = result.stdout.trim();
  if (result.exitCode !== 0 || !repository) {
    throw new ScrumlordError(
      'github_repository_not_found',
      'Could not resolve the current GitHub repository.',
    );
  }
  return repository;
};

export const repositoryUrl = async (cwd: string, options?: GitHubOptions): Promise<string> => {
  const repository = await repositoryName(cwd, options);
  return `https://github.com/${repository}`;
};

const repositoryParts = (repository: string): { owner: string; name: string } => {
  const [owner, name] = repository.split('/');
  if (!owner || !name)
    throw new ScrumlordError('invalid_repository', `Invalid GitHub repository: ${repository}`);
  return { owner, name };
};

/**
 * Returns every pull request whose head ref matches `branch`, regardless of
 * state (open/closed/merged). Useful for pipeline-style flows that need to
 * disambiguate the task's PR from arbitrary repository PRs.
 */
export const pullRequestsForBranch = async (
  projectRoot: string,
  repository: string,
  branch: string,
  options?: GitHubOptions,
): Promise<PullRequest[]> => {
  const { owner, name } = repositoryParts(repository);
  const parsedPullRequests = await runGitHubRestGet(
    projectRoot,
    `repos/${owner}/${name}/pulls`,
    { head: `${owner}:${branch}`, state: 'all', per_page: '100' },
    options,
    'pull_request_lookup_failed',
    true,
  );
  if (!Array.isArray(parsedPullRequests)) {
    throw new ScrumlordError(
      'pull_request_lookup_invalid',
      'Expected GitHub pull request list to return a JSON array.',
    );
  }
  return parsedPullRequests.flatMap((value) => {
    const pullRequest = pullRequestFrom(value);
    return pullRequest ? [pullRequest] : [];
  });
};

export const openPullRequests = async (
  projectRoot: string,
  repository: string,
  options?: GitHubOptions,
): Promise<PullRequest[]> => {
  const { owner, name } = repositoryParts(repository);
  const parsedPullRequests = await runGitHubRestGet(
    projectRoot,
    `repos/${owner}/${name}/pulls`,
    { per_page: '100', state: 'open' },
    options,
    'pull_request_lookup_failed',
    true,
  );
  if (!Array.isArray(parsedPullRequests)) {
    throw new ScrumlordError(
      'pull_request_lookup_invalid',
      'Expected GitHub pull request list to return a JSON array.',
    );
  }

  return parsedPullRequests.flatMap((value) => {
    const pullRequest = pullRequestFrom(value);
    return pullRequest ? [pullRequest] : [];
  });
};

const parseGhJson = (stdout: string, context: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ScrumlordError('github_json_parse_failed', `Could not parse JSON from ${context}.`);
  }
};

export const reviewCommentsForPullRequest = async (
  projectRoot: string,
  repository: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<ReviewComment[]> => {
  const { owner, name } = repositoryParts(repository);
  const query = `
      query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                isResolved
                comments(first: 20) {
                  nodes {
                    id
                    path
                    line
                    body
                    author { login }
                    url
                  }
                }
              }
            }
          }
        }
      }
    `;
  const result = await execute(
    [
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `number=${pullRequest.number}`,
    ],
    projectRoot,
    options,
  );
  if (result.exitCode !== 0)
    throw new ScrumlordError('review_comments_failed', result.stderr.trim());
  return unresolvedCommentsFrom(parseGhJson(result.stdout, 'gh api graphql'));
};

export const checksForPullRequest = async (
  projectRoot: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<PullRequestCheck[]> => {
  const repository = await repositoryName(projectRoot, options);
  return await checksForPullRequestInRepository(projectRoot, repository, pullRequest, options);
};

export const checksForPullRequestInRepository = async (
  projectRoot: string,
  repository: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<PullRequestCheck[]> => {
  const { owner, name } = repositoryParts(repository);
  const pullRequestWithHeadSha = pullRequest.headSha
    ? pullRequest
    : await pullRequestDetails(projectRoot, repository, pullRequest.number, options);
  const headSha = pullRequestWithHeadSha.headSha;
  if (!headSha) {
    throw new ScrumlordError('ci_status_failed', 'Could not resolve pull request head SHA.');
  }
  const [checkRuns, commitStatuses] = await Promise.all([
    runGitHubRestGet(
      projectRoot,
      `repos/${owner}/${name}/commits/${headSha}/check-runs`,
      { filter: 'latest', per_page: '100' },
      options,
      'ci_status_failed',
      true,
    ),
    runGitHubRestGet(
      projectRoot,
      `repos/${owner}/${name}/commits/${headSha}/statuses`,
      { per_page: '100' },
      options,
      'ci_status_failed',
      true,
    ),
  ]);
  return checkRunsFrom(checkRuns).concat(commitStatusesFrom(commitStatuses));
};

const pullRequestDetails = async (
  projectRoot: string,
  repository: string,
  number: number,
  options?: GitHubOptions,
): Promise<PullRequest> => {
  const { owner, name } = repositoryParts(repository);
  const parsedPullRequest = await runGitHubRestGet(
    projectRoot,
    `repos/${owner}/${name}/pulls/${number}`,
    {},
    options,
    'pull_request_lookup_failed',
    true,
  );
  const pullRequest = pullRequestFrom(parsedPullRequest);
  if (!pullRequest) {
    throw new ScrumlordError('pull_request_lookup_invalid', 'Expected GitHub pull request object.');
  }
  return pullRequest;
};

export const currentPullRequest = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<PullRequest> => {
  await requireGh(projectRoot, options);
  const branch = await currentBranch(projectRoot, options);
  const repository = await repositoryName(projectRoot, options);
  const { owner, name } = repositoryParts(repository);
  const parsedPullRequests = await runGitHubRestGet(
    projectRoot,
    `repos/${owner}/${name}/pulls`,
    { head: `${owner}:${branch}`, per_page: '1', state: 'open' },
    options,
    'pull_request_lookup_failed',
    true,
  );
  const pullRequest = Array.isArray(parsedPullRequests)
    ? parsedPullRequests.flatMap((value) => {
        const parsedPullRequest = pullRequestFrom(value);
        return parsedPullRequest ? [parsedPullRequest] : [];
      })[0]
    : undefined;
  if (!pullRequest) {
    throw new ScrumlordError(
      'pull_request_not_found',
      `No open pull request found for branch ${branch}.`,
    );
  }
  return pullRequest;
};

export const pullRequestUrl = async (
  projectRoot: string,
  open = false,
  options?: GitHubOptions,
): Promise<{ url: string }> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  if (open) {
    const result = await execute(['open', pullRequest.url], projectRoot, options);
    if (result.exitCode !== 0) {
      throw new ScrumlordError(
        'browser_open_failed',
        `Could not open pull request URL: ${pullRequest.url}`,
      );
    }
  }
  return { url: pullRequest.url };
};

export const unresolvedReviewComments = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<ReviewComment[]> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  const repository = await repositoryName(projectRoot, options);
  return await reviewCommentsForPullRequest(projectRoot, repository, pullRequest, options);
};

export const continuousIntegrationStatus = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<PullRequestCheck[]> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  return await checksForPullRequest(projectRoot, pullRequest, options);
};

/**
 * Returns full readiness state for a pull request. When `pullRequestNumber` is
 * provided, the status is scoped to that PR; otherwise it falls back to the
 * pull request inferred from the current branch (legacy behavior).
 */
export const pullRequestStatus = async (
  projectRoot: string,
  options?: GitHubOptions & { pullRequestNumber?: number },
): Promise<PullRequestStatusReport> => {
  const repository = await repositoryName(projectRoot, options);
  const pullRequest = options?.pullRequestNumber
    ? await pullRequestDetails(projectRoot, repository, options.pullRequestNumber, options)
    : await currentPullRequest(projectRoot, options);
  const [reviewComments, checks] = await Promise.all([
    reviewCommentsForPullRequest(projectRoot, repository, pullRequest, options),
    checksForPullRequestInRepository(projectRoot, repository, pullRequest, options),
  ]);
  const checkReports = checks.map(reportForCheck);
  const pending = checkReports.filter((check) => check.conclusion === 'pending');
  const failed = checkReports.filter((check) => check.conclusion === 'failed');
  const allReviewCommentsResolved = reviewComments.length === 0;
  const allContinuousIntegrationGreen = pending.length === 0 && failed.length === 0;

  return {
    pullRequest,
    reviewComments: {
      allResolved: allReviewCommentsResolved,
      unresolvedCount: reviewComments.length,
      unresolved: reviewComments,
    },
    continuousIntegration: {
      allGreen: allContinuousIntegrationGreen,
      pendingCount: pending.length,
      failedCount: failed.length,
      checks: checkReports,
      pending,
      failed,
    },
    readyToMerge: allReviewCommentsResolved && allContinuousIntegrationGreen,
  };
};
