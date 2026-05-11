import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-gh-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('GitHub CLI commands', () => {
  it('returns a JSON error when gh is not installed', async () => {
    const root = await temporaryDirectory();
    const emptyPath = await temporaryDirectory();
    await mkdir(join(root, 'packages', 'example'), { recursive: true });
    await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

    const subprocess = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), 'pr'], {
      cwd: join(root, 'packages', 'example'),
      env: { ...Bun.env, PATH: emptyPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await subprocess.exited).toBe(1);
    expect(await new Response(subprocess.stdout).text()).toBe('');
    expect(JSON.parse(await new Response(subprocess.stderr).text())).toEqual({
      error: {
        code: 'gh_not_found',
        message: 'The GitHub CLI (`gh`) is required for this command.',
      },
    });
  });
});
