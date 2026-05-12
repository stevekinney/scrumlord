import { describe, expect, it } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandRunner } from './command-runner';
import {
  openPullRequests,
  parseIncludedGitHubApiResponse,
  reviewCommentsForPullRequest,
} from './github';
import { gitHubRestCacheKey, gitHubRestCachePath } from './github-rest-cache';
import {
  defaultReviewComments,
  expectGitHubErrorSync,
  includedResponse,
  pullRequestRestBody,
  pullRequestRestList,
  workspaceRoot,
} from './github-test-helpers';

describe('GitHub REST ETag support', () => {
  it('parses included gh api responses', () => {
    expect(
      parseIncludedGitHubApiResponse('HTTP/2 304 Not Modified\r\nETag: "etag-value"\r\n\r\n'),
    ).toEqual({
      status: 304,
      headers: { etag: '"etag-value"' },
      body: null,
    });
    expect(
      parseIncludedGitHubApiResponse('HTTP/2 200 OK\nx-ratelimit-remaining: 42\n\n[]'),
    ).toEqual({
      status: 200,
      headers: { 'x-ratelimit-remaining': '42' },
      body: '[]',
    });
    expectGitHubErrorSync(
      () => parseIncludedGitHubApiResponse('not an included response'),
      'github_response_invalid',
    );
  });

  it('stores ETags, sends If-None-Match, and reuses cached JSON on 304', async () => {
    const root = await workspaceRoot();
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        return includedResponse({
          headers: { etag: '"pulls-v1"' },
          body: pullRequestRestList([pullRequestRestBody({ headSha: 'first-sha' })]),
        });
      }
      expect(command).toContain('-H');
      expect(command).toContain('If-None-Match: "pulls-v1"');
      return includedResponse({ status: 304, headers: { etag: '"pulls-v1"' }, body: null });
    };

    const first = await openPullRequests(root, 'owner/repository', { runner });
    const second = await openPullRequests(root, 'owner/repository', { runner });

    expect(first).toEqual(second);
    expect(second[0]?.headSha).toBe('first-sha');
    expect(await Bun.file(gitHubRestCachePath(root)).json()).toMatchObject({
      [gitHubRestCacheKey('repos/owner/repository/pulls', {
        per_page: '100',
        state: 'open',
      })]: {
        etag: '"pulls-v1"',
      },
    });
  });

  it('retries unconditionally when GitHub returns 304 without a cached body', async () => {
    const root = await workspaceRoot();
    await mkdir(join(root, 'tmp'), { recursive: true });
    await Bun.write(
      gitHubRestCachePath(root),
      `${JSON.stringify({
        [gitHubRestCacheKey('repos/owner/repository/pulls', {
          per_page: '100',
          state: 'open',
        })]: {
          etag: '"stale"',
          updatedAt: '2026-05-11T00:00:00.000Z',
        },
      })}\n`,
    );
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push(command);
      if (commands.length === 1) {
        expect(command).toContain('If-None-Match: "stale"');
        return includedResponse({ status: 304, headers: { etag: '"stale"' }, body: null });
      }
      expect(command).not.toContain('If-None-Match: "stale"');
      return includedResponse({
        headers: { etag: '"fresh"' },
        body: pullRequestRestList([pullRequestRestBody({ headSha: 'fresh-sha' })]),
      });
    };

    const pullRequests = await openPullRequests(root, 'owner/repository', { runner });

    expect(commands).toHaveLength(2);
    expect(pullRequests[0]?.headSha).toBe('fresh-sha');
  });

  it('leaves GraphQL review thread requests uncached and unwrapped', async () => {
    const root = await workspaceRoot();
    let graphQlCommand: string[] | null = null;
    const runner: CommandRunner = async (command) => {
      graphQlCommand = command;
      return defaultReviewComments;
    };

    await reviewCommentsForPullRequest(
      root,
      'owner/repository',
      {
        number: 42,
        url: 'https://github.test/pull/42',
        headRefName: 'feature/task-graph',
        headSha: 'abc123',
        title: 'Task graph',
      },
      { runner },
    );

    expect(graphQlCommand?.slice(0, 3)).toEqual(['gh', 'api', 'graphql']);
    expect(graphQlCommand).not.toContain('--include');
  });
});
