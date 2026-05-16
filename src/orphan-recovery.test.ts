import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from './command-runner.js';
import { createTaskStore } from './database-open.js';
import { branchExistsAnywhere, findOrphans, recoverOrphans } from './orphan-recovery.js';
import type { TaskStore } from './types.js';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-orphan-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const fail = (exitCode = 1, stderr = ''): CommandResult => ({ exitCode, stdout: '', stderr });

/** Builds a mock CommandRunner from a map of command → result. Falls back to exitCode=1. */
const mockRunner = (
  replies: Partial<Record<string, CommandResult | (() => CommandResult)>>,
): CommandRunner => {
  return async (command) => {
    const joined = command.join(' ');
    for (const [pattern, reply] of Object.entries(replies)) {
      if (joined === pattern || joined.startsWith(pattern)) {
        return typeof reply === 'function' ? reply() : reply;
      }
    }
    return fail();
  };
};

const createStore = async (): Promise<{ root: string; store: TaskStore }> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  const store = await createTaskStore({ cwd: root });
  return { root, store };
};

describe('branchExistsAnywhere', () => {
  it('returns exists when local ref found', async () => {
    const runner = mockRunner({ 'git show-ref --verify --quiet refs/heads/main': ok() });
    const result = await branchExistsAnywhere('/tmp', 'main', runner);
    expect(result).toBe('exists');
  });

  it('returns exists when only remote ref found', async () => {
    const runner = mockRunner({
      'git show-ref --verify --quiet refs/heads/main': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/main': ok(),
    });
    const result = await branchExistsAnywhere('/tmp', 'main', runner);
    expect(result).toBe('exists');
  });

  it('returns missing when both local and remote refs absent', async () => {
    const runner = mockRunner({
      'git show-ref --verify --quiet refs/heads/task/abc': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/abc': fail(1),
    });
    const result = await branchExistsAnywhere('/tmp', 'task/abc', runner);
    expect(result).toBe('missing');
  });

  it('returns error when local git exits non-1', async () => {
    const runner = mockRunner({ 'git show-ref --verify --quiet refs/heads/main': fail(128) });
    const result = await branchExistsAnywhere('/tmp', 'main', runner);
    expect(result).toBe('error');
  });

  it('returns error when remote git exits non-1 after local fails', async () => {
    const runner = mockRunner({
      'git show-ref --verify --quiet refs/heads/main': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/main': fail(128),
    });
    const result = await branchExistsAnywhere('/tmp', 'main', runner);
    expect(result).toBe('error');
  });
});

describe('findOrphans', () => {
  it('returns empty arrays when no in-progress tasks', async () => {
    const { root, store } = await createStore();
    const calls: string[] = [];
    const runner: CommandRunner = async (cmd) => {
      calls.push(cmd.join(' '));
      return ok();
    };
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
    expect(result.skips).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('flags task with null branch as missing-branch-field', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress' });
    const runner = mockRunner({ 'git remote': ok('origin\n') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reason).toBe('missing-branch-field');
    expect(result.candidates[0]!.task.id).toBe('t1');
  });

  it('flags task with empty string branch as missing-branch-field', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: '' });
    const runner = mockRunner({ 'git remote': ok('origin\n') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reason).toBe('missing-branch-field');
  });

  it('flags task with whitespace-only branch as missing-branch-field', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: '   ' });
    const runner = mockRunner({ 'git remote': ok('origin\n') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reason).toBe('missing-branch-field');
  });

  it('skips task whose branch exists locally', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc': ok(),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
    expect(result.skips).toHaveLength(0);
  });

  it('skips task whose branch exists only on origin', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/abc': ok(),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
    expect(result.skips).toHaveLength(0);
  });

  it('flags task whose branch is absent from both local and remote', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/abc': fail(1),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reason).toBe('branch-not-in-git');
  });

  it('skips with git-probe-error when local git exit is non-1 (128)', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc': fail(128),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
    expect(result.skips).toHaveLength(1);
    expect(result.skips[0]!.reason).toBe('git-probe-error');
  });

  it('skips with git-probe-error when remote git exit is non-1 (128)', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/abc': fail(128),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.skips[0]!.reason).toBe('git-probe-error');
  });

  it('rejects refs/ prefixed branch with invalid-branch-value without calling check-ref-format', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'refs/heads/foo' });
    let checkRefFormatCalled = false;
    const runner: CommandRunner = async (cmd) => {
      const joined = cmd.join(' ');
      if (joined.startsWith('git check-ref-format')) checkRefFormatCalled = true;
      if (joined === 'git remote') return ok('origin\n');
      return fail();
    };
    const result = await findOrphans(store, root, runner);
    expect(result.skips[0]!.reason).toBe('invalid-branch-value');
    expect(checkRefFormatCalled).toBe(false);
  });

  it('rejects origin/foo when origin is a remote without calling check-ref-format', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'origin/foo' });
    let checkRefFormatCalled = false;
    const runner: CommandRunner = async (cmd) => {
      const joined = cmd.join(' ');
      if (joined.startsWith('git check-ref-format')) checkRefFormatCalled = true;
      if (joined === 'git remote') return ok('origin\n');
      return fail();
    };
    const result = await findOrphans(store, root, runner);
    expect(result.skips[0]!.reason).toBe('invalid-branch-value');
    expect(checkRefFormatCalled).toBe(false);
  });

  it('accepts task/abc123 since slash alone is not a rejection signal', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/abc123' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/abc123': ok(),
      'git show-ref --verify --quiet refs/heads/task/abc123': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/abc123': fail(1),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates[0]!.reason).toBe('branch-not-in-git');
  });

  it('accepts origin/foo when only upstream is a remote', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'origin/foo' });
    const runner = mockRunner({
      'git remote': ok('upstream\n'),
      'git check-ref-format --branch origin/foo': ok(),
      'git show-ref --verify --quiet refs/heads/origin/foo': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/origin/foo': fail(1),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates[0]!.reason).toBe('branch-not-in-git');
  });

  it('rejects branch with spaces via check-ref-format', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'foo bar' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch foo bar': fail(1),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.skips[0]!.reason).toBe('invalid-branch-value');
  });

  it('returns git-probe-error when check-ref-format exits 128', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/x' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/x': fail(128, 'fatal: broken'),
    });
    const result = await findOrphans(store, root, runner);
    expect(result.skips[0]!.reason).toBe('git-probe-error');
  });

  it('skips non-empty branch tasks with git-probe-error when git remote fails, but still recovers null-branch tasks', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task with branch', status: 'in-progress', branch: 'task/x' });
    store.create({ id: 't2', title: 'Task no branch', status: 'in-progress' });
    const runner = mockRunner({ 'git remote': fail(1) });
    const result = await findOrphans(store, root, runner);
    const gitProbeSkip = result.skips.find((s) => s.id === 't1');
    const nullBranchCandidate = result.candidates.find((c) => c.task.id === 't2');
    expect(gitProbeSkip?.reason).toBe('git-probe-error');
    expect(nullBranchCandidate?.reason).toBe('missing-branch-field');
  });

  it('skips in-progress task that is soft-deleted', async () => {
    const { root, store } = await createStore();
    const task = store.create({ id: 't1', title: 'Task', status: 'in-progress' });
    store.delete(task.id);
    const runner = mockRunner({ 'git remote': ok('') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
    expect(result.skips).toHaveLength(0);
  });

  it('skips in-review task with missing branch', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-review' });
    const runner = mockRunner({ 'git remote': ok('') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
  });

  it('skips ready task with null branch', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'ready' });
    const runner = mockRunner({ 'git remote': ok('') });
    const result = await findOrphans(store, root, runner);
    expect(result.candidates).toHaveLength(0);
  });
});

describe('recoverOrphans', () => {
  it('demotes orphan: status ready, branch null, session null, plan preserved, provider preserved', async () => {
    const { root, store } = await createStore();
    // Write a real plan file so the store accepts it
    const planPath = join(root, 'plan.md');
    await Bun.write(planPath, '# Plan\n');
    store.create({
      id: 't1',
      title: 'Task',
      status: 'in-progress',
      branch: null,
      plan: planPath,
      provider: 'claude',
      session: 'sess123',
    });
    const runner = mockRunner({ 'git remote': ok('') });
    const { orphans } = await recoverOrphans(store, root, runner);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.applied).toBe(true);
    const recovered = store.getTask('t1')!;
    expect(recovered.status).toBe('ready');
    expect(recovered.branch).toBeNull();
    expect(recovered.session).toBeNull();
    expect(recovered.plan).toBe(planPath);
    expect(recovered.provider).toBe('claude');
  });

  it('dry-run returns applied=false and does not mutate the task', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress' });
    const runner = mockRunner({ 'git remote': ok('') });
    const { orphans } = await recoverOrphans(store, root, runner, { dryRun: true });
    expect(orphans[0]!.applied).toBe(false);
    expect(store.getTask('t1')!.status).toBe('in-progress');
  });

  it('progress entry contains previous branch and reason', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: null });
    const runner = mockRunner({ 'git remote': ok('') });
    await recoverOrphans(store, root, runner);
    const progress = store.progress('t1');
    expect(progress.some((p) => p.message.includes('[cleanup] orphan recovered'))).toBe(true);
    expect(progress.some((p) => p.message.includes('missing-branch-field'))).toBe(true);
  });

  it('stale-state guard: surfaces stale-state skip when task changes between discovery and recovery', async () => {
    const { root, store } = await createStore();
    store.create({ id: 't1', title: 'Task', status: 'in-progress', branch: 'task/x' });
    const runner = mockRunner({
      'git remote': ok('origin\n'),
      'git check-ref-format --branch task/x': ok(),
      'git show-ref --verify --quiet refs/heads/task/x': fail(1),
      'git show-ref --verify --quiet refs/remotes/origin/task/x': fail(1),
    });

    // Simulate another writer updating the task between discovery and recovery
    // We wrap the store with a proxy so the underlying private fields remain accessible
    const interceptingStore: typeof store = new Proxy(store, {
      get(target, prop) {
        if (prop === 'recoverOrphan') {
          return (...args: Parameters<typeof store.recoverOrphan>) => {
            target.update('t1', { branch: 'task/y' });
            return target.recoverOrphan(...args);
          };
        }
        const value = (target as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const { orphans, skipped } = await recoverOrphans(interceptingStore, root, runner);
    expect(orphans).toHaveLength(0);
    expect(skipped[0]!.reason).toBe('stale-state');
  });
});
