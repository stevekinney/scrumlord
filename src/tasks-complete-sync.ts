import { runCommand, type CommandRunner } from './command-runner.js';
import { completeTasks } from './task-commands.js';
import { mergeIfNeeded } from './pipeline.js';
import type { PullRequestOverviewItem, TasksOverviewOptions } from './tasks-overview.js';
import type { Task, TaskStore } from './types.js';

/** Why an open pull request was not merged during a sync. */
export type CompleteSyncSkipReason =
  | 'not_ready'
  | 'no_associated_task'
  | 'no_completable_associated_task';

/** Outcome of a merge attempt — distinguishes a fresh merge from a prior one. */
export type CompleteSyncMergeOutcome = 'merged' | 'already_merged';

export type CompleteSyncPlannedItem = {
  number: number;
  outcome: 'merge' | 'merge_no_tasks';
  taskIds: string[];
};

export type CompleteSyncMergedItem = {
  number: number;
  outcome: CompleteSyncMergeOutcome;
  completedTaskIds: string[];
};

export type CompleteSyncResult = {
  /** False for a dry-run, true once merges were applied. */
  applied: boolean;
  /** Populated only in dry-run mode; empty once applied. */
  planned: CompleteSyncPlannedItem[];
  /** Merged pull requests that had completable tasks. */
  merged: CompleteSyncMergedItem[];
  /** Merged pull requests with no tasks (only reachable with `--all`). */
  mergedWithoutTasks: { number: number; outcome: CompleteSyncMergeOutcome }[];
  skipped: { number: number; reason: CompleteSyncSkipReason }[];
  /** Merge or post-merge completion failures. Non-empty implies a non-zero exit. */
  failed: { number: number; reason: string; taskIds?: string[] }[];
};

/** The subset of the GitHub module the sync orchestration depends on. */
export type CompleteSyncGitHub = {
  tasksOverview(
    store: TaskStore,
    options?: TasksOverviewOptions,
  ): Promise<PullRequestOverviewItem[]>;
};

export type CompleteSyncOptions = {
  apply: boolean;
  all: boolean;
  runner?: CommandRunner;
};

type Eligibility =
  | { eligible: true; completableTasks: Task[] }
  | { eligible: false; reason: CompleteSyncSkipReason };

/**
 * Decides whether a pull request should be merged. A PR is eligible when CI is
 * green / comments resolved / no conflicts (`readyToMerge`) AND either it has at
 * least one completable (non-deleted) associated task, or `--all` was passed.
 * Already-completed active tasks count as a valid link but contribute no
 * completions. A PR whose only associations are soft-deleted is not completable.
 */
const eligibilityFor = (item: PullRequestOverviewItem, all: boolean): Eligibility => {
  if (!item.readyToMerge) return { eligible: false, reason: 'not_ready' };
  const completableTasks = item.associatedTasks.filter((task) => !task.deleted);
  if (completableTasks.length > 0) return { eligible: true, completableTasks };
  if (all) return { eligible: true, completableTasks: [] };
  if (item.associatedTasks.length === 0) {
    return { eligible: false, reason: 'no_associated_task' };
  }
  return { eligible: false, reason: 'no_completable_associated_task' };
};

const emptyResult = (applied: boolean): CompleteSyncResult => ({
  applied,
  planned: [],
  merged: [],
  mergedWithoutTasks: [],
  skipped: [],
  failed: [],
});

const recordPlanned = (
  result: CompleteSyncResult,
  item: PullRequestOverviewItem,
  completableTasks: Task[],
): void => {
  const pendingTaskIds = completableTasks
    .filter((task) => task.status !== 'completed')
    .map((task) => task.id);
  result.planned.push({
    number: item.pullRequest.number,
    outcome: completableTasks.length > 0 ? 'merge' : 'merge_no_tasks',
    taskIds: pendingTaskIds,
  });
};

const mergeOutcome = (item: PullRequestOverviewItem): CompleteSyncMergeOutcome =>
  item.pullRequest.state === 'MERGED' ? 'already_merged' : 'merged';

const applyMerge = (
  result: CompleteSyncResult,
  store: TaskStore,
  item: PullRequestOverviewItem,
  completableTasks: Task[],
  outcome: CompleteSyncMergeOutcome,
): void => {
  if (completableTasks.length === 0) {
    result.mergedWithoutTasks.push({ number: item.pullRequest.number, outcome });
    return;
  }
  const taskIds = completableTasks.map((task) => task.id);
  // Tasks already completed before this run contribute no new completions.
  const newlyCompletableIds = completableTasks
    .filter((task) => task.status !== 'completed')
    .map((task) => task.id);
  try {
    completeTasks(store, taskIds);
    result.merged.push({
      number: item.pullRequest.number,
      outcome,
      completedTaskIds: newlyCompletableIds,
    });
  } catch (error) {
    result.failed.push({
      number: item.pullRequest.number,
      reason: `merged_but_completion_failed: ${error instanceof Error ? error.message : String(error)}`,
      taskIds,
    });
  }
};

/**
 * Walks open pull requests, merges the ones that are ready to merge, and marks
 * their completable tasks `completed`. Dry-run by default; pass `apply: true`
 * to perform merges. The readiness inventory is always read-only — task state
 * changes only as an explicit completion after a successful merge.
 */
export const tasksCompleteSync = async (
  store: TaskStore,
  github: CompleteSyncGitHub,
  options: CompleteSyncOptions,
): Promise<CompleteSyncResult> => {
  const runner = options.runner ?? runCommand;
  const items = await github.tasksOverview(store, { mutateTaskReviewState: false });
  const projectRoot = store.projectRoot;
  const result = emptyResult(options.apply);

  for (const item of items) {
    const eligibility = eligibilityFor(item, options.all);
    if (!eligibility.eligible) {
      result.skipped.push({ number: item.pullRequest.number, reason: eligibility.reason });
      continue;
    }

    if (!options.apply) {
      recordPlanned(result, item, eligibility.completableTasks);
      continue;
    }

    const merge = await mergeIfNeeded(projectRoot, item.pullRequest, runner);
    if (!merge.merged) {
      result.failed.push({
        number: item.pullRequest.number,
        reason: merge.reason ?? 'merge_failed',
      });
      continue;
    }
    applyMerge(result, store, item, eligibility.completableTasks, mergeOutcome(item));
  }

  return result;
};
