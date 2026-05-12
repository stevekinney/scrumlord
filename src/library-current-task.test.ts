import { describe, expect, it } from 'bun:test';
import { currentBranchTask, ScrumlordError } from './index';
import type { CommandRunner, CurrentBranchTaskOptions, Task } from './index';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
  startDate: null,
  dueDate: null,
  branch: 'feature/current-task',
  plan: null,
  provider: null,
  session: null,
  tags: [],
  parent: null,
  subtasks: [],
  blockedBy: [],
  blocking: [],
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  archived: false,
  deleted: false,
  ...overrides,
});

const branchRunner: CommandRunner = async () => ({
  exitCode: 0,
  stdout: 'feature/current-task\n',
  stderr: '',
});

const store = (tasks: Task[]) => ({
  projectRoot: '/project',
  withBranch(branch: string) {
    return tasks.filter((item) => item.branch === branch);
  },
});

const acceptsCurrentBranchTaskOptions = (_value: CurrentBranchTaskOptions): boolean => true;

describe('currentBranchTask', () => {
  it('returns the single active task assigned to the current branch', async () => {
    expect(acceptsCurrentBranchTaskOptions({ runner: branchRunner })).toBe(true);

    const result = await currentBranchTask(store([task('task-id')]), { runner: branchRunner });

    expect(result).toMatchObject({ id: 'task-id' });
  });

  it('ignores inactive tasks and reports ambiguous active matches', async () => {
    const inactiveResult = await currentBranchTask(
      store([task('done', { status: 'completed' }), task('deleted', { deleted: true })]),
      { runner: branchRunner },
    );

    expect(inactiveResult).toBeNull();
    try {
      await currentBranchTask(store([task('first'), task('second')]), { runner: branchRunner });
      throw new Error('Expected currentBranchTask to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(ScrumlordError);
    }
  });
});
