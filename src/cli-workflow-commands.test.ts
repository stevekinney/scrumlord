import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentInvocation } from './agent-providers';
import type { ParsedArguments } from './cli-arguments';
import { runWorkflowCommand } from './cli-agent-commands';
import type { CliOptions } from './cli-types';
import { createTaskStore } from './database-open';
import type { TaskStore } from './types';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-workflow-command-'));
  temporaryDirectories.push(directory);
  return directory;
};

const initializeGit = async (directory: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'init'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

const parsedWith = (flags: Record<string, string[]>): ParsedArguments => ({
  command: 'plan',
  positionals: [],
  flags: new Map(Object.entries(flags)),
});

const withStore = async <T>(run: (store: TaskStore) => Promise<T>): Promise<T> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  const store = await createTaskStore({ cwd: root });
  try {
    return await run(store);
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

describe('runWorkflowCommand', () => {
  it('prints the rendered prompt and never launches an agent in print mode', async () => {
    await withStore(async (store) => {
      let launched = false;
      const options: CliOptions = {
        which: () => '/bin/provider',
        runAgentInvocation: async () => {
          launched = true;
          return 0;
        },
      };

      const result = await runWorkflowCommand(store, parsedWith({ print: ['true'] }), options, {
        skillName: 'plan',
        renderPrompt: () => 'PLAN PROMPT BODY',
      });

      expect(result).toEqual({ exitCode: 0, stdout: 'PLAN PROMPT BODY\n', stderr: '' });
      expect(launched).toBe(false);
    });
  });

  it('passes the resolved store, parsed args, and options to renderPrompt', async () => {
    await withStore(async (store) => {
      const parsed = parsedWith({ print: ['true'] });
      const options: CliOptions = {};
      let seen: { store: unknown; parsed: unknown; options: unknown } | undefined;

      await runWorkflowCommand(store, parsed, options, {
        skillName: 'plan',
        renderPrompt: (context) => {
          seen = context;
          return 'ignored';
        },
      });

      expect(seen?.store).toBe(store);
      expect(seen?.parsed).toBe(parsed);
      expect(seen?.options).toBe(options);
    });
  });

  it('launches the agent with the rendered prompt in launch mode', async () => {
    await withStore(async (store) => {
      const invocations: AgentInvocation[] = [];
      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => '/bin/provider',
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation);
          return 7;
        },
      };

      const result = await runWorkflowCommand(store, parsedWith({}), options, {
        skillName: 'plan',
        renderPrompt: () => 'PLAN PROMPT BODY',
      });

      expect(result).toEqual({ exitCode: 7, stdout: '', stderr: '' });
      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.command).toContain('PLAN PROMPT BODY');
      expect(invocations[0]?.command[0]).toBe('/bin/provider');
    });
  });

  it('resolves the provider from the --cli flag in launch mode', async () => {
    await withStore(async (store) => {
      const invocations: AgentInvocation[] = [];
      const options: CliOptions = {
        which: () => '/bin/provider',
        runAgentInvocation: async (invocation) => {
          invocations.push(invocation);
          return 0;
        },
      };

      await runWorkflowCommand(store, parsedWith({ cli: ['codex'] }), options, {
        skillName: 'plan',
        renderPrompt: () => 'BODY',
      });

      // Codex invocations carry --cd; that is how we know the codex adapter was selected.
      expect(invocations[0]?.command).toContain('--cd');
    });
  });

  it('throws provider_cli_not_found when the executable is missing in launch mode', async () => {
    await withStore(async (store) => {
      const options: CliOptions = {
        environment: { SCRUMLORD_CLI: 'claude' },
        which: () => null,
        runAgentInvocation: async () => 0,
      };

      let caught: unknown;
      try {
        await runWorkflowCommand(store, parsedWith({}), options, {
          skillName: 'plan',
          renderPrompt: () => 'BODY',
        });
      } catch (error) {
        caught = error;
      }

      expect((caught as { code?: string })?.code).toBe('provider_cli_not_found');
    });
  });
});
