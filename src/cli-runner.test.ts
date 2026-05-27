import { afterEach, describe, expect, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import { runTasksCli } from './cli-runner';
import {
  createTemporaryDirectory,
  createWorkspaceRoot,
  fakeStore,
} from './cli-runner-test-helpers';

const temporaryDirectories: string[] = [];

const temporaryDirectory = (): Promise<string> => createTemporaryDirectory(temporaryDirectories);
const workspaceRoot = (): Promise<string> => createWorkspaceRoot(temporaryDirectories);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('runTasksCli', () => {
  it('routes store commands and returns JSON', async () => {
    const calls: string[] = [];
    const options = { createStore: async () => fakeStore(calls) };
    const commands = [
      ['available'],
      ['list'],
      ['list', '--all'],
      ['blocked'],
      ['completed'],
      ['get', 'task-id'],
      ['tagged', 'frontend'],
      ['tagged', 'frontend', 'backend', '--all'],
      ['with-branch', 'feature/task-graph'],
      ['blocked-by', 'task-id'],
      ['blockers', 'task-id'],
      ['blocking', 'task-id'],
      ['priority', '3'],
      ['status', 'in-progress'],
      ['session', 'task-id'],
      ['peek'],
      ['remaining'],
      [
        'create',
        '--title',
        'New Task',
        '--description',
        'Body',
        '--priority',
        '3',
        '--draft',
        '--tag',
        'a,b',
        '--branch',
        'feature/task-graph',
        '--plan',
        'tmp/tasks/created/PLAN.md',
        '--provider',
        'codex',
        '--session',
        'codex-session',
      ],
      [
        'update',
        'task-id',
        '--title',
        'Renamed',
        '--status',
        'in-review',
        '--description',
        'Edited',
        '--priority',
        '2',
        '--start-date',
        '2026-05-11',
        '--due-date',
        '2026-05-12',
        '--deleted',
        'false',
        '--branch',
        'feature/task-graph',
        '--plan',
        'tmp/tasks/task-id/PLAN.md',
        '--provider',
        'claude',
        '--session',
        'claude-session',
      ],
      ['update', 'task-id', '--status', 'completed'],
      ['update', 'task-id', '--branch', 'feature/task-graph'],
      ['clear', 'branch', 'task-id'],
      ['update', 'task-id', '--plan', 'tmp/tasks/task-id/PLAN.md'],
      ['clear', 'plan', 'task-id'],
      ['update', 'task-id', '--provider', 'codex', '--session', 'codex-session'],
      ['clear', 'session', 'task-id'],
      ['delete', 'task-id'],
      ['blockers', 'add', 'task-id', 'blocker-id'],
      ['blockers', 'remove', 'task-id', 'blocker-id'],
    ];

    for (const command of commands) {
      const result = await runTasksCli(command, options);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }

    // Cleanup returns text, not JSON — now under the prompt namespace.
    const cleanupResult = await runTasksCli(['prompt', 'cleanup', '12'], options);
    expect(cleanupResult.exitCode).toBe(0);
    expect(cleanupResult.stderr).toBe('');
    expect(cleanupResult.stdout).toContain('Aged cleanup:');

    expect(calls).toContain('create:New Task:draft:3:feature/task-graph:desc=Body');
    expect(calls).toContain('update:task-id:Renamed:2:feature/task-graph');
    expect(calls).toContain('withStatus:in-progress');
    expect(calls).toContain('update:task-id:::feature/task-graph');
    expect(calls).toContain('clearBranch:task-id');
    // update --plan goes through store.update(); clear plan goes through store.setPlan(null)
    expect(calls.some((c) => c.startsWith('update:task-id:::'))).toBe(true);
    expect(calls).toContain('setPlan:task-id:');
    expect(calls).toContain('updateSession:task-id::');
    expect(calls).toContain('list:active');
    expect(calls).toContain('list:all');
    expect(calls).toContain('withBranch:feature/task-graph');
    expect(calls).toContain('get:task-id');
    expect(calls).toContain('addBlocker:task-id:blocker-id');
    expect(calls).toContain('removeBlocker:task-id:blocker-id');
    // +1 for the cleanup command tested separately
    expect(calls.filter((call) => call === 'close')).toHaveLength(commands.length + 1);
  });

  it('returns a JSON error for unknown help topics', async () => {
    const result = await runTasksCli(['help', 'unknown'], { colorMode: 'never' });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'unknown_help_topic',
      message: 'Unknown help topic: unknown.',
    });
  });

  it('returns JSON errors without creating stores for invalid input', async () => {
    let createStoreCalls = 0;
    const createStore = async () => {
      createStoreCalls += 1;
      return fakeStore([]);
    };

    const unknownCommandResult = await runTasksCli(['unknown'], { createStore });
    expect(JSON.parse(unknownCommandResult.stderr).error.code).toBe('unknown_command');

    const removedPriorityAliasResult = await runTasksCli(['with-priority', '3'], { createStore });
    expect(JSON.parse(removedPriorityAliasResult.stderr).error.code).toBe('unknown_command');

    const removedAddTagResult = await runTasksCli(['add-tag', 'task-id', 'frontend'], {
      createStore,
    });
    expect(JSON.parse(removedAddTagResult.stderr).error.code).toBe('unknown_command');

    const removedRemoveTagResult = await runTasksCli(['remove-tag', 'task-id', 'frontend'], {
      createStore,
    });
    expect(JSON.parse(removedRemoveTagResult.stderr).error.code).toBe('unknown_command');

    const removedAddBlockerResult = await runTasksCli(['add-blocker', 'task-id', 'blocker-id'], {
      createStore,
    });
    expect(JSON.parse(removedAddBlockerResult.stderr).error.code).toBe('unknown_command');

    const removedRemoveBlockerResult = await runTasksCli(
      ['remove-blocker', 'task-id', 'blocker-id'],
      {
        createStore,
      },
    );
    expect(JSON.parse(removedRemoveBlockerResult.stderr).error.code).toBe('unknown_command');

    const unknownPullRequestPositionalResult = await runTasksCli(['pr', 'checks'], { createStore });
    expect(JSON.parse(unknownPullRequestPositionalResult.stderr).error.code).toBe(
      'unexpected_argument',
    );

    const missingTitleResult = await runTasksCli(['create'], { createStore });
    expect(JSON.parse(missingTitleResult.stderr).error.code).toBe('missing_title');

    const invalidStatusResult = await runTasksCli(
      ['create', '--title', 'Task', '--status', 'later'],
      {
        createStore,
      },
    );
    expect(JSON.parse(invalidStatusResult.stderr).error.code).toBe('invalid_status');

    const updateStatusResult = await runTasksCli(['update', 'task-id', '--status', 'later'], {
      createStore,
    });
    expect(JSON.parse(updateStatusResult.stderr).error.code).toBe('invalid_status');

    const queryStatusResult = await runTasksCli(['status', 'later'], { createStore });
    expect(JSON.parse(queryStatusResult.stderr).error.code).toBe('invalid_status');

    const badProviderResult = await runTasksCli(
      ['progress', 'add', '--message', 'hi', '--provider', 'vim'],
      { createStore },
    );
    expect(JSON.parse(badProviderResult.stderr).error.code).toBe('invalid_provider');

    const invalidSkillRoot = await workspaceRoot();
    const invalidAgentResult = await runTasksCli(['setup', '--subagents', '--agent', 'vim'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(invalidAgentResult.stderr).error.code).toBe('invalid_agent');

    const invalidSetupCommandResult = await runTasksCli(['setup', 'wizard'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(invalidSetupCommandResult.stderr).error).toEqual({
      code: 'unknown_command',
      message: 'Unknown setup command: setup wizard.',
    });

    const setupProviderConflict = await runTasksCli(['setup', '--codex', '--claude'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(setupProviderConflict.stderr).error.code).toBe('setup_provider_conflict');

    const setupModeConflict = await runTasksCli(['setup', '--skills', '--subagents'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(setupModeConflict.stderr).error.code).toBe('setup_mode_conflict');

    const setupScopeConflict = await runTasksCli(['setup', '--subagents', '--project', '--user'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(setupScopeConflict.stderr).error.code).toBe('setup_scope_conflict');
    expect(createStoreCalls).toBe(0);
  });

  it('rejects missing flag values, unknown flags, and unexpected positional arguments', async () => {
    const createStore = async () => fakeStore([]);

    const missingFlagValueResult = await runTasksCli(['create', '--title'], { createStore });
    expect(JSON.parse(missingFlagValueResult.stderr).error).toEqual({
      code: 'missing_flag_value',
      message: '--title requires a value.',
    });

    const unknownFlagResult = await runTasksCli(['available', '--bogus'], { createStore });
    expect(JSON.parse(unknownFlagResult.stderr).error).toEqual({
      code: 'unknown_flag',
      message: 'Unknown flag for available: --bogus.',
    });

    const unexpectedArgumentResult = await runTasksCli(['get', 'task-id', 'extra'], {
      createStore,
    });
    expect(JSON.parse(unexpectedArgumentResult.stderr).error).toEqual({
      code: 'unexpected_argument',
      message: 'get expects exactly 1 argument.',
    });

    const missingVariadicArgumentResult = await runTasksCli(['tagged'], { createStore });
    expect(JSON.parse(missingVariadicArgumentResult.stderr).error).toEqual({
      code: 'missing_argument',
      message: 'tagged expects at least 1 argument.',
    });

    const invalidCleanupResult = await runTasksCli(['prompt', 'cleanup', '1.5'], { createStore });
    expect(JSON.parse(invalidCleanupResult.stderr).error).toEqual({
      code: 'invalid_cleanup_days',
      message: 'Cleanup days must be a non-negative integer.',
    });

    const conflictingPlanFiltersResult = await runTasksCli(
      ['available', '--planned', '--unplanned'],
      { createStore },
    );
    expect(JSON.parse(conflictingPlanFiltersResult.stderr).error).toEqual({
      code: 'plan_filter_conflict',
      message: 'Use either --planned or --unplanned, not both.',
    });
  });
});
