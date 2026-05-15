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
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  archived: false,
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
  delete(id) {
    calls.push(`delete:${id}`);
    return task(id);
  },
  archive(id) {
    calls.push(`archive:${id}`);
    return task(id);
  },
  restore(id) {
    calls.push(`restore:${id}`);
    return task(id);
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
  cleanup(days) {
    calls.push(`cleanup:${days}`);
    return { deleted: days };
  },
  addTag(id, tag) {
    calls.push(`addTag:${id}:${tag}`);
    return task(id);
  },
  removeTag(id, tag) {
    calls.push(`removeTag:${id}:${tag}`);
    return task(id);
  },
  setParent(id, parent) {
    calls.push(`setParent:${id}:${referenceId(parent)}`);
    return task(id);
  },
  clearParent(id) {
    calls.push(`clearParent:${id}`);
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
      ['with-tag', 'frontend'],
      ['with-all-tags', 'frontend', 'backend'],
      ['with-any-tag', 'frontend', 'backend'],
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
        '--archived',
        'false',
        '--deleted',
        'false',
        '--parent',
        'parent-id',
        '--branch',
        'feature/task-graph',
        '--plan',
        'tmp/tasks/task-id/PLAN.md',
        '--provider',
        'claude',
        '--session',
        'claude-session',
      ],
      ['set-status', 'task-id', 'completed'],
      ['set-branch', 'task-id', 'feature/task-graph'],
      ['clear-branch', 'task-id'],
      ['set-plan', 'task-id', 'tmp/tasks/task-id/PLAN.md'],
      ['clear-plan', 'task-id'],
      ['set-session', 'task-id', 'codex', 'codex-session'],
      ['clear-session', 'task-id'],
      ['delete', 'task-id'],
      ['archive', 'task-id'],
      ['restore', 'task-id'],
      ['add-tag', 'task-id', 'frontend'],
      ['remove-tag', 'task-id', 'frontend'],
      ['set-parent', 'task-id', 'parent-id'],
      ['clear-parent', 'task-id'],
      ['add-blocker', 'task-id', 'blocker-id'],
      ['remove-blocker', 'task-id', 'blocker-id'],
      ['cleanup', '12'],
      ['sync-git-status'],
    ];

    for (const command of commands) {
      const result = await runTasksCli(command, {
        ...options,
        syncGitStatus: async () => ({ branch: 'feature/task-graph' }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }

    expect(calls).toContain('create:New Task:draft:3:feature/task-graph');
    expect(calls).toContain('update:task-id:Renamed:2:feature/task-graph');
    expect(calls).toContain('updateStatus:task-id:completed');
    expect(calls).toContain('update:task-id:::feature/task-graph');
    expect(calls).toContain('clearBranch:task-id');
    expect(calls).toContain('setPlan:task-id:tmp/tasks/task-id/PLAN.md');
    expect(calls).toContain('setPlan:task-id:');
    expect(calls).toContain('setSession:task-id:codex:codex-session');
    expect(calls).toContain('updateSession:task-id::');
    expect(calls).toContain('list:active');
    expect(calls).toContain('list:all');
    expect(calls).toContain('withBranch:feature/task-graph');
    expect(calls.filter((call) => call === 'close')).toHaveLength(commands.length);
  });

  it('supports quiet Git status synchronization for hooks', async () => {
    const calls: string[] = [];
    const result = await runTasksCli(['sync-git-status', '--quiet'], {
      createStore: async () => fakeStore(calls),
      syncGitStatus: async () => {
        calls.push('syncGitStatus');
        return { updated: [{ id: 'task-id', from: 'ready', to: 'in-progress' }] };
      },
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(calls).toEqual(['syncGitStatus', 'close']);
  });

  it('renders help for the main CLI and subcommands', async () => {
    const mainHelp = await runTasksCli(['--help'], { colorMode: 'always' });
    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stderr).toBe('');
    expect(mainHelp.stdout).toContain('\u001b[');
    expect(stripAnsi(mainHelp.stdout)).toContain('tasks <command> [options]');
    expect(mainHelp.stdout).toContain('setup-git-hooks');
    expect(mainHelp.stdout).toContain('setup-subagents');

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

    const setStatusHelp = await runTasksCli(['set-status', '--help'], { colorMode: 'never' });
    expect(setStatusHelp.stdout).toContain('tasks set-status [task-id] <status>');
    expect(setStatusHelp.stdout).toContain('draft, ready, in-progress, in-review, or completed');

    const pullRequestStatusHelp = await runTasksCli(['pr', 'status', '--help'], {
      colorMode: 'never',
    });
    expect(pullRequestStatusHelp.stdout).toContain('tasks pr status');
    expect(pullRequestStatusHelp.stdout).toContain('readyToMerge');

    const setupStatusHelp = await runTasksCli(['setup', 'status', '--help'], {
      colorMode: 'never',
    });
    expect(setupStatusHelp.stdout).toContain('tasks setup status');
    expect(setupStatusHelp.stdout).toContain('tasksExecutable');

    const setupSubagentsHelp = await runTasksCli(['setup-subagents', '--help'], {
      colorMode: 'never',
    });
    expect(setupSubagentsHelp.stdout).toContain('tasks setup-subagents');
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

    const unknownPullRequestCommandResult = await runTasksCli(['pr', 'checks'], { createStore });
    expect(JSON.parse(unknownPullRequestCommandResult.stderr).error).toEqual({
      code: 'unknown_command',
      message: 'Unknown pull request command: pr checks.',
    });

    const missingTitleResult = await runTasksCli(['create'], { createStore });
    expect(JSON.parse(missingTitleResult.stderr).error.code).toBe('missing_title');

    const invalidStatusResult = await runTasksCli(
      ['create', '--title', 'Task', '--status', 'later'],
      {
        createStore,
      },
    );
    expect(JSON.parse(invalidStatusResult.stderr).error.code).toBe('invalid_status');

    const invalidSetStatusResult = await runTasksCli(['set-status', 'task-id', 'later'], {
      createStore,
    });
    expect(JSON.parse(invalidSetStatusResult.stderr).error.code).toBe('invalid_status');

    const invalidSetSessionResult = await runTasksCli(
      ['set-session', 'task-id', 'vim', 'session-id'],
      { createStore },
    );
    expect(JSON.parse(invalidSetSessionResult.stderr).error.code).toBe('invalid_provider');

    const invalidSkillRoot = await workspaceRoot();
    const invalidSkillResult = await runTasksCli(['setup-skills', 'vim'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(invalidSkillResult.stderr).error.code).toBe('invalid_skill_target');

    const invalidSubagentResult = await runTasksCli(['setup-subagents', 'vim'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(invalidSubagentResult.stderr).error.code).toBe('invalid_provider');

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

    const setupSubagentScopeConflict = await runTasksCli(
      ['setup-subagents', '--local', '--global'],
      {
        cwd: invalidSkillRoot,
      },
    );
    expect(JSON.parse(setupSubagentScopeConflict.stderr).error.code).toBe('setup_scope_conflict');
    expect(createStoreCalls).toBe(0);
  });

  it('rejects missing flag values, unknown flags, and unexpected positional arguments', async () => {
    const createStore = async () => fakeStore([]);

    const missingFlagValueResult = await runTasksCli(['create', '--title'], { createStore });
    expect(JSON.parse(missingFlagValueResult.stderr).error).toEqual({
      code: 'missing_flag_value',
      message: '--title requires a value.',
    });

    const unknownFlagResult = await runTasksCli(['available', '--json'], { createStore });
    expect(JSON.parse(unknownFlagResult.stderr).error).toEqual({
      code: 'unknown_flag',
      message: 'Unknown flag for available: --json.',
    });

    const unexpectedArgumentResult = await runTasksCli(['get', 'task-id', 'extra'], {
      createStore,
    });
    expect(JSON.parse(unexpectedArgumentResult.stderr).error).toEqual({
      code: 'unexpected_argument',
      message: 'get expects at most 1 argument.',
    });

    const missingVariadicArgumentResult = await runTasksCli(['with-all-tags'], { createStore });
    expect(JSON.parse(missingVariadicArgumentResult.stderr).error).toEqual({
      code: 'missing_argument',
      message: 'with-all-tags expects at least 1 argument.',
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
