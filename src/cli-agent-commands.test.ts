import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentHookCommand, startTask } from './cli-agent-commands';
import { parseArguments } from './cli-arguments';
import type { CommandRunner } from './command-runner';
import { createTaskStore } from './database-open';
import { taskStartRunner as startRunner } from './test-runner-mocks';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-agent-command-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, '.gitignore'), 'tmp/\n');
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'init'], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('startTask phase resolution and worktree setup', () => {
  it('selects resume-implementation when status is in-progress and plan is non-empty', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Resume me' });
    store.update(task.id, { status: 'in-progress' });
    const planPath = join(root, 'tmp', 'tasks', task.id, 'PLAN.md');
    await mkdir(join(root, 'tmp', 'tasks', task.id), { recursive: true });
    await writeFile(planPath, '# Plan\n');

    const stderrLines: string[] = [];
    const invocations: string[][] = [];
    try {
      const result = await startTask(store, task.id, {
        provider: 'claude',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation.command);
          return 0;
        },
        stderr: (line) => stderrLines.push(line),
      });
      expect(result.exitCode).toBe(0);
      expect(invocations[0]).not.toContain('--permission-mode');
      expect(invocations[0]?.join('\n')).toContain('resume-implementation');
    } finally {
      store.close();
    }
  });

  it('selects resume-planning when status is in-progress but plan file is empty', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Plan missing' });
    store.update(task.id, { status: 'in-progress' });
    const planPath = join(root, 'tmp', 'tasks', task.id, 'PLAN.md');
    await mkdir(join(root, 'tmp', 'tasks', task.id), { recursive: true });
    await writeFile(planPath, '');

    const invocations: string[][] = [];
    try {
      await startTask(store, task.id, {
        provider: 'claude',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation.command);
          return 0;
        },
        stderr: () => {},
      });
      expect(invocations[0]).toContain('--permission-mode');
      expect(invocations[0]?.join('\n')).toContain('resume-planning');
    } finally {
      store.close();
    }
  });

  it('refuses --no-worktree on the resolved base branch without --force', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Base guard' });

    const runner = startRunner({
      'git branch --show-current': () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
    });
    try {
      let caught: unknown;
      try {
        await startTask(store, task.id, {
          provider: 'codex',
          which: () => '/bin/provider',
          runner,
          noWorktree: true,
          runAgentInvocation: async () => 0,
          stderr: () => {},
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'refuse_no_worktree_on_base_branch' });
    } finally {
      store.close();
    }
  });

  it('allows --no-worktree with --force, warns to stderr, and runs in projectRoot', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Force base' });

    const runner = startRunner({
      'git branch --show-current': () => ({ exitCode: 0, stdout: 'main\n', stderr: '' }),
    });
    const stderrLines: string[] = [];
    const invocations: string[][] = [];
    try {
      const result = await startTask(store, task.id, {
        provider: 'codex',
        which: () => '/bin/provider',
        runner,
        noWorktree: true,
        force: true,
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation.command);
          return 0;
        },
        stderr: (line) => stderrLines.push(line),
      });
      expect(result.exitCode).toBe(0);
      expect(stderrLines.some((line) => line.includes('--no-worktree'))).toBe(true);
      expect(invocations[0]).toContain('--cd');
      expect(invocations[0]?.[invocations[0].indexOf('--cd') + 1]).toBe(store.projectRoot);
      // Running on the integration branch must not pin the task to it.
      expect(store.getTask(task.id)?.branch).toBeNull();
    } finally {
      store.close();
    }
  });

  it('emits the status line unless --quiet is set', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Status line' });

    const stderr: string[] = [];
    try {
      await startTask(store, task.id, {
        provider: 'claude',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async () => 0,
        stderr: (line) => stderr.push(line),
      });
    } finally {
      store.close();
    }
    expect(stderr.some((line) => line.startsWith('▶ task task-id'))).toBe(true);
  });

  it('suppresses status line under --quiet but still warns on --no-worktree', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Quiet' });

    const runner = startRunner({
      'git branch --show-current': () => ({ exitCode: 0, stdout: 'feature/branch\n', stderr: '' }),
    });
    const stderr: string[] = [];
    try {
      await startTask(store, task.id, {
        provider: 'codex',
        which: () => '/bin/provider',
        runner,
        noWorktree: true,
        quiet: true,
        runAgentInvocation: async () => 0,
        stderr: (line) => stderr.push(line),
      });
    } finally {
      store.close();
    }
    expect(stderr.every((line) => !line.startsWith('▶'))).toBe(true);
    expect(stderr.some((line) => line.includes('--no-worktree'))).toBe(true);
  });

  it('fails MISSING_CLAUDE_WORKTREE when claude --help lacks the flag', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Capability' });

    const runner: CommandRunner = async (command) => {
      if (command.includes('--help')) {
        return { exitCode: 0, stdout: 'Options:\n  -h, --help\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    try {
      let caught: unknown;
      try {
        await startTask(store, task.id, {
          provider: 'claude',
          which: () => '/bin/provider',
          runner,
          runAgentInvocation: async () => 0,
          stderr: () => {},
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'MISSING_CLAUDE_WORKTREE' });
    } finally {
      store.close();
    }
  });

  it('reuses an existing tasks/<short> branch by parsing its short id', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({
      id: 'task-id',
      title: 'Existing branch',
      branch: 'tasks/deadbeef',
    });

    const invocations: string[][] = [];
    try {
      await startTask(store, task.id, {
        provider: 'codex',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation.command);
          return 0;
        },
        stderr: () => {},
      });
      expect(invocations[0]?.join('\n')).toContain('tasks/deadbeef');
    } finally {
      store.close();
    }
  });

  it('treats a non-standard recorded branch by re-deriving the short id', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({
      id: 'task-id',
      title: 'Non-standard branch',
      branch: 'feature/legacy',
    });

    const invocations: string[][] = [];
    try {
      await startTask(store, task.id, {
        provider: 'codex',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation.command);
          return 0;
        },
        stderr: () => {},
      });
      // Codex worktree path should still be derived; invocation includes --cd to some path.
      expect(invocations[0]).toContain('--cd');
    } finally {
      store.close();
    }
  });

  it('returns null branch when git is unavailable in --no-worktree mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Git missing' });

    const runner: CommandRunner = async (command) => {
      const joined = command.join(' ');
      if (joined.endsWith('--help')) {
        return {
          exitCode: 0,
          stdout: 'Options:\n  --worktree [name]\n  -C, --cd <DIR>\n',
          stderr: '',
        };
      }
      if (joined === 'git branch --show-current') {
        return { exitCode: 1, stdout: '', stderr: 'fatal' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };
    try {
      const result = await startTask(store, task.id, {
        provider: 'codex',
        which: () => '/bin/provider',
        runner,
        noWorktree: true,
        force: true,
        runAgentInvocation: async () => 0,
        stderr: () => {},
      });
      expect(result.exitCode).toBe(0);
    } finally {
      store.close();
    }
  });

  it('leaves the task claimed when Claude fails after creating a managed worktree', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Revert me', status: 'ready' });

    const stderrLines: string[] = [];
    try {
      await startTask(store, task.id, {
        provider: 'claude',
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async () => 1,
        stderr: (line) => stderrLines.push(line),
      });
      const after = store.getTask(task.id);
      expect(after?.status).toBe('in-progress');
      expect(after?.branch).toStartWith('tasks/');
      expect(stderrLines.some((line) => line.includes('provider claude'))).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe('startTask — reattach paths', () => {
  it('throws provider_mismatch when a different provider is requested on resume', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    const task = store.create({ id: 'task-id', title: 'Provider mismatch' });
    // Set up an in-progress task with a stored claude provider/session
    store.update(task.id, {
      status: 'in-progress',
      provider: 'claude',
      session: 'claude-session-id',
    });

    let caught: unknown;
    try {
      // Task was started with claude; request codex via --cli override → should throw provider_mismatch
      await startTask(store, task.id, {
        // provider: undefined so optionalProviderFromStartOptions uses the environment override
        environment: { SCRUMLORD_CLI: 'codex' },
        which: () => '/bin/provider',
        runner: startRunner(),
        runAgentInvocation: async () => 0,
        stderr: () => {},
      });
    } catch (error) {
      caught = error;
    } finally {
      store.close();
    }
    expect((caught as { code?: string })?.code).toBe('provider_mismatch');
  });
});

describe('runAgentHookCommand', () => {
  it('returns UserPromptSubmit context on stdout', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
    await mkdir(join(root, 'tmp', 'tasks', 'task-id'), { recursive: true });
    await writeFile(join(root, 'tmp', 'tasks', 'task-id', 'PLAN.md'), '# Plan\n');
    const task = store.create({
      id: 'task-id',
      title: 'Inject task context',
      branch: 'feature/current',
      plan: 'tmp/tasks/task-id/PLAN.md',
    });
    try {
      const result = await runAgentHookCommand(store, parseArguments(['agent-hook', 'codex']), {
        environment: { SCRUMLORD_TASK_ID: task.id },
        readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Scrumlord inferred this task for the current branch.');
      expect(result.stdout).toContain('id: task-id');
      expect(result.stdout).toContain('tmp/tasks/task-id/PLAN.md');
    } finally {
      store.close();
    }
  });
});
