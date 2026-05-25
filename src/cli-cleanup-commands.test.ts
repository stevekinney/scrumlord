import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import type { CommandResult } from './command-runner';
import { createTaskStore } from './database-open';
import { emptyProgressStoreMethods } from './test-progress-store-methods';
import type { Task, TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cleanup-cli-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'ready',
  description: '',
  priority: 1,
  createdAt: '2026-05-11T00:00:00.000Z',
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
  lastModifiedAt: '2026-05-11T00:00:00.000Z',
  deleted: false,
  ...overrides,
});

const fakeStore = (): TaskStore => ({
  projectRoot: '/project',
  databasePath: '/project/tmp/tasks.db',
  projectGitCommonDir: null,
  projectResolved: true,
  create() {
    return task('created');
  },
  update(id) {
    return task(id);
  },
  delete() {
    return null;
  },
  getTask(id) {
    return task(id);
  },
  list() {
    return [];
  },
  available() {
    return [];
  },
  blocked() {
    return [];
  },
  completed() {
    return [];
  },
  withTag() {
    return [];
  },
  withAllTags() {
    return [];
  },
  withAnyTag() {
    return [];
  },
  withBranch() {
    return [];
  },
  blockedBy() {
    return [];
  },
  blocking() {
    return [];
  },
  withPriority() {
    return [];
  },
  next() {
    return null;
  },
  remaining() {
    return 0;
  },
  claimNext() {
    return null;
  },
  listClaimCandidates() {
    return [];
  },
  conditionalUpdate() {
    return null;
  },
  summarizeReadyQueue() {
    return { draft: 0, ready: 0, inProgress: 0, inReview: 0, completed: 0, blocked: 0 };
  },
  cleanup() {
    return { deleted: 0 };
  },
  previewCleanup() {
    return { wouldDelete: [] };
  },
  inProgress() {
    return [];
  },
  recoverOrphan() {
    return {
      outcome: 'stale-state',
      actual: { status: 'in-progress', branch: null, session: null, deleted: false },
    } as const;
  },
  countInProgress() {
    return 0;
  },
  countBranched() {
    return 0;
  },
  addTag(id) {
    return task(id);
  },
  removeTag(id) {
    return task(id);
  },
  addBlocker(id) {
    return task(id);
  },
  removeBlocker(id) {
    return task(id);
  },
  setPlan(id) {
    return task(id);
  },
  setSession(id) {
    return task(id);
  },
  withSession() {
    return [];
  },
  taskSession(id) {
    return { taskId: id, provider: null, session: null, branch: null, plan: null };
  },
  ...emptyProgressStoreMethods,
  close() {},
});

describe('cleanup command', () => {
  it('parses aged, orphans-only, aged-and-orphans, prompt flags', async () => {
    const createStore = async () => fakeStore();

    const orphansOnly = await runTasksCli(['cleanup', '--orphans-only'], { createStore });
    expect(orphansOnly.exitCode).toBe(0);
    expect(orphansOnly.stdout).toContain('Orphan recovery:');

    const orphansOnlyWithDays = await runTasksCli(['cleanup', '--orphans-only', '30'], {
      createStore,
    });
    expect(orphansOnlyWithDays.exitCode).toBe(1);
    expect(JSON.parse(orphansOnlyWithDays.stderr).error.code).toBe('invalid_cleanup_flags');

    const orphansOnlyWithHard = await runTasksCli(['cleanup', '--orphans-only', '--hard'], {
      createStore,
    });
    expect(orphansOnlyWithHard.exitCode).toBe(1);
    expect(JSON.parse(orphansOnlyWithHard.stderr).error.code).toBe('invalid_cleanup_flags');

    const noArgs = await runTasksCli(['cleanup'], { createStore });
    expect(noArgs.exitCode).toBe(1);
    expect(JSON.parse(noArgs.stderr).error.code).toBe('invalid_cleanup_flags');

    const promptMode = await runTasksCli(['cleanup', '--prompt'], { createStore });
    expect(promptMode.exitCode).toBe(0);
    expect(promptMode.stdout).toContain('# Role');

    const promptWithHard = await runTasksCli(['cleanup', '--prompt', '--hard'], { createStore });
    expect(promptWithHard.exitCode).toBe(1);
    expect(JSON.parse(promptWithHard.stderr).error.code).toBe('invalid_cleanup_flags');

    const promptWithDays = await runTasksCli(['cleanup', '--prompt', '30'], { createStore });
    expect(promptWithDays.exitCode).toBe(1);
    expect(JSON.parse(promptWithDays.stderr).error.code).toBe('invalid_cleanup_flags');

    const promptWithDryRun = await runTasksCli(['cleanup', '--prompt', '--dry-run'], {
      createStore,
    });
    expect(promptWithDryRun.exitCode).toBe(1);
    expect(JSON.parse(promptWithDryRun.stderr).error.code).toBe('invalid_cleanup_flags');

    // --orphans-only + --recover-orphans should error
    const orphansOnlyWithRecover = await runTasksCli(
      ['cleanup', '--orphans-only', '--recover-orphans'],
      { createStore },
    );
    expect(orphansOnlyWithRecover.exitCode).toBe(1);
    expect(JSON.parse(orphansOnlyWithRecover.stderr).error.code).toBe('invalid_cleanup_flags');
  });

  it('dry-run renders [dry-run] prefix', async () => {
    const createStore = async () => fakeStore();

    const agedDryRun = await runTasksCli(['cleanup', '30', '--dry-run'], { createStore });
    expect(agedDryRun.exitCode).toBe(0);
    expect(agedDryRun.stdout).toContain('[dry-run] Aged cleanup:');

    const orphansDryRun = await runTasksCli(['cleanup', '--orphans-only', '--dry-run'], {
      createStore,
    });
    expect(orphansDryRun.exitCode).toBe(0);
    expect(orphansDryRun.stdout).toContain('[dry-run] Orphan recovery:');
  });

  it('aged mode renders deleted count', async () => {
    const createStore = async () => fakeStore();
    const result = await runTasksCli(['cleanup', '30'], { createStore });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Aged cleanup: deleted=\d+ \(hard=false\)/);
  });

  it('--recover-orphans renders both aged and orphan sections', async () => {
    const createStore = async () => fakeStore();
    const result = await runTasksCli(['cleanup', '30', '--recover-orphans'], { createStore });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aged cleanup:');
    expect(result.stdout).toContain('Orphan recovery:');
  });

  it('--recover-orphans --dry-run renders [dry-run] prefix on both sections', async () => {
    const createStore = async () => fakeStore();
    const result = await runTasksCli(['cleanup', '30', '--recover-orphans', '--dry-run'], {
      createStore,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[dry-run] Aged cleanup:');
    expect(result.stdout).toContain('[dry-run] Orphan recovery:');
  });

  it('renders orphan detail lines for recovered and skipped tasks', async () => {
    const root = await temporaryDirectory();
    const initProcess = Bun.spawn(['git', 'init'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    await initProcess.exited;
    const store = await createTaskStore({ cwd: root });
    store.create({ id: 'orphan-task', title: 'Orphan', status: 'in-progress' });
    store.create({
      id: 'skip-task',
      title: 'Skip',
      status: 'in-progress',
      branch: 'refs/heads/foo',
    });
    const createStore = async () => store;

    const runner = async (_cmd: string[]): Promise<CommandResult> => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const result = await runTasksCli(['cleanup', '--orphans-only'], { createStore, runner });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Orphan recovery: recovered=1');
    expect(result.stdout).toContain('in-progress→ready');
    expect(result.stdout).toContain('no branch recorded');
    expect(result.stdout).toContain('skip-task');
    expect(result.stdout).toContain('skipped');
  });
});
