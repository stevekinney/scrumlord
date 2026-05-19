import { describe, expect, it } from 'bun:test';
import {
  clearTaskBranch,
  clearTaskPlan,
  clearTaskSession,
  setTaskBranch,
  setTaskStatus,
} from './index';
import type { Task, TaskStore, UpdateTaskInput } from './index';

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

const updatedTask = (id: string, input: UpdateTaskInput): Task => {
  return task(id, {
    branch: 'branch' in input ? (input.branch ?? null) : null,
    provider: 'provider' in input ? (input.provider ?? null) : null,
    session: 'session' in input ? (input.session ?? null) : null,
    status: input.status ?? 'ready',
  });
};

describe('task lifecycle package helpers', () => {
  it('exports focused helpers for task status and lifecycle metadata', () => {
    expect(
      [setTaskStatus, setTaskBranch, clearTaskBranch, clearTaskPlan, clearTaskSession].every(
        (method) => typeof method === 'function',
      ),
    ).toBe(true);
  });

  it('routes status, branch, and session helpers through update', () => {
    const calls: string[] = [];
    const store: Pick<TaskStore, 'update'> = {
      update(id, input) {
        calls.push(JSON.stringify({ id, input }));
        return updatedTask(id, input);
      },
    };

    expect(setTaskStatus(store, 'task-id', 'completed').status).toBe('completed');
    expect(setTaskBranch(store, 'task-id', 'feature/task-graph').branch).toBe('feature/task-graph');
    expect(clearTaskBranch(store, 'task-id').branch).toBeNull();
    expect(clearTaskSession(store, 'task-id')).toMatchObject({ provider: null, session: null });
    expect(calls).toContain(JSON.stringify({ id: 'task-id', input: { status: 'completed' } }));
    expect(calls).toContain(
      JSON.stringify({ id: 'task-id', input: { branch: 'feature/task-graph' } }),
    );
    expect(calls).toContain(JSON.stringify({ id: 'task-id', input: { branch: null } }));
    expect(calls).toContain(
      JSON.stringify({ id: 'task-id', input: { provider: null, session: null } }),
    );
  });

  it('routes plan clearing through the task plan helper', () => {
    const store: Pick<TaskStore, 'setPlan'> = {
      setPlan(id, plan) {
        return task(id, { plan });
      },
    };

    expect(clearTaskPlan(store, 'task-id').plan).toBeNull();
  });
});
