import { describe, expect, it } from 'bun:test';
import {
  classifyTaskForRecovery,
  type PipelinePullRequest,
  type RecoveryInputs,
} from './pipeline-recovery';
import type { Task } from './types';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't',
  title: 'T',
  status: 'in-progress',
  description: '',
  priority: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  blocked: false,
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-01-01T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const inputs = (overrides: Partial<RecoveryInputs> = {}): RecoveryInputs => ({
  task: task(),
  resolvedBaseBranch: 'main',
  worktreePath: null,
  worktreeDirty: false,
  worktreeUnpushed: 0,
  remoteBranchExists: false,
  remoteCommitsAheadOfMain: 0,
  candidatePullRequests: [],
  progressPhases: [],
  branchProvenance: 'task-derived',
  now: Date.parse('2026-01-01T12:00:00Z'),
  ...overrides,
});

const merged = (overrides: Partial<PipelinePullRequest> = {}): PipelinePullRequest => ({
  number: 1,
  state: 'MERGED',
  baseRefName: 'main',
  mergedAt: '2026-01-01T11:00:00Z',
  url: 'https://github.test/pull/1',
  ...overrides,
});

const open = (overrides: Partial<PipelinePullRequest> = {}): PipelinePullRequest => ({
  number: 1,
  state: 'OPEN',
  baseRefName: 'main',
  mergedAt: null,
  url: 'https://github.test/pull/1',
  ...overrides,
});

describe('classifyTaskForRecovery', () => {
  it('rollback-safe when no branch, no PR, no progress', () => {
    expect(classifyTaskForRecovery(inputs()).kind).toBe('rollback-safe');
  });

  it('manual past-claim-with-missing-state when phase markers exist but no branch', () => {
    const result = classifyTaskForRecovery(
      inputs({ task: task({ branch: 'tasks/abc' }), progressPhases: ['claim', 'push'] }),
    );
    expect(result.kind).toBe('manual');
    expect(result).toMatchObject({ code: 'past-claim-with-missing-state' });
  });

  it('resumable needs-pr when remote branch exists ahead of base with task-derived provenance', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        remoteBranchExists: true,
        remoteCommitsAheadOfMain: 3,
        branchProvenance: 'task-derived',
      }),
    );
    expect(result).toMatchObject({ kind: 'resumable', needsPr: true, branch: 'tasks/abc' });
  });

  it('manual foreign-branch when remote branch exists but provenance is foreign', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'feature/legacy' }),
        remoteBranchExists: true,
        remoteCommitsAheadOfMain: 3,
        branchProvenance: 'foreign',
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'foreign-branch' });
  });

  it('manual empty-remote-branch when remote branch exists but is not ahead of base', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        remoteBranchExists: true,
        remoteCommitsAheadOfMain: 0,
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'empty-remote-branch' });
  });

  it('resumable when one open PR with clean worktree and task-derived provenance', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        candidatePullRequests: [open()],
      }),
    );
    expect(result).toMatchObject({ kind: 'resumable', needsPr: false });
  });

  it('manual dirty-worktree when one open PR with dirty worktree', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        worktreeDirty: true,
        candidatePullRequests: [open()],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'dirty-worktree' });
  });

  it('manual foreign-branch when one open PR but provenance is foreign', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'feature/legacy' }),
        branchProvenance: 'foreign',
        candidatePullRequests: [open()],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'foreign-branch' });
  });

  it('complete-safe when one PR merged into the resolved base', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        candidatePullRequests: [merged()],
      }),
    );
    expect(result.kind).toBe('complete-safe');
  });

  it('manual wrong-base when one PR merged into a different base', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        candidatePullRequests: [merged({ baseRefName: 'develop' })],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'wrong-base' });
  });

  it('manual merged-dirty-worktree when one PR merged but worktree has uncommitted work', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        worktreeDirty: true,
        candidatePullRequests: [merged()],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'merged-dirty-worktree' });
  });

  it('manual foreign-branch when one PR merged but branch is not derived from task', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'feature/legacy' }),
        branchProvenance: 'foreign',
        candidatePullRequests: [merged()],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'foreign-branch' });
  });

  it('manual multiple-prs when more than one PR matches', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        candidatePullRequests: [open(), open({ number: 2 })],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'multiple-prs' });
  });

  it('manual closed-unmerged-pr when the only PR is closed without merging', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        candidatePullRequests: [{ ...open(), state: 'CLOSED' }],
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'closed-unmerged-pr' });
  });

  it('manual dirty-worktree when no PR but worktree has unpushed commits', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        worktreeUnpushed: 2,
      }),
    );
    expect(result).toMatchObject({ kind: 'manual', code: 'dirty-worktree' });
  });

  it('rollback-safe when branch recorded but no remote, no PR, only claim phase', () => {
    const result = classifyTaskForRecovery(
      inputs({
        task: task({ branch: 'tasks/abc' }),
        remoteBranchExists: false,
        progressPhases: ['claim'],
      }),
    );
    expect(result.kind).toBe('rollback-safe');
  });

  it('manual orphan-worktree when worktree exists on disk but task has no branch', () => {
    const result = classifyTaskForRecovery(inputs({ worktreePath: '/tmp/worktrees/orphan' }));
    expect(result).toMatchObject({ kind: 'manual', code: 'orphan-worktree' });
  });

  it('manual input-unavailable when any load-bearing input is unknown', () => {
    for (const overrides of [
      { remoteBranchExists: 'unknown' as const },
      { candidatePullRequests: 'unknown' as const },
      { resolvedBaseBranch: 'unknown' as const },
      { worktreeDirty: 'unknown' as const },
      { worktreeUnpushed: 'unknown' as const },
      { remoteCommitsAheadOfMain: 'unknown' as const },
      { branchProvenance: 'unknown' as const },
    ]) {
      const result = classifyTaskForRecovery(inputs(overrides));
      expect(result).toMatchObject({ kind: 'manual', code: 'input-unavailable' });
    }
  });

  describe('live-pipeline detection (W-B-3)', () => {
    it('manual live-pipeline-detected when currentLockState is live (highest precedence)', () => {
      // Live lock wins even if all other inputs look rollback-safe.
      const result = classifyTaskForRecovery(inputs({ currentLockState: 'live' }));
      expect(result).toMatchObject({
        kind: 'manual',
        code: 'live-pipeline-detected',
      });
    });

    it('manual live-pipeline-detected when lock is absent but heartbeat pid is alive and fresh', () => {
      const now = Date.parse('2026-01-01T12:00:00Z');
      const result = classifyTaskForRecovery(
        inputs({
          now,
          currentLockState: 'absent',
          latestHeartbeat: {
            ts: now - 5_000, // 5s old
            runId: 'r1',
            pid: 99999,
            pidAlive: true,
          },
        }),
      );
      expect(result).toMatchObject({
        kind: 'manual',
        code: 'live-pipeline-detected',
      });
    });

    it('falls through when heartbeat is fresh but pid is dead', () => {
      const now = Date.parse('2026-01-01T12:00:00Z');
      const result = classifyTaskForRecovery(
        inputs({
          now,
          currentLockState: 'absent',
          latestHeartbeat: { ts: now - 5_000, runId: 'r1', pid: 99999, pidAlive: false },
        }),
      );
      // Falls back to normal classification — no branch, no PR → rollback-safe.
      expect(result.kind).toBe('rollback-safe');
    });

    it('falls through when heartbeat pid is alive but the marker is stale', () => {
      const now = Date.parse('2026-01-01T12:00:00Z');
      const result = classifyTaskForRecovery(
        inputs({
          now,
          currentLockState: 'absent',
          latestHeartbeat: {
            ts: now - 5 * 60_000, // 5 minutes old
            runId: 'r1',
            pid: 99999,
            pidAlive: true,
          },
        }),
      );
      expect(result.kind).toBe('rollback-safe');
    });

    it('falls through with stale lock + no heartbeat (recoverable)', () => {
      const result = classifyTaskForRecovery(
        inputs({ currentLockState: 'stale', latestHeartbeat: null }),
      );
      expect(result.kind).toBe('rollback-safe');
    });
  });
});
