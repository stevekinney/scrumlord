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
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
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

describe('syncGitStatus --with-progress', () => {
  const progressStore = (
    tasks: Task[],
    progressEntries: { taskId: string; input: unknown }[] = [],
  ): TaskStore => ({
    ...store(tasks),
    addProgress(taskId: string, input: unknown) {
      progressEntries.push({ taskId, input });
      return {
        id: 'progress-id',
        taskId,
        message: (input as { message: string }).message,
        createdAt: new Date().toISOString(),
        provider: null,
        session: null,
        event: 'commit' as const,
        tool: null,
        cwd: null,
        transcriptPath: null,
        commitSha: (input as { commitSha: string }).commitSha,
      };
    },
    update(id: string, input: UpdateTaskInput) {
      return task(id, input.status ?? 'ready');
    },
  });

  const commitRunner = (
    sha: string,
    subject: string,
    committerEmail: string,
    userEmail: string,
  ): CommandRunner => {
    return async (command) => {
      const cmd = command.join(' ');
      if (cmd === 'git branch --show-current')
        return { exitCode: 0, stdout: 'feature/task-graph\n', stderr: '' };
      if (cmd === 'git worktree list --porcelain')
        return {
          exitCode: 0,
          stdout: 'worktree /project\nHEAD abc\nbranch refs/heads/feature/task-graph\n',
          stderr: '',
        };
      if (
        cmd ===
        'gh pr list --head feature/task-graph --state all --json number,state,baseRefName,mergedAt,url --limit 1'
      ) {
        return { exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (cmd === `git log -1 --format=%H%n%s%n%cE`)
        return { exitCode: 0, stdout: `${sha}\n${subject}\n${committerEmail}\n`, stderr: '' };
      if (cmd === 'git config user.email')
        return { exitCode: 0, stdout: `${userEmail}\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  };

  it('records a commit progress entry for the HEAD commit on the active task', async () => {
    const progressEntries: { taskId: string; input: unknown }[] = [];
    const activeTask = task('task-1', 'in-progress');
    const s = progressStore([activeTask], progressEntries);

    await syncGitStatus(s, {
      withProgress: true,
      runner: commitRunner('abc1234567890', 'Fix the bug', 'user@example.com', 'user@example.com'),
    });

    expect(progressEntries).toHaveLength(1);
    const entry = progressEntries[0] as {
      taskId: string;
      input: { event: string; commitSha: string };
    };
    expect(entry.taskId).toBe('task-1');
    expect(entry.input.event).toBe('commit');
    expect(entry.input.commitSha).toBe('abc1234567890');
  });

  it('does not record when committer email does not match user.email', async () => {
    const progressEntries: { taskId: string; input: unknown }[] = [];
    const activeTask = task('task-1', 'in-progress');
    const s = progressStore([activeTask], progressEntries);

    await syncGitStatus(s, {
      withProgress: true,
      runner: commitRunner('abc1234567890', 'Fix the bug', 'other@example.com', 'user@example.com'),
    });

    expect(progressEntries).toHaveLength(0);
  });

  it('records when user.email is unset (filter skipped)', async () => {
    const progressEntries: { taskId: string; input: unknown }[] = [];
    const activeTask = task('task-1', 'in-progress');
    const s = progressStore([activeTask], progressEntries);

    const runnerNoEmail: CommandRunner = async (command) => {
      const cmd = command.join(' ');
      if (cmd === 'git branch --show-current')
        return { exitCode: 0, stdout: 'feature/task-graph\n', stderr: '' };
      if (cmd === 'git worktree list --porcelain')
        return {
          exitCode: 0,
          stdout: 'worktree /project\nHEAD abc\nbranch refs/heads/feature/task-graph\n',
          stderr: '',
        };
      if (cmd.startsWith('gh ')) return { exitCode: 0, stdout: '[]', stderr: '' };
      if (cmd === 'git log -1 --format=%H%n%s%n%cE')
        return { exitCode: 0, stdout: 'sha123456789\nFix stuff\nsome@one.com\n', stderr: '' };
      if (cmd === 'git config user.email') return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await syncGitStatus(s, { withProgress: true, runner: runnerNoEmail });

    expect(progressEntries).toHaveLength(1);
  });

  it('does not record when there is no single active task on the branch', async () => {
    const progressEntries: { taskId: string; input: unknown }[] = [];
    const s = progressStore([], progressEntries);

    await syncGitStatus(s, {
      withProgress: true,
      runner: commitRunner('abc1234567890', 'Fix', 'user@example.com', 'user@example.com'),
    });

    expect(progressEntries).toHaveLength(0);
  });

  it('swallows the unique constraint error on a repeated SHA and rethrows other errors', async () => {
    const activeTask = task('task-1', 'in-progress');
    let callCount = 0;
    const conflictStore: TaskStore = {
      ...store([activeTask]),
      addProgress() {
        callCount += 1;
        throw new Error('UNIQUE constraint failed: task_progress_commit_sha_unique');
      },
      update(id: string, input: UpdateTaskInput) {
        return task(id, input.status ?? 'ready');
      },
    };

    // Should not throw — unique constraint violation is swallowed.
    await syncGitStatus(conflictStore, {
      withProgress: true,
      runner: commitRunner('abc1234567890', 'Fix', 'user@example.com', 'user@example.com'),
    });
    expect(callCount).toBe(1);

    // Rethrow on unrelated errors.
    const otherStore: TaskStore = {
      ...store([activeTask]),
      addProgress() {
        throw new Error('some other database error');
      },
      update(id: string, input: UpdateTaskInput) {
        return task(id, input.status ?? 'ready');
      },
    };

    expect(
      syncGitStatus(otherStore, {
        withProgress: true,
        runner: commitRunner('abc1234567890', 'Fix', 'user@example.com', 'user@example.com'),
      }),
    ).rejects.toThrow('some other database error');
  });
});
