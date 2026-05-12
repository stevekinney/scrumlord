import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskReference, TaskStore } from './types';

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

const fakeStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create: () => task('created'),
  update(id, input) {
    calls.push(`update:${id}:${input.status ?? ''}:${input.branch ?? ''}`);
    return task(id, input);
  },
  delete: (id) => task(id),
  archive: (id) => task(id),
  restore: (id) => task(id),
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
  setParent: (id, parent) => task(id, { parent: referenceId(parent) }),
  clearParent: (id) => task(id),
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

    const startResult = await runTasksCli(['start', 'task-id', '--cli', 'claude'], {
      createStore: async () => store,
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 7;
      },
    });

    expect(startResult).toEqual({ exitCode: 7, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');
    expect(invocations[0]).toContain('--permission-mode');
    expect(invocations[0]).toContain('--session-id');

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

    const result = await runTasksCli(['start', 'task-id', '--cli', 'claude'], {
      createStore: async () => ({ ...fakeStore(calls), projectRoot: root }),
      which: () => truePath,
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
    });
    expect(JSON.parse(missingExecutable.stderr).error.code).toBe('provider_cli_not_found');

    const blocked = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
      createStore,
      which: () => '/bin/codex',
    });
    expect(JSON.parse(blocked.stderr).error.code).toBe('task_blocked');

    for (const [overrides, code] of [
      [{ deleted: true }, 'task_deleted'],
      [{ archived: true }, 'task_archived'],
      [{ status: 'completed' }, 'task_completed'],
      [{ startDate: '9999-01-01T00:00:00.000Z' }, 'task_not_started'],
    ] as const) {
      const result = await runTasksCli(['start', 'task-id', '--cli', 'codex'], {
        createStore: async () => ({
          ...fakeStore([]),
          getTask: () => task('task-id', overrides),
        }),
        which: () => '/bin/codex',
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

describe('runTasksCli boundary commands', () => {
  it('handles setup and pull request boundary commands', async () => {
    const root = await workspaceRoot();
    const githubCalls: string[] = [];
    const pullRequest = {
      number: 1,
      url: 'https://github.test/pull/1',
      headRefName: 'feature/task-graph',
      headSha: 'abc123',
      title: 'Task graph',
    };
    const check = {
      name: 'build',
      state: 'SUCCESS',
      bucket: 'pass',
      workflow: 'Validate',
      url: 'https://github.test/checks/build',
      completedAt: '2026-05-11T12:00:00Z',
    };
    const checkReport = {
      ...check,
      conclusion: 'successful' as const,
      synopsis: 'Validate: build passed.',
    };
    const reviewComment = {
      id: 'comment-id',
      url: 'https://github.test/comment',
      path: 'src/github.ts',
      line: 123,
      body: 'Please fix this.',
      author: 'reviewer',
    };
    const github = {
      async repositoryName(projectRoot: string) {
        githubCalls.push(`repository:${projectRoot}`);
        return 'owner/repository';
      },
      async repositoryUrl(projectRoot: string) {
        githubCalls.push(`repositoryUrl:${projectRoot}`);
        return 'https://github.com/owner/repository';
      },
      async pullRequestUrl(projectRoot: string, open: boolean) {
        githubCalls.push(`url:${projectRoot}:${open}`);
        return { url: pullRequest.url };
      },
      async pullRequestStatus(projectRoot: string) {
        githubCalls.push(`status:${projectRoot}`);
        return {
          pullRequest,
          reviewComments: { allResolved: true, unresolvedCount: 0, unresolved: [] },
          continuousIntegration: {
            allGreen: true,
            pendingCount: 0,
            failedCount: 0,
            checks: [checkReport],
            pending: [],
            failed: [],
          },
          readyToMerge: true,
        };
      },
      async tasksOverview(store: TaskStore) {
        githubCalls.push(`overview:${store.projectRoot}`);
        return [
          {
            pullRequest,
            associatedTasks: [],
            reviewComments: { unresolvedCount: 0 },
            continuousIntegration: {
              status: 'success' as const,
              pendingCount: 0,
              failedCount: 0,
              checks: [checkReport],
            },
            readyToMerge: true,
          },
        ];
      },
      async unresolvedReviewComments(projectRoot: string) {
        githubCalls.push(`comments:${projectRoot}`);
        return [reviewComment];
      },
      async continuousIntegrationStatus(projectRoot: string) {
        githubCalls.push(`ci:${projectRoot}`);
        return [check];
      },
    };

    const pullRequestResult = await runTasksCli(['pr', '--open'], { cwd: root, github });
    expect(JSON.parse(pullRequestResult.stdout)).toEqual({ url: 'https://github.test/pull/1' });
    expect(githubCalls).toContain(`url:${root}:true`);
    const pullRequestStatusResult = await runTasksCli(['pr', 'status'], { cwd: root, github });
    expect(JSON.parse(pullRequestStatusResult.stdout).readyToMerge).toBe(true);
    expect(githubCalls).toContain(`status:${root}`);
    const repositoryResult = await runTasksCli(['repository'], { cwd: root, github });
    expect(JSON.parse(repositoryResult.stdout)).toBe('owner/repository');
    expect(githubCalls).toContain(`repository:${root}`);
    const repositoryUrlResult = await runTasksCli(['repository', '--url'], { cwd: root, github });
    expect(JSON.parse(repositoryUrlResult.stdout)).toBe('https://github.com/owner/repository');
    expect(githubCalls).toContain(`repositoryUrl:${root}`);
    const overviewCalls: string[] = [];
    const overviewResult = await runTasksCli(['overview'], {
      cwd: root,
      createStore: async () => fakeStore(overviewCalls),
      github,
    });
    expect(JSON.parse(overviewResult.stdout)[0].pullRequest.number).toBe(1);
    expect(githubCalls).toContain('overview:/project');
    expect(overviewCalls).toEqual(['close']);
    const commentsResult = await runTasksCli(['comments'], { cwd: root, github });
    expect(JSON.parse(commentsResult.stdout)).toEqual([reviewComment]);
    expect(githubCalls).toContain(`comments:${root}`);
    const continuousIntegrationResult = await runTasksCli(['ci'], { cwd: root, github });
    expect(JSON.parse(continuousIntegrationResult.stdout)).toEqual([check]);
    expect(githubCalls).toContain(`ci:${root}`);

    const initResult = await runTasksCli(['init'], {
      cwd: root,
      initializeProject: async (options) => ({ initialized: true, cwd: options.cwd }),
    });
    expect(JSON.parse(initResult.stdout)).toEqual({ initialized: true, cwd: root });

    const setupResult = await runTasksCli(['setup-skills', '--all'], { cwd: root });
    expect(JSON.parse(setupResult.stdout).map((entry: { target: string }) => entry.target)).toEqual(
      ['codex', 'claude', 'cursor'],
    );

    const setupGitHooksResult = await runTasksCli(['setup-git-hooks'], {
      cwd: root,
      setupGitHooks: async (projectRoot: string) => ({
        configurationPath: join(projectRoot, 'lefthook.yml'),
        changed: true,
        hooks: [],
        install: null,
      }),
    });
    expect(JSON.parse(setupGitHooksResult.stdout)).toEqual({
      configurationPath: join(root, 'lefthook.yml'),
      changed: true,
      hooks: [],
      install: null,
    });

    const setupAgentHooksResult = await runTasksCli(['setup-agent-hooks'], {
      cwd: root,
      homeDirectory: root,
      setupAgentHooks: async () => ({
        wrapperPath: join(root, '.scrumlord/hooks/scrumlord-agent-hook.ts'),
        claude: {
          settingsPath: join(root, '.claude/settings.json'),
          changed: true,
          skipped: false,
        },
        codex: {
          configurationPath: join(root, '.codex/config.toml'),
          hooksPath: join(root, '.codex/hooks.json'),
          changed: true,
          skipped: false,
        },
      }),
    });
    expect(JSON.parse(setupAgentHooksResult.stdout).wrapperPath).toBe(
      join(root, '.scrumlord/hooks/scrumlord-agent-hook.ts'),
    );

    const setupSubagentsResult = await runTasksCli(['setup-subagents', 'codex', '--global'], {
      cwd: root,
      homeDirectory: root,
      setupSubagents: async (projectRoot, options) => ({
        projectRoot,
        scope: options?.scope ?? 'local',
        providers: [
          {
            provider: options?.target === 'claude' ? 'claude' : 'codex',
            path: join(projectRoot, '.codex/agents/scrumlord-task-manager.toml'),
            changed: true,
            settingsPath: null,
            settingsChanged: false,
          },
        ],
        skills: [],
        warnings: options?.target ? [`target:${options.target}`] : [],
      }),
      which: () => '/bin/provider',
    });
    expect(JSON.parse(setupSubagentsResult.stdout)).toEqual({
      projectRoot: root,
      scope: 'global',
      providers: [
        {
          provider: 'codex',
          path: join(root, '.codex/agents/scrumlord-task-manager.toml'),
          changed: true,
          settingsPath: null,
          settingsChanged: false,
        },
      ],
      skills: [],
      warnings: ['target:codex'],
    });

    const setupStatusResult = await runTasksCli(['setup', 'status'], {
      cwd: root,
      which: (executable) => (executable === 'tasks' ? '/bin/tasks' : null),
    });
    expect(JSON.parse(setupStatusResult.stdout).projectRoot).toBe(root);

    const fullSetupResult = await runTasksCli(['setup', '--yes'], {
      cwd: root,
      setupProject: async (setupOptions) => ({
        projectRoot: setupOptions.cwd ?? root,
        databasePath: join(setupOptions.cwd ?? root, 'tmp/tasks.db'),
        skills: [],
        subagents: null,
        agentHooks: null,
        gitHooks: { configurationPath: null, changed: false, hooks: [], install: null },
        warnings: [],
      }),
      which: (executable) => (executable === 'codex' ? '/bin/codex' : null),
    });
    expect(JSON.parse(fullSetupResult.stdout).projectRoot).toBe(root);

    const setupInteractiveResult = await runTasksCli(['setup'], {
      cwd: root,
      colorMode: 'always',
      readStdin: async () => 'codex\nlocal\nnone\n',
      setupProject: async (setupOptions) => ({
        projectRoot: setupOptions.cwd ?? root,
        databasePath: join(setupOptions.cwd ?? root, 'tmp/tasks.db'),
        skills: [],
        subagents: null,
        agentHooks: null,
        gitHooks: { configurationPath: null, changed: false, hooks: [], install: null },
        warnings: [],
      }),
      which: (executable) => (executable === 'codex' ? '/bin/codex' : null),
    });
    expect(JSON.parse(setupInteractiveResult.stdout).projectRoot).toBe(root);
    expect(setupInteractiveResult.stderr).toContain('\u001b[');

    const truePath = Bun.which('true') ?? '/usr/bin/true';
    const spawnedSetupResult = await runTasksCli(['setup', '--codex'], {
      cwd: root,
      setupProject: async (setupOptions) => ({
        projectRoot: setupOptions.cwd ?? root,
        databasePath: join(setupOptions.cwd ?? root, 'tmp/tasks.db'),
        skills: [],
        subagents: null,
        agentHooks: null,
        gitHooks: { configurationPath: null, changed: false, hooks: [], install: null },
        warnings: [],
      }),
      which: (executable) => (executable === 'codex' ? truePath : null),
    });
    expect(spawnedSetupResult).toEqual({ exitCode: 0, stdout: '', stderr: '' });

    const realSetupResult = await runTasksCli(['setup', '--yes'], {
      cwd: root,
      which: () => null,
    });
    expect(JSON.parse(realSetupResult.stdout).databasePath).toBe(join(root, 'tmp/tasks.db'));
  });
});
