import { ScrumlordError } from './errors.js';
import type { Task, TaskStore } from './types.js';

export type SearchField = 'title' | 'description';

export type SearchQuery =
  | { kind: 'default'; query: string }
  | { kind: 'field'; queries: Partial<Record<SearchField, string>> };

export type SearchTasksOptions = {
  plan?: 'planned' | 'unplanned';
  includeInactive?: boolean;
};

export type CountSearchTasksOptions = SearchTasksOptions & { count: true };

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

const tokenize = (text: string): string[] =>
  normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

const levenshtein = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  const row: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const diagOrSub = row[j - 1] ?? 0;
      const del = row[j] ?? 0;
      const val = a[i - 1] === b[j - 1] ? diagOrSub : Math.min(diagOrSub, del, prev) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  return row[n] ?? 0;
};

const TOKEN_CLIP = 256;
const MIN_TOKEN_LEN = 3;
const TOKEN_THRESHOLD = 0.5;

const scoreToken = (queryToken: string, haystackTokens: string[], haystackFull: string): number => {
  if (haystackFull.includes(queryToken)) return 0;
  const q = queryToken.slice(0, TOKEN_CLIP);
  let best = 1;
  for (const raw of haystackTokens) {
    const t = raw.slice(0, TOKEN_CLIP);
    if (t.includes(q)) {
      best = Math.min(best, 0.05);
      continue;
    }
    if (t.length >= MIN_TOKEN_LEN && t.length / q.length >= 0.5 && q.includes(t)) {
      best = Math.min(best, 0.05);
      continue;
    }
    const ratio = levenshtein(q, t) / Math.max(q.length, t.length);
    best = Math.min(best, ratio);
  }
  return best;
};

const scoreField = (query: string, fieldValue: string): number | null => {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;
  const hTokens = tokenize(fieldValue);
  const hFull = normalize(fieldValue);
  let sum = 0;
  for (const qt of qTokens) {
    const s = scoreToken(qt, hTokens, hFull);
    if (s >= TOKEN_THRESHOLD) return null;
    sum += s;
  }
  return sum / qTokens.length;
};

const isSearchField = (key: string): key is SearchField => key === 'title' || key === 'description';

const fieldEntries = (queries: Partial<Record<SearchField, string>>): [SearchField, string][] =>
  (Object.entries(queries) as [string, string | undefined][]).flatMap(([key, value]) =>
    isSearchField(key) && value !== undefined ? [[key, value]] : [],
  );

const validateQuery = (query: SearchQuery): void => {
  if (query.kind === 'default') {
    if (query.query.trim() === '') {
      throw new ScrumlordError('empty_search_query', 'search requires a non-empty query.');
    }
    return;
  }
  const entries = fieldEntries(query.queries);
  if (entries.length === 0) {
    throw new ScrumlordError('empty_search_query', 'search requires at least one field query.');
  }
  for (const [field, value] of entries) {
    if (value.trim() === '') {
      throw new ScrumlordError('empty_search_query', `--${field} requires a non-empty value.`);
    }
  }
};

const planMatches = (task: Task, plan: 'planned' | 'unplanned' | undefined): boolean => {
  if (plan === 'planned') return task.plan !== null;
  if (plan === 'unplanned') return task.plan === null;
  return true;
};

/**
 * Fuzzy-search tasks by title/description. Default mode searches the combined
 * title+description document; field mode scopes each query to its column and
 * intersects results by average score.
 */
export function searchTasks(
  store: Pick<TaskStore, 'list'>,
  query: SearchQuery,
  options: CountSearchTasksOptions,
): number;
export function searchTasks(
  store: Pick<TaskStore, 'list'>,
  query: SearchQuery,
  options?: SearchTasksOptions,
): Task[];
export function searchTasks(
  store: Pick<TaskStore, 'list'>,
  query: SearchQuery,
  options: SearchTasksOptions & { count?: boolean } = {},
): Task[] | number {
  validateQuery(query);

  const candidates = store.list({ includeInactive: options.includeInactive ?? false });

  type Scored = { task: Task; score: number };
  const ranked: Scored[] = [];

  const scoreTask = (task: Task): number | null => {
    if (query.kind === 'default') {
      return scoreField(query.query, `${task.title}\n${task.description}`);
    }
    const entries = fieldEntries(query.queries);
    let sum = 0;
    for (const [field, value] of entries) {
      const s = scoreField(value, task[field]);
      if (s === null) return null;
      sum += s;
    }
    return sum / entries.length;
  };

  let matchCount = 0;
  for (const task of candidates) {
    if (!planMatches(task, options.plan)) continue;
    const score = scoreTask(task);
    if (score === null) continue;
    matchCount++;
    if (!options.count) ranked.push({ task, score });
  }

  if (options.count) return matchCount;

  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      b.task.priority - a.task.priority ||
      a.task.createdAt.localeCompare(b.task.createdAt) ||
      a.task.id.localeCompare(b.task.id),
  );

  return ranked.map(({ task }) => task);
}
