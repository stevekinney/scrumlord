import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInvocation } from './agent-providers';
import { createTaskStore } from './database-open';
import type { CommandResult, CommandRunner } from './command-runner';
import {
  acquirePipelineLock,
  resolvePipelineConstants,
  runPipeline,
  type SpawnAgent,
} from './pipeline';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-pipeline-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr });

type Scenario = 'happy' | 'merged-state' | 'failing-ci' | 'no-pr' | 'multiple-prs';

const mockGitHubRunner = (scenario: Scenario): CommandRunner => {
  // Used by github.ts (gh api) — return enough JSON to satisfy pullRequestsForBranch and pullRequestStatus.
  // eslint-disable-next-line complexity
  return async (command, _cwd) => {
    const joined = command.join(' ');
    if (joined.endsWith('--help')) {
      return ok('Options:\n  --worktree [name]\n  -C, --cd <DIR>\n');
    }
    if (joined === 'git rev-parse --git-common-dir') return ok('.git\n');
    if (joined === 'git worktree list --porcelain') return ok('');
    if (joined === 'git branch --show-current') return ok('feature/main\n');
    if (joined === 'git symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main\n');
    if (joined.startsWith('git show-ref --verify --quiet refs/remotes/origin/main')) return ok('');
    if (joined.startsWith('git show-ref')) return fail();
    if (joined.startsWith('git fetch')) return ok('');
    if (joined.startsWith('git worktree add')) return ok('');
    if (joined.startsWith('gh repo view')) {
      return ok(JSON.stringify({ nameWithOwner: 'owner/repo' }));
    }
    if (joined.startsWith('gh api repos/owner/repo/pulls?head=')) {
      if (scenario === 'no-pr') return ok(JSON.stringify([]));
      if (scenario === 'multiple-prs') {
        return ok(JSON.stringify([buildPullRequest(1, 'open'), buildPullRequest(2, 'open')]));
      }
      const state = scenario === 'merged-state' ? 'closed' : 'open';
      return ok(JSON.stringify([buildPullRequest(42, state, scenario === 'merged-state')]));
    }
    if (joined.startsWith('gh api repos/owner/repo/pulls/42')) {
      const state = scenario === 'merged-state' ? 'closed' : 'open';
      return ok(JSON.stringify(buildPullRequest(42, state, scenario === 'merged-state')));
    }
    if (joined.startsWith('gh api repos/owner/repo/commits/sha-42/check-runs')) {
      if (scenario === 'failing-ci') {
        return ok(
          JSON.stringify({
            check_runs: [
              {
                name: 'build',
                status: 'completed',
                conclusion: 'failure',
                html_url: 'https://x',
                completed_at: null,
              },
            ],
          }),
        );
      }
      return ok(JSON.stringify({ check_runs: [] }));
    }
    if (joined.startsWith('gh api repos/owner/repo/commits/sha-42/statuses')) {
      return ok(JSON.stringify([]));
    }
    if (joined.startsWith('gh api repos/owner/repo/pulls/42/comments'))
      return ok(JSON.stringify([]));
    if (joined.startsWith('gh api repos/owner/repo/pulls/42/reviews'))
      return ok(JSON.stringify([]));
    if (joined.startsWith('gh api')) {
      // catch-all for graphql / other gh api calls
      return ok(JSON.stringify({}));
    }
    if (joined.startsWith('gh auth status')) return ok('');
    if (joined.startsWith('gh pr merge')) return ok('');
    return fail(`unexpected ${joined}`);
  };
};

const buildPullRequest = (number: number, state: 'open' | 'closed', merged = false) => ({
  number,
  state,
  url: `https://github.test/pull/${number}`,
  title: 'Title',
  head: { ref: 'task/abc12345', sha: 'sha-42' },
  base: { ref: 'main' },
  merged_at: merged ? '2026-05-13T15:00:00Z' : null,
});

const recordingSpawnAgent = (
  results: number[],
): { spawn: SpawnAgent; invocations: AgentInvocation[] } => {
  const invocations: AgentInvocation[] = [];
  let call = 0;
  const spawn: SpawnAgent = async (invocation) => {
    invocations.push(invocation);
    const exitCode = results[call] ?? 0;
    call += 1;
    return { exitCode, stuck: null, killed: null, tail: '', promise: null };
  };
  return { spawn, invocations };
};

describe('resolvePipelineConstants', () => {
  it('returns defaults when env is empty', () => {
    const c = resolvePipelineConstants({});
    expect(c.AGENT_IDLE_MS).toBe(600_000);
    expect(c.AGENT_MAX_MS).toBe(14_400_000);
  });

  it('rejects non-integer env overrides with pipeline_env_invalid', () => {
    expect(() => resolvePipelineConstants({ SCRUMLORD_PIPELINE_AGENT_IDLE_MS: 'abc' })).toThrow(
      'is not a valid integer',
    );
  });

  it('rejects out-of-range env overrides with pipeline_env_out_of_range', () => {
    expect(() => resolvePipelineConstants({ SCRUMLORD_PIPELINE_AGENT_IDLE_MS: '10' })).toThrow(
      'outside the allowed range',
    );
  });

  it('accepts in-range overrides', () => {
    const c = resolvePipelineConstants({ SCRUMLORD_PIPELINE_AGENT_IDLE_MS: '60001' });
    expect(c.AGENT_IDLE_MS).toBe(60_001);
  });
});

describe('acquirePipelineLock', () => {
  it('writes a lockfile and returns a release callback', async () => {
    const root = await temporaryDirectory();
    const release = acquirePipelineLock(root, 'run-1');
    expect(existsSync(join(root, 'tmp', 'pipeline.lock'))).toBe(true);
    release();
    expect(existsSync(join(root, 'tmp', 'pipeline.lock'))).toBe(false);
  });

  it('refuses when a live pid holds the lock', async () => {
    const root = await temporaryDirectory();
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(
      join(root, 'tmp', 'pipeline.lock'),
      JSON.stringify({
        pid: process.pid, // alive
        runId: 'other-run',
        startedAt: new Date().toISOString(),
        hostname: 'host',
      }),
    );
    try {
      acquirePipelineLock(root, 'run-1');
      throw new Error('expected pipeline_already_running');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('pipeline_already_running');
    }
  });

  it('reaps a stale lockfile when the pid is dead and proceeds', async () => {
    const root = await temporaryDirectory();
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(
      join(root, 'tmp', 'pipeline.lock'),
      JSON.stringify({
        pid: 999999999, // unlikely to be alive
        runId: 'other-run',
        startedAt: new Date().toISOString(),
        hostname: 'host',
      }),
    );
    const release = acquirePipelineLock(root, 'run-1');
    release();
  });

  it('reaps a lockfile older than staleMs and proceeds', async () => {
    const root = await temporaryDirectory();
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(
      join(root, 'tmp', 'pipeline.lock'),
      JSON.stringify({
        pid: process.pid,
        runId: 'other-run',
        startedAt: '2020-01-01T00:00:00Z',
        hostname: 'host',
      }),
    );
    const release = acquirePipelineLock(root, 'run-1', { staleMs: 1_000 });
    release();
  });

  it('reaps a malformed lockfile', async () => {
    const root = await temporaryDirectory();
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(join(root, 'tmp', 'pipeline.lock'), 'not json');
    const release = acquirePipelineLock(root, 'run-1');
    release();
  });
});

describe('runPipeline drain mode (mocked)', () => {
  it('exits 0 with shipped:0 on empty queue', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'drain',
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: recordingSpawnAgent([0]).spawn,
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.exitCode).toBe(0);
      expect(summary.shipped).toHaveLength(0);
      expect(summary.failed).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('exits 1 and stops after first failed task on stop-on-stuck', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      store.create({ id: 'b', title: 'B' });
      const { spawn } = recordingSpawnAgent([1]);
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'drain',
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: spawn,
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.exitCode).toBe(1);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]!.reason).toBe('agent_failed');
      // Second task untouched.
      expect(store.getTask('b')?.status).toBe('ready');
    } finally {
      store.close();
    }
  });

  it('records agent_idle when the spawn reports an idle timeout', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'drain',
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: async () => ({
          exitCode: 0,
          stuck: null,
          killed: 'idle',
          tail: '',
          promise: null,
        }),
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.failed[0]!.reason).toBe('agent_idle');
    } finally {
      store.close();
    }
  });

  it('records STUCK:<reason> when the agent exits non-zero with a stuck signal', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'drain',
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: async () => ({
          exitCode: 2,
          stuck: 'tests failed',
          killed: null,
          tail: '',
          promise: null,
        }),
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.failed[0]!.reason).toBe('stuck:tests failed');
    } finally {
      store.close();
    }
  });

  it('refuses to drain twice when the lockfile is held', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(
      join(root, 'tmp', 'pipeline.lock'),
      JSON.stringify({
        pid: process.pid,
        runId: 'other-run',
        startedAt: new Date().toISOString(),
        hostname: 'host',
      }),
    );
    const store = await createTaskStore({ cwd: root });
    try {
      let caught: unknown;
      try {
        await runPipeline(store, {
          provider: 'claude',
          skipPreflight: true,
          mode: 'drain',
          quiet: true,
          runner: mockGitHubRunner('happy'),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          sleep: async () => {},
          runId: 'r1',
          repository: 'owner/repo',
        });
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe('pipeline_already_running');
    } finally {
      store.close();
    }
  });
});

describe('runPipeline dry-run mode', () => {
  it('lists candidates without claiming or spawning', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      store.create({ id: 'b', title: 'B' });
      let spawnCalled = false;
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'drain',
        max: 2,
        dryRun: true,
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: async () => {
          spawnCalled = true;
          return { exitCode: 0, stuck: null, killed: null, tail: '', promise: null };
        },
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(spawnCalled).toBe(false);
      expect(summary.exitCode).toBe(0);
      expect(summary.skipped).toHaveLength(2);
      expect(summary.skipped.every((o) => o.reason === 'dry_run_would_claim')).toBe(true);
      // No claim happened.
      expect(store.getTask('a')?.status).toBe('ready');
      expect(store.getTask('b')?.status).toBe('ready');
      // No lockfile.
      expect(existsSync(join(root, 'tmp', 'pipeline.lock'))).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('runPipeline recover mode (annotate-only)', () => {
  it('annotates stranded tasks without mutating when --apply is not set', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 'stranded', title: 'Stranded' });
      store.update(task.id, { status: 'in-progress' });
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'recover',
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: recordingSpawnAgent([]).spawn,
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.recovery).not.toBeNull();
      expect(summary.recovery).toHaveLength(1);
      expect(summary.recovery![0]!.applied).toBe(false);
      // Status untouched (was in-progress, still in-progress).
      expect(store.getTask(task.id)?.status).toBe('in-progress');
    } finally {
      store.close();
    }
  });

  it('applies rollback-safe verdicts when --apply is set', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 'stranded', title: 'Stranded' });
      store.update(task.id, { status: 'in-progress' });
      const summary = await runPipeline(store, {
        provider: 'claude',
        skipPreflight: true,
        mode: 'recover',
        apply: true,
        quiet: true,
        runner: mockGitHubRunner('happy'),
        spawnAgent: recordingSpawnAgent([]).spawn,
        sleep: async () => {},
        runId: 'r1',
        repository: 'owner/repo',
      });
      expect(summary.recovery![0]!.applied).toBe(true);
      expect(summary.recovery![0]!.verdict.kind).toBe('rollback-safe');
      expect(store.getTask(task.id)?.status).toBe('ready');
    } finally {
      store.close();
    }
  });
});
