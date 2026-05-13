import type { PipelinePhase } from './pipeline-markers.js';
import type { Task, TaskIdentifier } from './types.js';

/** Summary of a pull request as seen by the pipeline (subset of github.ts:PullRequest). */
export type PipelinePullRequest = {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: string;
  mergedAt: string | null;
  url: string;
  /** PR body — used by the structured-footer identity check. */
  body: string | null;
};

/**
 * Inputs to the recovery classifier. Any field that can fail to resolve due to
 * network or git unavailability is typed `T | 'unknown'`; the classifier never
 * returns a destructive verdict when any such input is `'unknown'`.
 */
export type RecoveryInputs = {
  task: Task;
  // eslint-disable-next-line typescript-eslint/no-redundant-type-constituents
  resolvedBaseBranch: string | 'unknown';
  worktreePath: string | null;
  worktreeDirty: boolean | 'unknown';
  worktreeUnpushed: number | 'unknown';
  remoteBranchExists: boolean | 'unknown';
  remoteCommitsAheadOfMain: number | 'unknown';
  candidatePullRequests: PipelinePullRequest[] | 'unknown';
  progressPhases: PipelinePhase[];
  branchProvenance: 'task-derived' | 'foreign' | 'unknown';
  now: number;
  /**
   * State of the global pipeline lockfile at the moment recovery ran. Used
   * by rule precedence: a live lock means another pipeline is actively
   * working — recovery should refuse all mutations and classify as
   * `manual: live-pipeline-detected`.
   *
   *   `absent` — no lockfile on disk.
   *   `live`   — lockfile present and PID is alive.
   *   `stale`  — lockfile present but PID is dead or age > threshold.
   *
   * Optional so older test fixtures continue to work; treated as `absent`
   * when undefined.
   */
  currentLockState?: 'absent' | 'live' | 'stale';
  /**
   * Latest heartbeat marker written by a running pipeline for this task,
   * if any. The marker records the pid of the lock owner so we can
   * distinguish "pipeline alive, lock crashed" from "pipeline dead".
   */
  latestHeartbeat?: { ts: number; runId: string; pid: number; pidAlive: boolean } | null;
  /** How long a heartbeat counts as fresh. Defaults to 60s (2× the 30s emit interval). */
  heartbeatFreshnessMs?: number;
};

export type ManualReasonCode =
  | 'multiple-prs'
  | 'wrong-base'
  | 'merged-dirty-worktree'
  | 'dirty-worktree'
  | 'closed-unmerged-pr'
  | 'stale-branch-no-pr'
  | 'foreign-branch'
  | 'empty-remote-branch'
  | 'past-claim-with-missing-state'
  | 'orphan-worktree'
  | 'input-unavailable'
  | 'live-pipeline-detected';

export type RecoveryVerdict =
  | { kind: 'rollback-safe'; reason: string }
  | { kind: 'complete-safe'; reason: string; pullRequest: PipelinePullRequest }
  | { kind: 'resumable'; reason: string; pullRequest: PipelinePullRequest; needsPr: false }
  | { kind: 'resumable'; reason: string; pullRequest: null; needsPr: true; branch: string }
  | {
      kind: 'manual';
      reason: string;
      code: ManualReasonCode;
      evidence: string[];
      pullRequest?: PipelinePullRequest;
    };

export type RecoveryOutcome = {
  taskId: TaskIdentifier;
  verdict: RecoveryVerdict;
  applied: boolean;
};

/** True when any classifier input we depend on came back unresolved. */
const hasUnknownInputs = (inputs: RecoveryInputs): boolean => {
  return (
    inputs.resolvedBaseBranch === 'unknown' ||
    inputs.worktreeDirty === 'unknown' ||
    inputs.worktreeUnpushed === 'unknown' ||
    inputs.remoteBranchExists === 'unknown' ||
    inputs.remoteCommitsAheadOfMain === 'unknown' ||
    inputs.candidatePullRequests === 'unknown' ||
    inputs.branchProvenance === 'unknown'
  );
};

const verifiedPullRequests = (
  inputs: RecoveryInputs,
  branch: string | null,
): PipelinePullRequest[] => {
  if (inputs.candidatePullRequests === 'unknown') return [];
  if (!branch) return [];
  return inputs.candidatePullRequests;
};

const worktreeBlocks = (inputs: RecoveryInputs): boolean => {
  if (inputs.worktreeDirty === true) return true;
  if (typeof inputs.worktreeUnpushed === 'number' && inputs.worktreeUnpushed > 0) return true;
  return false;
};

const wentPastClaim = (phases: PipelinePhase[]): boolean => {
  return phases.some((phase) => phase !== 'claim');
};

/**
 * Detects whether another pipeline is actively working on this task.
 * Precedence (highest signal first):
 *   1. Live lockfile: another pipeline holds the global lock right now.
 *   2. Absent/stale lockfile + fresh heartbeat whose PID is alive: the lock
 *      crashed but the pipeline itself is still running. Rare but possible.
 * Both produce a `manual: live-pipeline-detected` verdict; the recovery
 * sweep refuses any mutation. Stale-heartbeat / dead-PID falls through to
 * normal recovery.
 */
const detectLivePipeline = (
  inputs: RecoveryInputs,
): { reason: string; evidence: string[] } | null => {
  if (inputs.currentLockState === 'live') {
    return {
      reason:
        'Another pipeline holds the global lockfile; refusing to mutate state. Re-run recovery after the live pipeline finishes.',
      evidence: ['currentLockState=live'],
    };
  }
  const heartbeat = inputs.latestHeartbeat;
  if (!heartbeat) return null;
  if (!heartbeat.pidAlive) return null;
  const freshnessMs = inputs.heartbeatFreshnessMs ?? 60_000;
  const age = inputs.now - heartbeat.ts;
  if (age > freshnessMs) return null;
  return {
    reason:
      'Lockfile is absent or stale but a recent heartbeat marker references a live PID; another pipeline is still running.',
    evidence: [
      `heartbeat.pid=${heartbeat.pid}`,
      `heartbeat.ageMs=${age}`,
      `freshnessMs=${freshnessMs}`,
    ],
  };
};

/**
 * Classifies a stranded task into a recovery verdict. Pure function — does no
 * I/O, makes no mutations. The caller is responsible for dispatching whatever
 * action the verdict requires (or refusing to mutate in default `--recover`).
 */
// eslint-disable-next-line complexity
export const classifyTaskForRecovery = (inputs: RecoveryInputs): RecoveryVerdict => {
  const liveSignal = detectLivePipeline(inputs);
  if (liveSignal) {
    return {
      kind: 'manual',
      reason: liveSignal.reason,
      code: 'live-pipeline-detected',
      evidence: liveSignal.evidence,
    };
  }
  if (hasUnknownInputs(inputs)) {
    return {
      kind: 'manual',
      reason: 'One or more recovery inputs could not be resolved (git or GitHub unavailable).',
      code: 'input-unavailable',
      evidence: [],
    };
  }

  const branch = inputs.task.branch;
  const prs = verifiedPullRequests(inputs, branch);
  const blocks = worktreeBlocks(inputs);

  if (prs.length >= 2) {
    return {
      kind: 'manual',
      reason: `${prs.length} pull requests match this task; operator must reconcile.`,
      code: 'multiple-prs',
      evidence: prs.map((pr) => pr.url),
    };
  }

  if (prs.length === 1) {
    const pullRequest = prs[0]!;
    if (pullRequest.state === 'MERGED') {
      if (pullRequest.baseRefName !== inputs.resolvedBaseBranch) {
        return {
          kind: 'manual',
          reason: `Pull request #${pullRequest.number} merged into ${pullRequest.baseRefName}, expected ${inputs.resolvedBaseBranch}.`,
          code: 'wrong-base',
          evidence: [pullRequest.url],
          pullRequest,
        };
      }
      if (blocks) {
        return {
          kind: 'manual',
          reason: `Pull request #${pullRequest.number} merged but worktree has uncommitted or unpushed work.`,
          code: 'merged-dirty-worktree',
          evidence: [pullRequest.url],
          pullRequest,
        };
      }
      if (inputs.branchProvenance === 'foreign') {
        return {
          kind: 'manual',
          reason: `Pull request #${pullRequest.number} merged but branch ${branch ?? '?'} is not derived from this task.`,
          code: 'foreign-branch',
          evidence: [pullRequest.url],
          pullRequest,
        };
      }
      return {
        kind: 'complete-safe',
        reason: `Pull request #${pullRequest.number} merged on ${pullRequest.baseRefName}.`,
        pullRequest,
      };
    }
    if (pullRequest.state === 'OPEN') {
      if (blocks) {
        return {
          kind: 'manual',
          reason: `Worktree dirty while pull request #${pullRequest.number} is open.`,
          code: 'dirty-worktree',
          evidence: [pullRequest.url],
          pullRequest,
        };
      }
      if (inputs.branchProvenance === 'foreign') {
        return {
          kind: 'manual',
          reason: `Pull request #${pullRequest.number} is open but branch ${branch ?? '?'} is not derived from this task.`,
          code: 'foreign-branch',
          evidence: [pullRequest.url],
          pullRequest,
        };
      }
      return {
        kind: 'resumable',
        reason: `Pull request #${pullRequest.number} open; resume to continue.`,
        pullRequest,
        needsPr: false,
      };
    }
    return {
      kind: 'manual',
      reason: `Pull request #${pullRequest.number} closed without merging.`,
      code: 'closed-unmerged-pr',
      evidence: [pullRequest.url],
      pullRequest,
    };
  }

  if (blocks) {
    return {
      kind: 'manual',
      reason: 'Worktree has dirty or unpushed changes with no pull request.',
      code: 'dirty-worktree',
      evidence: [],
    };
  }

  if (branch) {
    if (inputs.remoteBranchExists === true) {
      if (inputs.branchProvenance === 'foreign') {
        return {
          kind: 'manual',
          reason: `Remote branch ${branch} exists with no pull request; provenance is foreign (not derived from this task id).`,
          code: 'foreign-branch',
          evidence: [],
        };
      }
      if (
        typeof inputs.remoteCommitsAheadOfMain === 'number' &&
        inputs.remoteCommitsAheadOfMain === 0
      ) {
        return {
          kind: 'manual',
          reason: `Remote branch ${branch} exists but is not ahead of the base branch.`,
          code: 'empty-remote-branch',
          evidence: [],
        };
      }
      return {
        kind: 'resumable',
        reason: `Remote branch ${branch} exists with no pull request; resume to open one.`,
        pullRequest: null,
        needsPr: true,
        branch,
      };
    }
    if (wentPastClaim(inputs.progressPhases)) {
      return {
        kind: 'manual',
        reason: 'Phase markers indicate work past `claim` but no branch state survives.',
        code: 'past-claim-with-missing-state',
        evidence: inputs.progressPhases,
      };
    }
    return {
      kind: 'rollback-safe',
      reason:
        'No pull request, no remote branch, no past-claim progress; safe to return to `ready`.',
    };
  }

  if (inputs.worktreePath) {
    return {
      kind: 'manual',
      reason: 'Worktree exists on disk but the task has no recorded branch.',
      code: 'orphan-worktree',
      evidence: [inputs.worktreePath],
    };
  }
  return {
    kind: 'rollback-safe',
    reason: 'Task never reached branch-setting; safe to return to `ready`.',
  };
};
