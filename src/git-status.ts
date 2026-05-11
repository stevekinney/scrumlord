import type { CommandResult, CommandRunner } from './command-runner.js';
import { runCommand } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import type { Task, TaskStatus, TaskStore, UpdateTaskInput } from './types.js';

type PullRequestState = {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: string;
  mergedAt: string | null;
  url: string;
};

export type SyncGitStatusResult = {
  branch: string;
  worktree: string;
  ghAvailable: boolean;
  pullRequest: PullRequestState | null;
  updated: {
    id: string;
    from: TaskStatus;
    to: TaskStatus;
  }[];
};

type SyncGitStatusOptions = {
  runner?: CommandRunner;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const isPullRequestState = (value: unknown): value is PullRequestState => {
  return (
    isRecord(value) &&
    typeof value['number'] === 'number' &&
    typeof value['state'] === 'string' &&
    typeof value['baseRefName'] === 'string' &&
    (typeof value['mergedAt'] === 'string' || value['mergedAt'] === null) &&
    typeof value['url'] === 'string'
  );
};

const currentBranch = async (projectRoot: string, runner: CommandRunner): Promise<string> => {
  const result = await runner(['git', 'branch', '--show-current'], projectRoot);
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || !branch) {
    throw new ScrumlordError('git_branch_not_found', 'Could not resolve the current Git branch.');
  }
  return branch;
};

export const worktreeForBranch = async (
  projectRoot: string,
  branch: string,
  runner: CommandRunner = runCommand,
): Promise<string> => {
  const result = await runner(['git', 'worktree', 'list', '--porcelain'], projectRoot);
  if (result.exitCode !== 0) return projectRoot;

  let currentWorktree: string | null = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) currentWorktree = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}` && currentWorktree) return currentWorktree;
  }

  return projectRoot;
};

const currentPullRequest = async (
  projectRoot: string,
  branch: string,
  runner: CommandRunner,
): Promise<{ ghAvailable: boolean; pullRequest: PullRequestState | null }> => {
  let result: CommandResult;
  try {
    result = await runner(
      [
        'gh',
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'all',
        '--json',
        'number,state,baseRefName,mergedAt,url',
        '--limit',
        '1',
      ],
      projectRoot,
    );
  } catch {
    return { ghAvailable: false, pullRequest: null };
  }

  if (result.exitCode !== 0) return { ghAvailable: false, pullRequest: null };

  const parsed: unknown = JSON.parse(result.stdout);
  const pullRequest = Array.isArray(parsed) ? parsed.find(isPullRequestState) : undefined;
  return { ghAvailable: true, pullRequest: pullRequest ?? null };
};

const statusFor = (task: Task, pullRequest: PullRequestState | null): TaskStatus | null => {
  if (task.deleted || task.archived || task.status === 'completed') return null;
  if (pullRequest?.mergedAt && pullRequest.baseRefName === 'main') return 'completed';
  if (pullRequest?.state === 'OPEN') return 'in-review';
  if (task.status === 'ready') return 'in-progress';
  return null;
};

/** Synchronizes branch-bound tasks with the current Git branch and pull request state. */
export const syncGitStatus = async (
  store: TaskStore,
  options: SyncGitStatusOptions = {},
): Promise<SyncGitStatusResult> => {
  const runner = options.runner ?? runCommand;
  const branch = await currentBranch(store.projectRoot, runner);
  const worktree = await worktreeForBranch(store.projectRoot, branch, runner);
  const { ghAvailable, pullRequest } = await currentPullRequest(store.projectRoot, branch, runner);
  const updated: SyncGitStatusResult['updated'] = [];

  for (const task of store.withBranch(branch)) {
    const nextStatus = statusFor(task, pullRequest);
    if (!nextStatus || task.status === nextStatus) continue;
    const input: UpdateTaskInput = { status: nextStatus };
    store.update(task.id, input);
    updated.push({ id: task.id, from: task.status, to: nextStatus });
  }

  return { branch, worktree, ghAvailable, pullRequest, updated };
};
