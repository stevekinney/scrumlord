import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  absoluteTaskPlanPath,
  agentProviders,
  buildSetupInvocation,
  buildSkillInvocation,
  buildTaskResumeInvocation,
  buildTaskStartInvocation,
  defaultTaskPlanPath,
  getAgentProvider,
  resolveTaskSession,
} from './agent-providers';
import { createTaskStore } from './database-open';
import { ScrumlordError } from './errors';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-agent-providers-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('agent providers', () => {
  it('builds provider-specific start and resume invocations', () => {
    expect(agentProviders).toEqual(['claude', 'codex']);
    expect(defaultTaskPlanPath('task-id')).toBe('tmp/tasks/task-id/PLAN.md');
    expect(absoluteTaskPlanPath('/project', 'tmp/tasks/task-id/PLAN.md')).toBe(
      '/project/tmp/tasks/task-id/PLAN.md',
    );
    expect(absoluteTaskPlanPath('/project', null)).toBeNull();

    const task = {
      id: 'task-id',
      title: 'Task',
      status: 'ready' as const,
      description: '',
      priority: 1 as const,
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
    };
    const startContext = {
      task,
      projectRoot: '/project',
      cwd: '/worktree',
      planPath: '/project/tmp/tasks/task-id/PLAN.md',
      planContents: '# Plan',
      session: 'session-id',
    };

    const claude = getAgentProvider('claude');
    expect(claude.executable).toBe('claude');
    expect(claude.createSession()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(buildTaskStartInvocation('claude', startContext).command).toContain('--permission-mode');
    expect(buildTaskStartInvocation('claude', startContext).command.join('\n')).toContain(
      'tasks progress add',
    );
    expect(
      buildTaskResumeInvocation('claude', { cwd: '/worktree', session: 'session-id' }),
    ).toEqual({
      command: ['claude', '--resume', 'session-id'],
      cwd: '/worktree',
      environment: {},
    });

    const codex = getAgentProvider('codex');
    expect(codex.createSession()).toBeNull();
    expect(buildTaskStartInvocation('codex', startContext).command).toEqual([
      'codex',
      '--cd',
      '/worktree',
      expect.stringContaining('/plan'),
    ]);
    expect(buildTaskStartInvocation('codex', startContext).command.join('\n')).toContain(
      'tasks progress add',
    );
    expect(buildTaskResumeInvocation('codex', { cwd: '/worktree', session: 'session-id' })).toEqual(
      {
        command: ['codex', 'resume', '--cd', '/worktree', 'session-id'],
        cwd: '/worktree',
        environment: {},
      },
    );
    expect(
      buildSetupInvocation('claude', { projectRoot: '/project', setup: { ok: true } }),
    ).toEqual({
      command: ['claude', expect.stringContaining('Scrumlord setup has just completed')],
      cwd: '/project',
      environment: {},
    });
    expect(buildSetupInvocation('codex', { projectRoot: '/project', setup: { ok: true } })).toEqual(
      {
        command: ['codex', '--cd', '/project', expect.stringContaining('tasks setup status')],
        cwd: '/project',
        environment: {},
      },
    );
    expect(() => getAgentProvider('vim')).toThrow(ScrumlordError);
  });

  it('resolves session metadata, derived worktrees, and session files', async () => {
    const root = await temporaryDirectory();
    const home = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    await mkdir(join(root, 'tmp', 'tasks', 'task-id'), { recursive: true });
    await Bun.write(join(root, 'tmp', 'tasks', 'task-id', 'PLAN.md'), '# Plan\n');
    const task = store.create({
      id: 'task-id',
      title: 'Task',
      branch: 'feature/task',
      plan: 'tmp/tasks/task-id/PLAN.md',
      provider: 'codex',
      session: 'codex-session',
    });
    await mkdir(join(home, '.codex', 'sessions', '2026'), { recursive: true });
    await Bun.write(join(home, '.codex', 'sessions', '2026', 'session.jsonl'), 'codex-session');

    const result = await resolveTaskSession(store, task.id, {
      homeDirectory: home,
      runner: async (command) => {
        if (command.join(' ') === 'git worktree list --porcelain') {
          return {
            exitCode: 0,
            stdout: `worktree ${root}\nHEAD abc\nbranch refs/heads/feature/task\n`,
            stderr: '',
          };
        }
        return { exitCode: 1, stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({
      taskId: 'task-id',
      provider: 'codex',
      session: 'codex-session',
      branch: 'feature/task',
      worktree: root,
      plan: join(store.projectRoot, 'tmp/tasks/task-id/PLAN.md'),
      sessionPath: join(home, '.codex', 'sessions', '2026', 'session.jsonl'),
      warnings: [],
    });
    expect(result).not.toHaveProperty('planPath');
    store.close();
  });

  it('reports missing provider, session, and session files as warnings', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const missingProvider = store.create({ id: 'missing-provider', title: 'No provider' });
    const missingSession = store.create({
      id: 'missing-session',
      title: 'No session',
      provider: 'claude',
    });
    const missingPath = store.create({
      id: 'missing-path',
      title: 'Missing path',
      provider: 'claude',
      session: 'claude-session',
    });
    await mkdir(join(root, '.claude', 'projects'), { recursive: true });
    await Bun.write(join(root, '.claude', 'projects', 'unreadable.jsonl'), 'no match');
    await chmod(join(root, '.claude', 'projects', 'unreadable.jsonl'), 0);
    await symlink(
      join(root, 'missing-session-file.jsonl'),
      join(root, '.claude', 'projects', 'broken.jsonl'),
    );

    const missingProviderSession = await resolveTaskSession(store, missingProvider.id);
    expect(missingProviderSession.warnings).toEqual(['provider_missing']);
    const missingStoredSession = await resolveTaskSession(store, missingSession.id);
    expect(missingStoredSession.warnings).toEqual(['session_missing']);
    const missingPathSession = await resolveTaskSession(store, missingPath.id, {
      homeDirectory: root,
    });
    expect(missingPathSession.warnings).toEqual(['session_path_not_found']);
    store.close();
  });

  it('uses provider-specific session roots from environment overrides', () => {
    expect(
      getAgentProvider('claude').sessionSearchRoots({
        homeDirectory: '/home',
        environment: { CLAUDE_CONFIG_DIR: '/claude-config' },
      }),
    ).toEqual(['/claude-config/projects']);
    expect(
      getAgentProvider('codex').sessionSearchRoots({
        homeDirectory: '/home',
        environment: { CODEX_HOME: '/codex-home' },
      }),
    ).toEqual(['/codex-home/sessions']);
  });
});

describe('buildSkillInvocation', () => {
  const cwd = '/project';
  const prompt = 'Review this pull request and approve it.';

  it('builds a claude invocation with the workflow system prompt appended', () => {
    const result = buildSkillInvocation('claude', { cwd, prompt });
    expect(result.cwd).toBe(cwd);
    expect(result.environment).toEqual({});
    expect(result.command[0]).toBe('claude');
    expect(result.command).toContain('--append-system-prompt');
    const systemPromptIndex = result.command.indexOf('--append-system-prompt');
    expect(result.command[systemPromptIndex + 1]).toContain('workflow skill');
    // prompt is the last argument
    expect(result.command[result.command.length - 1]).toBe(prompt);
    // no plan mode flags by default
    expect(result.command).not.toContain('--permission-mode');
  });

  it('builds a claude invocation with planMode=true', () => {
    const result = buildSkillInvocation('claude', { cwd, prompt, planMode: true });
    expect(result.command).toContain('--permission-mode');
    expect(result.command).toContain('plan');
  });

  it('builds a claude invocation with a session id', () => {
    const result = buildSkillInvocation('claude', { cwd, prompt, session: 'my-session' });
    expect(result.command).toContain('--session-id');
    const sessionIndex = result.command.indexOf('--session-id');
    expect(result.command[sessionIndex + 1]).toBe('my-session');
  });

  it('omits --session-id when session is null', () => {
    const result = buildSkillInvocation('claude', { cwd, prompt, session: null });
    expect(result.command).not.toContain('--session-id');
  });

  it('builds a codex invocation with the workflow system prompt embedded', () => {
    const result = buildSkillInvocation('codex', { cwd, prompt });
    expect(result.cwd).toBe(cwd);
    expect(result.environment).toEqual({});
    expect(result.command[0]).toBe('codex');
    expect(result.command).toContain('--cd');
    const cdIndex = result.command.indexOf('--cd');
    expect(result.command[cdIndex + 1]).toBe(cwd);
    // The final argument is the combined prompt
    const finalArg = result.command[result.command.length - 1]!;
    expect(finalArg).toContain('workflow skill');
    expect(finalArg).toContain(prompt);
  });

  it('builds a codex invocation with planMode=true prefixed with /plan', () => {
    const result = buildSkillInvocation('codex', { cwd, prompt, planMode: true });
    const finalArg = result.command[result.command.length - 1]!;
    expect(finalArg).toStartWith('/plan ');
  });

  it('builds a codex invocation without /plan prefix when planMode is false', () => {
    const result = buildSkillInvocation('codex', { cwd, prompt, planMode: false });
    const finalArg = result.command[result.command.length - 1]!;
    expect(finalArg).not.toStartWith('/plan ');
  });

  it('rejects an unknown provider', () => {
    expect(() => buildSkillInvocation('vim' as 'claude', { cwd, prompt })).toThrow(ScrumlordError);
  });
});
