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
      const result = await runNextCommand(store, parsedWith('next', { print: ['true'] }), {});
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    });
  });

  it('returns prompt seeded with task id and title in print mode', async () => {
    await withStore(async (store) => {
      store.create({ title: 'Build the thing' });

      const result = await runNextCommand(store, parsedWith('next', { print: ['true'] }), {});
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

      await runNextCommand(store, parsedWith('next', { print: ['true'] }), options);
      expect(launched).toBe(false);
    });
  });

  it('returns empty output in launch mode when no task is available', async () => {
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

      const result = await runNextCommand(store, parsedWith('next'), options);
      expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(launched).toBe(false);
    });
  });

  it('claims the task and launches the agent in launch mode', async () => {
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

      const result = await runNextCommand(store, parsedWith('next'), options);

      expect(result.exitCode).toBe(5);
      expect(result.stdout).toBe('');
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command[0]).toBe('/bin/provider');

      // Task should be claimed (in-progress)
      const updated = store.getTask(task.id);
      expect(updated?.status).toBe('in-progress');
    });
  });

  it('uses tmp/worktrees/tasks/<task-id> as the worktree directory in launch mode', async () => {
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

      await runNextCommand(store, parsedWith('next'), options);

      // Worktree path is tmp/worktrees/tasks/<shortId>, where shortId is an 8-char hash.
      // Use a suffix match to tolerate macOS /var → /private/var symlink resolution.
      expect(invocations[0]?.cwd).toMatch(/tmp\/worktrees\/tasks\/[0-9a-f]{8}$/);
    });
  });

  it('resolves provider from --cli flag in launch mode', async () => {
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

      await runNextCommand(store, parsedWith('next', { cli: ['codex'] }), options);

      // Codex invocations include --cd flag
      expect(invocations[0]?.command).toContain('--cd');
    });
  });

  it('throws provider_cli_not_found when the executable is missing in launch mode', async () => {
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
        await runNextCommand(store, parsedWith('next'), options);
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

describe('tasks prompt next (CLI routing)', () => {
  it('exits 0 with empty output when no task is available (print mode)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['prompt', 'next', '--print'], { cwd: root });
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('exits 0 with prompt output when a task exists (print mode)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Alpha Task'], { cwd: root });

    const result = await runTasksCli(['prompt', 'next', '--print'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Alpha Task');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });
});

/** Drives a pure-skill launch and returns the captured invocations. */
const launchPureSkill = async (
  skill: string,
  extraArgs: string[] = [],
): Promise<AgentInvocation[]> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  await writeGitignore(root);
  const invocations: AgentInvocation[] = [];
  await runTasksCli(['prompt', skill, '--cli', 'claude', ...extraArgs], {
    cwd: root,
    which: () => '/bin/provider',
    runAgentInvocation: async (invocation) => {
      invocations.push(invocation);
      return 0;
    },
  });
  return invocations;
};

for (const skill of ['resolve', 'sync', 'audit', 'merge'] as const) {
  describe('tasks prompt ' + skill + ' (CLI routing)', () => {
    it('exits 0 and emits the prompt in print mode', async () => {
      const root = await temporaryDirectory();
      await initializeGit(root);

      const result = await runTasksCli(['prompt', skill, '--print'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(skill);
      expect(result.stdout.endsWith('\n')).toBe(true);
    });

    it('launches the agent with --cli', async () => {
      const invocations = await launchPureSkill(skill);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command[0]).toBe('/bin/provider');
    });

    it('rejects --print combined with --cli (conflicting_mode)', async () => {
      const root = await temporaryDirectory();
      await initializeGit(root);
      const result = await runTasksCli(['prompt', skill, '--print', '--cli', 'claude'], {
        cwd: root,
        which: () => '/bin/provider',
        runAgentInvocation: async () => 0,
      });
      expect(JSON.parse(result.stderr).error.code).toBe('conflicting_mode');
    });
  });
}

describe('tasks prompt resolve --all (scope flag)', () => {
  it('launches scoped to all without conflicting with --cli', async () => {
    const invocations = await launchPureSkill('resolve', ['--all']);
    expect(invocations).toHaveLength(1);
  });
});

describe('tasks prompt plan (CLI routing)', () => {
  it('emits the plan batch prompt in store mode (no --cli)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
    expect(result.exitCode).toBe(0);
    // Store mode returns the plan-prompt Markdown, not the workflow prompt.
    expect(result.stdout).toContain('# Task Plan Authoring');
  });

  it('--print is byte-identical to the bare store form', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await runTasksCli(['create', '--title', 'Plannable'], { cwd: root });

    const bare = await runTasksCli(['prompt', 'plan'], { cwd: root });
    const printed = await runTasksCli(['prompt', 'plan', '--print'], { cwd: root });
    expect(printed.stdout).toBe(bare.stdout);
  });

  it('launches the plan workflow prompt with --cli', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    const result = await runTasksCli(['prompt', 'plan', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.command.join(' ')).toContain('plan');
  });

  it('rejects --print combined with --cli (conflicting_mode)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const result = await runTasksCli(['prompt', 'plan', '--print', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runAgentInvocation: async () => 0,
    });
    expect(JSON.parse(result.stderr).error.code).toBe('conflicting_mode');
  });

  it('rejects --json (plan has no JSON form)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const result = await runTasksCli(['prompt', 'plan', '--json'], { cwd: root });
    expect(JSON.parse(result.stderr).error.code).toBe('json_not_supported');
  });
});

describe('tasks prompt cleanup (CLI routing)', () => {
  it('runs aged graph cleanup with a <days> selector', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['prompt', 'cleanup', '30'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Aged cleanup:');
  });

  it('emits the cleanup skill prompt with --print and no selector', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['prompt', 'cleanup', '--print'], { cwd: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('cleanup');
    expect(result.stdout.endsWith('\n')).toBe(true);
  });

  it('errors missing_mode with no selector, --print, or --cli', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['prompt', 'cleanup'], { cwd: root });
    expect(JSON.parse(result.stderr).error.code).toBe('missing_mode');
  });

  it('launches the cleanup skill with --cli', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    await writeGitignore(root);
    const invocations: AgentInvocation[] = [];

    const result = await runTasksCli(['prompt', 'cleanup', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runAgentInvocation: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(invocations).toHaveLength(1);
  });

  it('rejects a selector combined with --cli (conflicting_mode)', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const result = await runTasksCli(['prompt', 'cleanup', '30', '--cli', 'claude'], {
      cwd: root,
      which: () => '/bin/provider',
      runAgentInvocation: async () => 0,
    });
    expect(JSON.parse(result.stderr).error.code).toBe('conflicting_mode');
  });
});
