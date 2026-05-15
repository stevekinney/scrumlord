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

const expectRejectionMessage = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  try {
    await promise;
    throw new Error('Expected promise to reject.');
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', message);
  }
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
    expect(configuration.match(/tasks-pr-sync/g)?.length).toBe(4);
    expect(configuration.match(/scrumlord:begin/g)?.length).toBe(4);
    expect(configuration.match(/scrumlord:end/g)?.length).toBe(4);
    expect(configuration).toContain('run: tasks pr --sync --quiet');
    expect(configuration).not.toContain('tasks sync-git-status');
    expect(configuration).not.toContain('tasks-sync-git-status');
    expect(configuration).toContain('post-commit:\n  jobs:\n    # scrumlord:begin');
    expect(configuration).toContain(
      'pre-push:\n  jobs:\n    # scrumlord:begin\n    - name: tasks-pr-sync\n      run: tasks pr --sync --quiet\n    # scrumlord:end\n    - name: validate',
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
        '    # scrumlord:begin',
        '    - name: tasks-pr-sync',
        '      run: tasks pr --sync --quiet',
        '    # scrumlord:end',
        'post-commit:',
        '  jobs:',
        '    # scrumlord:begin',
        '    - name: tasks-pr-sync',
        '      run: tasks pr --sync --quiet',
        '    # scrumlord:end',
        'post-merge:',
        '  jobs:',
        '    # scrumlord:begin',
        '    - name: tasks-pr-sync',
        '      run: tasks pr --sync --quiet',
        '    # scrumlord:end',
        'pre-push:',
        '  jobs:',
        '    # scrumlord:begin',
        '    - name: tasks-pr-sync',
        '      run: tasks pr --sync --quiet',
        '    # scrumlord:end',
        '',
      ].join('\n'),
    );

    const result = await setupGitHooks(root, { install: false });

    expect(result.changed).toBe(false);
    expect(result.install).toBeNull();
    const configuration = await Bun.file(configurationPath).text();
    expect(configuration.match(/tasks-pr-sync/g)?.length).toBe(4);
    expect(configuration).not.toContain('tasks sync-git-status');
  });

  it('migrates old sync-git-status blocks to tasks pr --sync', async () => {
    const root = await temporaryDirectory();
    const configurationPath = join(root, 'lefthook.yml');
    await Bun.write(
      configurationPath,
      [
        'pre-push:',
        '  jobs:',
        '    # scrumlord:begin',
        '    - name: tasks-sync-git-status',
        '      run: tasks sync-git-status --quiet',
        '    # scrumlord:end',
        '',
      ].join('\n'),
    );

    const result = await setupGitHooks(root, { install: false });

    expect(result.changed).toBe(true);
    const configuration = await Bun.file(configurationPath).text();
    expect(configuration).toContain('    - name: tasks-pr-sync');
    expect(configuration).toContain('      run: tasks pr --sync --quiet');
    expect(configuration).not.toContain('tasks sync-git-status');
    expect(configuration).not.toContain('tasks-sync-git-status');
  });

  it('replaces stale managed hook blocks', async () => {
    const root = await temporaryDirectory();
    const configurationPath = join(root, 'lefthook.yml');
    await Bun.write(
      configurationPath,
      [
        'pre-push:',
        '  jobs:',
        '    # scrumlord:begin',
        '    - name: old-tasks-sync',
        '      run: tasks available',
        '    # scrumlord:end',
        '',
      ].join('\n'),
    );

    const result = await setupGitHooks(root, { install: false });

    expect(result.changed).toBe(true);
    const configuration = await Bun.file(configurationPath).text();
    expect(configuration).toContain('    - name: tasks-pr-sync');
    expect(configuration).toContain('      run: tasks pr --sync --quiet');
    expect(configuration).not.toContain('old-tasks-sync');
  });

  it('fails clearly when the managed Lefthook block is malformed', async () => {
    const root = await temporaryDirectory();
    await Bun.write(
      join(root, 'lefthook.yml'),
      ['pre-push:', '  jobs:', '    # scrumlord:begin', '    - name: tasks-pr-sync'].join('\n'),
    );

    await expectRejectionMessage(
      setupGitHooks(root, { install: false }),
      'Managed Scrumlord hook block is missing an end marker.',
    );
  });

  it('fails clearly when Lefthook installation fails', async () => {
    const root = await temporaryDirectory();
    await Bun.write(join(root, 'lefthook.yml'), 'pre-push:\n');

    await expectRejectionMessage(
      setupGitHooks(root, {
        runner: async () => ({ exitCode: 1, stdout: '', stderr: 'lefthook failed' }),
      }),
      'Could not install Lefthook hooks: lefthook failed',
    );
  });
});
