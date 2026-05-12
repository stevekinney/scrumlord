import type { TaskStore } from './types.js';

export const emptyProgressStoreMethods = {
  progress: () => [],
  addProgress: (id, input) => ({
    id: 'progress-id',
    taskId: id,
    message: input.message,
    createdAt: '2026-05-11T00:00:00.000Z',
    provider: input.provider ?? null,
    session: input.session ?? null,
  }),
} satisfies Pick<TaskStore, 'progress' | 'addProgress'>;
