import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskReference, TaskStore } from './types';

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
  update: (id, input) => task(id, input),
  delete: (id) => task(id),
  getTask: (id) => task(id),
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
  setPlan: (id, plan) => task(id, { plan }),
  setSession: (id, provider, session) => task(id, { provider, session }),
  taskSession: (id) => ({
    taskId: id,
    provider: null,
    session: null,
    branch: null,
    plan: null,
  }),
  ...emptyProgressStoreMethods,
  close: () => {
    calls.push('close');
  },
});

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-boundary-'));
  temporaryDirectories.push(directory);
  return directory;
};

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
        githubCalls.push(`comments:unresolved:${projectRoot}`);
        return [{ ...reviewComment, isResolved: false }];
      },
      async resolvedReviewComments(projectRoot: string) {
        githubCalls.push(`comments:resolved:${projectRoot}`);
        return [{ ...reviewComment, isResolved: true }];
      },
      async allReviewComments(projectRoot: string) {
        githubCalls.push(`comments:all:${projectRoot}`);
        return [{ ...reviewComment, isResolved: false }];
      },
    };

    const pullRequestOpenResult = await runTasksCli(['pr', '--open'], { cwd: root, github });
    expect(JSON.parse(pullRequestOpenResult.stdout)).toEqual({ url: 'https://github.test/pull/1' });
    expect(githubCalls).toContain(`url:${root}:true`);
    const pullRequestOverviewResult = await runTasksCli(['pr'], { cwd: root, github });
    expect(JSON.parse(pullRequestOverviewResult.stdout).readyToMerge).toBe(true);
    expect(githubCalls).toContain(`status:${root}`);
    const pullRequestUrlResult = await runTasksCli(['pr', '--url'], { cwd: root, github });
    expect(pullRequestUrlResult.stdout).toBe('https://github.test/pull/1\n');
    expect(githubCalls).toContain(`url:${root}:false`);
    const pullRequestCommentsResult = await runTasksCli(['pr', '--comments'], {
      cwd: root,
      github,
    });
    expect(JSON.parse(pullRequestCommentsResult.stdout)).toEqual([
      { ...reviewComment, isResolved: false },
    ]);
    expect(githubCalls).toContain(`comments:unresolved:${root}`);
    const pullRequestResolvedCommentsResult = await runTasksCli(
      ['pr', '--comments', '--resolved'],
      { cwd: root, github },
    );
    expect(JSON.parse(pullRequestResolvedCommentsResult.stdout)).toEqual([
      { ...reviewComment, isResolved: true },
    ]);
    expect(githubCalls).toContain(`comments:resolved:${root}`);
    const pullRequestAllCommentsResult = await runTasksCli(['pr', '--comments', '--all'], {
      cwd: root,
      github,
    });
    expect(JSON.parse(pullRequestAllCommentsResult.stdout)).toEqual([
      { ...reviewComment, isResolved: false },
    ]);
    expect(githubCalls).toContain(`comments:all:${root}`);
    const pullRequestFlagConflictResult = await runTasksCli(['pr', '--url', '--comments'], {
      cwd: root,
      github,
    });
    expect(JSON.parse(pullRequestFlagConflictResult.stderr).error.code).toBe('pr_flag_conflict');
    const repositoryResult = await runTasksCli(['repository'], { cwd: root, github });
    expect(repositoryResult.stdout).toBe('owner/repository\n');
    expect(githubCalls).toContain(`repository:${root}`);
    const repositoryUrlResult = await runTasksCli(['repository', '--url'], { cwd: root, github });
    expect(repositoryUrlResult.stdout).toBe('https://github.com/owner/repository\n');
    expect(githubCalls).toContain(`repositoryUrl:${root}`);
    const repositoryJsonResult = await runTasksCli(['repository', '--json'], {
      cwd: root,
      github,
    });
    expect(JSON.parse(repositoryJsonResult.stdout)).toEqual({
      name: 'owner/repository',
      url: 'https://github.com/owner/repository',
    });
    const repositoryJsonOverrideResult = await runTasksCli(['repository', '--url', '--json'], {
      cwd: root,
      github,
    });
    expect(JSON.parse(repositoryJsonOverrideResult.stdout)).toEqual({
      name: 'owner/repository',
      url: 'https://github.com/owner/repository',
    });
    const overviewCalls: string[] = [];
    const overviewResult = await runTasksCli(['overview'], {
      cwd: root,
      createStore: async () => fakeStore(overviewCalls),
      github,
    });
    expect(JSON.parse(overviewResult.stdout)[0].pullRequest.number).toBe(1);
    expect(githubCalls).toContain('overview:/project');
    expect(overviewCalls).toEqual(['close']);
    const initResult = await runTasksCli(['init'], {
      cwd: root,
      initializeProject: async (options) => ({ initialized: true, cwd: options.cwd }),
    });
    expect(JSON.parse(initResult.stdout)).toEqual({ initialized: true, cwd: root });

    const setupResult = await runTasksCli(['setup', '--skills'], { cwd: root });
    expect(JSON.parse(setupResult.stdout).map((entry: { target: string }) => entry.target)).toEqual(
      ['codex', 'claude', 'cursor'],
    );

    const setupGitHooksResult = await runTasksCli(['setup', '--git-hooks'], {
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

    const setupAgentHooksResult = await runTasksCli(['setup', '--agent-hooks'], {
      cwd: root,
      homeDirectory: root,
      setupAgentHooks: async () => ({
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
    expect(JSON.parse(setupAgentHooksResult.stdout).claude.settingsPath).toBe(
      join(root, '.claude/settings.json'),
    );

    const setupSubagentsResult = await runTasksCli(
      ['setup', '--subagents', '--agent', 'codex', '--user'],
      {
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
      },
    );
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

    const setupPromptResult = await runTasksCli(['setup', '--prompt'], { cwd: root });
    expect(setupPromptResult.exitCode).toBe(0);
    expect(setupPromptResult.stdout.startsWith('"')).toBe(false);
    expect(setupPromptResult.stdout).toContain('tasks init');
    expect(setupPromptResult.stdout.endsWith('\n')).toBe(true);

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
