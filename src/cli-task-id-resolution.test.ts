import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { parseArguments, validatePositionals } from './cli-arguments';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-task-id-resolution-'));
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

describe('resolveTaskId — UUID passthrough', () => {
  it('get returns the specified task by UUID', async () => {
    const root = await workspaceRoot();
    const { currentId, otherId } = await seedTasks(root);

    const result = await runTasksCli(['get', otherId], { cwd: root });
    const parsed = JSON.parse(result.stdout) as { id: string };
    expect(parsed.id).toBe(otherId);
    expect(parsed.id).not.toBe(currentId);
  });

  it('update acts on only the resolved task by UUID', async () => {
    const root = await workspaceRoot();
    const { currentId, otherId } = await seedTasks(root);

    const result = await runTasksCli(['update', otherId, '--title', 'Renamed by UUID'], {
      cwd: root,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ id: otherId, title: 'Renamed by UUID' });

    const unchanged = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ title: 'Current task' });
  });

  it('delete removes only the resolved task by UUID', async () => {
    const root = await workspaceRoot();
    const { otherId, currentId } = await seedTasks(root);

    await runTasksCli(['delete', otherId], { cwd: root });

    // Soft-deleted task still exists but is marked deleted=true
    const deletedResult = await runTasksCli(['get', otherId], { cwd: root });
    expect(JSON.parse(deletedResult.stdout)).toMatchObject({ id: otherId, deleted: true });

    // Other task untouched
    const untouched = await runTasksCli(['get', currentId], { cwd: root });
    expect(JSON.parse(untouched.stdout)).toMatchObject({ id: currentId, deleted: false });
  });
});

describe('resolveTaskId — `next` token', () => {
  it('get next returns the highest-priority available task', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    let highPriorityId: string;
    let lowPriorityId: string;
    try {
      lowPriorityId = store.create({ title: 'Low priority', priority: 1 }).id;
      highPriorityId = store.create({ title: 'High priority', priority: 3 }).id;
    } finally {
      store.close();
    }

    const result = await runTasksCli(['get', 'next'], { cwd: root });
    const parsed = JSON.parse(result.stdout) as { id: string };
    expect(parsed.id).toBe(highPriorityId!);
    expect(parsed.id).not.toBe(lowPriorityId!);
  });

  it('next errors with next_task_not_found when no claimable task exists', async () => {
    const root = await workspaceRoot();
    expect(await errorCode(['get', 'next'], root)).toBe('next_task_not_found');
  });
});

// Returns exit 0 with --worktree in stdout so checkProviderCapabilities passes
// without requiring the claude or codex CLI to be installed in the test environment.
const stubProviderRunner = async (
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  if (cmd[1] === '--help') return { exitCode: 0, stdout: '--worktree --print -C', stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};

describe('resolveTaskId — start and resume commands', () => {
  it('start with explicit task-id starts that task', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);
    const invocations: string[][] = [];

    const result = await runTasksCli(['start', currentId, '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runner: stubProviderRunner,
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');
    expect(invocations[0]).toContain('--session-id');
  });

  it('start current starts the current branch task', async () => {
    const root = await workspaceRoot();
    const { currentId: _ } = await seedTasks(root);
    const invocations: string[][] = [];

    const result = await runTasksCli(['start', 'current', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runner: stubProviderRunner,
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');
  });

  it('start next starts the next claimable task without invoking claim-next path', async () => {
    const root = await workspaceRoot();
    const store = await createTaskStore({ cwd: root });
    let nextId: string;
    let lowerId: string;
    try {
      lowerId = store.create({ title: 'Low priority', priority: 1 }).id;
      nextId = store.create({ title: 'High priority', priority: 3 }).id;
    } finally {
      store.close();
    }

    const invocations: string[][] = [];
    const result = await runTasksCli(['start', 'next', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runner: stubProviderRunner,
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations[0]?.[0]).toBe('/bin/provider');

    // Only the resolved task should be in-progress; lower-priority task untouched
    const lowerResult = await runTasksCli(['get', lowerId!], { cwd: root });
    expect(JSON.parse(lowerResult.stdout)).toMatchObject({ status: 'ready' });

    const nextResult = await runTasksCli(['get', nextId!], { cwd: root });
    expect(JSON.parse(nextResult.stdout)).toMatchObject({ status: 'in-progress' });
  });

  it('start current reattaches an in-progress task with a recorded session', async () => {
    const root = await workspaceRoot();
    const { currentId } = await seedTasks(root);
    const claudeConfigDir = join(await temporaryDirectory(), '.claude');

    await runTasksCli(
      [
        'update',
        currentId,
        '--status',
        'in-progress',
        '--provider',
        'claude',
        '--session',
        'some-session',
      ],
      { cwd: root },
    );

    const invocations: string[][] = [];
    const result = await runTasksCli(['start', 'current', '--cli', 'claude'], {
      cwd: root,
      environment: { CLAUDE_CONFIG_DIR: claudeConfigDir },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation.command);
        return 0;
      },
    });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(invocations.at(-1)?.slice(0, 2)).toEqual(['/bin/provider', '--resume']);
  });
});

describe('resolveTaskId — case sensitivity and whitespace', () => {
  it('Current (capitalized) is treated as a UUID and emits task_not_found', async () => {
    const root = await workspaceRoot();
    await seedTasks(root);
    // update requires a real task id — store throws task_not_found for unknown ids
    expect(await errorCode(['update', 'Current', '--title', 'x'], root)).toBe('task_not_found');
  });

  it('NEXT (uppercase) is treated as a UUID and emits task_not_found', async () => {
    const root = await workspaceRoot();
    await seedTasks(root);
    expect(await errorCode(['update', 'NEXT', '--title', 'x'], root)).toBe('task_not_found');
  });
});

describe('resolveTaskId — missing argument gate (every positional task-id command)', () => {
  const positionalTaskIdCommands = [
    'get',
    'session',
    'start',
    'delete',
    'update',
    'tags',
    'blockers',
    'blocked-by',
    'blocking',
  ] as const;

  for (const command of positionalTaskIdCommands) {
    it(`${command} emits missing_argument when called with no arguments`, async () => {
      const root = await workspaceRoot();
      const code = await errorCode([command], root);
      expect(code).toBe('missing_argument');
    });
  }

  it('every positional task-id command has minPositionals >= 1 (validated via validatePositionals)', () => {
    for (const command of positionalTaskIdCommands) {
      // Passing zero positionals must throw missing_argument.
      const parsed = parseArguments([command]);
      let threw = false;
      try {
        validatePositionals(parsed);
      } catch (error) {
        threw = true;
        expect((error as { code?: string }).code).toBe('missing_argument');
      }
      expect(threw).toBe(true);
    }
  });

  it('deleted symbols are absent from production source files', async () => {
    const glob = new Glob('src/**/*.ts');
    const deletedFragments = [
      // Base64-encoded to avoid self-matching:
      // taskIdFromArguments, hasExplicitTaskId, trailingArgumentCount
      // taskCommandArguments, requiredTaskCommandArgument
      atob('dGFza0lkRnJvbUFyZ3VtZW50cw=='),
      atob('aGFzRXhwbGljaXRUYXNrSWQ='),
      atob('dHJhaWxpbmdBcmd1bWVudENvdW50'),
      atob('dGFza0NvbW1hbmRBcmd1bWVudHM='),
      atob('cmVxdWlyZWRUYXNrQ29tbWFuZEFyZ3VtZW50'),
    ];
    for await (const file of glob.scan('.')) {
      if (file.endsWith('.test.ts')) continue;
      const content = await Bun.file(file).text();
      for (const fragment of deletedFragments) {
        expect(content).not.toContain(fragment);
      }
    }
  });
});
