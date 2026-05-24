import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactCommand, runAgentHook, toolCallFailed } from './agent-hook';
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
  blocked: false,
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
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
  addProgress(id: string, input: { message: string; event?: string | null }) {
    calls.push(`addProgress:${id}:${input.event ?? 'null'}:${input.message}`);
    return {
      id: crypto.randomUUID(),
      taskId: id,
      message: input.message,
      createdAt: new Date().toISOString(),
      provider: null,
      session: null,
      event: null,
      tool: null,
      cwd: null,
      transcriptPath: null,
      commitSha: null,
    };
  },
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
      actions: ['session-recorded', 'branch-recorded', 'plan-recorded'],
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
    expect(result.context).toContain('tasks progress add --message "<note>"');
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

    expect(result.actions).toEqual(['plan-recorded', 'record-progress']);
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

    expect(result.actions).toEqual(['github-synchronized']);
    expect(calls).toContain('withBranch:feature/current');
    expect(calls).toContain('update:task-id::in-progress');
  });

  it('skips recording when the session is on an integration branch', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/old' })], calls),
      'claude',
      JSON.stringify({ event: 'PostToolUse', command: 'git checkout main' }),
      {
        environment: { SCRUMLORD_TASK_ID: 'task-id' },
        runner: branchRunner('main'),
      },
    );

    expect(result.actions).toContain('branch-skipped-reserved');
    expect(calls.some((call) => call.startsWith('update:task-id:main'))).toBe(false);
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

  it('records session_start progress and transcript_path on SessionStart', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'resume',
        transcript_path: '/home/user/.claude/projects/foo/transcript.jsonl',
      }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toContain('record-progress');
    const progressCall = calls.find((c) => c.startsWith('addProgress:task-id:session_start:'));
    expect(progressCall).toContain('session_start (source=resume)');
  });

  it('records session_stop on Stop and skips on stop_hook_active re-entry', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1' }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toContain('record-progress');

    const calls2: string[] = [];
    const resultReentry = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls2),
      'claude',
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', stop_hook_active: true }),
      { runner: branchRunner('feature/current') },
    );

    expect(resultReentry.actions).not.toContain('record-progress');
  });

  it('records session_end with reason on SessionEnd', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason: 'prompt_input_exit',
      }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toContain('record-progress');
    const progressCall = calls.find((c) => c.startsWith('addProgress:task-id:session_end:'));
    expect(progressCall).toContain('prompt_input_exit');
  });

  it('records subagent-stopped action without a DB write on SubagentStop', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 'sess-1' }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toContain('subagent-stopped');
    expect(calls.some((c) => c.startsWith('addProgress:'))).toBe(false);
  });

  it('records tool_failed progress with redacted command on PostToolUse failure', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: 'curl -H "Authorization: Bearer secret123" https://api.example.com',
        },
        tool_response: { success: false },
      }),
      { runner: branchRunner('feature/current') },
    );

    expect(result.actions).toContain('record-progress');
    const progressCall = calls.find((c) => c.startsWith('addProgress:task-id:tool_failed:'));
    expect(progressCall).toContain('<redacted>');
    expect(progressCall).not.toContain('secret123');
  });

  it('does not record progress for successful PostToolUse', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: { success: true, stdout: 'file.txt' },
      }),
      { runner: branchRunner('feature/current') },
    );

    expect(calls.some((c) => c.startsWith('addProgress:'))).toBe(false);
  });

  it('emits cwd-drift action when payload cwd differs from CLAUDE_PROJECT_DIR', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/other/dir' }),
      {
        runner: branchRunner('feature/current'),
        environment: { SCRUMLORD_TASK_ID: 'task-id', CLAUDE_PROJECT_DIR: '/project/root' },
      },
    );

    expect(result.actions.some((a) => a.startsWith('cwd-drift:'))).toBe(true);
  });

  it('does not emit cwd-drift when cwd matches CLAUDE_PROJECT_DIR', async () => {
    const root = await temporaryDirectory();
    const calls: string[] = [];
    const result = await runAgentHook(
      store(root, [task('task-id', { branch: 'feature/current' })], calls),
      'claude',
      JSON.stringify({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/project/root' }),
      {
        runner: branchRunner('feature/current'),
        environment: { SCRUMLORD_TASK_ID: 'task-id', CLAUDE_PROJECT_DIR: '/project/root' },
      },
    );

    expect(result.actions.some((a) => a.startsWith('cwd-drift:'))).toBe(false);
  });
});

describe('toolCallFailed', () => {
  it('returns false when success is boolean true', () => {
    expect(toolCallFailed({ tool_response: { success: true } })).toBe(false);
  });

  it('returns true when success is boolean false', () => {
    expect(toolCallFailed({ tool_response: { success: false } })).toBe(true);
  });

  it('treats string "false" as success (not a boolean)', () => {
    expect(toolCallFailed({ tool_response: { success: 'false' } })).toBe(false);
  });

  it('returns true when exit_code is nonzero', () => {
    expect(toolCallFailed({ tool_response: { exit_code: 1 } })).toBe(true);
  });

  it('returns false when exit_code is zero', () => {
    expect(toolCallFailed({ tool_response: { exit_code: 0 } })).toBe(false);
  });

  it('returns true when stderr present and stdout absent', () => {
    expect(toolCallFailed({ tool_response: { stderr: 'error' } })).toBe(true);
  });

  it('returns false when stdout present (even with stderr)', () => {
    expect(toolCallFailed({ tool_response: { stderr: 'warning', stdout: 'output' } })).toBe(false);
  });

  it('returns false when no tool_response', () => {
    expect(toolCallFailed({})).toBe(false);
  });
});

describe('redactCommand', () => {
  it('redacts Authorization: Bearer <value>', () => {
    const result = redactCommand(
      'curl -H "Authorization: Bearer mysecret" https://api.example.com',
    );
    expect(result).toContain('Authorization: Bearer <redacted>');
    expect(result).not.toContain('mysecret');
  });

  it('redacts Authorization: <value> (no scheme)', () => {
    const result = redactCommand('curl -H "Authorization: mysecret"');
    expect(result).toContain('Authorization: <redacted>');
    expect(result).not.toContain('mysecret');
  });

  it('redacts Proxy-Authorization header', () => {
    const result = redactCommand('curl -H "Proxy-Authorization: Bearer proxy-secret"');
    expect(result).toContain('Proxy-Authorization: Bearer <redacted>');
    expect(result).not.toContain('proxy-secret');
  });

  it('redacts --token <value>', () => {
    const result = redactCommand('gh api --token mytoken123');
    expect(result).toContain('--token <redacted>');
    expect(result).not.toContain('mytoken123');
  });

  it('redacts --password=<value>', () => {
    const result = redactCommand('login --password=hunter2');
    expect(result).toContain('--password=<redacted>');
    expect(result).not.toContain('hunter2');
  });

  it('redacts --password "quoted value"', () => {
    const result = redactCommand('login --password "a b c"');
    expect(result).not.toContain('a b c');
  });

  it('redacts GITHUB_TOKEN=<value>', () => {
    const result = redactCommand('GITHUB_TOKEN=abc123 curl https://api.github.com');
    expect(result).toContain('GITHUB_TOKEN=<redacted>');
    expect(result).not.toContain('abc123');
  });

  it('redacts lowercase my_token=<value>', () => {
    const result = redactCommand('my_token=secret123 run-deploy');
    expect(result).toContain('my_token=<redacted>');
    expect(result).not.toContain('secret123');
  });

  it('leaves commands without secrets untouched', () => {
    const input = 'git status --short';
    expect(redactCommand(input)).toBe(input);
  });
});
