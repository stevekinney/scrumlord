import { afterEach, describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrumlordError } from './errors';
import { createScrumlordMcpServer } from './mcp-server';
import type { Task, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-mcp-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
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

const connectClient = async (cwd: string) => {
  const server = createScrumlordMcpServer({ cwd });
  const client = new Client({ name: 'scrumlord-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
};

const callTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  if (!result.structuredContent) throw new Error(`Missing structured content for ${name}.`);
  return result.structuredContent;
};

const callErrorTool = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  if (!result.structuredContent) throw new Error(`Missing structured error content for ${name}.`);
  return result.structuredContent;
};

const hasTask = (structuredContent: Record<string, unknown>, id: string): boolean => {
  const tasks = structuredContent.tasks;
  return Array.isArray(tasks) && tasks.some((item) => typeof item === 'object' && item?.id === id);
};

const failingAvailableStore = (calls: string[]): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  create(input) {
    return task('created', { title: input.title });
  },
  update(id, input) {
    return task(id, input);
  },
  delete(id) {
    return task(id, { deleted: true });
  },
  archive(id) {
    return task(id, { archived: true });
  },
  restore(id) {
    return task(id);
  },
  getTask(id) {
    return task(id);
  },
  list() {
    return [];
  },
  available() {
    calls.push('available');
    throw new ScrumlordError('available_failed', 'Available failed.');
  },
  blocked() {
    return [];
  },
  completed() {
    return [];
  },
  withTag() {
    return [];
  },
  withAllTags() {
    return [];
  },
  withAnyTag() {
    return [];
  },
  withBranch() {
    return [];
  },
  blockedBy() {
    return [];
  },
  blocking() {
    return [];
  },
  withPriority() {
    return [];
  },
  next() {
    return null;
  },
  remaining() {
    return 0;
  },
  cleanup() {
    return { deleted: 0 };
  },
  addTag(id, tag) {
    return task(id, { tags: [tag] });
  },
  removeTag(id) {
    return task(id);
  },
  setParent(id, parent) {
    return task(id, { parent: typeof parent === 'string' ? parent : parent.id });
  },
  clearParent(id) {
    return task(id);
  },
  addBlocker(id, blockedBy) {
    return task(id, { blockedBy: [typeof blockedBy === 'string' ? blockedBy : blockedBy.id] });
  },
  removeBlocker(id) {
    return task(id);
  },
  setPlan(id, plan) {
    return task(id, { plan });
  },
  setSession(id, provider, session) {
    return task(id, { provider, session });
  },
  withSession(provider, session) {
    return [task('with-session', { provider, session })];
  },
  taskSession(id) {
    return { taskId: id, provider: null, session: null, branch: null, plan: null };
  },
  progress() {
    return [];
  },
  addProgress(id, input) {
    return {
      id: 'progress-id',
      taskId: id,
      message: input.message,
      createdAt: '2026-05-11T00:00:00.000Z',
      provider: input.provider ?? null,
      session: input.session ?? null,
    };
  },
  close() {
    calls.push('close');
  },
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('createScrumlordMcpServer', () => {
  it('registers typed Scrumlord task tools', async () => {
    const root = await workspaceRoot();
    const { client, server } = await connectClient(root);
    try {
      const result = await client.listTools();
      const toolNames = result.tools.map((tool) => tool.name);

      expect(toolNames).toContain('scrumlord_available_tasks');
      expect(toolNames).toContain('scrumlord_create_task');
      expect(toolNames).toContain('scrumlord_update_task');
      expect(toolNames).toContain('scrumlord_task_progress');
      expect(toolNames).toContain('scrumlord_add_progress');
      expect(toolNames).toContain('scrumlord_cleanup_tasks');
      expect(result.tools.find((tool) => tool.name === 'scrumlord_create_task')).toMatchObject({
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      });
    } finally {
      await server.close();
    }
  });

  it('manages the task graph through real MCP tool calls', async () => {
    const root = await workspaceRoot();
    const { client, server } = await connectClient(root);
    try {
      await callTool(client, 'scrumlord_create_task', { id: 'blocker', title: 'Blocker' });
      await callTool(client, 'scrumlord_create_task', { id: 'parent', title: 'Parent' });
      const created = await callTool(client, 'scrumlord_create_task', {
        id: 'feature',
        title: 'Feature',
        description: 'Build the feature.',
        priority: 3,
        status: 'ready',
        tags: ['frontend', 'testing'],
        branch: 'feature/mcp',
        blockedBy: ['blocker'],
      });

      expect(created.task).toMatchObject({ id: 'feature', blockedBy: ['blocker'] });
      expect(hasTask(await callTool(client, 'scrumlord_list_tasks'), 'feature')).toBe(true);
      expect(await callTool(client, 'scrumlord_get_task', { id: 'feature' })).toMatchObject({
        task: expect.objectContaining({ id: 'feature' }),
      });
      expect(hasTask(await callTool(client, 'scrumlord_blocked_tasks'), 'feature')).toBe(true);
      expect(
        hasTask(await callTool(client, 'scrumlord_blocked_by', { id: 'feature' }), 'blocker'),
      ).toBe(true);
      expect(
        hasTask(await callTool(client, 'scrumlord_blocking', { id: 'blocker' }), 'feature'),
      ).toBe(true);

      await callTool(client, 'scrumlord_add_tag', { id: 'feature', tag: 'mcp' });
      await callTool(client, 'scrumlord_remove_tag', { id: 'feature', tag: 'frontend' });
      expect(
        hasTask(await callTool(client, 'scrumlord_tasks_with_tag', { tag: 'mcp' }), 'feature'),
      ).toBe(true);
      expect(
        hasTask(
          await callTool(client, 'scrumlord_tasks_with_all_tags', { tags: ['mcp', 'testing'] }),
          'feature',
        ),
      ).toBe(true);
      expect(
        hasTask(
          await callTool(client, 'scrumlord_tasks_with_any_tags', { tags: ['frontend', 'mcp'] }),
          'feature',
        ),
      ).toBe(true);

      await callTool(client, 'scrumlord_set_parent', { id: 'feature', parent: 'parent' });
      expect(await callTool(client, 'scrumlord_get_task', { id: 'feature' })).toMatchObject({
        task: expect.objectContaining({ parent: 'parent' }),
      });
      await callTool(client, 'scrumlord_clear_parent', { id: 'feature' });

      await callTool(client, 'scrumlord_remove_blocker', { id: 'feature', blockedBy: 'blocker' });
      await callTool(client, 'scrumlord_add_blocker', { id: 'feature', blockedBy: 'blocker' });
      expect(
        await callTool(client, 'scrumlord_set_branch', {
          id: 'feature',
          branch: 'feature/mcp-v2',
        }),
      ).toMatchObject({
        task: expect.objectContaining({ branch: 'feature/mcp-v2', status: 'in-progress' }),
      });
      expect(
        hasTask(
          await callTool(client, 'scrumlord_tasks_with_branch', { branch: 'feature/mcp-v2' }),
          'feature',
        ),
      ).toBe(true);
      await callTool(client, 'scrumlord_clear_branch', { id: 'feature' });

      await callTool(client, 'scrumlord_set_plan', {
        id: 'feature',
        plan: 'tmp/tasks/feature/PLAN.md',
      });
      expect(await callTool(client, 'scrumlord_get_task', { id: 'feature' })).toMatchObject({
        task: expect.objectContaining({ plan: 'tmp/tasks/feature/PLAN.md' }),
      });
      await callTool(client, 'scrumlord_clear_plan', { id: 'feature' });

      await callTool(client, 'scrumlord_set_session', {
        id: 'feature',
        provider: 'codex',
        session: 'codex-session',
      });
      expect(
        hasTask(
          await callTool(client, 'scrumlord_tasks_with_session', {
            provider: 'codex',
            session: 'codex-session',
          }),
          'feature',
        ),
      ).toBe(true);
      expect(await callTool(client, 'scrumlord_task_session', { id: 'feature' })).toMatchObject({
        session: expect.objectContaining({ taskId: 'feature', provider: 'codex' }),
      });
      await callTool(client, 'scrumlord_clear_session', { id: 'feature' });

      expect(
        await callTool(client, 'scrumlord_add_progress', {
          id: 'feature',
          message: 'Recorded MCP progress.',
          provider: 'codex',
          session: 'codex-session',
        }),
      ).toMatchObject({
        progress: expect.objectContaining({
          taskId: 'feature',
          message: 'Recorded MCP progress.',
          provider: 'codex',
          session: 'codex-session',
        }),
      });
      expect(await callTool(client, 'scrumlord_task_progress', { id: 'feature' })).toMatchObject({
        progress: [expect.objectContaining({ message: 'Recorded MCP progress.' })],
      });

      expect(hasTask(await callTool(client, 'scrumlord_available_tasks'), 'blocker')).toBe(true);
      expect(await callTool(client, 'scrumlord_next_task')).toMatchObject({
        task: expect.objectContaining({ id: 'blocker' }),
      });
      expect(await callTool(client, 'scrumlord_remaining_tasks')).toMatchObject({ count: 2 });
      expect(
        hasTask(
          await callTool(client, 'scrumlord_tasks_with_priority', { priority: 3 }),
          'feature',
        ),
      ).toBe(true);

      await callTool(client, 'scrumlord_update_task', {
        id: 'feature',
        status: 'completed',
        description: 'Shipped.',
      });
      expect(hasTask(await callTool(client, 'scrumlord_completed_tasks'), 'feature')).toBe(true);
      await callTool(client, 'scrumlord_delete_task', { id: 'feature' });
      expect(
        hasTask(
          await callTool(client, 'scrumlord_list_tasks', { includeInactive: true }),
          'feature',
        ),
      ).toBe(true);
      await callTool(client, 'scrumlord_restore_task', { id: 'feature' });
      await callTool(client, 'scrumlord_archive_task', { id: 'feature' });
      expect(await callTool(client, 'scrumlord_cleanup_tasks', { days: 0 })).toMatchObject({
        deleted: expect.any(Number),
      });
    } finally {
      await server.close();
    }
  });

  it('returns structured MCP errors and closes stores after failures', async () => {
    const calls: string[] = [];
    const store = failingAvailableStore(calls);
    const server = createScrumlordMcpServer({ createStore: async () => store });
    const client = new Client({ name: 'scrumlord-test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      expect(await callErrorTool(client, 'scrumlord_available_tasks')).toMatchObject({
        error: { code: 'available_failed', message: 'Available failed.' },
      });
      expect(calls).toEqual(['available', 'close']);
    } finally {
      await server.close();
    }
  });
});
