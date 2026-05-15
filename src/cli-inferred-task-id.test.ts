import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-inferred-task-id-'));
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
  await run(['git', 'checkout', '-b', 'feature/inferred-task'], root);
  return root;
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

const createCurrentTask = async (root: string): Promise<string> => {
  const store = await createTaskStore({ cwd: root });
  try {
    store.create({ title: 'Other task', branch: 'feature/other' });
    return store.create({ title: 'Current task', branch: 'feature/inferred-task' }).id;
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

describe('task-id inference for current branch commands', () => {
  it('uses the current branch task when task-id is omitted', async () => {
    const root = await workspaceRoot();
    const taskId = await createCurrentTask(root);

    const fetched = await runTasksCli(['get'], { cwd: root });
    expect(JSON.parse(fetched.stdout)).toMatchObject({ id: taskId, title: 'Current task' });

    const updated = await runTasksCli(['update', '--title', 'Renamed current task'], {
      cwd: root,
    });
    expect(JSON.parse(updated.stdout)).toMatchObject({
      id: taskId,
      title: 'Renamed current task',
    });

    const status = await runTasksCli(['set-status', 'in-progress'], { cwd: root });
    expect(JSON.parse(status.stdout)).toMatchObject({ id: taskId, status: 'in-progress' });
  });

  it('uses the current branch task for inferred session and progress commands', async () => {
    const root = await workspaceRoot();
    const codexHome = await temporaryDirectory();
    const taskId = await createCurrentTask(root);

    const session = await runTasksCli(['set-session', 'codex', 'codex-session'], { cwd: root });
    expect(JSON.parse(session.stdout)).toMatchObject({
      id: taskId,
      provider: 'codex',
      session: 'codex-session',
    });

    const sessionReport = await runTasksCli(['session'], {
      cwd: root,
      environment: { CODEX_HOME: codexHome },
    });
    expect(JSON.parse(sessionReport.stdout)).toMatchObject({
      taskId,
      provider: 'codex',
      session: 'codex-session',
    });

    const progressEntry = await runTasksCli(
      ['add-progress', '--message', 'Recorded inferred task progress.'],
      // Isolate environment so agent env vars don't override task-inherited provider/session.
      { cwd: root, environment: {} },
    );
    expect(JSON.parse(progressEntry.stdout)).toMatchObject({
      taskId,
      message: 'Recorded inferred task progress.',
      provider: 'codex',
      session: 'codex-session',
    });

    const progress = await runTasksCli(['progress'], { cwd: root });
    expect(JSON.parse(progress.stdout)).toEqual([
      expect.objectContaining({ taskId, message: 'Recorded inferred task progress.' }),
    ]);

    const tagged = await runTasksCli(['add-tag', 'inferred'], { cwd: root });
    expect(JSON.parse(tagged.stdout)).toMatchObject({ id: taskId, tags: ['inferred'] });
  });

  it('uses the current branch task for inferred blocker commands', async () => {
    const root = await workspaceRoot();
    const taskId = await createCurrentTask(root);

    const blocker = await runTasksCli(['create', '--title', 'Blocker task'], { cwd: root });
    const blockerId = taskIdFromOutput(blocker.stdout);
    const blocked = await runTasksCli(['add-blocker', blockerId], { cwd: root });
    expect(JSON.parse(blocked.stdout)).toMatchObject({ id: taskId, blockedBy: [blockerId] });

    const blockers = await runTasksCli(['blocked-by'], { cwd: root });
    expect(JSON.parse(blockers.stdout)).toEqual([expect.objectContaining({ id: blockerId })]);
  });

  it('uses inferred task IDs for start and resume commands', async () => {
    const root = await workspaceRoot();
    const claudeConfigurationDirectory = join(await temporaryDirectory(), '.claude');
    await runTasksCli(['create', '--title', 'Agent task', '--branch', 'feature/inferred-task'], {
      cwd: root,
    });
    const invocations: string[][] = [];

    const startResult = await runTasksCli(['start', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });
    expect(startResult).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');
    expect(invocations[0]).toContain('--session-id');

    const resumeResult = await runTasksCli(['resume'], {
      cwd: root,
      environment: { CLAUDE_CONFIG_DIR: claudeConfigurationDirectory },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });

    expect(resumeResult).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations.at(-1)?.slice(0, 2)).toEqual(['/bin/provider', '--resume']);
  });

  it('fails clearly when no current branch task can be inferred', async () => {
    const result = await runTasksCli(['get'], { cwd: await workspaceRoot() });

    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'current_task_not_found',
      message: 'No active task is assigned to the current Git branch.',
    });
  });
});
