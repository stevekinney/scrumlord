import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-plan-'));
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

const checkoutBranch = async (directory: string, branch: string): Promise<void> => {
  const subprocess = Bun.spawn(['git', 'checkout', '-b', branch], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await subprocess.exited;
  if (exitCode !== 0) throw new Error(await new Response(subprocess.stderr).text());
};

const projectRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await initializeGit(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('tasks plan', () => {
  describe('no-argument form (batch)', () => {
    it('exits 0 with empty-batch message when no available unplanned tasks exist', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('There are no available, unplanned tasks.');
    });

    it('exits 0 and contains both task ids and titles in a Markdown table', async () => {
      const root = await projectRoot();
      const a = await runTasksCli(['create', '--title', 'Task Alpha'], { cwd: root });
      const b = await runTasksCli(['create', '--title', 'Task Beta'], { cwd: root });
      const idA = JSON.parse(a.stdout).id as string;
      const idB = JSON.parse(b.stdout).id as string;

      const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(idA);
      expect(result.stdout).toContain(idB);
      expect(result.stdout).toContain('Task Alpha');
      expect(result.stdout).toContain('Task Beta');
      expect(result.stdout).toContain('| ID |');
    });

    it('ignores tasks that already have a plan path', async () => {
      const root = await projectRoot();
      await runTasksCli(['create', '--title', 'Planned Task', '--plan', '/some/plan.md'], {
        cwd: root,
      });
      const unplanned = await runTasksCli(['create', '--title', 'Unplanned Task'], { cwd: root });
      const unplannedId = JSON.parse(unplanned.stdout).id as string;

      const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(unplannedId);
      expect(result.stdout).not.toContain('Planned Task');
    });

    it('output ends with exactly one trailing newline', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
      expect(result.stdout.endsWith('\n')).toBe(true);
      expect(result.stdout.endsWith('\n\n')).toBe(false);
    });

    it('routes correctly so the empty-batch prompt is returned rather than unknown_command', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('# Task Plan Authoring — Batch');
    });
  });

  describe('single-task form', () => {
    it('exits 0 and stdout contains the task id in the H1 and the title in the body', async () => {
      const root = await projectRoot();
      const created = await runTasksCli(['create', '--title', 'My Feature'], { cwd: root });
      const id = JSON.parse(created.stdout).id as string;

      const result = await runTasksCli(['prompt', 'plan', id], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`# Task Plan Authoring — \`${id}\``);
      expect(result.stdout).toContain('My Feature');
    });

    it('exits 1 with task_not_found for a non-existent UUID', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', '00000000-0000-0000-0000-000000000000'], {
        cwd: root,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).error.code).toBe('task_not_found');
    });

    it('exits 0 for "current" when there is an active task on the current branch', async () => {
      const root = await projectRoot();
      await checkoutBranch(root, 'feature/my-work');
      const created = await runTasksCli(
        ['create', '--title', 'Branch Task', '--branch', 'feature/my-work'],
        { cwd: root },
      );
      const id = JSON.parse(created.stdout).id as string;

      const result = await runTasksCli(['prompt', 'plan', 'current'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(id);
    });

    it('exits 1 with current_task_not_found for "current" when no task is on the branch', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', 'current'], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).error.code).toBe('current_task_not_found');
    });

    it('exits 0 for "next" when an available task exists', async () => {
      const root = await projectRoot();
      const created = await runTasksCli(['create', '--title', 'Next Task'], { cwd: root });
      const id = JSON.parse(created.stdout).id as string;

      const result = await runTasksCli(['prompt', 'plan', 'next'], { cwd: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(id);
    });

    it('exits 1 with next_task_not_found for "next" when no tasks are available', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', 'next'], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).error.code).toBe('next_task_not_found');
    });

    it('exits 1 with unexpected_argument when two positionals are given', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', 'a', 'b'], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('unexpected_argument');
    });

    it('exits 1 with task_not_found for "Current" (capitalized, not a token)', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', 'Current'], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr).error.code).toBe('task_not_found');
    });

    it('output ends with exactly one trailing newline', async () => {
      const root = await projectRoot();
      const created = await runTasksCli(['create', '--title', 'Output Test'], { cwd: root });
      const id = JSON.parse(created.stdout).id as string;
      const result = await runTasksCli(['prompt', 'plan', id], { cwd: root });
      expect(result.stdout.endsWith('\n')).toBe(true);
      expect(result.stdout.endsWith('\n\n')).toBe(false);
    });
  });

  describe('help', () => {
    it('tasks help prompt plan returns a non-null string', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['help', 'prompt', 'plan'], {
        cwd: root,
        colorMode: 'never',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toBe('');
    });

    it('tasks prompt plan --help returns the plan help topic', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['prompt', 'plan', '--help'], {
        cwd: root,
        colorMode: 'never',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('tasks prompt plan [task-id]');
    });

    it('plan help includes the example lines', async () => {
      const root = await projectRoot();
      const result = await runTasksCli(['help', 'prompt', 'plan'], {
        cwd: root,
        colorMode: 'never',
      });
      expect(result.stdout).toContain('tasks prompt plan');
      expect(result.stdout).toContain('tasks prompt plan current');
      expect(result.stdout).toContain('tasks prompt plan next');
      expect(result.stdout).toContain('tasks prompt plan 8f7d6a');
    });
  });
});
