import type { PullRequestCheckReport } from './github-checks.js';
import {
  pullRequestStatus,
  type GitHubOptions,
  type PullRequest,
  type PullRequestStatusReport,
} from './github.js';

export type PullRequestPollReport = PullRequestStatusReport & {
  poll: {
    polls: number;
    pollsExhausted: boolean;
    pollIntervalSeconds: number;
    maxPolls: number;
    botsPending: boolean;
    mergeabilityPending: boolean;
    hasMergeConflict: boolean;
  };
};

export type PullRequestPollOptions = GitHubOptions & {
  maxPolls?: number;
  pollIntervalSeconds?: number;
  botPatterns?: string;
  /** Injectable sleep for tests; defaults to Bun.sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_POLLS = 5;
const DEFAULT_POLL_INTERVAL_SECONDS = 20;
const DEFAULT_BOT_PATTERNS = 'review|copilot|bugbot|coderabbit';

const mergeStateFrom = (
  pullRequest: PullRequest,
): { mergeabilityPending: boolean; hasMergeConflict: boolean } => ({
  mergeabilityPending:
    pullRequest.mergeable === 'UNKNOWN' ||
    pullRequest.mergeStateStatus === 'UNKNOWN' ||
    pullRequest.mergeable === null,
  hasMergeConflict:
    pullRequest.mergeable === 'CONFLICTING' || pullRequest.mergeStateStatus === 'DIRTY',
});

const botsPendingFrom = (pending: PullRequestCheckReport[], botPattern: RegExp): boolean =>
  pending.some((check) => botPattern.test(check.name));

const isSettled = (status: PullRequestStatusReport, botPattern: RegExp): boolean => {
  const { mergeabilityPending } = mergeStateFrom(status.pullRequest);
  return (
    status.readyToMerge &&
    !mergeabilityPending &&
    !botsPendingFrom(status.continuousIntegration.pending, botPattern)
  );
};

const pollLoop = async (
  projectRoot: string,
  options: PullRequestPollOptions | undefined,
  maxPolls: number,
  pollIntervalSeconds: number,
  botPattern: RegExp,
  sleep: (ms: number) => Promise<void>,
): Promise<{ status: PullRequestStatusReport; polls: number }> => {
  let polls = 0;
  let status = await pullRequestStatus(projectRoot, options);
  polls++;
  while (!isSettled(status, botPattern) && polls < maxPolls) {
    await sleep(pollIntervalSeconds * 1000);
    status = await pullRequestStatus(projectRoot, options);
    polls++;
  }
  return { status, polls };
};

/**
 * Polls `pullRequestStatus` until the PR is ready to merge or `maxPolls` is
 * reached. Always resolves — callers branch on `poll.pollsExhausted` and
 * `readyToMerge`.
 */
export const pullRequestPollStatus = async (
  projectRoot: string,
  options?: PullRequestPollOptions,
): Promise<PullRequestPollReport> => {
  const maxPolls = options?.maxPolls ?? DEFAULT_MAX_POLLS;
  const pollIntervalSeconds = options?.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
  const botPattern = new RegExp(options?.botPatterns ?? DEFAULT_BOT_PATTERNS, 'i');
  const sleep = options?.sleep ?? ((ms: number) => Bun.sleep(ms));

  const { status, polls } = await pollLoop(
    projectRoot,
    options,
    maxPolls,
    pollIntervalSeconds,
    botPattern,
    sleep,
  );

  const { mergeabilityPending, hasMergeConflict } = mergeStateFrom(status.pullRequest);
  const botsPending = botsPendingFrom(status.continuousIntegration.pending, botPattern);

  return {
    ...status,
    poll: {
      polls,
      pollsExhausted: !status.readyToMerge && polls >= maxPolls,
      pollIntervalSeconds,
      maxPolls,
      botsPending,
      mergeabilityPending,
      hasMergeConflict,
    },
  };
};
