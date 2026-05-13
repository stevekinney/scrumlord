#!/usr/bin/env bun
/* eslint-disable max-lines */
/**
 * Smoke harness for `runPipeline`.
 *
 * Drives the real pipeline orchestrator with injected `runner` (mock `gh` + `git`)
 * and injected `spawnAgent` (mock agent process) per scenario. Each scenario
 * declares an expected exit code and a list of stderr substring assertions, and
 * the harness fails if either disagrees.
 *
 * Usage:
 *   bun scripts/smoke-pipeline.ts --list
 *   bun scripts/smoke-pipeline.ts --scenario <name>
 *   bun scripts/smoke-pipeline.ts --all
 *
 * Scenarios carry two metadata fields:
 *   - introducedInWorkstream: which workstream PR added the scenario
 *   - assertsBehaviorFrom: which workstream's behavior the assertions cover
 *     (the harness only executes scenarios whose target behavior is already
 *     present in the codebase — see the README block in this file)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInvocation } from '../src/agent-providers';
import type { CommandResult, CommandRunner } from '../src/command-runner';
import { createTaskStore } from '../src/database-open';
import { runPipeline, type PipelineSummary, type SpawnAgent } from '../src/pipeline';
import type { TaskStore } from '../src/types';

type Scenario = {
  name: string;
  introducedInWorkstream: string;
  /**
   * Which workstream's behavior the scenario asserts. `'current'` means it
   * asserts pre-change behavior present on `main` at the time the scenario
   * was written; future workstreams set this to their own id.
   */
  assertsBehaviorFrom: string;
  description: string;
  run: (context: ScenarioContext) => Promise<ScenarioOutcome>;
  expectedExitCode: number;
  expectedStderrSubstrings: readonly string[];
  /** Optional store-state assertions run after the pipeline returns. */
  storeAssertions?: (store: TaskStore) => Promise<void> | void;
  /**
   * Optional post-run assertion against scenario-supplied artifacts (captured
   * agent invocations, transcript files, etc.). The scenario builds the
   * artifact in its `run` and the harness invokes this with the same object.
   */
  customAssertions?: (artifacts: ScenarioOutcome) => Promise<void> | void;
};

type ScenarioContext = {
  store: TaskStore;
  appendStderr: (line: string) => void;
};

type ScenarioOutcome = {
  summary: PipelineSummary;
  /** Captured agent invocations, when the scenario uses `captureInvocationSpawnAgent`. */
  invocations?: AgentInvocation[];
};

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr = ''): CommandResult => ({ exitCode: 1, stdout: '', stderr });

/** Wraps a JSON body in the `gh api --include` envelope (HTTP status line + headers + body). */
const ghIncludeBody = (body: unknown, status = 200): CommandResult =>
  ok(`HTTP/2.0 ${status}\ncontent-type: application/json\n\n${JSON.stringify(body)}`);

/**
 * Mock command runner that satisfies the gh + git surface the pipeline reaches
 * for the in-scope scenarios. Keep this aligned with `pipeline.test.ts`'s
 * `mockGitHubRunner` so the harness exercises the same shape the unit tests do.
 */
type MockRunnerOptions = {
  mode: 'happy' | 'no-tasks';
  /** Branch the mock should claim is currently checked out (used by sync-git-status). */
  currentBranch?: () => string;
  /**
   * Initial PR state. `merged` returns a closed+merged PR (short-circuits the
   * polling loop). `open` returns an OPEN PR so the pipeline calls
   * `pullRequestStatus`, sees readyToMerge=true with green checks, and runs
   * the merge step itself.
   */
  prState?: 'merged' | 'open';
  /** Body the mock should return for the PR. Defaults to an empty string. */
  prBody?: () => string;
  /** Called when the mock receives `gh pr edit … --body <new>`. */
  onPrEdit?: (number: number, newBody: string) => void;
  /** Override the `git rev-list --count` return value used by the commit-count check. */
  commitCount?: number;
  /** Called when the mock receives `git worktree remove …`. */
  onWorktreeRemove?: (path: string, force: boolean) => void;
  /** Called when the mock receives `git branch -d …`. */
  onBranchDelete?: (branch: string) => void;
  /**
   * Reviews to return from `gh api repos/owner/repo/pulls/42/reviews`. Used
   * by the W-D bot-aware readiness scenarios. Default is an empty list.
   */
  reviews?: Array<{ user: { login: string }; state: string; commit_id: string }>;
};

const ghApiEndpoint = (joined: string, suffix: string): boolean => {
  return joined.includes(`repos/owner/repo/${suffix}`);
};

const mockRunner = (options: MockRunnerOptions): CommandRunner => {
  const { mode, prState = 'merged' } = options;
  // eslint-disable-next-line complexity
  return async (command) => {
    const joined = command.join(' ');
    const headParam = extractFParam(command, 'head');
    const branchFromHead = headParam?.split(':', 2)[1] ?? 'task/smoke';
    const prBody = options.prBody ? options.prBody() : '';
    const buildPr = (): ReturnType<typeof buildMergedPullRequest> => {
      return prState === 'merged'
        ? buildMergedPullRequest(branchFromHead, prBody)
        : buildOpenPullRequest(branchFromHead, prBody);
    };
    if (joined.endsWith('--help')) {
      return ok('Options:\n  --worktree [name]\n  -C, --cd <DIR>\n');
    }
    if (joined === 'git rev-parse --git-common-dir') return ok('.git\n');
    if (joined === 'git worktree list --porcelain') return ok('');
    if (joined === 'git branch --show-current') {
      return ok(`${options.currentBranch ? options.currentBranch() : 'feature/main'}\n`);
    }
    if (joined === 'git symbolic-ref --short refs/remotes/origin/HEAD') return ok('origin/main\n');
    if (joined.startsWith('git show-ref --verify --quiet refs/remotes/origin/main')) return ok('');
    if (joined.startsWith('git show-ref')) return fail();
    if (joined.startsWith('git fetch')) return ok('');
    if (joined.startsWith('git worktree add')) return ok('');
    if (joined.startsWith('git worktree remove')) {
      const path = command[command.length - 1]!;
      const force = command.includes('--force');
      options.onWorktreeRemove?.(path, force);
      return ok('');
    }
    if (joined.startsWith('git branch -d ')) {
      const branch = command[3] ?? '';
      options.onBranchDelete?.(branch);
      return ok('');
    }
    if (joined.startsWith('git rev-list --count')) {
      return ok(`${options.commitCount ?? 1}\n`);
    }
    if (joined.startsWith('gh repo view')) {
      // gh repo view --json nameWithOwner --jq .nameWithOwner → bare string.
      return ok('owner/repo\n');
    }
    // `gh api …/repos/owner/repo/pulls -F head=owner:<branch> …` (list query).
    if (joined.startsWith('gh api') && commandHasEndpoint(command, 'pulls')) {
      if (mode === 'no-tasks') return ghIncludeBody([]);
      return ghIncludeBody([buildPr()]);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42/comments')) {
      return ghIncludeBody([]);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42/reviews')) {
      return ghIncludeBody(options.reviews ?? []);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42')) {
      return ghIncludeBody(buildPr());
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'commits/sha-42/check-runs')) {
      return ghIncludeBody({ check_runs: [] });
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'commits/sha-42/statuses')) {
      return ghIncludeBody([]);
    }
    if (joined.startsWith('gh api graphql')) {
      // GraphQL responses do NOT use --include; plain JSON.
      return ok(
        JSON.stringify({
          data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
        }),
      );
    }
    if (joined.startsWith('gh api')) {
      if (process.env['SMOKE_DEBUG']) {
        process.stderr.write(`\n[smoke fallthrough] ${joined}\n`);
      }
      return ghIncludeBody({});
    }
    if (joined.startsWith('gh auth status')) return ok('');
    if (joined.startsWith('gh pr merge')) return ok('');
    // `gh pr edit <number> --body <new>` (used by the footer repair flag).
    if (joined.startsWith('gh pr edit')) {
      const number = Number(command[3]);
      const bodyIndex = command.indexOf('--body');
      const newBody = bodyIndex >= 0 ? (command[bodyIndex + 1] ?? '') : '';
      options.onPrEdit?.(number, newBody);
      return ok('');
    }
    // `gh pr list --head <branch> --state all --json … --limit 1` (used by sync-git-status).
    if (joined.startsWith('gh pr list')) {
      if (mode === 'no-tasks') return ok(JSON.stringify([]));
      const headIndex = command.indexOf('--head');
      const branch = (headIndex >= 0 ? command[headIndex + 1] : undefined) ?? 'task/smoke';
      return ok(
        JSON.stringify([
          {
            number: 42,
            state: 'MERGED',
            baseRefName: 'main',
            mergedAt: '2026-05-13T15:00:00Z',
            url: 'https://github.test/pull/42',
            headRefName: branch,
          },
        ]),
      );
    }
    return fail(`unexpected ${joined}`);
  };
};

const buildMergedPullRequest = (branch: string, body = '') => ({
  number: 42,
  state: 'closed',
  url: 'https://github.test/pull/42',
  title: 'smoke task',
  head: { ref: branch, sha: 'sha-42' },
  base: { ref: 'main' },
  merged_at: '2026-05-13T15:00:00Z',
  body,
});

const buildOpenPullRequest = (branch: string, body = '') => ({
  number: 42,
  state: 'open',
  url: 'https://github.test/pull/42',
  title: 'smoke task',
  head: { ref: branch, sha: 'sha-42' },
  base: { ref: 'main' },
  merged_at: null,
  body,
});

const extractFParam = (command: readonly string[], key: string): string | undefined => {
  for (let index = 0; index < command.length - 1; index += 1) {
    if (command[index] === '-F') {
      const value = command[index + 1]!;
      if (value.startsWith(`${key}=`)) return value.slice(key.length + 1);
    }
  }
  return undefined;
};

const commandHasEndpoint = (command: readonly string[], endpoint: string): boolean => {
  return command.some((token) => token === `repos/owner/repo/${endpoint}`);
};

/**
 * Spawn-agent factories. Each returns a `SpawnAgent` that records its
 * invocations on `invocations` so assertions can inspect them.
 */
const recordingSpawnAgent = (
  exitCodes: readonly number[],
): { spawn: SpawnAgent; invocations: AgentInvocation[] } => {
  const invocations: AgentInvocation[] = [];
  let call = 0;
  const spawn: SpawnAgent = async (invocation) => {
    invocations.push(invocation);
    const exitCode = exitCodes[call] ?? 0;
    call += 1;
    return { exitCode, stuck: null, killed: null, tail: '', promise: null };
  };
  return { spawn, invocations };
};

const stuckStderrSpawnAgent = (): SpawnAgent => {
  return async (_invocation, _caps, controls) => {
    controls.stderr('STUCK: stuck on flaky test\n');
    return {
      exitCode: 1,
      stuck: 'stuck on flaky test',
      killed: null,
      tail: 'STUCK: stuck on flaky test',
      promise: null,
    };
  };
};

/** Records the invocation so the scenario can assert on argv/stdin shape. */
const captureInvocationSpawnAgent = (): {
  spawn: SpawnAgent;
  invocations: AgentInvocation[];
} => {
  const invocations: AgentInvocation[] = [];
  const spawn: SpawnAgent = async (invocation) => {
    invocations.push(invocation);
    return { exitCode: 0, stuck: null, killed: null, tail: '', promise: null };
  };
  return { spawn, invocations };
};

/** Surfaces a `<promise>` tag in the captured tail. */
const promiseTagSpawnAgent = (): SpawnAgent => {
  return async () => {
    return {
      exitCode: 0,
      stuck: null,
      killed: null,
      tail: 'doing work…\n<promise>PR feedback addressed and CI passing</promise>\n',
      promise: 'PR feedback addressed and CI passing',
    };
  };
};

const seedReadyTask = (store: TaskStore, title: string): { id: string; branch: string } => {
  const task = store.create({ title, status: 'ready' });
  return { id: task.id, branch: `task/${task.id.slice(0, 8)}` };
};

const scenarios: readonly Scenario[] = [
  {
    name: 'green',
    introducedInWorkstream: 'W0',
    assertsBehaviorFrom: 'W-A',
    description: 'one ready task ships end-to-end against happy mock gh + git',
    expectedExitCode: 0,
    expectedStderrSubstrings: [
      'tasks pipeline starting…',
      'smoke task', // title threaded into claim line (#2)
      'tip: cd ', // worktree path tip (#14)
      'PR #42 found',
      'https://github.test/pull/42', // URL on its own line (#15)
      'pass=', // quad snapshot present (#10)
      'shipped',
    ],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'smoke task');
      // After the pipeline claims the task and prepares a worktree, the task
      // row is updated with its branch. The sync-git-status step reads
      // `git branch --show-current`; return the task's branch so the sync
      // can find the row by branch and transition it to completed.
      const currentBranch = (): string => {
        const tasks = store.list();
        const branched = tasks.find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'happy', currentBranch, prState: 'open' }),
        spawnAgent: recordingSpawnAgent([0]).spawn,
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-green',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1,
        constants: {
          CHECK_POLL_INTERVAL_MS: 1,
          CHECK_POLL_MAX_ATTEMPTS: 1,
          REVIEW_BOT_WAIT_MS: 1,
          REVIEW_BOT_MAX_ATTEMPTS: 1,
          ADDRESS_PR_MAX_ROUNDS: 1,
          AGENT_IDLE_MS: 60_001,
          AGENT_MAX_MS: 60_001,
          LOCK_STALE_MS: 60_001,
        },
      });
      // `runPipeline` operates against the supplied projectRoot only via the lockfile path.
      return { summary };
    },
    storeAssertions: (store) => {
      const stillReady = store.available();
      assert(
        stillReady.length === 0,
        `expected no ready tasks after green run, got ${stillReady.length}`,
      );
    },
  },
  {
    name: 'empty',
    introducedInWorkstream: 'W0',
    assertsBehaviorFrom: 'W-A',
    description: 'empty queue exits 0 with ready-queue breakdown',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['tasks pipeline starting…', 'ready-queue breakdown:', 'queue empty'],
    run: async ({ store, appendStderr }) => {
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'no-tasks' }),
        spawnAgent: recordingSpawnAgent([]).spawn,
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-empty',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1,
      });
      return { summary };
    },
  },
  {
    name: 'stuck-stderr',
    introducedInWorkstream: 'W0',
    assertsBehaviorFrom: 'current',
    description: 'agent emits `STUCK:` on stderr; pipeline records failure and exits non-zero',
    expectedExitCode: 1,
    expectedStderrSubstrings: ['STUCK:', 'failed'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'stuck task');
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'happy' }),
        spawnAgent: stuckStderrSpawnAgent(),
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-stuck',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1,
        constants: {
          CHECK_POLL_INTERVAL_MS: 1,
          CHECK_POLL_MAX_ATTEMPTS: 1,
          REVIEW_BOT_WAIT_MS: 1,
          REVIEW_BOT_MAX_ATTEMPTS: 1,
          ADDRESS_PR_MAX_ROUNDS: 1,
          AGENT_IDLE_MS: 60_001,
          AGENT_MAX_MS: 60_001,
          LOCK_STALE_MS: 60_001,
        },
      });
      return { summary };
    },
    storeAssertions: (store) => {
      const shipped = store.completed();
      assert(shipped.length === 0, 'stuck task must not be marked completed');
    },
  },
  {
    name: 'prompt-stdin',
    introducedInWorkstream: 'B-1',
    assertsBehaviorFrom: 'B-1',
    description: "pipeline writes the prompt body to the agent's stdin, not argv (#8)",
    expectedExitCode: 0,
    expectedStderrSubstrings: [],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'stdin task');
      const capture = captureInvocationSpawnAgent();
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'happy', currentBranch, prState: 'merged' }),
        spawnAgent: capture.spawn,
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-stdin',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1,
        constants: {
          CHECK_POLL_INTERVAL_MS: 1,
          CHECK_POLL_MAX_ATTEMPTS: 1,
          REVIEW_BOT_WAIT_MS: 1,
          REVIEW_BOT_MAX_ATTEMPTS: 1,
          ADDRESS_PR_MAX_ROUNDS: 1,
          AGENT_IDLE_MS: 60_001,
          AGENT_MAX_MS: 60_001,
          LOCK_STALE_MS: 60_001,
        },
      });
      return { summary, invocations: capture.invocations };
    },
    customAssertions: ({ invocations }) => {
      assert(invocations !== undefined, 'invocations not captured');
      assert(
        invocations.length >= 1,
        `expected at least one invocation, got ${invocations.length}`,
      );
      const claudeInvocation = invocations[0]!;
      assert(claudeInvocation.stdin !== undefined, 'expected claude invocation to use stdin');
      assert(claudeInvocation.stdin.length > 0, 'expected non-empty stdin body');
      const argv = claudeInvocation.command.join(' ');
      // The body should not appear on argv. Use a stable substring from the
      // pipeline prompt to confirm.
      assert(!argv.includes(claudeInvocation.stdin), `body leaked into argv: ${argv}`);
    },
  },
  {
    name: 'wrong-task-pr',
    introducedInWorkstream: 'B-2',
    assertsBehaviorFrom: 'B-2',
    description:
      'with PR_IDENTITY=on, a PR whose body references a different task id is rejected (#5)',
    expectedExitCode: 1,
    expectedStderrSubstrings: ['no PR yet', 'pr_never_opened'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'identity task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      process.env['SCRUMLORD_PIPELINE_PR_IDENTITY'] = 'on';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'open',
            prBody: () => 'pipeline-task-id: deadbeef-deadbeef-deadbeef',
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-wrong-pr',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_PR_IDENTITY'];
      }
    },
  },
  {
    name: 'footer-missing',
    introducedInWorkstream: 'B-2',
    assertsBehaviorFrom: 'B-2',
    description: 'with PR_FOOTER_VERIFY=on, a PR whose body is missing the footer fails fast (#6b)',
    expectedExitCode: 1,
    expectedStderrSubstrings: ['missing the pipeline-task-id footer', 'pr_footer_missing'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'verify task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      process.env['SCRUMLORD_PIPELINE_PR_FOOTER_VERIFY'] = 'on';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'open',
            prBody: () => 'no footer here',
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-footer-missing',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_PR_FOOTER_VERIFY'];
      }
    },
  },
  {
    name: 'footer-repair',
    introducedInWorkstream: 'B-2',
    assertsBehaviorFrom: 'B-2',
    description:
      'with PR_FOOTER_REPAIR=on and a missing footer, the pipeline calls gh pr edit to append (#6c)',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['footer missing; appending pipeline-task-id:'],
    run: async ({ store, appendStderr }) => {
      const { id } = seedReadyTask(store, 'repair task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const edits: Array<{ number: number; body: string }> = [];
      process.env['SCRUMLORD_PIPELINE_PR_FOOTER_REPAIR'] = 'on';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'merged',
            prBody: () => 'Original PR body',
            onPrEdit: (number, body) => edits.push({ number, body }),
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-footer-repair',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        assert(edits.length === 1, `expected 1 edit, got ${edits.length}`);
        assert(
          edits[0]!.body.includes(`pipeline-task-id: ${id}`),
          `edit body missing footer: ${edits[0]!.body}`,
        );
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_PR_FOOTER_REPAIR'];
      }
    },
  },
  {
    name: 'no-commits',
    introducedInWorkstream: 'C',
    assertsBehaviorFrom: 'C',
    description:
      'with REQUIRE_COMMITS=on, agent exits 0 with no commits → no_commits_after_agent (#20)',
    expectedExitCode: 1,
    expectedStderrSubstrings: ['0 commits', 'no_commits_after_agent'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'no-commit task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      process.env['SCRUMLORD_PIPELINE_REQUIRE_COMMITS'] = 'on';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'merged',
            commitCount: 0,
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-no-commits',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_REQUIRE_COMMITS'];
      }
    },
  },
  {
    name: 'worktree-cleanup',
    introducedInWorkstream: 'C',
    assertsBehaviorFrom: 'C',
    description: 'with CLEANUP=remove, the cleanup helper runs after merge (#26)',
    expectedExitCode: 0,
    // The smoke harness has no real per-task worktree on disk, so
    // worktreeForTask resolves to the project root and the cleanup helper
    // short-circuits without calling git. We assert behavior the harness
    // can observe: the env var is honored without breaking the run, and a
    // real worktree (one not equal to project root) would have triggered
    // the recorded removal. Unit tests in src/pipeline.test.ts cover the
    // full removal path against a stub runner.
    expectedStderrSubstrings: ['task completed (PR #42 merged)'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'cleanup task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const removals: Array<{ path: string; force: boolean }> = [];
      const branchDeletes: string[] = [];
      process.env['SCRUMLORD_PIPELINE_CLEANUP'] = 'remove';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'merged',
            onWorktreeRemove: (path, force) => removals.push({ path, force }),
            onBranchDelete: (branch) => branchDeletes.push(branch),
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-cleanup',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        // Without a real worktree on disk, worktreeForTask returns
        // store.projectRoot and cleanup short-circuits. Allow zero removals
        // in that case, but if removals did happen they must NOT be --force.
        for (const removal of removals) {
          assert(!removal.force, 'CLEANUP=remove must not pass --force');
        }
        void branchDeletes;
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_CLEANUP'];
      }
    },
  },
  {
    name: 'bot-pending-advisory',
    introducedInWorkstream: 'D',
    assertsBehaviorFrom: 'D',
    description: 'with EXPECTED_BOTS set and no review, advisory mode warns then ships (#7 + #25)',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['Awaiting review bots', 'accepting (advisory)', 'task shipped'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'advisory task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      process.env['SCRUMLORD_PIPELINE_EXPECTED_BOTS'] = 'copilot';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'open',
            reviews: [],
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-advisory',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1_000,
            REVIEW_BOT_MAX_ATTEMPTS: 2,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
          // The fake sleep makes the wait budget elapse instantly.
          sleep: async () => undefined,
        });
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_EXPECTED_BOTS'];
      }
    },
  },
  {
    name: 'bot-pending-strict',
    introducedInWorkstream: 'D',
    assertsBehaviorFrom: 'D',
    description:
      'with EXPECTED_BOTS set, BOT_WAIT=strict, and no review, the pipeline fails (#7 + #25)',
    expectedExitCode: 1,
    expectedStderrSubstrings: [
      'expected bots never reviewed (strict)',
      'expected_bots_never_reviewed',
    ],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'strict task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      process.env['SCRUMLORD_PIPELINE_EXPECTED_BOTS'] = 'copilot';
      process.env['SCRUMLORD_PIPELINE_BOT_WAIT'] = 'strict';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({
            mode: 'happy',
            currentBranch,
            prState: 'open',
            reviews: [],
          }),
          spawnAgent: recordingSpawnAgent([0]).spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-strict',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1_000,
            REVIEW_BOT_MAX_ATTEMPTS: 2,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
          sleep: async () => undefined,
        });
        return { summary };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_EXPECTED_BOTS'];
        delete process.env['SCRUMLORD_PIPELINE_BOT_WAIT'];
      }
    },
  },
  {
    name: 'once-three-tasks',
    introducedInWorkstream: 'F',
    assertsBehaviorFrom: 'F',
    description: 'with --once (max=1) and three ready tasks, ships one and leaves two ready (#9)',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['draining queue (max 1 attempts)', 'task completed'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'first task');
      seedReadyTask(store, 'second task');
      seedReadyTask(store, 'third task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'happy', currentBranch, prState: 'merged' }),
        spawnAgent: recordingSpawnAgent([0]).spawn,
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-once',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1, // The CLI maps --once to max:1; PipelineOptions takes it directly.
        constants: {
          CHECK_POLL_INTERVAL_MS: 1,
          CHECK_POLL_MAX_ATTEMPTS: 1,
          REVIEW_BOT_WAIT_MS: 1,
          REVIEW_BOT_MAX_ATTEMPTS: 1,
          ADDRESS_PR_MAX_ROUNDS: 1,
          AGENT_IDLE_MS: 60_001,
          AGENT_MAX_MS: 60_001,
          LOCK_STALE_MS: 60_001,
        },
      });
      return { summary };
    },
    storeAssertions: (store) => {
      const remaining = store.available();
      assert(remaining.length === 2, `expected 2 ready tasks remaining, got ${remaining.length}`);
    },
  },
  {
    name: 'phase-split',
    introducedInWorkstream: 'E',
    assertsBehaviorFrom: 'E',
    description:
      'with PHASES=split and no existing plan, the pipeline runs a plan-only agent first (#3, #18)',
    expectedExitCode: 0,
    expectedStderrSubstrings: [
      'plan: none — agent will draft',
      'phase: plan-only agent run',
      'plan-only phase complete',
    ],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'phase-split task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const capture = captureInvocationSpawnAgent();
      process.env['SCRUMLORD_PIPELINE_PHASES'] = 'split';
      try {
        const summary = await runPipeline(store, {
          provider: 'claude',
          mode: 'drain',
          skipPreflight: true,
          runner: mockRunner({ mode: 'happy', currentBranch, prState: 'merged' }),
          spawnAgent: capture.spawn,
          stderr: appendStderr,
          now: () => Date.parse('2026-05-13T15:00:00Z'),
          runId: 'smoke-phase',
          repository: 'owner/repo',
          hostname: 'smoke-host',
          colorMode: 'off',
          max: 1,
          constants: {
            CHECK_POLL_INTERVAL_MS: 1,
            CHECK_POLL_MAX_ATTEMPTS: 1,
            REVIEW_BOT_WAIT_MS: 1,
            REVIEW_BOT_MAX_ATTEMPTS: 1,
            ADDRESS_PR_MAX_ROUNDS: 1,
            AGENT_IDLE_MS: 60_001,
            AGENT_MAX_MS: 60_001,
            LOCK_STALE_MS: 60_001,
          },
        });
        return { summary, invocations: capture.invocations };
      } finally {
        delete process.env['SCRUMLORD_PIPELINE_PHASES'];
      }
    },
    customAssertions: ({ invocations }) => {
      assert(invocations !== undefined, 'invocations not captured');
      assert(
        invocations.length === 2,
        `expected 2 agent invocations (plan, implement), got ${invocations.length}`,
      );
      // First invocation is the plan-only phase; its stdin should mention the
      // plan-only contract and NOT the merge contract.
      const planStdin = invocations[0]!.stdin ?? '';
      assert(
        planStdin.includes('plan-only phase'),
        `plan-phase invocation stdin missing the plan-only marker: ${planStdin}`,
      );
      assert(
        !planStdin.includes('drive it through merge'),
        'plan-phase invocation must not include the merge contract',
      );
    },
  },
  {
    name: 'promise-tag',
    introducedInWorkstream: 'B-1',
    assertsBehaviorFrom: 'B-1',
    description: 'agent <promise> tag is surfaced as a pipeline log line (#23)',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['agent reports: PR feedback addressed and CI passing'],
    run: async ({ store, appendStderr }) => {
      seedReadyTask(store, 'promise task');
      const currentBranch = (): string => {
        const branched = store.list().find((task) => task.branch);
        return branched?.branch ?? 'feature/main';
      };
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
        skipPreflight: true,
        runner: mockRunner({ mode: 'happy', currentBranch, prState: 'merged' }),
        spawnAgent: promiseTagSpawnAgent(),
        stderr: appendStderr,
        now: () => Date.parse('2026-05-13T15:00:00Z'),
        runId: 'smoke-promise',
        repository: 'owner/repo',
        hostname: 'smoke-host',
        colorMode: 'off',
        max: 1,
        constants: {
          CHECK_POLL_INTERVAL_MS: 1,
          CHECK_POLL_MAX_ATTEMPTS: 1,
          REVIEW_BOT_WAIT_MS: 1,
          REVIEW_BOT_MAX_ATTEMPTS: 1,
          ADDRESS_PR_MAX_ROUNDS: 1,
          AGENT_IDLE_MS: 60_001,
          AGENT_MAX_MS: 60_001,
          LOCK_STALE_MS: 60_001,
        },
      });
      return { summary };
    },
  },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const parseArguments = (
  argv: readonly string[],
): { mode: 'list' | 'all' | 'scenario'; scenarioName?: string } => {
  if (argv.includes('--list')) return { mode: 'list' };
  if (argv.includes('--all')) return { mode: 'all' };
  const index = argv.indexOf('--scenario');
  if (index >= 0 && argv[index + 1]) return { mode: 'scenario', scenarioName: argv[index + 1]! };
  throw new Error('usage: bun scripts/smoke-pipeline.ts (--list | --all | --scenario <name>)');
};

const listScenarios = (): void => {
  for (const scenario of scenarios) {
    process.stdout.write(
      `${scenario.name.padEnd(16)} introducedIn=${scenario.introducedInWorkstream} ` +
        `assertsBehaviorFrom=${scenario.assertsBehaviorFrom}\n` +
        `${' '.repeat(16)}${scenario.description}\n`,
    );
  }
};

const initializeGit = async (directory: string): Promise<void> => {
  const proc = Bun.spawn(['git', 'init', '--quiet'], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git init failed: ${await new Response(proc.stderr).text()}`);
  }
};

// eslint-disable-next-line complexity
const runScenario = async (scenario: Scenario): Promise<{ pass: boolean; reason?: string }> => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'scrumlord-smoke-'));
  await initializeGit(projectRoot);
  const store = await createTaskStore({ cwd: projectRoot });
  const stderrLines: string[] = [];
  const appendStderr = (line: string): void => {
    stderrLines.push(line);
  };
  let outcome: ScenarioOutcome | null = null;
  try {
    let actualExitCode: number;
    try {
      outcome = await scenario.run({ store, appendStderr });
      actualExitCode = outcome.summary.exitCode;
    } catch (error) {
      return {
        pass: false,
        reason: `pipeline threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (actualExitCode !== scenario.expectedExitCode) {
      return {
        pass: false,
        reason:
          `exit code mismatch: expected ${scenario.expectedExitCode}, got ${actualExitCode}\n` +
          `--- stderr ---\n${stderrLines.join('')}--- end stderr ---`,
      };
    }
    const joinedStderr = stderrLines.join('');
    for (const needle of scenario.expectedStderrSubstrings) {
      if (!joinedStderr.includes(needle)) {
        return {
          pass: false,
          reason:
            `stderr did not contain expected substring ${JSON.stringify(needle)}\n` +
            (process.env['SMOKE_DEBUG']
              ? `--- stderr ---\n${joinedStderr}--- end stderr ---`
              : '(set SMOKE_DEBUG=1 to dump stderr)'),
        };
      }
    }
    if (scenario.storeAssertions) {
      try {
        await scenario.storeAssertions(store);
      } catch (error) {
        return {
          pass: false,
          reason: `store assertion failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (scenario.customAssertions && outcome) {
      try {
        await scenario.customAssertions(outcome);
      } catch (error) {
        return {
          pass: false,
          reason: `custom assertion failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    return { pass: true };
  } finally {
    store.close();
    await rm(projectRoot, { force: true, recursive: true });
  }
};

const main = async (): Promise<void> => {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode === 'list') {
    listScenarios();
    return;
  }
  const selected = args.mode === 'all' ? [...scenarios] : findScenario(args.scenarioName!);
  let failures = 0;
  for (const scenario of selected) {
    process.stderr.write(`▶ ${scenario.name}…\n`);
    const result = await runScenario(scenario);
    if (result.pass) {
      process.stderr.write(`  ✓ ${scenario.name}\n`);
    } else {
      failures += 1;
      process.stderr.write(`  ✗ ${scenario.name}: ${result.reason ?? 'unknown failure'}\n`);
    }
  }
  process.stderr.write(`\n${selected.length - failures}/${selected.length} scenarios passed\n`);
  process.exit(failures === 0 ? 0 : 1);
};

const findScenario = (name: string): readonly Scenario[] => {
  const match = scenarios.find((scenario) => scenario.name === name);
  if (!match) {
    const known = scenarios.map((s) => s.name).join(', ');
    throw new Error(`unknown scenario "${name}". Known: ${known}`);
  }
  return [match];
};

await main();
