import type { CommandRunner } from './command-runner.js';
import type { Task, TaskIdentifier, TaskProgress, TaskStatus } from './types.js';

export type BranchProbe = 'exists' | 'missing' | 'error';

export type OrphanReason = 'missing-branch-field' | 'branch-not-in-git';
export type SkipReason = 'invalid-branch-value' | 'git-probe-error' | 'stale-state';

export type OrphanOutcome = {
  id: TaskIdentifier;
  previousBranch: string | null;
  previousSession: string | null;
  reason: OrphanReason;
  applied: boolean;
};

export type OrphanSkip = {
  id: TaskIdentifier;
  branch: string | null;
  reason: SkipReason;
  detail?: string;
  actual?: {
    status: TaskStatus;
    branch: string | null;
    session: string | null;
    deleted: boolean;
  };
};

export type RecoverOrphanInput = {
  previousBranch: string | null;
  previousSession: string | null;
  reason: OrphanReason;
};

export type RecoverOrphanResult =
  | { outcome: 'applied'; task: Task; progress: TaskProgress }
  | {
      outcome: 'stale-state';
      actual: {
        status: TaskStatus;
        branch: string | null;
        session: string | null;
        deleted: boolean;
      };
    };

type OrphanStore = {
  inProgress(): Task[];
  recoverOrphan(id: TaskIdentifier, expected: RecoverOrphanInput): RecoverOrphanResult;
};

/** Probes local then origin for the branch. Returns 'missing' only when both
 * show-ref calls exit with status 1 (ref not found). Any other non-zero exit
 * (e.g., 128 for a corrupted index) returns 'error' to keep recovery safe. */
export const branchExistsAnywhere = async (
  projectRoot: string,
  branch: string,
  runner: CommandRunner,
): Promise<BranchProbe> => {
  const local = await runner(
    ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    projectRoot,
  );
  if (local.exitCode === 0) return 'exists';
  if (local.exitCode !== 1) return 'error';
  const remote = await runner(
    ['git', 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`],
    projectRoot,
  );
  if (remote.exitCode === 0) return 'exists';
  if (remote.exitCode !== 1) return 'error';
  return 'missing';
};

/** Validates a stored branch value. Returns null if valid, or a SkipReason if invalid. */
const validateBranchValue = async (
  branch: string,
  projectRoot: string,
  runner: CommandRunner,
  remoteNames: string[] | null,
): Promise<SkipReason | null> => {
  const trimmed = branch.trim();

  // Static prefix check: reject refs/ prefix
  if (trimmed.startsWith('refs/')) return 'invalid-branch-value';

  // Static prefix check: reject remote-qualified names (e.g., origin/foo)
  if (remoteNames !== null) {
    const firstSegment = trimmed.split('/')[0];
    if (firstSegment && remoteNames.includes(firstSegment)) return 'invalid-branch-value';
  }

  // Git's own validator
  const result = await runner(['git', 'check-ref-format', '--branch', trimmed], projectRoot);
  if (result.exitCode === 0) return null;
  if (result.exitCode === 1) return 'invalid-branch-value';
  // Any other exit code (e.g., 128) means Git itself is broken
  return 'git-probe-error';
};

export type FindOrphansResult = {
  candidates: Array<{ task: Task; reason: OrphanReason }>;
  skips: OrphanSkip[];
};

/** Identifies orphaned in-progress tasks without mutating anything. */
export const findOrphans = async (
  store: Pick<OrphanStore, 'inProgress'>,
  projectRoot: string,
  runner: CommandRunner,
): Promise<FindOrphansResult> => {
  const tasks = store.inProgress();
  if (tasks.length === 0) return { candidates: [], skips: [] };

  // Fetch remote names once for the safety gate
  const remoteResult = await runner(['git', 'remote'], projectRoot);
  const remotesFailed = remoteResult.exitCode !== 0;
  const remoteNames: string[] | null = remotesFailed
    ? null
    : remoteResult.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);

  const candidates: Array<{ task: Task; reason: OrphanReason }> = [];
  const skips: OrphanSkip[] = [];

  for (const task of tasks) {
    const branch = task.branch;

    // No branch recorded — missing-branch-field path (always recoverable, unaffected by git remote failure)
    if (branch === null || branch.trim() === '') {
      candidates.push({ task, reason: 'missing-branch-field' });
      continue;
    }

    // Branch is recorded but git remote failed — skip with git-probe-error
    if (remotesFailed) {
      skips.push({
        id: task.id,
        branch,
        reason: 'git-probe-error',
        detail: 'git remote exited non-zero',
      });
      continue;
    }

    // Validate the branch value
    const validationResult = await validateBranchValue(branch, projectRoot, runner, remoteNames);
    if (validationResult !== null) {
      skips.push({ id: task.id, branch, reason: validationResult });
      continue;
    }

    // Probe branch existence
    const probe = await branchExistsAnywhere(projectRoot, branch.trim(), runner);
    if (probe === 'exists') continue; // skip silently
    if (probe === 'error') {
      skips.push({ id: task.id, branch, reason: 'git-probe-error' });
      continue;
    }

    // Branch is missing — candidate for recovery
    candidates.push({ task, reason: 'branch-not-in-git' });
  }

  return { candidates, skips };
};

export type RecoverOrphansResult = {
  orphans: OrphanOutcome[];
  skipped: OrphanSkip[];
};

/** Finds and optionally recovers orphaned in-progress tasks. */
export const recoverOrphans = async (
  store: OrphanStore,
  projectRoot: string,
  runner: CommandRunner,
  options: { dryRun?: boolean } = {},
): Promise<RecoverOrphansResult> => {
  const { candidates, skips } = await findOrphans(store, projectRoot, runner);
  const orphans: OrphanOutcome[] = [];

  for (const { task, reason } of candidates) {
    const previousBranch = task.branch;
    const previousSession = task.session;

    if (options.dryRun) {
      orphans.push({ id: task.id, previousBranch, previousSession, reason, applied: false });
      continue;
    }

    const result = store.recoverOrphan(task.id, { previousBranch, previousSession, reason });
    if (result.outcome === 'applied') {
      orphans.push({ id: task.id, previousBranch, previousSession, reason, applied: true });
    } else {
      skips.push({
        id: task.id,
        branch: previousBranch,
        reason: 'stale-state',
        detail: `task changed between discovery and recovery`,
        actual: result.actual,
      });
    }
  }

  return { orphans, skipped: skips };
};
