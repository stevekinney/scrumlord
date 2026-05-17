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

  it('renders a single task with key/value rows including (none) placeholders', () => {
    const output = renderPretty('single-task', task(), plainContext());
    expect(output).toContain('title');
    expect(output).toContain('Example task');
    expect(output).toContain('(none)');
  });

  it('renders short descriptions inline without the truncation hint', () => {
    const output = renderPretty(
      'single-task',
      task({ description: 'A short note.\nSecond line.' }),
      plainContext(),
    );
    expect(output).toContain('A short note.');
    expect(output).not.toContain('more lines');
  });

  it('truncates long descriptions and surfaces the json hint', () => {
    const longDescription = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n');
    const output = renderPretty(
      'single-task',
      task({ description: longDescription }),
      plainContext(),
    );
    expect(output).toContain('description:');
    expect(output).toContain('(… 4 more lines — pass --json)');
  });

  it('renders provider:session pairs when present', () => {
    const output = renderPretty(
      'single-task',
      task({ provider: 'claude', session: 'abc' }),
      plainContext(),
    );
    expect(output).toContain('claude:abc');
  });

  it('falls back to JSON for unexpected shapes', () => {
    const output = renderPretty('single-task', { not: 'a task' }, plainContext());
    expect(output).toBe(formatJson({ not: 'a task' }));
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

describe('cleanup renderer', () => {
  it('uses success color when tasks were deleted', () => {
    const output = renderPretty('cleanup', { deleted: 2 }, coloredContext());
    expect(output).toContain('cleaned up 2 task(s)');
    expect(output).toContain('[');
  });

  it('uses muted color when nothing was deleted', () => {
    expect(renderPretty('cleanup', { deleted: 0 }, plainContext())).toBe('cleaned up 0 task(s)\n');
  });

  it('falls back to JSON for unexpected shapes', () => {
    expect(renderPretty('cleanup', { other: 1 }, plainContext())).toBe(formatJson({ other: 1 }));
  });
});
