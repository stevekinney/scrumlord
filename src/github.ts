import { $ } from 'bun';
import { ScrumlordError } from './errors.js';

type PullRequest = {
  number: number;
  url: string;
  headRefName: string;
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

const unresolvedCommentsFrom = (response: unknown): unknown[] => {
  const data = isRecord(response) ? nestedRecord(response, 'data') : undefined;
  const repository = nestedRecord(data, 'repository');
  const pullRequest = nestedRecord(repository, 'pullRequest');
  const reviewThreads = nestedRecord(pullRequest, 'reviewThreads');
  const nodes = reviewThreads?.['nodes'];
  if (!Array.isArray(nodes)) return [];

  return nodes.flatMap((thread) => {
    if (!isRecord(thread) || thread['isResolved'] !== false) return [];
    const comments = nestedRecord(thread, 'comments');
    return Array.isArray(comments?.['nodes']) ? comments['nodes'] : [];
  });
};

const requireGh = async (cwd: string): Promise<void> => {
  const result = await $`gh --version`.cwd(cwd).quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new ScrumlordError('gh_not_found', 'The GitHub CLI (`gh`) is required for this command.');
  }
};

const currentBranch = async (cwd: string): Promise<string> => {
  const result = await $`git branch --show-current`.cwd(cwd).quiet().nothrow();
  const branch = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !branch)
    throw new ScrumlordError('git_branch_not_found', 'Could not resolve the current Git branch.');
  return branch;
};

const repositoryName = async (cwd: string): Promise<string> => {
  const result = await $`gh repo view --json nameWithOwner --jq .nameWithOwner`
    .cwd(cwd)
    .quiet()
    .nothrow();
  const repository = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !repository) {
    throw new ScrumlordError(
      'github_repository_not_found',
      'Could not resolve the current GitHub repository.',
    );
  }
  return repository;
};

export const currentPullRequest = async (projectRoot: string): Promise<PullRequest> => {
  await requireGh(projectRoot);
  const branch = await currentBranch(projectRoot);
  const repository = await repositoryName(projectRoot);
  const result =
    await $`gh pr list --repo ${repository} --head ${branch} --state open --json number,url,headRefName --limit 1`
      .cwd(projectRoot)
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    throw new ScrumlordError('pull_request_lookup_failed', result.stderr.toString().trim());
  }

  const parsedPullRequests: unknown = JSON.parse(result.stdout.toString());
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
): Promise<{ url: string }> => {
  const pullRequest = await currentPullRequest(projectRoot);
  if (open) {
    await $`open ${pullRequest.url}`.cwd(projectRoot).quiet().nothrow();
  }
  return { url: pullRequest.url };
};

export const unresolvedReviewComments = async (projectRoot: string): Promise<unknown> => {
  const pullRequest = await currentPullRequest(projectRoot);
  const repository = await repositoryName(projectRoot);
  const [owner, name] = repository.split('/');
  if (!owner || !name)
    throw new ScrumlordError('invalid_repository', `Invalid GitHub repository: ${repository}`);
  const result = await $`gh api graphql -f query=${`
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
    `} -F owner=${owner} -F name=${name} -F number=${pullRequest.number}`
    .cwd(projectRoot)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0)
    throw new ScrumlordError('review_comments_failed', result.stderr.toString().trim());
  return unresolvedCommentsFrom(JSON.parse(result.stdout.toString()));
};

export const continuousIntegrationStatus = async (projectRoot: string): Promise<unknown> => {
  const pullRequest = await currentPullRequest(projectRoot);
  const result =
    await $`gh pr checks ${pullRequest.number} --json bucket,completedAt,link,name,state,workflow`
      .cwd(projectRoot)
      .quiet()
      .nothrow();
  if (result.exitCode !== 0)
    throw new ScrumlordError('ci_status_failed', result.stderr.toString().trim());
  return JSON.parse(result.stdout.toString());
};
