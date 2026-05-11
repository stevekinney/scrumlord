import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import type { Task, TaskReference, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};

const task = (id: string): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  tags: [],
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  archived: false,
  deleted: false,
});

const referenceId = (reference: TaskReference): string => {
  return typeof reference === 'string' ? reference : reference.id;
};

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create(input) {
    calls.push(`create:${input.title}:${input.status}:${input.priority}:${input.branch ?? ''}`);
    return task('created');
  },
  update(id, input) {
    calls.push(`update:${id}:${input.title ?? ''}:${input.priority ?? ''}:${input.branch ?? ''}`);
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
      ['next'],
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
      ],
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

  it('handles setup and pull request boundary commands', async () => {
    const root = await workspaceRoot();
    const github = {
      async pullRequestUrl(projectRoot: string, open: boolean) {
        return { projectRoot, open, url: 'https://github.test/pull/1' };
      },
      async pullRequestStatus(projectRoot: string) {
        return { projectRoot, readyToMerge: true };
      },
      async unresolvedReviewComments(projectRoot: string) {
        return [{ projectRoot, body: 'Please fix this.' }];
      },
      async continuousIntegrationStatus(projectRoot: string) {
        return [{ projectRoot, state: 'SUCCESS' }];
      },
    };

    const pullRequestResult = await runTasksCli(['pr', '--open'], { cwd: root, github });
    expect(JSON.parse(pullRequestResult.stdout)).toEqual({
      projectRoot: root,
      open: true,
      url: 'https://github.test/pull/1',
    });
    const pullRequestStatusResult = await runTasksCli(['pr', 'status'], { cwd: root, github });
    expect(JSON.parse(pullRequestStatusResult.stdout)).toEqual({
      projectRoot: root,
      readyToMerge: true,
    });
    const commentsResult = await runTasksCli(['comments'], { cwd: root, github });
    expect(JSON.parse(commentsResult.stdout)).toEqual([
      { projectRoot: root, body: 'Please fix this.' },
    ]);
    const continuousIntegrationResult = await runTasksCli(['ci'], { cwd: root, github });
    expect(JSON.parse(continuousIntegrationResult.stdout)).toEqual([
      { projectRoot: root, state: 'SUCCESS' },
    ]);

    const setupResult = await runTasksCli(['setup-skills', '--all'], { cwd: root });
    expect(JSON.parse(setupResult.stdout).map((entry: { target: string }) => entry.target)).toEqual(
      ['codex', 'claude', 'cursor'],
    );

    const setupGitHooksResult = await runTasksCli(['setup-git-hooks'], {
      cwd: root,
      setupGitHooks: async (projectRoot: string) => ({ projectRoot, changed: true }),
    });
    expect(JSON.parse(setupGitHooksResult.stdout)).toEqual({ projectRoot: root, changed: true });
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

    const invalidSkillRoot = await workspaceRoot();
    const invalidSkillResult = await runTasksCli(['setup-skills', 'vim'], {
      cwd: invalidSkillRoot,
    });
    expect(JSON.parse(invalidSkillResult.stderr).error.code).toBe('invalid_skill_target');
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
      message: 'get expects exactly 1 argument.',
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
