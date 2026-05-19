import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';

const stripAnsi = (value: string): string => {
  const escape = String.fromCharCode(27);
  return value.replaceAll(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '');
};

describe('runTasksCli help output', () => {
  it('renders help for the main CLI and subcommands', async () => {
    const mainHelp = await runTasksCli(['--help'], { colorMode: 'always' });
    const emptyHelp = await runTasksCli([], { colorMode: 'always' });
    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stderr).toBe('');
    expect(emptyHelp).toEqual(mainHelp);
    expect(mainHelp.stdout).toContain('\u001b[');
    expect(stripAnsi(mainHelp.stdout)).toContain('tasks <command> [options]');
    expect(mainHelp.stdout).toContain('setup');

    const createHelp = await runTasksCli(['create', '--help'], { colorMode: 'never' });
    expect(createHelp.stdout).toContain('tasks create --title <title> [options]');
    expect(createHelp.stdout).toContain('--title');
    expect(createHelp.stdout).not.toContain('\u001b[');

    const availableHelp = await runTasksCli(['help', 'available'], { colorMode: 'never' });
    expect(availableHelp.stdout).toContain('tasks available');
    expect(availableHelp.stdout).toContain('--planned');
    expect(availableHelp.stdout).toContain('--count');

    const listHelp = await runTasksCli(['list', '--help'], { colorMode: 'never' });
    expect(listHelp.stdout).toContain('tasks list [--all]');
    expect(listHelp.stdout).toContain('--unplanned');

    const repositoryHelp = await runTasksCli(['repository', '--help'], { colorMode: 'never' });
    expect(repositoryHelp.stdout).toContain('tasks repository [--url] [--json]');
    expect(repositoryHelp.stdout).toContain('full GitHub repository URL');

    const overviewHelp = await runTasksCli(['overview', '--help'], { colorMode: 'never' });
    expect(overviewHelp.stdout).toContain('tasks overview');
    expect(overviewHelp.stdout).toContain('unresolved review comment counts');

    const progressHelp = await runTasksCli(['progress', '--help'], { colorMode: 'never' });
    expect(progressHelp.stdout).toContain('tasks progress');
    expect(progressHelp.stdout).toContain('list');

    const clearHelp = await runTasksCli(['clear', '--help'], { colorMode: 'never' });
    expect(clearHelp.stdout).toContain('tasks clear');

    const pullRequestHelp = await runTasksCli(['pr', '--help'], { colorMode: 'never' });
    expect(pullRequestHelp.stdout).toContain('tasks pr');
    expect(pullRequestHelp.stdout).toContain('--watch');
    expect(pullRequestHelp.stdout).toContain('readyToMerge');

    const setupStatusHelp = await runTasksCli(['setup', 'status', '--help'], {
      colorMode: 'never',
    });
    expect(setupStatusHelp.stdout).toContain('tasks setup status');
    expect(setupStatusHelp.stdout).toContain('tasksExecutable');

    const setupHelp = await runTasksCli(['setup', '--help'], { colorMode: 'never' });
    expect(setupHelp.stdout).toContain('tasks setup');
    expect(setupHelp.stdout).toContain('--subagents');
    expect(setupHelp.stdout).toContain('--prompt');
  });
});
