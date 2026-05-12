import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentHook } from './agent-hook';
import type { CommandRunner } from './command-runner';
import type { AgentProvider, Task, TaskReference, TaskStore, UpdateTaskInput } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-agent-hook-'));
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
  branch: 'feature/current',
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

const referenceId = (reference: TaskReference): string =>
  typeof reference === 'string' ? reference : reference.id;

const unexpected = (): never => {
  throw new Error('Unexpected store method call.');
};

const store = (projectRoot: string, tasks: Task[], calls: string[]): TaskStore => ({
  projectRoot,
  databasePath: join(projectRoot, 'tmp/tasks.db'),
  create: unexpected,
  update(id: string, input: UpdateTaskInput) {
    calls.push(`update:${id}:${input.branch ?? ''}:${input.status ?? ''}`);
    return task(id, input);
  },
  delete: unexpected,
  archive: unexpected,
  restore: unexpected,
  getTask(id: string) {
    calls.push(`getTask:${id}`);
    return tasks.find((item) => item.id === id) ?? null;
  },
  list: unexpected,
  available: unexpected,
  blocked: unexpected,
  completed: unexpected,
  withTag: unexpected,
  withAllTags: unexpected,
  withAnyTag: unexpected,
  withBranch(branch: string) {
    calls.push(`withBranch:${branch}`);
    return tasks.filter((item) => item.branch === branch);
  },
  blockedBy: unexpected,
  blocking: unexpected,
  withPriority: unexpected,
  next: unexpected,
  cleanup: unexpected,
  addTag: unexpected,
  removeTag: unexpected,
  setParent(id, parent) {
    calls.push(`setParent:${id}:${referenceId(parent)}`);
    return task(id);
  },
  clearParent: unexpected,
  addBlocker: unexpected,
  removeBlocker: unexpected,
  setPlan(id: string, plan: string | null) {
    calls.push(`setPlan:${id}:${plan ?? ''}`);
    return task(id, { plan });
  },
  setSession(id: string, provider: AgentProvider, session: string | null) {
    calls.push(`setSession:${id}:${provider}:${session ?? ''}`);
    return task(id, { provider, session });
  },
  withSession(provider: AgentProvider, session: string) {
    calls.push(`withSession:${provider}:${session}`);
    return tasks.filter((item) => item.provider === provider && item.session === session);
  },
  taskSession: unexpected,
  progress: unexpected,
  addProgress: unexpected,
  close() {},
});

const branchRunner =
  (branch: string): CommandRunner =>
  async (command) => {
    const rendered = command.join(' ');
    if (rendered === 'git branch --show-current') {
      return { exitCode: 0, stdout: `${branch}\n`, stderr: '' };
    }
    if (rendered === 'git worktree list --porcelain') {
      return {
        exitCode: 0,
        stdout: `worktree /worktree\nbranch refs/heads/${branch}\n`,
        stderr: '',
      };
    }
    if (command[0] === 'gh') return { exitCode: 1, stdout: '', stderr: '' };
    return { exitCode: 1, stdout: '', stderr: 'unexpected' };
  };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('runAgentHook', () => {
  it('skips invalid payloads and unresolved tasks without throwing', async () => {
    const root = await temporaryDirectory();
    expect(await runAgentHook(store(root, [], []), 'codex', '[]')).toEqual({
      taskId: null,
      actions: [],
      skipped: 'invalid_payload',
      context: null,
    });
    expect(await runAgentHook(store(root, [], []), 'codex', '{')).toEqual({
      taskId: null,
      actions: [],
      skipped: 'invalid_payload',
      context: null,
    });
    expect(await runAgentHook(store(root, [], []), 'codex', '{}')).toEqual({
      taskId: null,
      actions: [],
      skipped: 'task_not_resolved',
      context: null,
    });
  });

  it('captures Claude sessions, branches, and ExitPlanMode plans', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/old' })], calls),
      'claude',
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'ExitPlanMode',
        session_id: 'claude-session',
        tool_input: { plan: '# Updated plan' },
        tool_result: { command: 'git switch feature/current' },
      }),
      {
        environment: { SCRUMLORD_TASK_ID: 'task-id' },
        runner: branchRunner('feature/current'),
      },
    );

    expect(result).toEqual({
      taskId: 'task-id',
      actions: ['set-session', 'set-branch', 'set-plan'],
      skipped: null,
      context: null,
    });
    expect(calls).toContain('setSession:task-id:claude:claude-session');
    expect(calls).toContain('update:task-id:feature/current:');
    expect(calls).toContain('setPlan:task-id:tmp/tasks/task-id/PLAN.md');
    expect(await Bun.file(join(root, 'tmp/tasks/task-id/PLAN.md')).text()).toBe('# Updated plan');
  });

  it('injects current task context for UserPromptSubmit hooks resolved from the branch', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(
        root,
        [
          task('task-id', {
            title: 'Record task progress',
            description: 'Add task progress context to agent hooks.',
            plan: 'tmp/tasks/task-id/PLAN.md',
            tags: ['automation', 'hooks'],
          }),
        ],
        calls,
      ),
      'codex',
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'What is next?' }),
      { runner: branchRunner('feature/current') },
    );

    expect(result).toEqual({
      taskId: 'task-id',
      actions: [],
      skipped: null,
      context: expect.stringContaining('Scrumlord inferred this task for the current branch.'),
    });
    expect(result.context).toContain('id: task-id');
    expect(result.context).toContain('title: Record task progress');
    expect(result.context).toContain('plan: tmp/tasks/task-id/PLAN.md');
    expect(result.context).toContain('tasks add-progress --message "<note>"');
    expect(calls).toContain('withBranch:feature/current');
  });

  it('captures Codex Stop output plans for a task resolved by session', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { provider: 'codex', session: 'codex-session' })], calls),
      'codex',
      JSON.stringify({
        event: 'Stop',
        sessionId: 'codex-session',
        output: '# Codex plan',
      }),
    );

    expect(result.actions).toEqual(['set-plan']);
    expect(calls).toContain('withSession:codex:codex-session');
    expect(await Bun.file(join(root, 'tmp/tasks/task-id/PLAN.md')).text()).toBe('# Codex plan');
  });

  it('updates branch state and synchronizes pull request lifecycle for git commands', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'codex',
      JSON.stringify({
        event: 'PostToolUse',
        command: 'gh pr create --fill',
      }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toEqual(['sync-git-status']);
    expect(calls).toContain('withBranch:feature/current');
    expect(calls).toContain('update:task-id::in-progress');
  });

  it('records branch lookup failures as non-blocking hook actions', async () => {
    const root = await temporaryDirectory();
    const result = await runAgentHook(
      store(root, [task('task-id')], []),
      'claude',
      JSON.stringify({ event: 'PostToolUse', command: 'git switch feature/missing' }),
      {
        environment: { SCRUMLORD_TASK_ID: 'task-id' },
        runner: async () => ({ exitCode: 1, stdout: '', stderr: 'detached' }),
      },
    );

    expect(result).toEqual({
      taskId: 'task-id',
      actions: ['branch-unavailable'],
      skipped: null,
      context: null,
    });
  });
});
