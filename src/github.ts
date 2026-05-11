import { runCommand, type CommandResult, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';

type PullRequest = {
  number: number;
  url: string;
  headRefName: string;
};

type ReviewComment = {
  id: string;
  url: string | null;
  path: string | null;
  line: number | null;
  body: string;
  author: string | null;
};

type PullRequestCheck = {
  name: string;
  state: string;
  bucket: string | null;
  workflow: string | null;
  url: string | null;
  completedAt: string | null;
};

type PullRequestCheckConclusion = 'successful' | 'pending' | 'failed';

type PullRequestCheckReport = PullRequestCheck & {
  conclusion: PullRequestCheckConclusion;
  synopsis: string;
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

type GitHubOptions = {
  runner?: CommandRunner;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const isPullRequest = (value: unknown): value is PullRequest => {
  return (
    isRecord(value) &&
    typeof value['number'] === 'number' &&
    typeof value['url'] === 'string' &&
    typeof value['headRefName'] === 'string'
  );
};

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record?.[key];
  return isRecord(value) ? value : undefined;
};

const stringOrNull = (value: unknown): string | null => {
  return typeof value === 'string' ? value : null;
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

const checkFrom = (value: unknown): PullRequestCheck | undefined => {
  if (!isRecord(value) || typeof value['name'] !== 'string') return undefined;
  return {
    name: value['name'],
    state: typeof value['state'] === 'string' ? value['state'] : 'UNKNOWN',
    bucket: stringOrNull(value['bucket']),
    workflow: stringOrNull(value['workflow']),
    url: stringOrNull(value['link']),
    completedAt: stringOrNull(value['completedAt']),
  };
};

const checksFrom = (response: unknown): PullRequestCheck[] => {
  if (!Array.isArray(response)) {
    throw new ScrumlordError('ci_status_invalid', 'Expected gh pr checks to return a JSON array.');
  }
  return response.flatMap((value) => {
    const check = checkFrom(value);
    return check ? [check] : [];
  });
};

const normalizeState = (value: string | null): string => {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '_');
};

const successfulStates = new Set([
  'pass',
  'passed',
  'success',
  'successful',
  'skipped',
  'skipping',
  'neutral',
]);

const pendingStates = new Set([
  'pending',
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'expected',
]);

const failedStates = new Set([
  'fail',
  'failed',
  'failure',
  'error',
  'cancel',
  'cancelled',
  'canceled',
  'timed_out',
  'action_required',
]);

const classifyCheck = (check: PullRequestCheck): PullRequestCheckConclusion => {
  const bucket = normalizeState(check.bucket);
  const state = normalizeState(check.state);

  if (failedStates.has(bucket) || failedStates.has(state)) return 'failed';
  if (pendingStates.has(bucket) || pendingStates.has(state)) return 'pending';
  if (successfulStates.has(bucket) || successfulStates.has(state)) return 'successful';
  return 'pending';
};

const checkSynopsis = (check: PullRequestCheck, conclusion: PullRequestCheckConclusion): string => {
  const workflow = check.workflow ? `${check.workflow}: ` : '';
  if (conclusion === 'failed') return `${workflow}${check.name} failed with state ${check.state}.`;
  if (conclusion === 'pending') return `Waiting on ${workflow}${check.name} (${check.state}).`;
  return `${workflow}${check.name} passed.`;
};

const reportForCheck = (check: PullRequestCheck): PullRequestCheckReport => {
  const conclusion = classifyCheck(check);
  return {
    ...check,
    conclusion,
    synopsis: checkSynopsis(check, conclusion),
  };
};

const execute = async (
  command: string[],
  cwd: string,
  options: GitHubOptions | undefined,
): Promise<CommandResult> => {
  return await (options?.runner ?? runCommand)(command, cwd);
};

const requireGh = async (cwd: string, options?: GitHubOptions): Promise<void> => {
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

const repositoryName = async (cwd: string, options?: GitHubOptions): Promise<string> => {
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

const parseGhJson = (stdout: string, context: string): unknown => {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new ScrumlordError('github_json_parse_failed', `Could not parse JSON from ${context}.`);
  }
};

const reviewCommentsForPullRequest = async (
  projectRoot: string,
  repository: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<ReviewComment[]> => {
  const [owner, name] = repository.split('/');
  if (!owner || !name)
    throw new ScrumlordError('invalid_repository', `Invalid GitHub repository: ${repository}`);
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

const checksForPullRequest = async (
  projectRoot: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<PullRequestCheck[]> => {
  const result = await execute(
    [
      'gh',
      'pr',
      'checks',
      String(pullRequest.number),
      '--json',
      'bucket,completedAt,link,name,state,workflow',
    ],
    projectRoot,
    options,
  );
  if (result.exitCode !== 0) throw new ScrumlordError('ci_status_failed', result.stderr.trim());
  return checksFrom(parseGhJson(result.stdout, 'gh pr checks'));
};

export const currentPullRequest = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<PullRequest> => {
  await requireGh(projectRoot, options);
  const branch = await currentBranch(projectRoot, options);
  const repository = await repositoryName(projectRoot, options);
  const result = await execute(
    [
      'gh',
      'pr',
      'list',
      '--repo',
      repository,
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'number,url,headRefName',
      '--limit',
      '1',
    ],
    projectRoot,
    options,
  );

  if (result.exitCode !== 0) {
    throw new ScrumlordError('pull_request_lookup_failed', result.stderr.trim());
  }

  const parsedPullRequests = parseGhJson(result.stdout, 'gh pr list');
  const pullRequest = Array.isArray(parsedPullRequests)
    ? parsedPullRequests.find(isPullRequest)
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
): Promise<unknown> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  const repository = await repositoryName(projectRoot, options);
  return await reviewCommentsForPullRequest(projectRoot, repository, pullRequest, options);
};

export const continuousIntegrationStatus = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<unknown> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  return await checksForPullRequest(projectRoot, pullRequest, options);
};

export const pullRequestStatus = async (
  projectRoot: string,
  options?: GitHubOptions,
): Promise<PullRequestStatusReport> => {
  const pullRequest = await currentPullRequest(projectRoot, options);
  const repository = await repositoryName(projectRoot, options);
  const [reviewComments, checks] = await Promise.all([
    reviewCommentsForPullRequest(projectRoot, repository, pullRequest, options),
    checksForPullRequest(projectRoot, pullRequest, options),
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
