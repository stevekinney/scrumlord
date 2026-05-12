import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ScrumlordError } from './errors.js';

export type GitHubRestCacheEntry = {
  etag: string;
  body?: unknown;
  updatedAt: string;
};

export type GitHubRestCache = Record<string, GitHubRestCacheEntry>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object';
};

const isCacheEntry = (value: unknown): value is GitHubRestCacheEntry => {
  return (
    isRecord(value) && typeof value['etag'] === 'string' && typeof value['updatedAt'] === 'string'
  );
};

const parseGitHubRestCache = (value: unknown): GitHubRestCache => {
  if (!isRecord(value)) {
    throw new ScrumlordError('github_cache_invalid', 'GitHub ETag cache must be a JSON object.');
  }

  const cache: GitHubRestCache = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isCacheEntry(entry)) {
      throw new ScrumlordError(
        'github_cache_invalid',
        `GitHub ETag cache entry is invalid: ${key}`,
      );
    }
    cache[key] = { etag: entry.etag, updatedAt: entry.updatedAt };
    if ('body' in entry) cache[key].body = entry.body;
  }
  return cache;
};

export const gitHubRestCachePath = (projectRoot: string): string => {
  return join(projectRoot, 'tmp', 'github-etag-cache.json');
};

export const gitHubRestCacheKey = (
  endpoint: string,
  parameters: Record<string, string> = {},
): string => {
  const sortedParameters = Object.entries(parameters).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (sortedParameters.length === 0) return endpoint;
  const query = new URLSearchParams(sortedParameters).toString();
  return `${endpoint}?${query}`;
};

export const readGitHubRestCache = async (projectRoot: string): Promise<GitHubRestCache> => {
  const path = gitHubRestCachePath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    return parseGitHubRestCache(await Bun.file(path).json());
  } catch (error) {
    if (error instanceof ScrumlordError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError(
      'github_cache_invalid',
      `Could not read GitHub ETag cache: ${message}`,
    );
  }
};

export const writeGitHubRestCache = async (
  projectRoot: string,
  cache: GitHubRestCache,
): Promise<void> => {
  const path = gitHubRestCachePath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(cache, null, 2)}\n`);
};
