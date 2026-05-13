#!/usr/bin/env bun
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

type ScenarioName = 'green' | 'empty' | 'stuck-stderr';

type Scenario = {
  name: ScenarioName;
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
};

type ScenarioContext = {
  store: TaskStore;
  appendStderr: (line: string) => void;
};

type ScenarioOutcome = {
  summary: PipelineSummary;
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
};

const ghApiEndpoint = (joined: string, suffix: string): boolean => {
  return joined.includes(`repos/owner/repo/${suffix}`);
};

const mockRunner = (options: MockRunnerOptions): CommandRunner => {
  const { mode } = options;
  // eslint-disable-next-line complexity
  return async (command) => {
    const joined = command.join(' ');
    const headParam = extractFParam(command, 'head');
    const branchFromHead = headParam?.split(':', 2)[1] ?? 'task/smoke';
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
    if (joined.startsWith('gh repo view')) {
      // gh repo view --json nameWithOwner --jq .nameWithOwner → bare string.
      return ok('owner/repo\n');
    }
    // `gh api …/repos/owner/repo/pulls -F head=owner:<branch> …` (list query).
    if (joined.startsWith('gh api') && commandHasEndpoint(command, 'pulls')) {
      if (mode === 'no-tasks') return ghIncludeBody([]);
      return ghIncludeBody([buildMergedPullRequest(branchFromHead)]);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42/comments')) {
      return ghIncludeBody([]);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42/reviews')) {
      return ghIncludeBody([]);
    }
    if (joined.startsWith('gh api') && ghApiEndpoint(joined, 'pulls/42')) {
      return ghIncludeBody(buildMergedPullRequest(branchFromHead));
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

const buildMergedPullRequest = (branch: string) => ({
  number: 42,
  state: 'closed',
  url: 'https://github.test/pull/42',
  title: 'smoke task',
  head: { ref: branch, sha: 'sha-42' },
  base: { ref: 'main' },
  merged_at: '2026-05-13T15:00:00Z',
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
    return { exitCode, stuck: null, killed: null };
  };
  return { spawn, invocations };
};

const stuckStderrSpawnAgent = (): SpawnAgent => {
  return async (_invocation, _caps, controls) => {
    controls.stderr('STUCK: stuck on flaky test\n');
    return { exitCode: 1, stuck: 'stuck on flaky test', killed: null };
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
    assertsBehaviorFrom: 'current',
    description: 'one ready task ships end-to-end against happy mock gh + git',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['claimed', 'shipped'],
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
        runner: mockRunner({ mode: 'happy', currentBranch }),
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
    assertsBehaviorFrom: 'current',
    description: 'empty queue exits 0 with current "queue empty" log line',
    expectedExitCode: 0,
    expectedStderrSubstrings: ['queue empty'],
    run: async ({ store, appendStderr }) => {
      const summary = await runPipeline(store, {
        provider: 'claude',
        mode: 'drain',
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

const runScenario = async (scenario: Scenario): Promise<{ pass: boolean; reason?: string }> => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'scrumlord-smoke-'));
  await initializeGit(projectRoot);
  const store = await createTaskStore({ cwd: projectRoot });
  const stderrLines: string[] = [];
  const appendStderr = (line: string): void => {
    stderrLines.push(line);
  };
  try {
    let actualExitCode: number;
    try {
      const { summary } = await scenario.run({ store, appendStderr });
      actualExitCode = summary.exitCode;
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
          reason: `stderr did not contain expected substring ${JSON.stringify(needle)}`,
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
