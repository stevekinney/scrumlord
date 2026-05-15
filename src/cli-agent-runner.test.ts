import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import { taskStartRunner } from './test-runner-mocks';
import type { Task, TaskReference, TaskStore } from './types';

const startRunner = taskStartRunner({
  'git branch --show-current': () => ({
    exitCode: 0,
    stdout: 'feature/task-graph\n',
    stderr: '',
  }),
});

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-agent-'));
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

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create: () => task('created'),
  update(id, input) {
    calls.push(`update:${id}:${input.status ?? ''}:${input.branch ?? ''}`);
    return task(id, input);
  },
  delete: (id) => task(id),
  getTask(id) {
    calls.push(`get:${id}`);
    return task(id);
  },
  list: () => [],
  available: () => [],
  blocked: () => [],
  completed: () => [],
  withTag: () => [],
  withAllTags: () => [],
  withAnyTag: () => [],
  withBranch: () => [],
  withSession: () => [],
  blockedBy: () => [],
  blocking: () => [],
  withPriority: () => [],
  next: () => null,
  cleanup: (days) => ({ deleted: days }),
  addTag: (id) => task(id),
  removeTag: (id) => task(id),
  addBlocker: (id) => task(id),
  removeBlocker: (id) => task(id),
  setPlan(id, plan) {
    calls.push(`setPlan:${id}:${plan ?? ''}`);
    return task(id, { plan });
  },
  setSession(id, provider, session) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id, { provider, session });
  },
  taskSession(id) {
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

describe('runTasksCli agent session commands', () => {
  it('starts and resumes provider sessions with inherited agent invocations', async () => {
    const calls: string[] = [];
    const invocations: string[][] = [];
    const codexHome = join(await temporaryDirectory(), '.codex');
    const store = {
      ...fakeStore(calls),
      getTask: (id: string) => {
        calls.push(`get:${id}`);
        return task(id, { branch: 'feature/task-graph' });
      },
      taskSession: () => ({
        taskId: 'task-id',
        provider: 'codex' as const,
        session: 'codex-session',
        branch: null,
        plan: null,
      }),
    };

    const startResult = await runTasksCli(['start', 'task-id', '--cli', 'claude', '--quiet'], {
      createStore: async () => store,
      which: () => '/bin/provider',
      runner: startRunner,
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 7;
      },
    });

    expect(startResult).toEqual({ exitCode: 7, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');
    expect(invocations[0]).toContain('--permission-mode');
    expect(invocations[0]).toContain('--session-id');
    expect(invocations[0]).toContain('--worktree');

    const resumeResult = await runTasksCli(['resume', 'task-id'], {
      createStore: async () => store,
      environment: { CODEX_HOME: codexHome },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });

    expect(resumeResult).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations.at(-1)).toEqual([
      '/bin/provider',
      'resume',
      '--cd',
      '/project',
      'codex-session',
    ]);
    expect(calls).toContain('close');
  });

  it('can run the default agent invocation process', async () => {
    const root = await temporaryDirectory();
    const truePath = Bun.which('true') ?? '/usr/bin/true';
    const calls: string[] = [];

    const result = await runTasksCli(['start', 'task-id', '--cli', 'claude', '--quiet'], {
      createStore: async () => ({ ...fakeStore(calls), projectRoot: root }),
      which: () => truePath,
      runner: startRunner,
    });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('returns helpful JSON errors for agent session commands', async () => {
    const createStore = async () => ({
      ...fakeStore([]),
      blockedBy: () => [task('blocker')],
    });

    const missingProvider = await runTasksCli(['start', 'task-id'], { createStore });
    expect(JSON.parse(missingProvider.stderr).error.code).toBe('scrumlord_cli_required');

    const missingExecutable = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
      createStore,
      which: () => null,
      runner: startRunner,
    });
    expect(JSON.parse(missingExecutable.stderr).error.code).toBe('provider_cli_not_found');

    const blocked = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
      createStore,
      which: () => '/bin/codex',
      runner: startRunner,
    });
    expect(JSON.parse(blocked.stderr).error.code).toBe('task_blocked');

    for (const [overrides, code] of [
      [{ deleted: true }, 'task_deleted'],
      [{ status: 'completed' }, 'task_completed'],
      [{ startDate: '9999-01-01T00:00:00.000Z' }, 'task_not_started'],
    ] as const) {
      const result = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
        createStore: async () => ({
          ...fakeStore([]),
          getTask: () => task('task-id', overrides),
        }),
        which: () => '/bin/codex',
        runner: startRunner,
      });
      expect(JSON.parse(result.stderr).error.code).toBe(code);
    }

    const missingSession = await runTasksCli(['resume', 'task-id'], {
      createStore: async () => fakeStore([]),
    });
    expect(JSON.parse(missingSession.stderr).error.code).toBe('task_session_missing');

    const unreadableRoot = await temporaryDirectory();
    const unreadablePath = join(unreadableRoot, 'PLAN.md');
    await Bun.write(unreadablePath, '# Plan');
    await chmod(unreadablePath, 0);
    const unreadablePlan = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
      createStore: async () => ({
        ...fakeStore([]),
        projectRoot: unreadableRoot,
        getTask: () => task('task-id', { plan: unreadablePath }),
        update: (_id: string, input) => task('task-id', { ...input, plan: unreadablePath }),
      }),
      which: () => '/bin/codex',
      runner: startRunner,
    });
    expect(JSON.parse(unreadablePlan.stderr).error.code).toBe('plan_unreadable');
  });

  it('handles agent hooks quietly when the database is absent and routes hook input when present', async () => {
    const noRoot = await temporaryDirectory();
    const unresolvedRoot = await runTasksCli(['agent-hook', 'codex'], {
      cwd: noRoot,
      readStdin: async () => JSON.stringify({ session_id: 'session-1' }),
    });
    expect(unresolvedRoot).toEqual({ exitCode: 0, stdout: '', stderr: '' });

    const root = await workspaceRoot();
    const missingDatabase = await runTasksCli(['agent-hook', 'codex'], {
      cwd: root,
      readStdin: async () => JSON.stringify({ session_id: 'session-1' }),
    });
    expect(missingDatabase).toEqual({ exitCode: 0, stdout: '', stderr: '' });

    await mkdir(join(root, 'tmp'), { recursive: true });
    await Bun.write(join(root, 'tmp', 'tasks.db'), '');
    const calls: string[] = [];
    const routed = await runTasksCli(['agent-hook', 'codex'], {
      cwd: root,
      createStore: async () => fakeStore(calls),
      environment: { SCRUMLORD_TASK_ID: 'task-id' },
      readStdin: async () => JSON.stringify({ session_id: 'session-1' }),
    });

    expect(routed).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(calls).toContain('setSession:task-id:codex:session-1');
  });
});
