import type { CommandResult, CommandRunner } from './command-runner.js';
import { runCommand } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import type { Task, TaskStatus, TaskStore } from './types.js';

export type SynchronizedPullRequestState = {
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
  pullRequest: SynchronizedPullRequestState | null;
  updated: {
    id: string;
    from: TaskStatus;
    to: TaskStatus;
  }[];
};

export type SyncGitStatusOptions = {
  runner?: CommandRunner;
  /** When true, records a `commit` progress entry for the HEAD commit on the active task. */
  withProgress?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const isPullRequestState = (value: unknown): value is SynchronizedPullRequestState => {
  return (
    isRecord(value) &&
    typeof value['number'] === 'number' &&
    typeof value['state'] === 'string' &&
    typeof value['baseRefName'] === 'string' &&
    (typeof value['mergedAt'] === 'string' || value['mergedAt'] === null) &&
    typeof value['url'] === 'string'
  );
};

export const currentGitBranch = async (
  projectRoot: string,
  runner: CommandRunner = runCommand,
): Promise<string> => {
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
): Promise<{ ghAvailable: boolean; pullRequest: SynchronizedPullRequestState | null }> => {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { ghAvailable: false, pullRequest: null };
  }
  const pullRequest = Array.isArray(parsed) ? parsed.find(isPullRequestState) : undefined;
  return { ghAvailable: true, pullRequest: pullRequest ?? null };
};

const isInactiveTask = (task: Task): boolean => {
  return task.deleted || task.status === 'completed';
};

const isStartableTask = (task: Task): boolean => {
  return task.status === 'draft' || task.status === 'ready';
};

const isMergedIntoMain = (pullRequest: SynchronizedPullRequestState | null): boolean => {
  return Boolean(pullRequest?.mergedAt && pullRequest.baseRefName === 'main');
};

const statusFor = (
  task: Task,
  pullRequest: SynchronizedPullRequestState | null,
): TaskStatus | null => {
  if (isInactiveTask(task)) return null;
  if (isMergedIntoMain(pullRequest)) return 'completed';
  if (pullRequest?.state === 'OPEN') return 'in-review';
  if (isStartableTask(task)) return 'in-progress';
  return null;
};

const headCommitInfo = async (
  projectRoot: string,
  runner: CommandRunner,
): Promise<{ sha: string; subject: string; committerEmail: string } | null> => {
  const result = await runner(['git', 'log', '-1', '--format=%H%n%s%n%cE'], projectRoot);
  if (result.exitCode !== 0) return null;
  const [sha, subject, committerEmail] = result.stdout.trim().split('\n');
  if (!sha || !subject) return null;
  return { sha, subject, committerEmail: committerEmail ?? '' };
};

const gitUserEmail = async (projectRoot: string, runner: CommandRunner): Promise<string | null> => {
  const result = await runner(['git', 'config', 'user.email'], projectRoot);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
};

const COMMIT_SHA_UNIQUE_ERROR = 'task_progress_commit_sha_unique';

const recordCommitProgress = async (
  store: TaskStore,
  task: Task,
  projectRoot: string,
  runner: CommandRunner,
): Promise<void> => {
  const commit = await headCommitInfo(projectRoot, runner);
  if (!commit) return;

  const userEmail = await gitUserEmail(projectRoot, runner);
  // If user.email is configured, only record commits made by this user.
  if (userEmail && commit.committerEmail !== userEmail) return;

  const shortSha = commit.sha.slice(0, 7);
  try {
    store.addProgress(task.id, {
      message: `commit ${shortSha}: ${commit.subject}`,
      event: 'commit',
      commitSha: commit.sha,
    });
  } catch (error) {
    // Swallow the unique-index violation (same SHA hooked twice); rethrow everything else.
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(COMMIT_SHA_UNIQUE_ERROR)) throw error;
  }
};

const isActiveTask = (task: Task): boolean => !task.deleted && task.status !== 'completed';

const maybeRecordCommit = async (
  store: TaskStore,
  branch: string,
  updatedIds: Set<string>,
  runner: CommandRunner,
): Promise<void> => {
  const remaining = store
    .withBranch(branch)
    .filter((t) => isActiveTask(t) && !updatedIds.has(t.id));
  if (remaining.length === 1 && remaining[0]) {
    await recordCommitProgress(store, remaining[0], store.projectRoot, runner);
  }
};

/** Synchronizes branch-bound tasks with the current Git branch and pull request state. */
export const syncGitStatus = async (
  store: TaskStore,
  options: SyncGitStatusOptions = {},
): Promise<SyncGitStatusResult> => {
  const runner = options.runner ?? runCommand;
  const branch = await currentGitBranch(store.projectRoot, runner);
  const worktree = await worktreeForBranch(store.projectRoot, branch, runner);
  const { ghAvailable, pullRequest } = await currentPullRequest(store.projectRoot, branch, runner);
  const updated: SyncGitStatusResult['updated'] = [];

  for (const task of store.withBranch(branch)) {
    const nextStatus = statusFor(task, pullRequest);
    if (!nextStatus || task.status === nextStatus) continue;
    store.update(task.id, { status: nextStatus });
    updated.push({ id: task.id, from: task.status, to: nextStatus });
  }

  if (options.withProgress) {
    await maybeRecordCommit(store, branch, new Set(updated.map((u) => u.id)), runner);
  }

  return { branch, worktree, ghAvailable, pullRequest, updated };
};
