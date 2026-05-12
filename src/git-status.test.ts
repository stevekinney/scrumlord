import { describe, expect, it } from 'bun:test';
import type { CommandRunner } from './command-runner';
import { ScrumlordError } from './errors';
import { syncGitStatus, worktreeForBranch } from './git-status';
import type { Task, TaskStatus, TaskStore, UpdateTaskInput } from './types';

const task = (id: string, status: TaskStatus = 'ready', overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status,
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: 'feature/task-graph',
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

const unexpectedStoreMethod = (): never => {
  throw new Error('Unexpected TaskStore method call.');
};

const store = (
  tasks: Task[],
  updates: { id: string; input: UpdateTaskInput }[] = [],
): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create() {
    return unexpectedStoreMethod();
  },
  withBranch(branch: string) {
    return tasks.filter((item) => item.branch === branch);
  },
  withSession() {
    return unexpectedStoreMethod();
  },
  update(id: string, input: UpdateTaskInput) {
    updates.push({ id, input });
    return task(id, input.status ?? 'ready');
  },
  delete() {
    return unexpectedStoreMethod();
  },
  archive() {
    return unexpectedStoreMethod();
  },
  restore() {
    return unexpectedStoreMethod();
  },
  getTask() {
    return unexpectedStoreMethod();
  },
  available() {
    return unexpectedStoreMethod();
  },
  list() {
    return unexpectedStoreMethod();
  },
  blocked() {
    return unexpectedStoreMethod();
  },
  completed() {
    return unexpectedStoreMethod();
  },
  withTag() {
    return unexpectedStoreMethod();
  },
  withAllTags() {
    return unexpectedStoreMethod();
  },
  withAnyTag() {
    return unexpectedStoreMethod();
  },
  blockedBy() {
    return unexpectedStoreMethod();
  },
  blocking() {
    return unexpectedStoreMethod();
  },
  withPriority() {
    return unexpectedStoreMethod();
  },
  next() {
    return unexpectedStoreMethod();
  },
  remaining() {
    return unexpectedStoreMethod();
  },
  cleanup() {
    return unexpectedStoreMethod();
  },
  addTag() {
    return unexpectedStoreMethod();
  },
  removeTag() {
    return unexpectedStoreMethod();
  },
  setParent() {
    return unexpectedStoreMethod();
  },
  clearParent() {
    return unexpectedStoreMethod();
  },
  addBlocker() {
    return unexpectedStoreMethod();
  },
  removeBlocker() {
    return unexpectedStoreMethod();
  },
  setPlan() {
    return unexpectedStoreMethod();
  },
  setSession() {
    return unexpectedStoreMethod();
  },
  taskSession() {
    return unexpectedStoreMethod();
  },
  progress() {
    return unexpectedStoreMethod();
  },
  addProgress() {
    return unexpectedStoreMethod();
  },
  close() {},
});

const matchingWorktreeRunner: CommandRunner = async () => ({
  exitCode: 0,
  stdout:
    'worktree /project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /worktrees/task-graph\nHEAD def456\nbranch refs/heads/feature/task-graph\n',
  stderr: '',
});

const failingWorktreeRunner: CommandRunner = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: 'nope',
});

const missingBranchRunner: CommandRunner = async () => ({
  exitCode: 1,
  stdout: '',
  stderr: 'no branch',
});

const gitRunner = (ghOutput: { exitCode: number; stdout: string }): CommandRunner => {
  return async (command) => {
    if (command.join(' ') === 'git branch --show-current') {
      return { exitCode: 0, stdout: 'feature/task-graph\n', stderr: '' };
    }
    if (command.join(' ') === 'git worktree list --porcelain') {
      return {
        exitCode: 0,
        stdout:
          'worktree /project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /worktrees/task-graph\nHEAD def456\nbranch refs/heads/feature/task-graph\n',
        stderr: '',
      };
    }
    if (command[0] === 'gh') return { ...ghOutput, stderr: '' };
    return { exitCode: 127, stdout: '', stderr: 'unexpected command' };
  };
};

const throwingGitHubRunner: CommandRunner = async (command) => {
  if (command.join(' ') === 'git branch --show-current') {
    return { exitCode: 0, stdout: 'feature/task-graph\n', stderr: '' };
  }
  if (command.join(' ') === 'git worktree list --porcelain') {
    return {
      exitCode: 0,
      stdout:
        'worktree /project\nHEAD abc123\nbranch refs/heads/main\n\nworktree /worktrees/task-graph\nHEAD def456\nbranch refs/heads/feature/task-graph\n',
      stderr: '',
    };
  }
  throw new Error('Executable not found in PATH: gh');
};

describe('worktreeForBranch', () => {
  it('derives the worktree from Git branch metadata', async () => {
    expect(await worktreeForBranch('/project', 'feature/task-graph', matchingWorktreeRunner)).toBe(
      '/worktrees/task-graph',
    );
    expect(await worktreeForBranch('/project', 'feature/other', matchingWorktreeRunner)).toBe(
      '/project',
    );
  });

  it('falls back to the project root when Git worktree lookup fails', async () => {
    expect(await worktreeForBranch('/project', 'feature/task-graph', failingWorktreeRunner)).toBe(
      '/project',
    );
  });
});

describe('syncGitStatus', () => {
  it('moves draft and ready branch tasks to in-progress when work begins', async () => {
    const updates: { id: string; input: UpdateTaskInput }[] = [];
    const result = await syncGitStatus(
      store(
        [
          task('draft', 'draft'),
          task('ready'),
          task('already-started', 'in-progress'),
          task('archived', 'ready', { archived: true }),
          task('completed', 'completed'),
          task('deleted', 'ready', { deleted: true }),
          task('other-branch', 'ready', { branch: 'feature/other' }),
        ],
        updates,
      ),
      { runner: gitRunner({ exitCode: 1, stdout: '' }) },
    );

    expect(result).toEqual({
      branch: 'feature/task-graph',
      worktree: '/worktrees/task-graph',
      ghAvailable: false,
      pullRequest: null,
      updated: [
        { id: 'draft', from: 'draft', to: 'in-progress' },
        { id: 'ready', from: 'ready', to: 'in-progress' },
      ],
    });
    expect(updates).toEqual([
      { id: 'draft', input: { status: 'in-progress' } },
      { id: 'ready', input: { status: 'in-progress' } },
    ]);
  });

  it('moves branch tasks into review when a pull request is open', async () => {
    const updates: { id: string; input: UpdateTaskInput }[] = [];
    const result = await syncGitStatus(
      store(
        [
          task('draft', 'draft'),
          task('ready'),
          task('started', 'in-progress'),
          task('review', 'in-review'),
        ],
        updates,
      ),
      {
        runner: gitRunner({
          exitCode: 0,
          stdout:
            '[null,{"number":12,"state":"OPEN","baseRefName":"main","mergedAt":null,"url":"https://github.test/pull/12"}]',
        }),
      },
    );

    expect(result.pullRequest).toMatchObject({ number: 12, state: 'OPEN' });
    expect(result.updated).toEqual([
      { id: 'draft', from: 'draft', to: 'in-review' },
      { id: 'ready', from: 'ready', to: 'in-review' },
      { id: 'started', from: 'in-progress', to: 'in-review' },
    ]);
    expect(updates).toEqual([
      { id: 'draft', input: { status: 'in-review' } },
      { id: 'ready', input: { status: 'in-review' } },
      { id: 'started', input: { status: 'in-review' } },
    ]);
  });

  it('marks branch tasks completed after their pull request merges into main', async () => {
    const updates: { id: string; input: UpdateTaskInput }[] = [];
    const result = await syncGitStatus(store([task('review', 'in-review')], updates), {
      runner: gitRunner({
        exitCode: 0,
        stdout:
          '[{"number":12,"state":"MERGED","baseRefName":"main","mergedAt":"2026-05-11T12:00:00Z","url":"https://github.test/pull/12"}]',
      }),
    });

    expect(result.updated).toEqual([{ id: 'review', from: 'in-review', to: 'completed' }]);
    expect(updates).toEqual([{ id: 'review', input: { status: 'completed' } }]);
  });

  it('falls back to in-progress when gh returns no matching pull request payload', async () => {
    const updates: { id: string; input: UpdateTaskInput }[] = [];
    const result = await syncGitStatus(store([task('ready')], updates), {
      runner: gitRunner({ exitCode: 0, stdout: '[{"state":"OPEN"}]' }),
    });

    expect(result.ghAvailable).toBe(true);
    expect(result.pullRequest).toBeNull();
    expect(result.updated).toEqual([{ id: 'ready', from: 'ready', to: 'in-progress' }]);
  });

  it('treats malformed gh JSON as unavailable during hook synchronization', async () => {
    const result = await syncGitStatus(store([task('ready')]), {
      runner: gitRunner({ exitCode: 0, stdout: 'not-json' }),
    });

    expect(result.ghAvailable).toBe(false);
    expect(result.pullRequest).toBeNull();
    expect(result.updated).toEqual([{ id: 'ready', from: 'ready', to: 'in-progress' }]);
  });

  it('treats a missing gh executable as unavailable during hook synchronization', async () => {
    const result = await syncGitStatus(store([task('ready')]), {
      runner: throwingGitHubRunner,
    });

    expect(result.ghAvailable).toBe(false);
    expect(result.pullRequest).toBeNull();
    expect(result.updated).toEqual([{ id: 'ready', from: 'ready', to: 'in-progress' }]);
  });

  it('fails when the current Git branch cannot be resolved', async () => {
    try {
      await syncGitStatus(store([]), { runner: missingBranchRunner });
      throw new Error('Expected syncGitStatus to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
    }
  });
});
