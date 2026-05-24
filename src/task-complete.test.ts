import { describe, expect, it } from 'bun:test';
import { completeTasks } from './task-commands';
import { createTaskStore } from './database-open';
import { ScrumlordError } from './errors';
import { workspaceRoot } from './github-test-helpers';
import type { TaskStore } from './types';

const withStore = async (run: (store: TaskStore) => void): Promise<void> => {
  const store = await createTaskStore({ cwd: await workspaceRoot() });
  try {
    run(store);
  } finally {
    store.close();
  }
};

describe('completeTasks', () => {
  it('marks multiple tasks completed and returns them', async () => {
    await withStore((store) => {
      const first = store.create({ title: 'First', status: 'ready' });
      const second = store.create({ title: 'Second', status: 'in-progress' });

      const result = completeTasks(store, [first.id, second.id]);

      expect(result.map((task) => task.status)).toEqual(['completed', 'completed']);
      expect(store.getTask(first.id)?.status).toBe('completed');
      expect(store.getTask(second.id)?.status).toBe('completed');
    });
  });

  it('deduplicates resolved ids preserving first-seen order', async () => {
    await withStore((store) => {
      const first = store.create({ title: 'First', status: 'ready' });
      const second = store.create({ title: 'Second', status: 'ready' });

      const result = completeTasks(store, [second.id, first.id, second.id]);

      expect(result.map((task) => task.id)).toEqual([second.id, first.id]);
    });
  });

  it('returns already-completed tasks unchanged without re-writing them', async () => {
    await withStore((store) => {
      const task = store.create({ title: 'Done', status: 'ready' });
      const completed = store.update(task.id, { status: 'completed' });

      const result = completeTasks(store, [task.id]);

      expect(result[0]?.status).toBe('completed');
      // No write occurred: lastModifiedAt is unchanged from the prior completion.
      expect(result[0]?.lastModifiedAt).toBe(completed.lastModifiedAt);
    });
  });

  it('throws and writes nothing when any id is missing', async () => {
    await withStore((store) => {
      const task = store.create({ title: 'Present', status: 'ready' });

      expect(() => completeTasks(store, [task.id, 'missing-id'])).toThrow(ScrumlordError);
      // The present task was not mutated because the read phase failed first.
      expect(store.getTask(task.id)?.status).toBe('ready');
    });
  });

  it('rejects completing a soft-deleted task and leaves the batch unwritten', async () => {
    await withStore((store) => {
      const live = store.create({ title: 'Live', status: 'ready' });
      const removed = store.create({ title: 'Removed', status: 'ready' });
      store.delete(removed.id);

      let error: unknown;
      try {
        completeTasks(store, [live.id, removed.id]);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ScrumlordError);
      expect((error as ScrumlordError).code).toBe('cannot_complete_deleted');
      expect(store.getTask(live.id)?.status).toBe('ready');
    });
  });
});
