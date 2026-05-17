import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskReference, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const referenceId = (reference: TaskReference): string => {
  return typeof reference === 'string' ? reference : reference.id;
};

const stripAnsi = (value: string): string => {
  const escape = String.fromCharCode(27);
  return value.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '');
};

const optionalCall = (condition: boolean, value: string): string[] => {
  return condition ? [value] : [];
};

const updateCallDescriptions = (
  id: string,
  input: Parameters<TaskStore['update']>[1],
): string[] => [
  `update:${id}:${input.title ?? ''}:${input.priority ?? ''}:${input.branch ?? ''}`,
  ...optionalCall(input.status !== undefined, `updateStatus:${id}:${input.status ?? ''}`),
  ...optionalCall('branch' in input && input.branch === null, `clearBranch:${id}`),
  ...optionalCall(
    'provider' in input || 'session' in input,
    `updateSession:${id}:${input.provider ?? ''}:${input.session ?? ''}`,
  ),
];

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create(input) {
    calls.push(`create:${input.title}:${input.status}:${input.priority}:${input.branch ?? ''}`);
    return task('created');
  },
  update(id, input) {
    calls.push(...updateCallDescriptions(id, input));
    return task(id);
  },
  delete(id, options) {
    calls.push(`delete:${id}${options?.hard ? ':hard' : ''}`);
    return options?.hard ? null : task(id);
  },
  getTask(id) {
    calls.push(`get:${id}`);
    return task(id);
  },
  list(options) {
    calls.push(`list:${options?.includeInactive ? 'all' : 'active'}`);
    return [task('list')];
  },
  available() {
    calls.push('available');
    return [task('available')];
  },
  blocked() {
    calls.push('blocked');
    return [task('blocked')];
  },
  completed() {
    calls.push('completed');
    return [task('completed')];
  },
  withTag(tag) {
    calls.push(`withTag:${tag}`);
    return [task('with-tag')];
  },
  withAllTags(...tags) {
    calls.push(`withAllTags:${tags.join(',')}`);
    return [task('with-all-tags')];
  },
  withAnyTag(...tags) {
    calls.push(`withAnyTag:${tags.join(',')}`);
    return [task('with-any-tag')];
  },
  withBranch(branch) {
    calls.push(`withBranch:${branch}`);
    return [task('with-branch')];
  },
  withSession(provider, session) {
    calls.push(`withSession:${provider}:${session}`);
    return [task('with-session')];
  },
  blockedBy(id) {
    calls.push(`blockedBy:${referenceId(id)}`);
    return [task('blocked-by')];
  },
  blocking(id) {
    calls.push(`blocking:${referenceId(id)}`);
    return [task('blocking')];
  },
  withPriority(priority) {
    calls.push(`withPriority:${priority}`);
    return [task('priority')];
  },
  next() {
    calls.push('next');
    return task('next');
  },
  remaining() {
    calls.push('remaining');
    return 3;
  },
  cleanup(days, options) {
    calls.push(`cleanup:${days}${options?.hard ? ':hard' : ''}`);
    return { deleted: days ?? 0 };
  },
  previewCleanup(days) {
    calls.push(`previewCleanup:${days}`);
    return { wouldDelete: [] };
  },
  inProgress() {
    calls.push('inProgress');
    return [];
  },
  recoverOrphan() {
    calls.push('recoverOrphan');
    return {
      outcome: 'stale-state',
      actual: { status: 'in-progress', branch: null, session: null, deleted: false },
    } as const;
  },
  countInProgress() {
    calls.push('countInProgress');
    return 0;
  },
  countBranched() {
    calls.push('countBranched');
    return 0;
  },
  addTag(id, tag) {
    calls.push(`addTag:${id}:${tag}`);
    return task(id);
  },
  removeTag(id, tag) {
    calls.push(`removeTag:${id}:${tag}`);
    return task(id);
  },
  addBlocker(id, blockedBy) {
    calls.push(`addBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  removeBlocker(id, blockedBy) {
    calls.push(`removeBlocker:${id}:${referenceId(blockedBy)}`);
    return task(id);
  },
  setPlan(id, plan) {
    calls.push(`setPlan:${id}:${plan ?? ''}`);
    return task(id);
  },
  setSession(id, provider, session) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id);
  },
  taskSession(id) {
    calls.push(`taskSession:${id}`);
    const item = task(id);
    return {
      taskId: item.id,
      provider: item.provider,
      session: item.session,
      branch: item.branch,
      plan: item.plan,
    };
  },
  allIds() {
    calls.push('allIds');
    return [];
  },
  allTags() {
    calls.push('allTags');
    return [];
  },
  ...emptyProgressStoreMethods,
  close() {
    calls.push('close');
  },
});

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

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
      ['blocking', 'task-id'],
      ['priority', '3'],
      ['with-priority', '2'],
      ['session', 'task-id'],
      ['next'],
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
      ['add-tag', 'task-id', 'frontend'],
      ['remove-tag', 'task-id', 'frontend'],
      ['add-blocker', 'task-id', 'blocker-id'],
      ['remove-blocker', 'task-id', 'blocker-id'],
    ];

    for (const command of commands) {
      const result = await runTasksCli(command, options);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }

    // Cleanup returns text, not JSON
    const cleanupResult = await runTasksCli(['cleanup', '12'], options);
    expect(cleanupResult.exitCode).toBe(0);
    expect(cleanupResult.stderr).toBe('');
    expect(cleanupResult.stdout).toContain('Aged cleanup:');

    expect(calls).toContain('create:New Task:draft:3:feature/task-graph');
    expect(calls).toContain('update:task-id:Renamed:2:feature/task-graph');
    expect(calls).toContain('update:task-id:::feature/task-graph');
    expect(calls).toContain('clearBranch:task-id');
    // update --plan goes through store.update(); clear plan goes through store.setPlan(null)
    expect(calls.some((c) => c.startsWith('update:task-id:::'))).toBe(true);
    expect(calls).toContain('setPlan:task-id:');
    expect(calls).toContain('updateSession:task-id::');
    expect(calls).toContain('list:active');
    expect(calls).toContain('list:all');
    expect(calls).toContain('withBranch:feature/task-graph');
    // +1 for the cleanup command tested separately
    expect(calls.filter((call) => call === 'close')).toHaveLength(commands.length + 1);
  });

  it('renders help for the main CLI and subcommands', async () => {
    const mainHelp = await runTasksCli(['--help'], { colorMode: 'always' });
    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stderr).toBe('');
    expect(mainHelp.stdout).toContain('\u001b[');
    expect(stripAnsi(mainHelp.stdout)).toContain('tasks <command> [options]');
    expect(mainHelp.stdout).toContain('setup');

    const createHelp = await runTasksCli(['create', '--help'], { colorMode: 'never' });
    expect(createHelp.stdout).toContain('tasks create --title <title> [options]');
    expect(createHelp.stdout).toContain('--title');
    expect(createHelp.stdout).not.toContain('\u001b[');

    const availableHelp = await runTasksCli(['help', 'available'], { colorMode: 'never' });
    expect(availableHelp.stdout).toContain('tasks available');
    expect(availableHelp.stdout).toContain('--planned');
    expect(availableHelp.stdout).toContain('--count');

    const listHelp = await runTasksCli(['list', '--help'], { colorMode: 'never' });
    expect(listHelp.stdout).toContain('tasks list [--all]');
    expect(listHelp.stdout).toContain('--unplanned');

    const repositoryHelp = await runTasksCli(['repository', '--help'], { colorMode: 'never' });
    expect(repositoryHelp.stdout).toContain('tasks repository [--url] [--json]');
    expect(repositoryHelp.stdout).toContain('full GitHub repository URL');

    const overviewHelp = await runTasksCli(['overview', '--help'], { colorMode: 'never' });
    expect(overviewHelp.stdout).toContain('tasks overview');
    expect(overviewHelp.stdout).toContain('unresolved review comment counts');

    const progressHelp = await runTasksCli(['progress', '--help'], { colorMode: 'never' });
    expect(progressHelp.stdout).toContain('tasks progress');
    expect(progressHelp.stdout).toContain('list');

    const clearHelp = await runTasksCli(['clear', '--help'], { colorMode: 'never' });
    expect(clearHelp.stdout).toContain('tasks clear');

    const pullRequestHelp = await runTasksCli(['pr', '--help'], {
      colorMode: 'never',
    });
    expect(pullRequestHelp.stdout).toContain('tasks pr');
    expect(pullRequestHelp.stdout).toContain('readyToMerge');

    const setupStatusHelp = await runTasksCli(['setup', 'status', '--help'], {
      colorMode: 'never',
    });
    expect(setupStatusHelp.stdout).toContain('tasks setup status');
    expect(setupStatusHelp.stdout).toContain('tasksExecutable');

    const setupHelp = await runTasksCli(['setup', '--help'], {
      colorMode: 'never',
    });
    expect(setupHelp.stdout).toContain('tasks setup');
    expect(setupHelp.stdout).toContain('--subagents');
    expect(setupHelp.stdout).toContain('--prompt');
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

    const missingCommandResult = await runTasksCli([], { createStore });
    expect(JSON.parse(missingCommandResult.stderr).error.code).toBe('missing_command');

    const unknownCommandResult = await runTasksCli(['unknown'], { createStore });
    expect(JSON.parse(unknownCommandResult.stderr).error.code).toBe('unknown_command');

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

    const invalidCleanupResult = await runTasksCli(['cleanup', '1.5'], { createStore });
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

  it('rejects empty comma-delimited tag lists before opening a store', async () => {
    let createStoreCalls = 0;
    const result = await runTasksCli(['create', '--title', 'Task', '--tags', ','], {
      createStore: async () => {
        createStoreCalls += 1;
        return fakeStore([]);
      },
    });

    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'invalid_tag',
      message: 'Tags cannot be empty.',
    });
    expect(createStoreCalls).toBe(0);
  });
});
