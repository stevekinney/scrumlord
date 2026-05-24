import { describe, expect, it } from 'bun:test';
import type { ReviewComment } from './github.js';
import { formatJson } from './output-json.js';
import { createRenderContext, renderPretty } from './output-renderer.js';
import type { PullRequestOverviewItem } from './tasks-overview.js';
import type { Task } from './types.js';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Example task',
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-15T00:00:00.000Z',
  lastModifiedAt: '2026-05-15T00:00:00.000Z',
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
  deleted: false,
  ...overrides,
});

const plainContext = () =>
  createRenderContext({
    colorMode: 'never',
    terminalWidth: 100,
    flags: new Set(),
  });

const coloredContext = () =>
  createRenderContext({
    colorMode: 'always',
    terminalWidth: 100,
    flags: new Set(),
  });

describe('review-comments renderer', () => {
  const comment = (overrides: Partial<ReviewComment> = {}) => ({
    id: 'c1',
    url: null,
    path: 'src/foo.ts',
    line: 42,
    body: 'nit',
    author: 'reviewer',
    isResolved: false,
    ...overrides,
  });

  it('renders muted placeholder for empty list', () => {
    expect(renderPretty('review-comments', [], plainContext())).toBe('(no review comments)\n');
  });

  it('renders one block per comment with path:line', () => {
    const output = renderPretty('review-comments', [comment()], plainContext());
    expect(output).toContain('[1]');
    expect(output).toContain('reviewer');
    expect(output).toContain('src/foo.ts:42');
    expect(output).toContain('nit');
  });

  it('omits location when path is null', () => {
    const output = renderPretty(
      'review-comments',
      [comment({ path: null, line: null, author: null })],
      plainContext(),
    );
    expect(output).toContain('unknown');
    expect(output).not.toContain('null');
  });

  it('truncates beyond 10 entries', () => {
    const many = Array.from({ length: 15 }, (_, index) => comment({ id: `c${index}` }));
    const output = renderPretty('review-comments', many, plainContext());
    expect(output).toContain('showing 10 of 15');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('review-comments', { not: 'an array' }, plainContext())).toBe(
      formatJson({ not: 'an array' }),
    );
  });
});

describe('pr-overview renderer', () => {
  const overviewItem = (overrides: Partial<PullRequestOverviewItem> = {}) => ({
    pullRequest: {
      number: 5,
      url: 'https://example/pr/5',
      headRefName: 'feature/y',
      headSha: 'def',
      title: 'Another change',
      state: 'OPEN' as const,
      baseRefName: 'main',
      mergedAt: null,
      body: null,
      mergeable: null,
      mergeStateStatus: null,
    },
    associatedTasks: [task({ id: 'taska-bbbb', title: 'Linked task' })],
    reviewComments: { unresolvedCount: 0 },
    continuousIntegration: {
      status: 'success' as const,
      pendingCount: 0,
      failedCount: 0,
      checks: [],
    },
    readyToMerge: true,
    ...overrides,
  });

  it('renders empty placeholder when no PRs', () => {
    expect(renderPretty('pr-overview', [], plainContext())).toBe('(No open pull requests.)\n');
  });

  it('renders a row per PR with the success branch and a task cell', () => {
    const output = renderPretty('pr-overview', [overviewItem()], plainContext());
    expect(output).toContain('#5');
    expect(output).toContain('feature/y');
    expect(output).toContain('Linked task');
    expect(output).toContain('1 PR(s)');
  });

  it('covers pending, failed, and no-tasks branches', () => {
    const pending = overviewItem({
      continuousIntegration: { status: 'pending', pendingCount: 1, failedCount: 0, checks: [] },
      associatedTasks: [],
      readyToMerge: false,
    });
    const failed = overviewItem({
      continuousIntegration: { status: 'failed', pendingCount: 0, failedCount: 1, checks: [] },
    });
    const pendingOut = renderPretty('pr-overview', [pending], coloredContext());
    const failedOut = renderPretty('pr-overview', [failed], coloredContext());
    expect(pendingOut).toContain('wait 1');
    expect(pendingOut).toContain('-');
    expect(failedOut).toContain('fail 1');
  });

  it('renders a table that does not exceed the terminal width', () => {
    const output = renderPretty(
      'pr-overview',
      [
        overviewItem({
          pullRequest: {
            ...overviewItem().pullRequest,
            headRefName: 'feature/a-very-long-branch-name-that-needs-truncation',
            mergeable: false,
          },
          associatedTasks: [
            task({ id: 'taska-bbbb', title: 'Linked task with a very long title that truncates' }),
          ],
        }),
      ],
      { ...plainContext(), terminalWidth: 48 },
    );

    expect(output).toContain('PR');
    expect(output).toContain('Branch');
    expect(output).toContain('Task');
    expect(output).toContain('Rd');
    expect(output).toContain('Cmt');
    expect(output).toContain('CI');
    expect(output).toContain('Conf');
    expect(output).toContain('…');
    expect(
      output
        .split('\n')
        .filter(Boolean)
        .every((line) => line.length <= 48),
    ).toBe(true);
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('pr-overview', { not: 'an array' }, plainContext())).toBe(
      formatJson({ not: 'an array' }),
    );
  });

  const ttyContext = () =>
    createRenderContext({
      colorMode: 'always',
      terminalWidth: 100,
      flags: new Set(),
      isTty: true,
    });

  it('wraps the PR number in an OSC 8 hyperlink on an interactive color terminal', () => {
    const output = renderPretty('pr-overview', [overviewItem()], ttyContext());
    // OSC 8 open + url + ST, label, then the OSC 8 close.
    expect(output).toContain(']8;;https://example/pr/5\\#5]8;;\\');
  });

  it('emits no OSC bytes when not a TTY or when color is disabled', () => {
    const plain = renderPretty('pr-overview', [overviewItem()], plainContext());
    const colorNoTty = renderPretty('pr-overview', [overviewItem()], coloredContext());
    expect(plain).not.toContain(']8;;');
    expect(colorNoTty).not.toContain(']8;;');
    expect(plain).toContain('#5');
  });

  it('keeps column alignment despite the hyperlink escape', () => {
    // Two PRs with different-width numbers; the hyperlinked PR cell must align
    // to the same visible width as a plain one.
    const wide = overviewItem({ pullRequest: { ...overviewItem().pullRequest, number: 12345 } });
    const output = renderPretty('pr-overview', [overviewItem(), wide], ttyContext());
    const lines = output.split('\n').filter((line) => line.includes(']8;;'));
    // The branch column should start at the same offset on both data rows.
    const branchOffsets = lines.map((line) => line.indexOf('feature/y'));
    expect(branchOffsets[0]).toBe(branchOffsets[1]);
  });
});

describe('cleanup renderer', () => {
  it('uses success color when tasks were deleted', () => {
    const output = renderPretty('cleanup', { deleted: 2 }, coloredContext());
    expect(output).toContain('cleaned up 2 task(s)');
    expect(output).toContain('\u001b[');
  });

  it('uses muted color when nothing was deleted', () => {
    expect(renderPretty('cleanup', { deleted: 0 }, plainContext())).toBe('cleaned up 0 task(s)\n');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('cleanup', { other: 1 }, plainContext())).toBe(formatJson({ other: 1 }));
  });
});
