import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';
import type { PullRequestPollReport } from './github-poll';

type PollGithub = { pullRequestPollStatus: (...args: unknown[]) => Promise<PullRequestPollReport> };

const makePollReport = (overrides: Partial<PullRequestPollReport> = {}): PullRequestPollReport => ({
  pullRequest: {
    number: 42,
    url: 'https://github.test/owner/repo/pull/42',
    headRefName: 'feature/poll',
    headSha: 'abc123',
    title: 'Test PR',
    state: 'OPEN',
    baseRefName: 'main',
    mergedAt: null,
    body: null,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  },
  reviewComments: { allResolved: true, unresolvedCount: 0, unresolved: [] },
  continuousIntegration: {
    allGreen: true,
    pendingCount: 0,
    failedCount: 0,
    checks: [],
    pending: [],
    failed: [],
  },
  readyToMerge: true,
  poll: {
    polls: 1,
    pollsExhausted: false,
    pollIntervalSeconds: 20,
    maxPolls: 5,
    botsPending: false,
    mergeabilityPending: false,
    hasMergeConflict: false,
  },
  ...overrides,
});

const baseGithub = {
  pullRequestStatus: async () => {
    throw Object.assign(new Error('no pr'), { code: 'pull_request_not_found' });
  },
  pullRequestUrl: async () => ({ url: '' }),
  pullRequestPollStatus: async () => makePollReport(),
  allReviewComments: async () => [],
  resolvedReviewComments: async () => [],
  unresolvedReviewComments: async () => [],
  tasksOverview: async () => [],
  repositoryName: async () => '',
  repositoryUrl: async () => '',
};

describe('tasks pr --poll', () => {
  it('returns poll report with readyToMerge: true on first pass', async () => {
    const capturedOptions: unknown[] = [];
    const github: PollGithub & typeof baseGithub = {
      ...baseGithub,
      pullRequestPollStatus: async (_root, opts) => {
        capturedOptions.push(opts);
        return makePollReport();
      },
    };

    const result = await runTasksCli(['pr', '--poll'], { github });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as PullRequestPollReport;
    expect(parsed.readyToMerge).toBe(true);
    expect(parsed.poll.polls).toBe(1);
    expect(parsed.poll.pollsExhausted).toBe(false);
  });

  it('forwards --max-polls and --poll-interval to github module', async () => {
    const capturedOptions: Array<{ maxPolls?: number; pollIntervalSeconds?: number }> = [];
    const github: PollGithub & typeof baseGithub = {
      ...baseGithub,
      pullRequestPollStatus: async (_root, opts) => {
        capturedOptions.push(opts as { maxPolls?: number; pollIntervalSeconds?: number });
        return makePollReport();
      },
    };

    await runTasksCli(['pr', '--poll', '--max-polls', '3', '--poll-interval', '5'], { github });

    expect(capturedOptions[0]?.maxPolls).toBe(3);
    expect(capturedOptions[0]?.pollIntervalSeconds).toBe(5);
  });

  it('forwards --bot-patterns to github module', async () => {
    const capturedOptions: Array<{ botPatterns?: string }> = [];
    const github: PollGithub & typeof baseGithub = {
      ...baseGithub,
      pullRequestPollStatus: async (_root, opts) => {
        capturedOptions.push(opts as { botPatterns?: string });
        return makePollReport();
      },
    };

    await runTasksCli(['pr', '--poll', '--bot-patterns', 'mybot|otherbot'], { github });

    expect(capturedOptions[0]?.botPatterns).toBe('mybot|otherbot');
  });

  it('exits 0 even when polls are exhausted', async () => {
    const github: PollGithub & typeof baseGithub = {
      ...baseGithub,
      pullRequestPollStatus: async () =>
        makePollReport({
          readyToMerge: false,
          poll: {
            polls: 5,
            pollsExhausted: true,
            pollIntervalSeconds: 20,
            maxPolls: 5,
            botsPending: false,
            mergeabilityPending: false,
            hasMergeConflict: false,
          },
        }),
    };

    const result = await runTasksCli(['pr', '--poll'], { github });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as PullRequestPollReport;
    expect(parsed.readyToMerge).toBe(false);
    expect(parsed.poll.pollsExhausted).toBe(true);
  });

  it('rejects --max-polls 0 as invalid', async () => {
    const result = await runTasksCli(['pr', '--poll', '--max-polls', '0'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('accepts fractional --poll-interval', async () => {
    const capturedOptions: Array<{ pollIntervalSeconds?: number }> = [];
    const github: PollGithub & typeof baseGithub = {
      ...baseGithub,
      pullRequestPollStatus: async (_root, opts) => {
        capturedOptions.push(opts as { pollIntervalSeconds?: number });
        return makePollReport();
      },
    };

    const result = await runTasksCli(['pr', '--poll', '--poll-interval', '1.5'], { github });

    expect(result.exitCode).toBe(0);
    expect(capturedOptions[0]?.pollIntervalSeconds).toBe(1.5);
  });

  it('--poll --url throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--url'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --open throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--open'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --sync throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--sync'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --quiet throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--quiet'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --comments throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--comments'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --resolved throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--resolved'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });

  it('--poll --all throws pr_flag_conflict', async () => {
    const result = await runTasksCli(['pr', '--poll', '--all'], { github: baseGithub });
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(result.stderr);
    expect(err.error.code).toBe('pr_flag_conflict');
  });
});
