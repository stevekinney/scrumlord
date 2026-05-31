import { describe, expect, it } from 'bun:test';
import { allTags, allTagsAcrossProjects, next, remaining } from './task-queries.js';

const mockStore = (overrides: Record<string, () => unknown> = {}) =>
  ({
    next: () => null,
    remaining: () => 0,
    allTags: () => [],
    allTagsAcrossProjects: () => [],
    ...overrides,
  }) as any;

describe('next', () => {
  it('delegates to store.next()', () => {
    const task = { id: 'task-1', title: 'A task' } as any;
    expect(next(mockStore({ next: () => task }))).toBe(task);
  });

  it('returns null when the queue is empty', () => {
    expect(next(mockStore())).toBeNull();
  });
});

describe('remaining', () => {
  it('delegates to store.remaining()', () => {
    expect(remaining(mockStore({ remaining: () => 7 }))).toBe(7);
  });

  it('returns 0 when there are no tasks', () => {
    expect(remaining(mockStore())).toBe(0);
  });
});

describe('allTags', () => {
  it('delegates to store.allTags()', () => {
    const tags = ['alpha', 'beta'];
    expect(allTags(mockStore({ allTags: () => tags }))).toEqual(tags);
  });

  it('returns an empty array when no tags exist', () => {
    expect(allTags(mockStore())).toEqual([]);
  });
});

describe('allTagsAcrossProjects', () => {
  it('delegates to store.allTagsAcrossProjects()', () => {
    const tags = ['alpha', 'beta', 'gamma'];
    expect(allTagsAcrossProjects(mockStore({ allTagsAcrossProjects: () => tags }))).toEqual(tags);
  });

  it('returns an empty array when no tags exist across projects', () => {
    expect(allTagsAcrossProjects(mockStore())).toEqual([]);
  });
});
