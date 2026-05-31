import type { Task, TaskStore } from './types.js';

/** Returns every distinct tag used in the current project, sorted and deduped. */
export const allTags = (store: Pick<TaskStore, 'allTags'>): string[] => {
  return store.allTags();
};

/** Returns every distinct tag used across all projects, sorted and deduped. */
export const allTagsAcrossProjects = (
  store: Pick<TaskStore, 'allTagsAcrossProjects'>,
): string[] => {
  return store.allTagsAcrossProjects();
};

/** Returns the first available task from a task store. */
export const next = (store: Pick<TaskStore, 'next'>): Task | null => {
  return store.next();
};

/** Returns the first available task from a task store. */
export const nextTask = next;

/** Counts active unfinished tasks, including tasks scheduled for the future. */
export const remaining = (store: Pick<TaskStore, 'remaining'>): number => {
  return store.remaining();
};

/** Counts active unfinished tasks, including tasks scheduled for the future. */
export const remainingTasks = remaining;
