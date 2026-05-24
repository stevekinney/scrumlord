import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-next-'));
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

describe('tasks next and remaining', () => {
  it('returns empty output when no task is available', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const result = await runTasksCli(['peek'], { cwd: root });

    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('returns a planned task before an unplanned task', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Unplanned high priority task', '--priority', '3'], {
      cwd: root,
    });
    await mkdir(join(root, 'tmp', 'tasks', 'planned'), { recursive: true });
    const planPath = join(root, 'tmp', 'tasks', 'planned', 'PLAN.md');
    await writeFile(planPath, '# Plan\n');
    const planned = await runTasksCli(
      [
        'create',
        '--title',
        'Planned low priority task',
        '--priority',
        '1',
        '--plan',
        'tmp/tasks/planned/PLAN.md',
      ],
      { cwd: root },
    );

    const result = await runTasksCli(['peek'], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const nextTask = JSON.parse(result.stdout);
    expect(nextTask.id).toBe(JSON.parse(planned.stdout).id);
    expect(nextTask.title).toBe('Planned low priority task');
    expect(nextTask.plan).toContain('tmp/tasks/planned/PLAN.md');
  });

  it('creates ready tasks with dependency language and enforces the edge on transition', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    const description = 'Add /.well-known/mcp.json route once live MCP server exists.';

    // Creating a default-status (`ready`) task with dependency prose succeeds:
    // the dependency-edge rule is enforced on the transition into `ready`, not
    // at create time (stable blocker IDs don't exist yet).
    const created = await runTasksCli(
      [
        'create',
        '--draft',
        '--title',
        'Add MCP catalog discovery metadata',
        '--description',
        description,
      ],
      { cwd: root },
    );
    expect(created.exitCode).toBe(0);
    expect(created.stderr).toBe('');
    const createdId = JSON.parse(created.stdout).id;

    // Transitioning that task to `ready` without a blocker edge is rejected.
    const transition = await runTasksCli(['update', createdId, '--status', 'ready'], { cwd: root });
    expect(transition.exitCode).toBe(1);
    expect(transition.stdout).toBe('');
    expect(JSON.parse(transition.stderr).error.code).toBe('dependency_edge_required');
  });

  it('returns the remaining task count as a JSON integer', async () => {
    const root = await temporaryDirectory();
    await initializeGit(root);

    await runTasksCli(['create', '--title', 'Future task', '--start-date', '2026-05-12'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Active task', '--status', 'in-progress'], {
      cwd: root,
    });
    await runTasksCli(['create', '--title', 'Done task', '--status', 'completed'], { cwd: root });

    const result = await runTasksCli(['remaining'], { cwd: root });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toBe(1);
  });
});
