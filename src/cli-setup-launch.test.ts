import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTasksCli } from './cli-runner';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-setup-launch-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('setup provider launch commands', () => {
  it('passes setup context to Codex when launching after setup', async () => {
    const root = await workspaceRoot();
    const launched: string[][] = [];

    const result = await runTasksCli(['setup', '--codex'], {
      cwd: root,
      setupProject: async (setupOptions) => ({
        projectRoot: setupOptions.cwd ?? root,
        databasePath: join(setupOptions.cwd ?? root, 'tmp/tasks.db'),
        skills: [],
        subagents: null,
        agentHooks: null,
        gitHooks: { configurationPath: null, changed: false, hooks: [], install: null },
        warnings: [],
      }),
      which: (executable) => (executable === 'codex' ? '/bin/codex' : null),
      runAgentInvocation: async (invocation) => {
        launched.push(invocation.command);
        return 9;
      },
    });

    expect(result).toEqual({ exitCode: 9, stdout: '', stderr: '' });
    expect(launched[0]?.[0]).toBe('/bin/codex');
    expect(launched[0]).toContain('--cd');
    expect(launched[0]?.at(-1)).toContain('Scrumlord setup has just completed');
    expect(launched[0]?.at(-1)).toContain('databasePath');
  });

  it('passes setup context to Claude when launching after setup', async () => {
    const root = await workspaceRoot();
    const launched: string[][] = [];

    const result = await runTasksCli(['setup', '--claude'], {
      cwd: root,
      setupProject: async (setupOptions) => ({
        projectRoot: setupOptions.cwd ?? root,
        databasePath: join(setupOptions.cwd ?? root, 'tmp/tasks.db'),
        skills: [],
        subagents: null,
        agentHooks: null,
        gitHooks: { configurationPath: null, changed: false, hooks: [], install: null },
        warnings: [],
      }),
      which: (executable) => (executable === 'claude' ? '/bin/claude' : null),
      runAgentInvocation: async (invocation) => {
        launched.push(invocation.command);
        return 8;
      },
    });

    expect(result).toEqual({ exitCode: 8, stdout: '', stderr: '' });
    expect(launched[0]?.[0]).toBe('/bin/claude');
    expect(launched[0]?.at(-1)).toContain('Scrumlord setup has just completed');
    expect(launched[0]?.at(-1)).toContain('tasks setup status');
    expect(launched[0]?.at(-1)).toContain('databasePath');
  });
});
