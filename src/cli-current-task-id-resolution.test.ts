import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-current-task-id-resolution-'));
  temporaryDirectories.push(directory);
  return directory;
};

const run = async (command: string[], cwd: string): Promise<void> => {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text());
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  await run(['git', 'init'], root);
  await run(['git', 'checkout', '-b', 'feature/resolution-test'], root);
  return root;
};

const errorCode = async (args: string[], cwd: string): Promise<string> => {
  const result = await runTasksCli(args, { cwd });
  return JSON.parse(result.stderr).error.code as string;
};

const taskIdFromOutput = (output: string): string => {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'id' in parsed &&
    typeof parsed.id === 'string'
  ) {
    return parsed.id;
  }
  throw new Error('Expected task JSON with a string id.');
};

const seedTasks = async (root: string): Promise<{ currentId: string; otherId: string }> => {
  const store = await createTaskStore({ cwd: root });
  try {
    const other = store.create({ title: 'Other task', branch: 'feature/other' });
    const current = store.create({ title: 'Current task', branch: 'feature/resolution-test' });
    return { currentId: current.id, otherId: other.id };
  } finally {
    store.close();
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('resolveTaskId — `current` token', () => {
  it('get current returns the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const result = await runTasksCli(['get', 'current'], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, title: 'Current task' });
  });

  it('update current acts on the current branch task only', async () => {
    const root = await workspaceRoot();
    const { currentId, otherId } = await seedTasks(root);

    const result = await runTasksCli(['update', 'current', '--title', 'Renamed via current'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: currentId,
      title: 'Renamed via current',
    });

    const unchanged = await runTasksCli(['get', otherId], { cwd: root });
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ title: 'Other task' });
  });

  it('update current --status transitions the current task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const result = await runTasksCli(['update', 'current', '--status', 'in-progress'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, status: 'in-progress' });
  });

  it('session current resolves session for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);
    const codexHome = await temporaryDirectory();

    await runTasksCli(['update', 'current', '--provider', 'codex', '--session', 'codex-sess'], {
      cwd: root,
    });

    const result = await runTasksCli(['session', 'current'], {
      cwd: root,
      environment: { CODEX_HOME: codexHome },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: currentId,
      provider: 'codex',
      session: 'codex-sess',
    });
  });

  it('progress list current lists progress for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['progress', 'add', 'current', '--message', 'First entry'], {
      cwd: root,
      environment: {},
    });

    const result = await runTasksCli(['progress', 'list', 'current'], { cwd: root });
    const entries = JSON.parse(result.stdout) as { taskId: string; message: string }[];
    expect(entries).toEqual([
      expect.objectContaining({ taskId: currentId, message: 'First entry' }),
    ]);
  });

  it('progress add current adds progress for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const result = await runTasksCli(
      ['progress', 'add', 'current', '--message', 'Recorded via current'],
      { cwd: root, environment: {} },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: currentId,
      message: 'Recorded via current',
    });
  });

  it('progress list bare invocation falls back to current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['progress', 'add', 'current', '--message', 'Bare fallback entry'], {
      cwd: root,
      environment: {},
    });

    const result = await runTasksCli(['progress', 'list'], { cwd: root });
    const entries = JSON.parse(result.stdout) as { taskId: string; message: string }[];
    expect(entries).toEqual([
      expect.objectContaining({ taskId: currentId, message: 'Bare fallback entry' }),
    ]);
  });

  it('bare progress defaults to listing the current branch task progress', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['progress', 'add', 'current', '--message', 'Default list entry'], {
      cwd: root,
      environment: {},
    });

    const result = await runTasksCli(['progress'], { cwd: root });
    const entries = JSON.parse(result.stdout) as { taskId: string; message: string }[];
    expect(entries).toEqual([
      expect.objectContaining({ taskId: currentId, message: 'Default list entry' }),
    ]);
  });

  it('progress add bare invocation falls back to current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const result = await runTasksCli(['progress', 'add', '--message', 'Bare add fallback'], {
      cwd: root,
      environment: {},
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      taskId: currentId,
      message: 'Bare add fallback',
    });
  });

  it('tags add current adds a tag to the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const result = await runTasksCli(['tags', 'add', 'current', 'tagged-via-current'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: currentId,
      tags: ['tagged-via-current'],
    });
  });

  it('tags remove current removes a tag from the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['tags', 'add', 'current', 'tag-to-remove'], { cwd: root });
    const result = await runTasksCli(['tags', 'remove', 'current', 'tag-to-remove'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, tags: [] });
  });

  it('tags current lists tags for the current branch task', async () => {
    const root = await workspaceRoot();
    await seedTasks(root);

    await runTasksCli(['tags', 'add', 'current', 'listed-tag'], { cwd: root });
    const result = await runTasksCli(['tags', 'current'], { cwd: root });
    expect(JSON.parse(result.stdout)).toEqual(['listed-tag']);
  });

  it('blockers add current <uuid> adds the specified task as blocker of the current task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const blockerResult = await runTasksCli(['create', '--title', 'Explicit blocker'], {
      cwd: root,
    });
    const blockerId = taskIdFromOutput(blockerResult.stdout);

    const result = await runTasksCli(['blockers', 'add', 'current', blockerId], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: currentId,
      blockedBy: [{ id: blockerId, status: 'ready' }],
    });
  });

  it('blockers add current next resolves next token as second operand', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const store = await createTaskStore({ cwd: root });
    let nextId: string;
    try {
      nextId = store.create({ title: 'High priority next', priority: 3 }).id;
    } finally {
      store.close();
    }

    const result = await runTasksCli(['blockers', 'add', 'current', 'next'], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: currentId,
      blockedBy: [{ id: nextId!, status: 'ready' }],
    });
  });

  it('blocked-by current lists tasks blocking the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const blockerResult = await runTasksCli(['create', '--title', 'Blocker task'], { cwd: root });
    const blockerId = taskIdFromOutput(blockerResult.stdout);

    await runTasksCli(['blockers', 'add', currentId, blockerId], { cwd: root });

    const result = await runTasksCli(['blocked-by', 'current'], { cwd: root });
    const blockers = JSON.parse(result.stdout) as { id: string }[];
    expect(blockers.some((task) => task.id === blockerId)).toBe(true);
  });

  it('blockers current lists tasks blocking the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const blockerResult = await runTasksCli(['create', '--title', 'Blocker task'], { cwd: root });
    const blockerId = taskIdFromOutput(blockerResult.stdout);

    await runTasksCli(['blockers', 'add', currentId, blockerId], { cwd: root });

    const result = await runTasksCli(['blockers', 'current'], { cwd: root });
    const blockers = JSON.parse(result.stdout) as { id: string }[];
    expect(blockers.some((task) => task.id === blockerId)).toBe(true);
  });

  it('blocking current lists tasks the current branch task blocks', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    const dependentResult = await runTasksCli(['create', '--title', 'Dependent task'], {
      cwd: root,
    });
    const dependentId = taskIdFromOutput(dependentResult.stdout);

    await runTasksCli(['blockers', 'add', dependentId, currentId], { cwd: root });

    const result = await runTasksCli(['blocking', 'current'], { cwd: root });
    const dependents = JSON.parse(result.stdout) as { id: string }[];
    expect(dependents.some((task) => task.id === dependentId)).toBe(true);
  });

  it('delete current marks the current branch task as deleted', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['delete', 'current'], { cwd: root });
    const result = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, deleted: true });
  });

  it('clear branch current clears the branch for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['clear', 'branch', 'current'], { cwd: root });
    const result = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, branch: null });
  });

  it('clear plan current clears the plan for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['update', 'current', '--plan', 'tmp/plan.md'], { cwd: root });
    await runTasksCli(['clear', 'plan', 'current'], { cwd: root });
    const result = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: currentId, plan: null });
  });

  it('clear session current clears both provider and session for the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);

    await runTasksCli(['update', 'current', '--provider', 'codex', '--session', 'sess'], {
      cwd: root,
    });
    await runTasksCli(['clear', 'session', 'current'], { cwd: root });
    const result = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: currentId,
      provider: null,
      session: null,
    });
  });

  it('current errors with current_task_not_found when no current branch task exists', async () => {
    const root = await workspaceRoot();
    expect(await errorCode(['get', 'current'], root)).toBe('current_task_not_found');
  });

  it('current errors with current_task_ambiguous when multiple tasks share the branch', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    try {
      store.create({ title: 'Task A', branch: 'feature/resolution-test' });
      store.create({ title: 'Task B', branch: 'feature/resolution-test' });
    } finally {
      store.close();
    }

    expect(await errorCode(['get', 'current'], root)).toBe('current_task_ambiguous');
  });
});
