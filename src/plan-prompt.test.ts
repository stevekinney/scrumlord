import { describe, expect, it } from 'bun:test';
import type { Task } from './types';
import { planBatchPrompt, planTaskPrompt } from './plan-prompt';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 'abc-123',
  title: 'Do the thing',
  status: 'ready',
  description: 'A description.',
  priority: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: null,
  plan: null,
  provider: null,
  session: null,
  tags: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-01-01T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const projectRoot = '/home/user/project';

describe('planTaskPrompt', () => {
  it('includes the task id in the H1 heading', () => {
    const result = planTaskPrompt(task({ id: 'xyz-789' }), projectRoot);
    expect(result).toContain('# Task Plan Authoring — `xyz-789`');
  });

  it('writes the deliverable path as tmp/plans/<task-id>.md', () => {
    const result = planTaskPrompt(task({ id: 'abc-123' }), projectRoot);
    expect(result).toContain('tmp/plans/abc-123.md');
    expect(result).toContain(`${projectRoot}/tmp/plans/abc-123.md`);
  });

  it('renders the title', () => {
    const result = planTaskPrompt(task({ title: 'My Cool Task' }), projectRoot);
    expect(result).toContain('**Title:** My Cool Task');
  });

  it('renders the status', () => {
    const result = planTaskPrompt(task({ status: 'in-progress' }), projectRoot);
    expect(result).toContain('**Status:** in-progress');
  });

  it('renders the priority', () => {
    const result = planTaskPrompt(task({ priority: 2 }), projectRoot);
    expect(result).toContain('**Priority:** 2');
  });

  it('renders tags as comma-separated', () => {
    const result = planTaskPrompt(task({ tags: ['cli', 'agents'] }), projectRoot);
    expect(result).toContain('**Tags:** cli, agents');
  });

  it('substitutes "none" for empty tag arrays', () => {
    const result = planTaskPrompt(task({ tags: [] }), projectRoot);
    expect(result).toContain('**Tags:** none');
  });

  it('substitutes "none" for null branch', () => {
    const result = planTaskPrompt(task({ branch: null }), projectRoot);
    expect(result).toContain('**Branch:** none');
  });

  it('renders the branch when present', () => {
    const result = planTaskPrompt(task({ branch: 'feature/foo' }), projectRoot);
    expect(result).toContain('**Branch:** feature/foo');
  });

  it('substitutes "none" for null plan', () => {
    const result = planTaskPrompt(task({ plan: null }), projectRoot);
    expect(result).toContain('**Existing plan:** none');
  });

  it('renders the plan path when present', () => {
    const result = planTaskPrompt(task({ plan: 'tmp/plans/abc.md' }), projectRoot);
    expect(result).toContain('**Existing plan:** tmp/plans/abc.md');
  });

  it('renders the description verbatim when present', () => {
    const result = planTaskPrompt(task({ description: 'My description text.' }), projectRoot);
    expect(result).toContain('My description text.');
  });

  it('substitutes _No description provided._ when description is empty string', () => {
    const result = planTaskPrompt(task({ description: '' }), projectRoot);
    expect(result).toContain('_No description provided._');
  });

  it('mentions the plan-review skill in operational steps', () => {
    const result = planTaskPrompt(task(), projectRoot);
    expect(result).toContain('plan-review');
  });

  it('does not end with a trailing newline', () => {
    const result = planTaskPrompt(task(), projectRoot);
    expect(result.endsWith('\n')).toBe(false);
  });

  describe('description fencing', () => {
    it('wraps a description with zero backticks in a triple-backtick fence', () => {
      const result = planTaskPrompt(task({ description: 'plain text' }), projectRoot);
      expect(result).toContain('```markdown\nplain text\n```');
    });

    it('wraps a description containing plain triple backticks in a four-backtick fence', () => {
      const description = 'some ``` code';
      const result = planTaskPrompt(task({ description }), projectRoot);
      expect(result).toContain('````markdown\nsome ``` code\n````');
    });

    it('wraps a description containing ```ts in a four-backtick fence', () => {
      const description = 'example:\n```ts\nconst x = 1;\n```';
      const result = planTaskPrompt(task({ description }), projectRoot);
      expect(result).toContain('````markdown\n');
      expect(result).toContain('\n````');
    });

    it('wraps a description containing ```markdown in a four-backtick fence', () => {
      const description = 'example:\n```markdown\n# Hi\n```';
      const result = planTaskPrompt(task({ description }), projectRoot);
      expect(result).toContain('````markdown\n');
      expect(result).toContain('\n````');
    });

    it('wraps a description containing a five-backtick run in a six-backtick fence', () => {
      const description = 'example: `````. end';
      const result = planTaskPrompt(task({ description }), projectRoot);
      expect(result).toContain('``````markdown\n');
      expect(result).toContain('\n``````');
    });
  });
});

describe('planBatchPrompt', () => {
  it('renders the empty-batch variant when given an empty array', () => {
    const result = planBatchPrompt([], projectRoot);
    expect(result).toContain('There are no available, unplanned tasks.');
  });

  it('does not include a table in the empty-batch variant', () => {
    const result = planBatchPrompt([], projectRoot);
    expect(result).not.toContain('| ID |');
  });

  it('renders the H1 as "Task Plan Authoring — Batch"', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result).toContain('# Task Plan Authoring — Batch');
  });

  it('includes the task count in the opening paragraph', () => {
    const result = planBatchPrompt([task({ id: 'a' }), task({ id: 'b' })], projectRoot);
    expect(result).toContain('There are 2 such tasks.');
  });

  it('renders a Markdown table with one row per task', () => {
    const tasks = [
      task({ id: 'task-a', title: 'Task A' }),
      task({ id: 'task-b', title: 'Task B' }),
    ];
    const result = planBatchPrompt(tasks, projectRoot);
    expect(result).toContain('task-a');
    expect(result).toContain('task-b');
  });

  it('renders the deliverable-outline section with the 7-item list', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result).toContain('**Goal**');
    expect(result).toContain('**Inventory**');
    expect(result).toContain('**Design**');
    expect(result).toContain('**Per-file changes**');
    expect(result).toContain('**Tests**');
    expect(result).toContain('**Risks and rollback**');
    expect(result).toContain('**Implementation order**');
  });

  it('mentions priority-ordering guidance', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result).toContain('highest priority first');
  });

  it('mentions parallelization guidance', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result).toContain('Parallelize');
  });

  it('renders table rows in priority-descending order with title-ascending tiebreak', () => {
    const tasks = [
      task({ id: 'low-b', title: 'B Task', priority: 1 }),
      task({ id: 'high-a', title: 'A Task', priority: 3 }),
      task({ id: 'low-a', title: 'A Task', priority: 1 }),
      task({ id: 'mid', title: 'Mid Task', priority: 2 }),
    ];
    const result = planBatchPrompt(tasks, projectRoot);
    const highIndex = result.indexOf('high-a');
    const midIndex = result.indexOf('mid');
    const lowAIndex = result.indexOf('low-a');
    const lowBIndex = result.indexOf('low-b');
    expect(highIndex).toBeLessThan(midIndex);
    expect(midIndex).toBeLessThan(lowAIndex);
    expect(lowAIndex).toBeLessThan(lowBIndex);
  });

  it('escapes pipe characters in task titles for table cells', () => {
    const result = planBatchPrompt([task({ title: 'Title | with pipe' })], projectRoot);
    expect(result).toContain('Title \\| with pipe');
  });

  it('collapses embedded newlines in titles to a space in table cells', () => {
    const result = planBatchPrompt([task({ title: 'Line1\nLine2' })], projectRoot);
    expect(result).toContain('Line1 Line2');
  });

  it('renders "none" for tasks with no tags in the table', () => {
    const result = planBatchPrompt([task({ tags: [] })], projectRoot);
    // The table row should have "none" in the tags column
    expect(result).toContain('| none |');
  });

  it('includes projectRoot in the deliverable path', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result).toContain(`${projectRoot}/tmp/plans/<task-id>.md`);
  });

  it('does not end with a trailing newline', () => {
    const result = planBatchPrompt([task()], projectRoot);
    expect(result.endsWith('\n')).toBe(false);
  });

  it('empty batch does not end with a trailing newline', () => {
    const result = planBatchPrompt([], projectRoot);
    expect(result.endsWith('\n')).toBe(false);
  });
});
