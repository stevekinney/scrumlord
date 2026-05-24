/**
 * Tests for the 7 new workflow command registrations:
 * next, plan (--start), resolve, sync, audit, merge, cleanup (--worktrees)
 *
 * Covers:
 *  - Print mode (no --start): emits prompt, no agent spawn
 *  - Start mode (--start): calls injected runAgentInvocation
 *  - next print mode with a task / with no task (empty output)
 *  - next start mode: claims task and uses tmp/worktrees/tasks/<id> path
 *  - renderPrompt functions return expected strings
 *  - CLI-level routing via runTasksCli
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInvocation } from './agent-providers';
import type { ParsedArguments } from './cli-arguments';
import {
  renderAuditPrompt,
  renderCleanupWorkflowPrompt,
  renderMergePrompt,
  renderNextPrompt,
  renderPlanWorkflowPrompt,
  renderResolvePrompt,
  renderSyncPrompt,
  runNextCommand,
} from './cli-agent-commands';
import type { CliOptions } from './cli-types';
import { runTasksCli } from './cli-runner';
import { createTaskStore } from './database-open';
import { taskStartRunner } from './test-runner-mocks';
import type { TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-workflow-reg-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

/** Writes a .gitignore that covers tmp/ (required by the worktree safety check). */
const writeGitignore = (directory: string): Promise<void> =>
  writeFile(join(directory, '.gitignore'), 'tmp/\n', 'utf-8');

const withStore = async <T>(run: (store: TaskStore, root: string) => Promise<T>): Promise<T> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  await writeGitignore(root);
  const store = await createTaskStore({ cwd: root });
  try {
    return await run(store, root);
  } finally {
    store.close();
  }
};

const parsedWith = (command: string, flags: Record<string, string[]> = {}): ParsedArguments => ({
  command,
  positionals: [],
  flags: new Map(Object.entries(flags)),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

// ---------------------------------------------------------------------------
// renderPrompt purity tests
// ---------------------------------------------------------------------------

describe('renderNextPrompt', () => {
  it('returns empty string when task id is null', () => {
    expect(renderNextPrompt(null, null)).toBe('');
  });

  it('returns prompt with id and title when both are provided', () => {
    const result = renderNextPrompt('abc123', 'Write tests');
    expect(result).toContain('abc123');
    expect(result).toContain('Write tests');
    expect(result).toContain('next');
  });

  it('returns prompt with id only when title is null', () => {
    const result = renderNextPrompt('abc123', null);
    expect(result).toContain('abc123');
    expect(result).toContain('next');
  });
});

describe('renderPlanWorkflowPrompt', () => {
  it('returns a non-empty string referencing the plan skill', () => {
    const result = renderPlanWorkflowPrompt({
      store: {} as TaskStore,
      parsed: parsedWith('plan'),
      options: {},
    });
    expect(result).toContain('plan');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('renderResolvePrompt', () => {
  it('returns a non-empty string referencing the resolve skill', () => {
    const result = renderResolvePrompt({
      store: {} as TaskStore,
      parsed: parsedWith('resolve'),
      options: {},
    });
    expect(result).toContain('resolve');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('renderSyncPrompt', () => {
  it('returns a non-empty string referencing the sync skill', () => {
    const result = renderSyncPrompt({
      store: {} as TaskStore,
      parsed: parsedWith('sync'),
      options: {},
    });
    expect(result).toContain('sync');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('renderAuditPrompt', () => {
  it('returns a non-empty string referencing the audit skill', () => {
    const result = renderAuditPrompt({
      store: {} as TaskStore,
      parsed: parsedWith('audit'),
      options: {},
    });
    expect(result).toContain('audit');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('renderMergePrompt', () => {
  it('returns a non-empty string referencing the merge skill', () => {
    const result = renderMergePrompt({
      store: {} as TaskStore,
      parsed: parsedWith('merge'),
      options: {},
    });
    expect(result).toContain('merge');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('renderCleanupWorkflowPrompt', () => {
  it('returns a non-empty string referencing the cleanup skill', () => {
    const result = renderCleanupWorkflowPrompt({
      store: {} as TaskStore,
      parsed: parsedWith('cleanup'),
      options: {},
    });
    expect(result).toContain('cleanup');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runNextCommand — unit tests
// ---------------------------------------------------------------------------

describe('runNextCommand', () => {
  it('returns empty output when no task is available (print mode)', async () => {
    await withStore(async (store) => {
      const result = await runNextCommand(store, parsedWith('next'), {});
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });
  });

  it('returns prompt seeded with task id and title in print mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'Build the thing' });

      const result = await runNextCommand(store, parsedWith('next'), {});
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Build the thing');
      expect(result.stdout).toContain('next');
      expect(result.stdout.endsWith('\n')).toBe(true);
    });
  });

  it('does not launch an agent in print mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'Some task' });
      let launched = false;
      const options: CliOptions = {
        which: () => '/bin/provider',
        runAgentInvocation: async () => {
          launched = true;
          return 0;
        },
      };

      await runNextCommand(store, parsedWith('next'), options);
      expect(launched).toBe(false);
    });
  });

  it('returns empty output in start mode when no task is available', async () => {
    await withStore(async (store) => {
      let launched = false;
      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => '/bin/provider',
        runner: taskStartRunner(),
        runAgentInvocation: async () => {
          launched = true;
          return 0;
        },
      };

      const result = await runNextCommand(store, parsedWith('next', { start: ['true'] }), options);
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(launched).toBe(false);
    });
  });

  it('claims the task and launches the agent in start mode', async () => {
    await withStore(async (store) => {
      const task = store.create({ title: 'Claimable task' });
      const invocations: AgentInvocation[] = [];

      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => '/bin/provider',
        runner: taskStartRunner(),
        stderr: () => {},
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation);
          return 5;
        },
      };

      const result = await runNextCommand(store, parsedWith('next', { start: ['true'] }), options);

      expect(result.exitCode).toBe(5);
      expect(result.stdout).toBe('');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command[0]).toBe('/bin/provider');

      // Task should be claimed (in-progress)
      const updated = store.getTask(task.id);
      expect(updated?.status).toBe('in-progress');
    });
  });

  it('uses tmp/worktrees/tasks/<task-id> as the worktree directory in start mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'Worktree task' });
      const invocations: AgentInvocation[] = [];

      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => '/bin/provider',
        runner: taskStartRunner(),
        stderr: () => {},
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation);
          return 0;
        },
      };

      await runNextCommand(store, parsedWith('next', { start: ['true'] }), options);

      // Worktree path is tmp/worktrees/tasks/<shortId>, where shortId is an 8-char hash.
      // Use a suffix match to tolerate macOS /var → /private/var symlink resolution.
      expect(invocations[0]?.cwd).toMatch(/tmp\/worktrees\/tasks\/[0-9a-f]{8}$/);
    });
  });

  it('resolves provider from --cli flag in start mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'A task' });
      const invocations: AgentInvocation[] = [];

      const options: CliOptions = {
        which: () => '/bin/provider',
        runner: taskStartRunner(),
        stderr: () => {},
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation);
          return 0;
        },
      };

      await runNextCommand(store, parsedWith('next', { start: ['true'], cli: ['codex'] }), options);

      // Codex invocations include --cd flag
      expect(invocations[0]?.command).toContain('--cd');
    });
  });

  it('throws provider_cli_not_found when the executable is missing in start mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'Task for missing provider test' });
      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => null,
        runner: taskStartRunner(),
        runAgentInvocation: async () => 0,
      };

      let caught: unknown;
      try {
        await runNextCommand(store, parsedWith('next', { start: ['true'] }), options);
      } catch (error) {
        caught = error;
      }

      expect((caught as { code?: string })?.code).toBe('provider_cli_not_found');
    });
  });
});

// ---------------------------------------------------------------------------
// CLI-level routing via runTasksCli
// ---------------------------------------------------------------------------

describe('tasks next (CLI routing)', () => {
  it('exits 0 with empty output when no task is available', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['next'], { cwd: root });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('exits 0 with prompt output when a task exists', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Alpha Task'], { cwd: root });

    const result = await runTasksCli(['next'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Alpha Task');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });
});

describe('tasks resolve (CLI routing)', () => {
  it('exits 0 and emits the resolve prompt in print mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['resolve'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('resolve');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('launches the agent in start mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    const result = await runTasksCli(['resolve', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 3;
      },
    });

    expect(result.exitCode).toBe(3);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command[0]).toBe('/bin/provider');
  });
});

describe('tasks sync (CLI routing)', () => {
  it('exits 0 and emits the sync prompt in print mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['sync'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('sync');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('launches the agent in start mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    await runTasksCli(['sync', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(invocations).toHaveLength(1);
  });
});

describe('tasks audit (CLI routing)', () => {
  it('exits 0 and emits the audit prompt in print mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['audit'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('audit');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('launches the agent in start mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    await runTasksCli(['audit', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(invocations).toHaveLength(1);
  });
});

describe('tasks merge (CLI routing)', () => {
  it('exits 0 and emits the merge prompt in print mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['merge'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('merge');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('launches the agent in start mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    await runTasksCli(['merge', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(invocations).toHaveLength(1);
  });
});

describe('tasks plan --start (CLI routing)', () => {
  it('emits the plan workflow prompt in print mode when --start is absent', async () => {
    // Regression: existing plan behavior must be unchanged when --start is absent.
    // The regular plan command returns the plan-prompt Markdown, not the workflow prompt.
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['plan'], { cwd: root });
    expect(result.exitCode).toBe(0);
    // Should contain the plan batch prompt (existing behavior), NOT the workflow prompt
    expect(result.stdout).toContain('# Task Plan Authoring');
  });

  it('launches the agent with the plan workflow prompt in start mode', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    const result = await runTasksCli(['plan', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(invocations).toHaveLength(1);
    // The prompt should reference the plan skill
    expect(invocations[0]?.command.join(' ')).toContain('plan');
  });
});

describe('tasks cleanup --worktrees (CLI routing)', () => {
  it('preserves existing cleanup behavior when --worktrees is absent', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    // Regular cleanup with no tasks just reports nothing deleted
    const result = await runTasksCli(['cleanup', '30'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aged cleanup:');
  });

  it('emits the cleanup workflow prompt in print mode with --worktrees', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['cleanup', '--worktrees'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cleanup');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('launches the agent in start mode with --worktrees --start', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    const result = await runTasksCli(['cleanup', '--worktrees', '--start'], {
      cwd: root,
      environment: { SCRUMLORD_CLI: 'claude' },
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(invocations).toHaveLength(1);
  });
});
