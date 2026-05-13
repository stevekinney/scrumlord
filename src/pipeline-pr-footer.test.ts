import { describe, expect, it } from 'bun:test';
import {
  buildRepairedPullRequestBody,
  isFlagOn,
  parsePullRequestFooter,
} from './pipeline-pr-footer';

describe('parsePullRequestFooter', () => {
  it('reports `missing` for null/empty bodies', () => {
    expect(parsePullRequestFooter(null, 'abc12345')).toEqual({ kind: 'missing' });
    expect(parsePullRequestFooter('', 'abc12345')).toEqual({ kind: 'missing' });
  });

  it('reports `missing` when the footer line is absent', () => {
    const body = 'Some PR body\nNo footer here';
    expect(parsePullRequestFooter(body, 'abc12345')).toEqual({ kind: 'missing' });
  });

  it('rejects substring matches in unrelated lines', () => {
    const body = 'discussing pipeline-task-id: details below';
    // The token must appear at column 0 on its own line.
    expect(parsePullRequestFooter(body, 'abc12345')).toEqual({ kind: 'missing' });
  });

  it('matches an exact footer line', () => {
    const body = 'PR body\n\npipeline-task-id: abc12345';
    expect(parsePullRequestFooter(body, 'abc12345')).toEqual({ kind: 'match' });
  });

  it('matches a footer with trailing whitespace', () => {
    const body = 'PR body\n\npipeline-task-id: abc12345   \n';
    expect(parsePullRequestFooter(body, 'abc12345')).toEqual({ kind: 'match' });
  });

  it('detects mismatch when the footer references a different task id', () => {
    const body = 'PR body\n\npipeline-task-id: deadbeef';
    expect(parsePullRequestFooter(body, 'abc12345')).toEqual({
      kind: 'mismatch',
      foundTaskId: 'deadbeef',
    });
  });
});

describe('buildRepairedPullRequestBody', () => {
  it('appends the footer to an existing body', () => {
    const result = buildRepairedPullRequestBody('Existing PR body.', 'abc12345');
    expect(result).toBe('Existing PR body.\n\npipeline-task-id: abc12345');
  });

  it('returns only the footer line for empty bodies', () => {
    expect(buildRepairedPullRequestBody(null, 'abc12345')).toBe('pipeline-task-id: abc12345');
    expect(buildRepairedPullRequestBody('', 'abc12345')).toBe('pipeline-task-id: abc12345');
  });

  it('strips trailing whitespace before appending', () => {
    const result = buildRepairedPullRequestBody('Body.\n\n\n', 'abc12345');
    expect(result).toBe('Body.\n\npipeline-task-id: abc12345');
  });
});

describe('isFlagOn', () => {
  it('returns true only when the env var is exactly `on`', () => {
    expect(
      isFlagOn({ SCRUMLORD_PIPELINE_PR_IDENTITY: 'on' }, 'SCRUMLORD_PIPELINE_PR_IDENTITY'),
    ).toBe(true);
    expect(
      isFlagOn({ SCRUMLORD_PIPELINE_PR_IDENTITY: 'off' }, 'SCRUMLORD_PIPELINE_PR_IDENTITY'),
    ).toBe(false);
    expect(
      isFlagOn({ SCRUMLORD_PIPELINE_PR_IDENTITY: 'true' }, 'SCRUMLORD_PIPELINE_PR_IDENTITY'),
    ).toBe(false);
    expect(isFlagOn({}, 'SCRUMLORD_PIPELINE_PR_IDENTITY')).toBe(false);
  });
});
