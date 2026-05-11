import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectRoot } from './root-resolution';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-root-'));
  temporaryDirectories.push(directory);
  return directory;
};

const run = async (command: string[], cwd: string): Promise<void> => {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('resolveProjectRoot', () => {
  it('prefers the Git repository root', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'example');
    await mkdir(nested, { recursive: true });
    await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await run(['git', 'init'], root);

    const resolvedRoot = await resolveProjectRoot(nested);
    expect(resolvedRoot).toBe(await realpath(root));
  });

  it('falls back to the npm workspace root', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'example', 'src');
    await mkdir(nested, { recursive: true });
    await Bun.write(
      join(root, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
    );

    const resolvedRoot = await resolveProjectRoot(nested);
    expect(resolvedRoot).toBe(root);
  });

  it('falls back to the npm workspace root when Git cannot be executed', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'example', 'src');
    await mkdir(nested, { recursive: true });
    await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    const originalPath = Bun.env.PATH;
    Bun.env.PATH = '';

    try {
      expect(await resolveProjectRoot(nested)).toBe(root);
    } finally {
      Bun.env.PATH = originalPath;
    }
  });

  it('fails without creating a database when no project root exists', async () => {
    const root = await temporaryDirectory();
    const result = await runTasksCli(['available'], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'project_root_not_found',
        message:
          'Could not find a Git repository root or npm workspace root from the current directory.',
      },
    });
    expect(existsSync(join(root, 'tmp', 'tasks.db'))).toBe(false);
  });

  it('fails without creating a database when a workspace package manifest is invalid', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'packages', 'example');
    await mkdir(nested, { recursive: true });
    await Bun.write(join(root, 'package.json'), '{ "workspaces": [');

    const result = await runTasksCli(['available'], { cwd: nested });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'invalid_workspace_package_json',
      message: `Could not parse workspace package.json: ${join(root, 'package.json')}`,
    });
    expect(existsSync(join(root, 'tmp', 'tasks.db'))).toBe(false);
  });
});
