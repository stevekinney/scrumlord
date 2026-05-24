import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import type { CommandResult } from './command-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskStore } from './types';

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
  blocked: false,
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const makePorcelain = (entries: { path: string; branch?: string }[]): string =>
  entries
    .map(({ path, branch }) => {
      const lines = [`worktree ${path}`, 'HEAD abc123'];
      if (branch) lines.push(`branch refs/heads/${branch}`);
      else lines.push('detached');
      return lines.join('\n');
    })
    .join('\n\n') + '\n\n';

type StoreOptions = {
  tasks?: Task[];
  currentBranch?: string;
  projectRoot?: string;
};

const makeStore = ({
  tasks = [],
  currentBranch,
  projectRoot = '/project',
}: StoreOptions = {}): TaskStore => ({
  projectRoot,
  databasePath: `${projectRoot}/tmp/tasks.db`,
  create: () => task('created'),
  update: (id, input) => task(id, input),
  delete: (id) => task(id),
  getTask: (id) => tasks.find((t) => t.id === id) ?? null,
  list: () => tasks,
  available: () => tasks.filter((t) => t.status === 'ready'),
  blocked: () => [],
  completed: () => [],
  withTag: () => [],
  withAllTags: () => [],
  withAnyTag: () => [],
  withBranch: (branch) => tasks.filter((t) => t.branch === branch),
  withSession: () => [],
  blockedBy: () => [],
  blocking: () => [],
  withPriority: () => [],
  next: () => tasks.find((t) => t.status === 'ready') ?? null,
  cleanup: (days) => ({ deleted: days }),
  addTag: (id) => task(id),
  removeTag: (id) => task(id),
  addBlocker: (id) => task(id),
  removeBlocker: (id) => task(id),
  setPlan: (id, plan) => task(id, { plan }),
  setSession: (id, provider, session) => task(id, { provider, session }),
  taskSession: (id) => ({
    taskId: id,
    provider: null,
    session: null,
    branch: null,
    plan: null,
  }),
  allIds: () => tasks.map((t) => t.id),
  allTags: () => [],
  ...emptyProgressStoreMethods,
  close: () => undefined,
  ...(currentBranch !== undefined
    ? {
        withBranch: (branch: string) => {
          if (branch === currentBranch) return tasks.filter((t) => t.branch === branch);
          return [];
        },
      }
    : {}),
});

const worktreeRunner =
  (
    porcelain: string,
    currentBranch: string = 'main',
  ): Parameters<typeof runTasksCli>[1]['runner'] =>
  async (command: string[]): Promise<CommandResult> => {
    if (command[0] === 'git' && command[1] === 'branch') {
      return { exitCode: 0, stdout: `${currentBranch}\n`, stderr: '' };
    }
    if (command[0] === 'git' && command[1] === 'worktree') {
      return { exitCode: 0, stdout: porcelain, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

const failingWorktreeRunner =
  (stderr: string): Parameters<typeof runTasksCli>[1]['runner'] =>
  async (command: string[]): Promise<CommandResult> => {
    if (command[0] === 'git' && command[1] === 'worktree') {
      return { exitCode: 128, stdout: '', stderr };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-teleport-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

/** Creates a temp directory with a real git repo checked out on `branch`. */
const makeGitRepo = async (branch: string): Promise<string> => {
  const root = await temporaryDirectory();
  const run = async (args: string[]) => {
    const proc = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
  };
  await run(['git', 'init']);
  await run(['git', 'checkout', '-b', branch]);
  // Need at least one commit for git to fully recognize the branch.
  await writeFile(join(root, '.gitkeep'), '');
  await run(['git', 'add', '.gitkeep']);
  await run([
    'git',
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@test.com',
    'commit',
    '-m',
    'init',
  ]);
  return root;
};

describe('tasks teleport — success cases', () => {
  it('returns the worktree path for a UUID task', async () => {
    const t = task('abc12345', { branch: 'tasks/abc12345' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-abc', branch: 'tasks/abc12345' }]);

    const result = await runTasksCli(['teleport', 'abc12345'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-abc\n');
    expect(result.stderr).toBe('');
  });

  it('returns the worktree path for the current task', async () => {
    const branch = 'tasks/cur-branch';
    const gitRoot = await makeGitRepo(branch);
    const t = task('cur-task', { branch });
    const store = makeStore({ tasks: [t], projectRoot: gitRoot });
    const porcelain = makePorcelain([{ path: '/tmp/wt-current', branch }]);

    const result = await runTasksCli(['teleport', 'current'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain, branch),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-current\n');
    expect(result.stderr).toBe('');
  });

  it('returns the worktree path for the next task', async () => {
    const t = task('next-task', { branch: 'tasks/next' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-next', branch: 'tasks/next' }]);

    const result = await runTasksCli(['teleport', 'next'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-next\n');
    expect(result.stderr).toBe('');
  });

  it('returns the primary checkout path when it matches the branch', async () => {
    const t = task('main-task', { branch: 'main' });
    const store = makeStore({ tasks: [t] });
    store.projectRoot = '/project';
    const porcelain = makePorcelain([{ path: '/project', branch: 'main' }]);

    const result = await runTasksCli(['teleport', 'main-task'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/project\n');
  });

  it('returns the raw path even when --json is passed on success', async () => {
    const t = task('json-task', { branch: 'tasks/json' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-json', branch: 'tasks/json' }]);

    const result = await runTasksCli(['teleport', 'json-task', '--json'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-json\n');
  });

  it('returns the raw path under CLAUDECODE=1', async () => {
    const t = task('claude-task', { branch: 'tasks/claude' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-claude', branch: 'tasks/claude' }]);

    const result = await runTasksCli(['teleport', 'claude-task'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
      environment: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-claude\n');
  });

  it('returns the raw path under CODEX_MANAGED_BY_BUN=1', async () => {
    const t = task('codex-task', { branch: 'tasks/codex' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-codex', branch: 'tasks/codex' }]);

    const result = await runTasksCli(['teleport', 'codex-task'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
      environment: { CODEX_MANAGED_BY_BUN: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-codex\n');
  });

  it('matches the right worktree from multi-record porcelain', async () => {
    const t = task('multi-task', { branch: 'tasks/abc12345' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([
      { path: '/project' }, // detached — no branch line
      { path: '/project', branch: 'main' },
      { path: '/tmp/wt-linked', branch: 'tasks/abc12345' },
    ]);

    const result = await runTasksCli(['teleport', 'multi-task'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-linked\n');
  });

  it('matches a branch name containing slashes', async () => {
    const t = task('slash-task', { branch: 'feature/multi/level' });
    const store = makeStore({ tasks: [t] });
    const porcelain = makePorcelain([{ path: '/tmp/wt-slash', branch: 'feature/multi/level' }]);

    const result = await runTasksCli(['teleport', 'slash-task'], {
      createStore: async () => store,
      runner: worktreeRunner(porcelain),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/tmp/wt-slash\n');
  });
});

describe('tasks teleport — teleport_no_branch', () => {
  const noBranchTask = task('no-branch-task', { branch: null });
  const store = makeStore({ tasks: [noBranchTask] });
  const runner = worktreeRunner('');

  it('emits human error to stderr when no --json', async () => {
    const result = await runTasksCli(['teleport', 'no-branch-task'], {
      createStore: async () => store,
      runner,
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('has no branch set');
    expect(result.stdout).toBe('');
  });

  it('emits JSON envelope when --json', async () => {
    const result = await runTasksCli(['teleport', 'no-branch-task', '--json'], {
      createStore: async () => store,
      runner,
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_no_branch');
  });

  it('emits JSON envelope under CLAUDECODE=1', async () => {
    const result = await runTasksCli(['teleport', 'no-branch-task'], {
      createStore: async () => store,
      runner,
      environment: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_no_branch');
  });

  it('emits JSON envelope under CODEX_MANAGED_BY_BUN=1', async () => {
    const result = await runTasksCli(['teleport', 'no-branch-task'], {
      createStore: async () => store,
      runner,
      environment: { CODEX_MANAGED_BY_BUN: '1' },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_no_branch');
  });
});

describe('tasks teleport — teleport_no_worktree', () => {
  const t = task('orphan-task', { branch: 'tasks/orphan' });
  const store = makeStore({ tasks: [t] });
  const emptyPorcelain = makePorcelain([{ path: '/project', branch: 'main' }]);
  const runner = worktreeRunner(emptyPorcelain);

  it('emits human error naming the task id and branch', async () => {
    const result = await runTasksCli(['teleport', 'orphan-task'], {
      createStore: async () => store,
      runner,
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('orphan-task');
    expect(result.stderr).toContain('tasks/orphan');
    expect(result.stdout).toBe('');
  });

  it('emits JSON envelope with teleport_no_worktree when --json', async () => {
    const result = await runTasksCli(['teleport', 'orphan-task', '--json'], {
      createStore: async () => store,
      runner,
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_no_worktree');
  });
});

describe('tasks teleport — teleport_worktree_lookup_failed', () => {
  const t = task('fail-task', { branch: 'tasks/fail' });
  const store = makeStore({ tasks: [t] });

  it('includes git error text in human stderr', async () => {
    const result = await runTasksCli(['teleport', 'fail-task'], {
      createStore: async () => store,
      runner: failingWorktreeRunner('fatal: not a git repository'),
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a git repository');
    expect(result.stdout).toBe('');
  });

  it('emits JSON envelope with teleport_worktree_lookup_failed when --json', async () => {
    const result = await runTasksCli(['teleport', 'fail-task', '--json'], {
      createStore: async () => store,
      runner: failingWorktreeRunner('fatal: not a git repository'),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_worktree_lookup_failed');
    expect(parsed.error.message).toContain('not a git repository');
  });

  it('collapses multi-line stderr into a single-line message without double punctuation', async () => {
    const result = await runTasksCli(['teleport', 'fail-task', '--json'], {
      createStore: async () => store,
      runner: failingWorktreeRunner('fatal: ambiguous argument\n  hint: try git fetch'),
    });

    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.message).not.toContain('\n');
    expect(parsed.error.message).not.toMatch(/\.\./);
  });

  it('emits teleport_worktree_lookup_failed for a non-absolute path', async () => {
    const t2 = task('rel-task', { branch: 'tasks/rel' });
    const store2 = makeStore({ tasks: [t2] });
    const relPorcelain = 'worktree worktrees/rel\nHEAD abc123\nbranch refs/heads/tasks/rel\n\n';

    const result = await runTasksCli(['teleport', 'rel-task', '--json'], {
      createStore: async () => store2,
      runner: worktreeRunner(relPorcelain),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('teleport_worktree_lookup_failed');
    expect(parsed.error.message).toContain('worktrees/rel');
  });
});

describe('tasks teleport — resolver and store errors', () => {
  // All tests that call `tasks teleport current` need a real git repo so
  // currentBranchTask can call `git branch --show-current`.
  it('returns human error for current with no branch task', async () => {
    const gitRoot = await makeGitRepo('tasks/empty-branch');
    const emptyStore = makeStore({ projectRoot: gitRoot });

    const result = await runTasksCli(['teleport', 'current'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('No active task');
    expect(result.stdout).toBe('');
  });

  it('returns JSON envelope for current with no branch task when --json', async () => {
    const gitRoot = await makeGitRepo('tasks/empty-branch2');
    const emptyStore = makeStore({ projectRoot: gitRoot });

    const result = await runTasksCli(['teleport', 'current', '--json'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('current_task_not_found');
  });

  it('returns JSON envelope under CLAUDECODE=1 for current_task_not_found', async () => {
    const gitRoot = await makeGitRepo('tasks/empty-branch3');
    const emptyStore = makeStore({ projectRoot: gitRoot });

    const result = await runTasksCli(['teleport', 'current'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
      environment: { CLAUDECODE: '1' },
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('current_task_not_found');
  });

  it('returns human error for next on empty store', async () => {
    const emptyStore = makeStore();

    const result = await runTasksCli(['teleport', 'next'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBeTruthy();
    expect(result.stdout).toBe('');
  });

  it('returns JSON envelope for next on empty store when --json', async () => {
    const emptyStore = makeStore();

    const result = await runTasksCli(['teleport', 'next', '--json'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('next_task_not_found');
  });

  it('returns human error for unknown UUID', async () => {
    const emptyStore = makeStore();

    const result = await runTasksCli(['teleport', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], {
      createStore: async () => emptyStore,
      runner: worktreeRunner(''),
      isStdoutTty: true,
      colorMode: 'never',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('was not found');
    expect(result.stdout).toBe('');
  });

  it('returns JSON envelope for unknown UUID when --json', async () => {
    const emptyStore = makeStore();

    const result = await runTasksCli(
      ['teleport', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', '--json'],
      {
        createStore: async () => emptyStore,
        runner: worktreeRunner(''),
      },
    );

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('task_not_found');
  });

  it('returns JSON envelope for ambiguous branch tasks when --json', async () => {
    const branch = 'tasks/ambiguous-branch';
    const gitRoot = await makeGitRepo(branch);
    const t1 = task('task-1', { branch });
    const t2 = task('task-2', { branch });
    const ambiguousStore = makeStore({ tasks: [t1, t2], projectRoot: gitRoot });

    const result = await runTasksCli(['teleport', 'current', '--json'], {
      createStore: async () => ambiguousStore,
      runner: worktreeRunner('', branch),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('current_task_ambiguous');
  });
});

describe('tasks teleport — missing argument', () => {
  it('returns JSON envelope for missing positional', async () => {
    const store = makeStore();
    const result = await runTasksCli(['teleport'], {
      createStore: async () => store,
      runner: worktreeRunner(''),
    });

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('missing_argument');
  });
});
