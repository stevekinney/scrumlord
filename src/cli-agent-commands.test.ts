import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentHookCommand } from './cli-agent-commands';
import { parseArguments } from './cli-arguments';
import { createTaskStore } from './database-open';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-agent-command-'));
  temporaryDirectories.push(directory);
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

describe('runAgentHookCommand', () => {
  it('returns UserPromptSubmit context on stdout', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);
    const store = await createTaskStore({ cwd: root });
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
      expect(result.stdout).toContain('plan: tmp/tasks/task-id/PLAN.md');
    } finally {
      store.close();
    }
  });
});
