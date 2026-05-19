import { describe, expect, it } from 'bun:test';
import { renderReadiness, type DataShape } from './output-contracts.js';
import { formatJson } from './output-json.js';
import { createRenderContext, renderers, renderPretty } from './output-renderer.js';
import type { Task } from './types.js';

const shapes = Object.keys(renderReadiness) as DataShape[];

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

const plainContext = (overrides?: { flags?: ReadonlySet<string>; terminalWidth?: number }) =>
  createRenderContext({
    colorMode: 'never',
    terminalWidth: overrides?.terminalWidth ?? 100,
    flags: overrides?.flags ?? new Set(),
  });

const coloredContext = () =>
  createRenderContext({
    colorMode: 'always',
    terminalWidth: 100,
    flags: new Set(),
  });

describe('renderer readiness exhaustiveness', () => {
  it('every implemented shape has a registered renderer', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'implemented') {
        expect(renderers[shape]).toBeDefined();
      }
    }
  });

  it('every jsonFallback shape has no registered renderer', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'jsonFallback') {
        expect(renderers[shape]).toBeUndefined();
      }
    }
  });
});

describe('renderPretty', () => {
  const context = createRenderContext({
    colorMode: 'never',
    terminalWidth: 80,
    flags: new Set(),
  });

  it('falls back to JSON when no renderer is registered for the shape', () => {
    for (const shape of shapes) {
      if (renderReadiness[shape] === 'jsonFallback') {
        const value = { example: shape };
        expect(renderPretty(shape, value, context)).toBe(formatJson(value));
      }
    }
  });
});

describe('createRenderContext', () => {
  it('defaults terminal width to 100', () => {
    const context = createRenderContext({ colorMode: 'never', flags: new Set() });
    expect(context.terminalWidth).toBe(100);
  });

  it('preserves explicit terminal width and countLabel', () => {
    const context = createRenderContext({
      colorMode: 'never',
      terminalWidth: 42,
      flags: new Set(['count']),
      countLabel: 'matching tasks',
    });
    expect(context.terminalWidth).toBe(42);
    expect(context.countLabel).toBe('matching tasks');
    expect(context.flags.has('count')).toBe(true);
  });
});

describe('task-list renderer', () => {
  it('renders an empty array with a muted placeholder', () => {
    const output = renderPretty('task-list', [], plainContext());
    expect(output).toContain('(no matching tasks)');
    expect(output).not.toContain('[');
  });

  it('renders a row per task with id prefix, status, priority, title', () => {
    const tasks = [task({ id: 'abcdef1234567890', title: 'Pick a task', tags: ['cli'] })];
    const output = renderPretty('task-list', tasks, plainContext());
    expect(output).toContain('abcdef12');
    expect(output).toContain('ready');
    expect(output).toContain('P1');
    expect(output).toContain('Pick a task');
    expect(output).toContain('cli');
  });

  it('truncates task rows to the terminal width', () => {
    const tasks = [
      task({
        id: 'abcdef1234567890',
        title: 'A task title that would otherwise overflow the terminal width',
        tags: ['very-long-tag-name', 'another-long-tag-name'],
      }),
    ];
    const output = renderPretty('task-list', tasks, plainContext({ terminalWidth: 48 }));
    const firstLine = output.split('\n')[0] ?? '';

    expect(firstLine.length).toBeLessThanOrEqual(48);
    expect(firstLine).toEndWith('…');
  });

  it('renders ANSI escapes when colorMode is always', () => {
    const tasks = [task()];
    const output = renderPretty('task-list', tasks, coloredContext());
    expect(output).toContain('[');
  });

  it('colors every status and priority branch', () => {
    const tasks = [
      task({ id: 'aaaaaaaa-aaaa', status: 'draft', priority: 3 }),
      task({ id: 'bbbbbbbb-bbbb', status: 'in-progress', priority: 2 }),
      task({ id: 'cccccccc-cccc', status: 'in-review', priority: 1 }),
      task({ id: 'dddddddd-dddd', status: 'completed', priority: 3 }),
    ];
    const output = renderPretty('task-list', tasks, coloredContext());
    expect(output).toContain('in-progress');
    expect(output).toContain('in-review');
    expect(output).toContain('P2');
    expect(output).toContain('P3');
  });

  it('renders a count object with the contract countLabel', () => {
    const context = createRenderContext({
      colorMode: 'never',
      flags: new Set(['count']),
      countLabel: 'available tasks',
    });
    const output = renderPretty('task-list', { count: 3 }, context);
    expect(output).toBe('3 available tasks\n');
  });

  it('truncates lists beyond 50 rows and hints at --json', () => {
    const tasks = Array.from({ length: 75 }, (_, index) =>
      task({ id: `00000000-0000-0000-0000-${index.toString().padStart(12, '0')}` }),
    );
    const output = renderPretty('task-list', tasks, plainContext());
    expect(output).toContain('showing 50 of 75');
    expect(output).toContain('pass --json');
  });

  it('falls back to JSON for unexpected shapes', () => {
    const output = renderPretty('task-list', { unexpected: true }, plainContext());
    expect(output).toBe(formatJson({ unexpected: true }));
  });
});

describe('single-task renderer', () => {
  it('renders a null task with a muted placeholder', () => {
    const output = renderPretty('single-task', null, plainContext());
    expect(output).toBe('(no task)\n');
  });

  it('renders a single task as Markdown with YAML front matter', () => {
    const output = renderPretty(
      'single-task',
      task({
        title: 'Example: "quoted" task',
        description: 'A short note.\n\n- Second line.',
        branch: 'feature/task-documents',
        tags: ['docs', 'cli'],
        blockedBy: [{ id: '00000000-0000-0000-0000-000000000002', status: 'ready' }],
      }),
      plainContext(),
    );

    expect(output).toStartWith('---\n');
    expect(output).toContain('id: "00000000-0000-0000-0000-000000000001"\n');
    expect(output).toContain('title: "Example: \\"quoted\\" task"\n');
    expect(output).toContain('status: "ready"\n');
    expect(output).toContain('priority: 1\n');
    expect(output).toContain('startDate: null\n');
    expect(output).toContain('branch: "feature/task-documents"\n');
    expect(output).toContain('tags:\n  - "docs"\n  - "cli"\n');
    expect(output).toContain(
      'blockedBy:\n  - { id: "00000000-0000-0000-0000-000000000002", status: "ready" }\n',
    );
    expect(output).toContain('deleted: false\n');
    expect(output).toEndWith('---\n\nA short note.\n\n- Second line.\n');
  });

  it('does not truncate long descriptions for individual task documents', () => {
    const longDescription = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
    const output = renderPretty(
      'single-task',
      task({ description: longDescription }),
      plainContext(),
    );
    expect(output).toContain('line 11');
    expect(output).not.toContain('pass --json');
  });

  it('does not emit ANSI escapes in task Markdown documents', () => {
    const output = renderPretty(
      'single-task',
      task({ provider: 'claude', session: 'abc' }),
      coloredContext(),
    );
    expect(output).toContain('provider: "claude"');
    expect(output).toContain('session: "abc"');
    expect(output).not.toContain('[');
  });

  it('falls back to JSON for unexpected shapes', () => {
    const output = renderPretty('single-task', { not: 'a task' }, plainContext());
    expect(output).toBe(formatJson({ not: 'a task' }));
  });
});

describe('tag-list renderer', () => {
  it('renders one tag per line', () => {
    expect(renderPretty('tag-list', ['frontend', 'testing'], plainContext())).toBe(
      '- frontend\n- testing\n',
    );
  });

  it('renders a placeholder for empty tag lists', () => {
    expect(renderPretty('tag-list', [], plainContext())).toBe('(no tags)\n');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('tag-list', { not: 'tags' }, plainContext())).toBe(
      formatJson({ not: 'tags' }),
    );
  });
});

describe('remaining renderer', () => {
  it('renders the number with a "remaining" label', () => {
    expect(renderPretty('remaining', 7, plainContext())).toBe('7 remaining\n');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('remaining', { count: 3 }, plainContext())).toBe(formatJson({ count: 3 }));
  });
});

describe('task-progress renderer', () => {
  const entry = (overrides: Partial<import('./types.js').TaskProgress> = {}) => ({
    id: 'p1',
    taskId: 'task-1',
    message: 'did the thing',
    createdAt: '2026-05-15T12:00:00.000Z',
    provider: null,
    session: null,
    event: null,
    tool: null,
    cwd: null,
    transcriptPath: null,
    commitSha: null,
    ...overrides,
  });

  it('renders muted placeholder for empty list', () => {
    expect(renderPretty('task-progress', [], plainContext())).toBe('(no progress recorded)\n');
  });

  it('renders one line per entry with timestamp and message', () => {
    const output = renderPretty('task-progress', [entry()], plainContext());
    expect(output).toContain('did the thing');
    expect(output).toContain('2026-05-15');
    expect(output).toContain('progress');
  });

  it('truncates beyond 10 entries while keeping the most recent progress', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      entry({ id: `p${index}`, message: `entry ${index}` }),
    );
    const output = renderPretty('task-progress', many, plainContext());
    expect(output).toContain('showing most recent 10 of 15');
    expect(output).toContain('entry 14');
    expect(output).not.toContain('entry 0');
  });

  it('renders every progress entry when --full is passed', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      entry({ id: `p${index}`, message: `entry ${index}` }),
    );
    const output = renderPretty('task-progress', many, plainContext({ flags: new Set(['full']) }));
    expect(output).toContain('entry 0');
    expect(output).toContain('entry 14');
    expect(output).not.toContain('showing most recent');
  });

  it('highlights event when present', () => {
    const output = renderPretty('task-progress', [entry({ event: 'commit' })], plainContext());
    expect(output).toContain('commit');
  });

  it('falls back to JSON for non-array shapes', () => {
    expect(renderPretty('task-progress', { not: 'an array' }, plainContext())).toBe(
      formatJson({ not: 'an array' }),
    );
  });
});

describe('single-task-progress renderer', () => {
  it('renders a one-line confirmation', () => {
    const value = {
      id: 'p1',
      taskId: 't1',
      message: 'noted',
      createdAt: '2026-05-15T00:00:00.000Z',
      provider: null,
      session: null,
      event: null,
      tool: null,
      cwd: null,
      transcriptPath: null,
      commitSha: null,
    };
    const output = renderPretty('single-task-progress', value, plainContext());
    expect(output).toContain('recorded');
    expect(output).toContain('noted');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('single-task-progress', { not: 'progress' }, plainContext())).toBe(
      formatJson({ not: 'progress' }),
    );
  });
});

describe('task-session renderer', () => {
  it('renders persisted task session fields', () => {
    const output = renderPretty(
      'task-session',
      {
        taskId: 'task-1',
        provider: 'claude',
        session: 'sess-1',
        branch: 'feature/x',
        plan: null,
      },
      plainContext(),
    );
    expect(output).toContain('task-1');
    expect(output).toContain('claude');
    expect(output).toContain('feature/x');
    expect(output).toContain('(none)');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('task-session', { not: 'a session' }, plainContext())).toBe(
      formatJson({ not: 'a session' }),
    );
  });
});

describe('pr-status renderer', () => {
  const baseReport = {
    pullRequest: {
      number: 42,
      url: 'https://example/pr/42',
      headRefName: 'feature/x',
      headSha: 'abc',
      title: 'My change',
      state: 'OPEN' as const,
      baseRefName: 'main',
      mergedAt: null,
      body: null,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    },
    reviewComments: {
      allResolved: true,
      unresolvedCount: 0,
      unresolved: [],
    },
    continuousIntegration: {
      allGreen: true,
      pendingCount: 0,
      failedCount: 0,
      checks: [],
      pending: [],
      failed: [],
    },
    readyToMerge: true,
  };

  it('renders the PR status block', () => {
    const output = renderPretty('pr-status', baseReport, plainContext());
    expect(output).toContain('#42');
    expect(output).toContain('My change');
    expect(output).toContain('feature/x → main');
    expect(output).toContain('MERGEABLE');
    expect(output).toContain('yes');
  });

  it('colors a non-open state via muted/heading branches', () => {
    const merged = {
      ...baseReport,
      pullRequest: { ...baseReport.pullRequest, state: 'MERGED' as const },
    };
    const closed = {
      ...baseReport,
      pullRequest: { ...baseReport.pullRequest, state: 'CLOSED' as const },
    };
    const notReady = { ...baseReport, readyToMerge: false };
    expect(renderPretty('pr-status', merged, coloredContext())).toContain('MERGED');
    expect(renderPretty('pr-status', closed, coloredContext())).toContain('CLOSED');
    expect(renderPretty('pr-status', notReady, plainContext())).toContain('no');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('pr-status', { not: 'pr' }, plainContext())).toBe(
      formatJson({ not: 'pr' }),
    );
  });
});
