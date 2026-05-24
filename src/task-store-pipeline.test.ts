import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskStore } from './database-open';
import { parsePipelineMarker } from './pipeline-markers';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-pipeline-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const process = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('TaskStore.claimNext', () => {
  it('returns null when no claimable task exists', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      expect(store.claimNext({ runId: 'run-1' })).toBeNull();
    } finally {
      store.close();
    }
  });

  it('atomically transitions the next task to in-progress and writes a phase=claim marker', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 'task-1', title: 'Pick me' });
      const claimed = store.claimNext({ runId: 'run-abc' });
      expect(claimed?.id).toBe(task.id);
      expect(claimed?.status).toBe('in-progress');

      const progress = store.progress(task.id);
      expect(progress).toHaveLength(1);
      const parsed = parsePipelineMarker(progress[0]!.message);
      expect(parsed).toMatchObject({ phase: 'claim', taskId: task.id, runId: 'run-abc' });
    } finally {
      store.close();
    }
  });

  it('refuses to double-claim the same task once it is in-progress', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'task-1', title: 'Solo' });
      const first = store.claimNext({ runId: 'run-1' });
      const second = store.claimNext({ runId: 'run-2' });
      expect(first?.id).toBe('task-1');
      expect(second).toBeNull();
    } finally {
      store.close();
    }
  });

  it('respects blocker filtering — blocked tasks are not claimable', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const blocker = store.create({ id: 'blocker', title: 'Blocker' });
      store.create({ id: 'blocked', title: 'Blocked', blockedBy: [blocker] });
      const claimed = store.claimNext({ runId: 'run-1' });
      expect(claimed?.id).toBe('blocker');
    } finally {
      store.close();
    }
  });
});

describe('TaskStore.listClaimCandidates', () => {
  it('returns up to limit ready tasks in claim order', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A', priority: 1 });
      store.create({ id: 'b', title: 'B', priority: 3 });
      store.create({ id: 'c', title: 'C', priority: 2 });
      const candidates = store.listClaimCandidates(2);
      expect(candidates).toHaveLength(2);
      // Highest priority first; b (3) then c (2).
      expect(candidates[0]?.id).toBe('b');
      expect(candidates[1]?.id).toBe('c');
    } finally {
      store.close();
    }
  });

  it('honors excludeIds without mutating store state', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      store.create({ id: 'b', title: 'B' });
      const skipping = store.listClaimCandidates(2, new Set(['a']));
      expect(skipping.map((t) => t.id)).toEqual(['b']);
      // No claim happened — both remain ready.
      expect(store.next()?.id).toBe('a');
    } finally {
      store.close();
    }
  });

  it('returns an empty array for non-positive limits', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ id: 'a', title: 'A' });
      expect(store.listClaimCandidates(0)).toEqual([]);
      expect(store.listClaimCandidates(-1)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('TaskStore.conditionalUpdate', () => {
  it('updates when every predicate field matches', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 't', title: 'T' });
      const updated = store.conditionalUpdate(
        task.id,
        { status: 'in-progress' },
        { ifStatus: 'ready' },
      );
      expect(updated?.status).toBe('in-progress');
    } finally {
      store.close();
    }
  });

  it('returns null and skips writes when ifStatus does not match', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 't', title: 'T', status: 'in-progress' });
      const result = store.conditionalUpdate(task.id, { status: 'ready' }, { ifStatus: 'ready' });
      expect(result).toBeNull();
      expect(store.getTask(task.id)?.status).toBe('in-progress');
    } finally {
      store.close();
    }
  });

  it('matches ifRunId against the latest pipeline phase marker', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 't', title: 'T' });
      store.claimNext({ runId: 'run-abc' });
      const matched = store.conditionalUpdate(task.id, { status: 'ready' }, { ifRunId: 'run-abc' });
      expect(matched?.status).toBe('ready');

      const mismatch = store.conditionalUpdate(
        task.id,
        { status: 'in-progress' },
        { ifRunId: 'run-other' },
      );
      expect(mismatch).toBeNull();
      expect(store.getTask(task.id)?.status).toBe('ready');
    } finally {
      store.close();
    }
  });

  it('returns null when the task does not exist', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const result = store.conditionalUpdate('missing', { status: 'ready' }, {});
      expect(result).toBeNull();
    } finally {
      store.close();
    }
  });

  it('returns null when ifBranch does not match the current branch', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 't', title: 'T', branch: 'tasks/abc' });
      const result = store.conditionalUpdate(
        task.id,
        { branch: 'tasks/xyz' },
        { ifBranch: 'other-branch' },
      );
      expect(result).toBeNull();
      expect(store.getTask(task.id)?.branch).toBe('tasks/abc');
    } finally {
      store.close();
    }
  });

  it('returns null when ifRunId is set but no pipeline marker exists', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    try {
      const task = store.create({ id: 't', title: 'T' });
      const result = store.conditionalUpdate(
        task.id,
        { status: 'in-progress' },
        { ifRunId: 'run-1' },
      );
      expect(result).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('parsePipelineMarker', () => {
  it('returns null for non-marker messages', async () => {
    expect(parsePipelineMarker('hello world')).toBeNull();
    expect(parsePipelineMarker('pipeline:phase=claim')).toBeNull();
    expect(parsePipelineMarker('pipeline:phase=bogus;task=t;run=r;at=2026')).toBeNull();
  });

  it('parses canonical markers', async () => {
    const parsed = parsePipelineMarker(
      'pipeline:phase=address-pr;task=t-1;run=r-2;at=2026-01-01T00:00:00Z',
    );
    expect(parsed).toMatchObject({
      phase: 'address-pr',
      taskId: 't-1',
      runId: 'r-2',
      at: '2026-01-01T00:00:00Z',
    });
  });
});
