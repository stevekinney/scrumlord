import {
  checksForPullRequestInRepository,
  openPullRequests,
  repositoryName,
  reportForCheck,
  requireGh,
  reviewCommentsForPullRequest,
  type GitHubOptions,
  type PullRequest,
  type PullRequestCheckReport,
} from './github.js';
import type { Task, TaskStore } from './types.js';

type PullRequestOverviewContinuousIntegrationStatus = 'success' | 'pending' | 'failed';

export type PullRequestOverviewItem = {
  pullRequest: PullRequest;
  associatedTasks: Task[];
  reviewComments: {
    unresolvedCount: number;
  };
  continuousIntegration: {
    status: PullRequestOverviewContinuousIntegrationStatus;
    pendingCount: number;
    failedCount: number;
    checks: PullRequestCheckReport[];
  };
  readyToMerge: boolean;
};

const overviewContinuousIntegrationStatus = (
  pending: PullRequestCheckReport[],
  failed: PullRequestCheckReport[],
): PullRequestOverviewContinuousIntegrationStatus => {
  if (failed.length > 0) return 'failed';
  if (pending.length > 0) return 'pending';
  return 'success';
};

const shouldMoveTaskToReview = (task: Task): boolean => {
  return !task.deleted && task.status !== 'completed' && task.status !== 'in-review';
};

const synchronizePullRequestTasks = (store: TaskStore, pullRequest: PullRequest): Task[] => {
  return store
    .withBranch(pullRequest.headRefName)
    .filter((task) => !task.deleted)
    .map((task) =>
      shouldMoveTaskToReview(task) ? store.update(task.id, { status: 'in-review' }) : task,
    );
};

const overviewForPullRequest = async (
  store: TaskStore,
  repository: string,
  pullRequest: PullRequest,
  options?: GitHubOptions,
): Promise<PullRequestOverviewItem> => {
  const [reviewComments, checks] = await Promise.all([
    reviewCommentsForPullRequest(store.projectRoot, repository, pullRequest, options),
    checksForPullRequestInRepository(store.projectRoot, repository, pullRequest, options),
  ]);
  const checkReports = checks.map(reportForCheck);
  const pending = checkReports.filter((check) => check.conclusion === 'pending');
  const failed = checkReports.filter((check) => check.conclusion === 'failed');
  const associatedTasks = synchronizePullRequestTasks(store, pullRequest);
  const readyToMerge = reviewComments.length === 0 && pending.length === 0 && failed.length === 0;

  return {
    pullRequest,
    associatedTasks,
    reviewComments: {
      unresolvedCount: reviewComments.length,
    },
    continuousIntegration: {
      status: overviewContinuousIntegrationStatus(pending, failed),
      pendingCount: pending.length,
      failedCount: failed.length,
      checks: checkReports,
    },
    readyToMerge,
  };
};

const mapPullRequestsWithConcurrency = async <Result>(
  pullRequests: PullRequest[],
  mapper: (pullRequest: PullRequest) => Promise<Result>,
): Promise<Result[]> => {
  const concurrency = 4;
  const results: Result[] = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const pullRequest = pullRequests[index];
      if (!pullRequest) return;
      results[index] = await mapper(pullRequest);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, pullRequests.length) }, () => worker()),
  );
  return results;
};

/** Lists open pull requests with task associations and merge-readiness signals. */
export const tasksOverview = async (
  store: TaskStore,
  options?: GitHubOptions,
): Promise<PullRequestOverviewItem[]> => {
  await requireGh(store.projectRoot, options);
  const repository = await repositoryName(store.projectRoot, options);
  const pullRequests = await openPullRequests(store.projectRoot, repository, options);

  return await mapPullRequestsWithConcurrency(pullRequests, (pullRequest) =>
    overviewForPullRequest(store, repository, pullRequest, options),
  );
};
