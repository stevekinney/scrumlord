import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';
import { TELEPORT_SHELL_SNIPPET } from './cli-teleport-command';
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

const fakeStore = (): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create: () => task('created'),
  update: (id, input) => task(id, input),
  delete: (id) => task(id),
  getTask: () => null,
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
  allIds: () => [],
  allTags: () => [],
  ...emptyProgressStoreMethods,
  close: () => undefined,
});

const cli = (args: string[]) => runTasksCli(args, { createStore: async () => fakeStore() });

describe('tasks setup --shell', () => {
  it('prints the snippet to stdout with exit 0 and empty stderr', async () => {
    const result = await cli(['setup', '--shell']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('tasks-teleport()');
  });

  it('snippet output matches TELEPORT_SHELL_SNIPPET', async () => {
    const result = await cli(['setup', '--shell']);
    const expectedContent = TELEPORT_SHELL_SNIPPET.endsWith('\n')
      ? TELEPORT_SHELL_SNIPPET
      : `${TELEPORT_SHELL_SNIPPET}\n`;
    expect(result.stdout).toBe(expectedContent);
  });

  it('rejects --shell combined with another mode flag (setup_mode_conflict)', async () => {
    const result = await cli(['setup', '--shell', '--skills']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_mode_conflict');
  });

  it('rejects --shell combined with --project (setup_shell_unexpected_flag)', async () => {
    const result = await cli(['setup', '--shell', '--project']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--project');
  });

  it('rejects --shell combined with --user', async () => {
    const result = await cli(['setup', '--shell', '--user']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--user');
  });

  it('rejects --shell combined with --local', async () => {
    const result = await cli(['setup', '--shell', '--local']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--local');
  });

  it('rejects --shell combined with --claude', async () => {
    const result = await cli(['setup', '--shell', '--claude']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--claude');
  });

  it('rejects --shell combined with --codex', async () => {
    const result = await cli(['setup', '--shell', '--codex']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--codex');
  });

  it('rejects --shell combined with --yes', async () => {
    const result = await cli(['setup', '--shell', '--yes']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--yes');
  });

  it('rejects --shell combined with --all', async () => {
    const result = await cli(['setup', '--shell', '--all']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--all');
  });

  it('rejects --shell combined with --agent', async () => {
    const result = await cli(['setup', '--shell', '--agent', 'claude']);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('setup_shell_unexpected_flag');
    expect(parsed.error.message).toContain('--agent');
  });
});
