/* eslint-disable max-lines */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bun as BunGlobal } from 'bun';
import { createTaskStore } from './database-open';
import { ScrumlordError } from './errors';
import { searchTasks } from './task-search';
import type { Task, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-search-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'init'], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const createStore = async (): Promise<{ root: string; store: TaskStore }> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  const store = await createTaskStore({ cwd: root });
  return { root, store };
};

const taskIds = (tasks: Task[]): string[] => tasks.map((t) => t.id);

describe('searchTasks — default mode', () => {
  it('finds an exact substring match (score 0) in title', async () => {
    const { store } = await createStore();
    store.create({ title: 'Authentication service' });
    store.create({ title: 'Unrelated feature' });

    const results = searchTasks(store, { kind: 'default', query: 'authentication' });
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Authentication service');
  });

  it('finds one-char typo in title (insertion)', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Authentication service' });

    // "authenticaton" is a deletion of one char — distance 1, ratio 1/14 ≈ 0.07 < 0.5
    const results = searchTasks(store, { kind: 'default', query: 'authenticaton' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });

  it('finds one-char typo in title (substitution)', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Fix database connection' });

    // "databse" → distance 1, ratio 1/8 = 0.125 < 0.5
    const results = searchTasks(store, { kind: 'default', query: 'databse' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });

  it('matches when query tokens are in different order', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Login timeout fix' });

    const results = searchTasks(store, { kind: 'default', query: 'timeout login' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });

  it('returns empty array when nothing matches', async () => {
    const { store } = await createStore();
    store.create({ title: 'Unrelated feature' });

    const results = searchTasks(store, { kind: 'default', query: 'xyzzy' });
    expect(results).toHaveLength(0);
  });

  it('matches when the query term is only in the description', async () => {
    const { store } = await createStore();
    const task = store.create({
      title: 'Fix the thing',
      description: 'There is a race condition in the scheduler',
    });

    const results = searchTasks(store, { kind: 'default', query: 'scheduler' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });

  it('matches cross-field: tokens split across title and description', async () => {
    const { store } = await createStore();
    const task = store.create({
      title: 'Login failure',
      description: 'Timeout on mobile',
    });
    store.create({ title: 'Unrelated task', description: 'Nothing here' });

    // "login" is in title, "timeout" is in description — combined doc search finds both
    const results = searchTasks(store, { kind: 'default', query: 'login timeout' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });

  it('handles diacritic normalization', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Café Tasks cleanup' });

    const results = searchTasks(store, { kind: 'default', query: 'cafe' });
    expect(results.map((t) => t.id)).toContain(task.id);
  });
});

describe('searchTasks — field mode', () => {
  it('finds a match scoped to the title field', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Login service', description: 'some description' });
    store.create({ title: 'Unrelated', description: 'login integration details' });

    // Only title should be searched; the second task has "login" in description only
    const results = searchTasks(store, { kind: 'field', queries: { title: 'login' } });
    expect(taskIds(results)).toEqual([task.id]);
  });

  it('does NOT match cross-field in field mode', async () => {
    const { store } = await createStore();
    store.create({ title: 'Login failure', description: 'Timeout on mobile' });

    // "login timeout" as a single title query — "timeout" isn't in the title alone
    const results = searchTasks(store, { kind: 'field', queries: { title: 'login timeout' } });
    expect(results).toHaveLength(0);
  });

  it('does not return a row where only the description matches when title-only mode', async () => {
    const { store } = await createStore();
    store.create({ title: 'Unrelated', description: 'authentication details here' });

    const results = searchTasks(store, { kind: 'field', queries: { title: 'authentication' } });
    expect(results).toHaveLength(0);
  });

  it('intersects field queries — both must match', async () => {
    const { store } = await createStore();
    const both = store.create({
      title: 'Login service',
      description: 'Timeout fix needed',
    });
    store.create({ title: 'Login page', description: 'UI improvements' }); // title matches, description doesn't
    store.create({ title: 'DB fix', description: 'Timeout in queries' }); // description matches, title doesn't

    const results = searchTasks(store, {
      kind: 'field',
      queries: { title: 'login', description: 'timeout' },
    });
    expect(taskIds(results)).toEqual([both.id]);
  });

  it('ranks by average score across fields', async () => {
    const { store } = await createStore();
    // strongBoth: both fields score very well (exact matches)
    const strongBoth = store.create({
      id: 'strong-both',
      title: 'Login failure',
      description: 'Timeout error',
    });
    // weakDesc: title strong, description weaker match
    const weakDesc = store.create({
      id: 'weak-desc',
      title: 'Login issue',
      description: 'Some timeouts in the network layer on slow connections perhaps',
    });

    const results = searchTasks(store, {
      kind: 'field',
      queries: { title: 'login', description: 'timeout' },
    });
    // strongBoth should rank ahead of weakDesc (lower average score)
    const ids = taskIds(results);
    expect(ids.indexOf(strongBoth.id)).toBeLessThan(ids.indexOf(weakDesc.id));
  });
});

describe('searchTasks — sorting', () => {
  it('sorts by score ascending (best match first)', async () => {
    const { store } = await createStore();
    const exact = store.create({ id: 'exact', title: 'authentication' });
    const typo = store.create({ id: 'typo', title: 'authenticaton service' });

    const results = searchTasks(store, { kind: 'default', query: 'authentication' });
    const ids = taskIds(results);
    expect(ids.indexOf(exact.id)).toBeLessThan(ids.indexOf(typo.id));
  });

  it('breaks score ties by priority descending', async () => {
    const { store } = await createStore();
    const low = store.create({ id: 'low', title: 'authentication fix', priority: 1 });
    const high = store.create({ id: 'high', title: 'authentication fix', priority: 3 });

    const results = searchTasks(store, { kind: 'default', query: 'authentication fix' });
    const ids = taskIds(results);
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });

  it('breaks score+priority ties by createdAt ascending', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => now });

    const first = store.create({ id: 'first', title: 'authentication fix', priority: 1 });
    now = new Date('2026-06-01T00:00:00.000Z');
    const second = store.create({ id: 'second', title: 'authentication fix', priority: 1 });

    const results = searchTasks(store, { kind: 'default', query: 'authentication fix' });
    const ids = taskIds(results);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
  });

  it('breaks all ties by id as final deterministic tie-breaker', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const fixedDate = new Date('2026-01-01T00:00:00.000Z');
    const store = await createTaskStore({ cwd: root, now: () => fixedDate });

    // Same title, same priority, same timestamp — id is the tie-breaker
    const taskA = store.create({ id: 'aaa-id', title: 'authentication fix', priority: 1 });
    const taskB = store.create({ id: 'bbb-id', title: 'authentication fix', priority: 1 });

    const results = searchTasks(store, { kind: 'default', query: 'authentication fix' });
    const ids = taskIds(results);
    expect(ids.indexOf(taskA.id)).toBeLessThan(ids.indexOf(taskB.id));
  });
});

describe('searchTasks — count option', () => {
  it('returns a number when count is true', async () => {
    const { store } = await createStore();
    store.create({ title: 'Authentication fix' });
    store.create({ title: 'Authentication improvements' });

    const result = searchTasks(
      store,
      { kind: 'default', query: 'authentication' },
      { count: true },
    );
    expect(result).toBe(2);
  });
});

describe('searchTasks — plan filter', () => {
  it('--planned excludes tasks with no plan', async () => {
    const { root, store } = await createStore();
    const planPath = join(root, 'plan.md');
    await Bun.write(planPath, '# Plan\n');
    store.create({ title: 'Authentication fix', plan: planPath });
    store.create({ title: 'Authentication improvements' });

    const results = searchTasks(
      store,
      { kind: 'default', query: 'authentication' },
      { plan: 'planned' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.plan).not.toBeNull();
  });

  it('--unplanned excludes tasks with a plan', async () => {
    const { root, store } = await createStore();
    const planPath = join(root, 'plan.md');
    await Bun.write(planPath, '# Plan\n');
    store.create({ title: 'Authentication fix', plan: planPath });
    store.create({ title: 'Authentication improvements' });

    const results = searchTasks(
      store,
      { kind: 'default', query: 'authentication' },
      { plan: 'unplanned' },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.plan).toBeNull();
  });
});

describe('searchTasks — includeInactive', () => {
  it('excludes soft-deleted tasks by default', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Authentication fix' });
    store.delete(task.id);

    const results = searchTasks(store, { kind: 'default', query: 'authentication' });
    expect(taskIds(results)).not.toContain(task.id);
  });

  it('includes soft-deleted tasks when includeInactive is true', async () => {
    const { store } = await createStore();
    const task = store.create({ title: 'Authentication fix' });
    store.delete(task.id);

    const results = searchTasks(
      store,
      { kind: 'default', query: 'authentication' },
      { includeInactive: true },
    );
    expect(taskIds(results)).toContain(task.id);
  });
});

describe('searchTasks — input validation', () => {
  it('throws empty_search_query for whitespace-only default query', async () => {
    const { store } = await createStore();

    expect(() => searchTasks(store, { kind: 'default', query: '   ' })).toThrow(ScrumlordError);

    try {
      searchTasks(store, { kind: 'default', query: '   ' });
    } catch (error) {
      expect(error instanceof ScrumlordError && error.code).toBe('empty_search_query');
    }
  });

  it('throws empty_search_query for whitespace-only field value', async () => {
    const { store } = await createStore();

    expect(() => searchTasks(store, { kind: 'field', queries: { title: '   ' } })).toThrow(
      ScrumlordError,
    );

    try {
      searchTasks(store, { kind: 'field', queries: { title: '   ' } });
    } catch (error) {
      expect(error instanceof ScrumlordError && error.code).toBe('empty_search_query');
    }
  });

  it('throws empty_search_query for empty field queries object', async () => {
    const { store } = await createStore();

    expect(() => searchTasks(store, { kind: 'field', queries: {} })).toThrow(ScrumlordError);
  });
});

describe('searchTasks — scorer edge cases', () => {
  it('a very long haystack token does not produce an artificially tiny ratio (token clip)', async () => {
    const { store } = await createStore();
    const longToken = 'x'.repeat(10_000);
    store.create({ title: longToken });

    // Short query "auth" should not match the 10k-char unrelated token
    const results = searchTasks(store, { kind: 'default', query: 'auth' });
    expect(results).toHaveLength(0);
  });

  it('reverse containment guard: short haystack token does not match long unrelated query', async () => {
    const { store } = await createStore();
    store.create({ title: 'a task' }); // haystack token "a" (length 1 < MIN_TOKEN_LEN)
    store.create({ title: 'id verification' }); // haystack token "id" (length 2 < MIN_TOKEN_LEN)

    // "authentication" as query — should NOT match "a" or "id" as haystack tokens
    const results = searchTasks(store, { kind: 'default', query: 'authentication' });
    expect(results).toHaveLength(0);
  });

  it('allowed reverse containment: haystack token of sufficient length and ratio', async () => {
    const { store } = await createStore();
    // "log" is 3 chars (≥ MIN_TOKEN_LEN), ratio 3/5 = 0.6 ≥ 0.5 → containment allowed
    const task = store.create({ title: 'log viewer' });

    const results = searchTasks(store, { kind: 'default', query: 'login' });
    expect(taskIds(results)).toContain(task.id);
  });

  it('forward containment via clipped query token (t.includes(clipped_q))', async () => {
    const { store } = await createStore();
    // Haystack token: "reauthentication" (a longer word containing a prefix of our long query)
    // Query token must be >256 chars so it gets clipped; the clipped prefix is found in the haystack token.
    const longPrefix = 'reauth'; // what haystackFull will NOT include in full
    // Construct a query token > 256 chars that starts with "reauth" so the clipped version is "reauth...x...x"
    // but haystackFull only contains "reauthentication" so haystackFull.includes(fullQuery) is false.
    const longQueryToken = 'reauth' + 'z'.repeat(260); // 266 chars; clips to 256 = "reauth" + 250 z's
    // The haystack token "reauthentication" does NOT include "reauthzzzz..." (full), so line 52 misses.
    // Clipped to 256 chars: "reauthzzzz..." — "reauthentication".includes("reauthzzz...") is false too.
    // Actually the forward containment t.includes(q) where t = "reauthentication" and q = "reauth"+"z"*250 is false.
    // Let's rethink: we need haystackFull.includes(queryToken) = false but t.includes(q) = true.
    // That requires q (clipped) ≠ queryToken (unclipped) AND t.includes(q) but not t.includes(queryToken).
    // Example: queryToken = "reauthentication" + "x"*300 (> 256 chars)
    //          q = "reauthentication" + "x"*240 (clipped to 256)
    //          t = haystack token = "reauthentication" + "x"*240 + "extra"
    //          haystackFull contains t, so haystackFull.includes(queryToken) is false
    //          but t.includes(q) is true → line 57-59 fires.
    const clipped = 'atoken' + 'x'.repeat(250); // exactly 256 chars
    const fullQuery = clipped + 'yyy'; // 259 chars — gets clipped to 256 = clipped
    const haystackToken = clipped + 'extra'; // haystack token contains the clipped prefix
    const task = store.create({ title: haystackToken });

    const results = searchTasks(store, { kind: 'default', query: fullQuery });
    expect(taskIds(results)).toContain(task.id);
    // Drop the task to clean state for other tests
    store.delete(task.id, { hard: true });
  });

  it('reverse containment blocked when ratio is below 0.5', async () => {
    const { store } = await createStore();
    // "auth" is 4 chars, query "authentication" is 14 chars: ratio 4/14 ≈ 0.286 < 0.5 → blocked
    store.create({ title: 'auth service' });

    // "auth" substring check: scoreToken checks t.includes(q) first — "auth".includes("authentication") is false.
    // Then reverse: q.includes(t) = "authentication".includes("auth") = true, but 4/14 < 0.5 → blocked.
    // Levenshtein fallthrough: distance between "authentication" and "auth" is 10, ratio 10/14 ≈ 0.71 ≥ 0.5 → no match.
    const results = searchTasks(store, { kind: 'default', query: 'authentication' });
    expect(results).toHaveLength(0);
  });
});
