import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from './command-runner';
import { setupGitHooks } from './git-hooks';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-hooks-'));
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

describe('setupGitHooks', () => {
  it('does nothing when no Lefthook configuration exists', async () => {
    const root = await temporaryDirectory();

    expect(await setupGitHooks(root, { install: false })).toEqual({
      configurationPath: null,
      changed: false,
      hooks: [],
      install: null,
    });
  });

  it('adds managed synchronization jobs to an existing Lefthook configuration', async () => {
    const root = await temporaryDirectory();
    const configurationPath = join(root, 'lefthook.yml');
    await Bun.write(
      configurationPath,
      [
        'pre-push:',
        '  jobs:',
        '    - name: validate',
        '      run: bun run validate',
        'post-commit:',
        '  commands:',
        '    existing:',
        '      run: echo existing',
        '',
      ].join('\n'),
    );
    const installCommands: string[] = [];
    const runner: CommandRunner = async (command, cwd) => {
      installCommands.push(`${cwd}:${command.join(' ')}`);
      return { exitCode: 0, stdout: 'installed', stderr: '' };
    };

    const result = await setupGitHooks(root, { runner });

    expect(result).toEqual({
      configurationPath,
      changed: true,
      hooks: ['post-checkout', 'post-commit', 'post-merge', 'pre-push'],
      install: { exitCode: 0, stdout: 'installed', stderr: '' },
    });
    expect(installCommands).toEqual([`${root}:bun run lefthook install`]);

    const configuration = await Bun.file(configurationPath).text();
    expect(configuration.match(/tasks-sync-git-status/g)?.length).toBe(4);
    expect(configuration).toContain('run: tasks sync-git-status --quiet');
    expect(configuration).toContain('post-commit:\n  jobs:\n    - name: tasks-sync-git-status');
    expect(configuration).toContain(
      'pre-push:\n  jobs:\n    - name: tasks-sync-git-status\n      run: tasks sync-git-status --quiet\n    - name: validate',
    );
  });

  it('does not duplicate managed jobs on later runs', async () => {
    const root = await temporaryDirectory();
    const configurationPath = join(root, 'lefthook.yml');
    await Bun.write(
      configurationPath,
      [
        'post-checkout:',
        '  jobs:',
        '    - name: tasks-sync-git-status',
        '      run: tasks sync-git-status --quiet',
        'post-commit:',
        '  jobs:',
        '    - name: tasks-sync-git-status',
        '      run: tasks sync-git-status --quiet',
        'post-merge:',
        '  jobs:',
        '    - name: tasks-sync-git-status',
        '      run: tasks sync-git-status --quiet',
        'pre-push:',
        '  jobs:',
        '    - name: tasks-sync-git-status',
        '      run: tasks sync-git-status --quiet',
        '',
      ].join('\n'),
    );

    const result = await setupGitHooks(root, { install: false });

    expect(result.changed).toBe(false);
    expect(result.install).toBeNull();
    const configuration = await Bun.file(configurationPath).text();
    expect(configuration.match(/tasks-sync-git-status/g)?.length).toBe(4);
  });
});
