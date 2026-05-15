import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { ScrumlordError } from './errors';
import {
  launchProviderInvocation,
  readTerminalSetupInput,
  selectedInstalledProviders,
  setupProject,
  setupSelectionFromFlags,
  setupSelectionFromInput,
  setupStatus,
} from './setup';

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-setup-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

const which =
  (installed: string[]) =>
  (executable: string): string | null =>
    installed.includes(executable) ? `/bin/${executable}` : null;

const expectRejectsWithScrumlordError = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
    throw new Error('Expected promise to reject.');
  } catch (error) {
    expect(error).toBeInstanceOf(ScrumlordError);
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('setup status and selection', () => {
  it('reports setup state without creating a database', async () => {
    const root = await workspaceRoot();
    const home = await temporaryDirectory();
    await mkdir(join(home, '.codex'), { recursive: true });
    await Bun.write(join(home, '.codex/config.toml'), '[features]\n');
    await Bun.write(join(root, 'lefthook.yml'), 'pre-commit:\n');

    const status = await setupStatus({
      cwd: join(root, 'packages/example'),
      homeDirectory: home,
      which: which(['tasks', 'codex']),
    });

    expect(status.projectRoot).toBe(root);
    expect(status.tasksExecutable).toBe('/bin/tasks');
    expect(status.databaseExists).toBe(false);
    expect(status.providers.codex.executable).toBe('/bin/codex');
    expect(status.providers.claude.executable).toBeNull();
    expect(status.providers.codex.localSubagentPath).toBe(
      join(root, '.codex/agents/scrumlord-task-manager.toml'),
    );
    expect(status.skillPaths.codex.localPath).toBe(join(root, '.agents/skills/tasks/SKILL.md'));
    expect(status.skillPaths.claude.localPath).toBe(join(root, '.claude/skills/tasks/SKILL.md'));
    expect(status.hooks.lefthookConfigurationExists).toBe(true);
    expect(status.hooks.codexConfigurationExists).toBe(true);
    expect(status.hooks.agentHookWrapperExists).toBe(false);
    expect(existsSync(join(root, 'tmp/tasks.db'))).toBe(false);
    expect(status.warnings).toEqual([]);
  });

  it('reports missing root and missing tasks executable as warnings', async () => {
    const root = await temporaryDirectory();

    const status = await setupStatus({ cwd: root, which: which([]) });

    expect(status.projectRoot).toBeNull();
    expect(status.databaseExists).toBe(false);
    expect(status.warnings).toEqual(['project_root_not_found', 'tasks_executable_not_found']);
  });

  it('selects installed providers and validates setup flag conflicts', async () => {
    expect(selectedInstalledProviders(which(['codex']))).toEqual(['codex']);
    expect(setupSelectionFromFlags({ yes: true }, which(['codex', 'claude']))).toEqual({
      providers: ['codex', 'claude'],
      scope: 'local',
      launchProvider: null,
    });
    expect(setupSelectionFromFlags({ codex: true, global: true }, which(['codex']))).toEqual({
      providers: ['codex'],
      scope: 'global',
      launchProvider: 'codex',
    });
    expect(() =>
      setupSelectionFromFlags({ codex: true, claude: true }, which(['codex', 'claude'])),
    ).toThrow(ScrumlordError);
    expect(() => setupSelectionFromFlags({ local: true, global: true })).toThrow(ScrumlordError);
    expect(() => setupSelectionFromFlags({ claude: true }, which([]))).toThrow(ScrumlordError);
  });

  it('parses colorized interactive setup answers and validates bad answers', async () => {
    const selection = await setupSelectionFromInput({
      colorMode: 'always',
      readStdin: async () => 'codex\nglobal\ncodex\n',
      which: which(['codex']),
    });

    expect(selection.providers).toEqual(['codex']);
    expect(selection.scope).toBe('global');
    expect(selection.launchProvider).toBe('codex');
    expect(selection.prompt).toContain('\u001b[');

    const numericSelection = await setupSelectionFromInput({
      readStdin: async () => '2\n1\n3\n',
      which: which(['codex', 'claude']),
    });
    expect(numericSelection.providers).toEqual(['codex', 'claude']);
    expect(numericSelection.scope).toBe('local');
    expect(numericSelection.launchProvider).toBe('claude');

    const defaultProviderSelection = await setupSelectionFromInput({
      readStdin: async () => '\nlocal\nnone\n',
      which: which(['codex']),
    });
    expect(defaultProviderSelection.providers).toEqual(['codex']);

    await expectRejectsWithScrumlordError(
      setupSelectionFromInput({ readStdin: async () => 'vim\nlocal\nnone\n' }),
    );
    await expectRejectsWithScrumlordError(
      setupSelectionFromInput({
        readStdin: async () => 'codex\nremote\nnone\n',
        which: which(['codex']),
      }),
    );
    await expectRejectsWithScrumlordError(
      setupSelectionFromInput({
        readStdin: async () => 'codex\nlocal\nvim\n',
        which: which(['codex']),
      }),
    );
    await expectRejectsWithScrumlordError(setupSelectionFromInput({ isTTY: false }));
  });

  it('can collect setup answers from terminal streams', async () => {
    const input = new PassThrough();
    let outputText = '';
    const output = new Writable({
      write(chunk, _encoding, callback) {
        outputText += chunk.toString();
        callback();
      },
    });
    input.end('claude\nlocal\nnone\n');

    expect(await readTerminalSetupInput(input, output)).toBe('claude\nlocal\nnone');
    expect(outputText).toContain('Which agents should Scrumlord configure?');

    const selection = await setupSelectionFromInput({
      isTTY: true,
      terminalInput: Readable.from(['codex\nlocal\nnone\n']),
      terminalOutput: output,
      which: which(['codex']),
    });
    expect(selection.providers).toEqual(['codex']);
    expect(selection.prompt).toBe('');
  });
});

describe('setupProject', () => {
  it('initializes the database and selected setup surfaces', async () => {
    const root = await workspaceRoot();
    const home = await temporaryDirectory();

    const result = await setupProject({
      cwd: root,
      providers: ['codex'],
      homeDirectory: home,
      which: which(['codex']),
      setupGitHooks: async (projectRoot) => ({
        configurationPath: join(projectRoot, 'lefthook.yml'),
        changed: false,
        hooks: [],
        install: null,
      }),
    });

    expect(result.projectRoot).toBe(root);
    expect(existsSync(result.databasePath)).toBe(true);
    expect(result.skills.map((skill) => skill.target)).toEqual(['codex']);
    expect(result.subagents?.providers.map((provider) => provider.provider)).toEqual(['codex']);
    expect(result.agentHooks?.codex.skipped).toBe(false);
    expect(result.agentHooks?.claude.skipped).toBe(true);
    expect(result.gitHooks.configurationPath).toBe(join(root, 'lefthook.yml'));
    expect(result.warnings).toEqual([]);
  });

  it('supports no installed provider defaults and mocked setup boundaries', async () => {
    const root = await workspaceRoot();
    const calls: string[] = [];

    const result = await setupProject({
      cwd: root,
      which: which([]),
      setupSubagents: async () => {
        throw new Error('Unexpected subagent setup.');
      },
      setupAgentHooks: async () => {
        throw new Error('Unexpected agent hook setup.');
      },
      setupGitHooks: async (projectRoot) => {
        calls.push(`git-hooks:${projectRoot}`);
        return { configurationPath: null, changed: false, hooks: [], install: null };
      },
    });

    expect(result.skills).toEqual([]);
    expect(result.subagents).toBeNull();
    expect(result.agentHooks).toBeNull();
    expect(result.warnings).toEqual(['no_agent_provider_cli_found']);
    expect(calls).toEqual([`git-hooks:${root}`]);
  });

  it('builds provider launch invocations', async () => {
    expect(launchProviderInvocation('codex', '/project', which(['codex']), { ok: true })).toEqual({
      command: [
        '/bin/codex',
        '--cd',
        '/project',
        expect.stringContaining('Scrumlord setup has just completed'),
      ],
      cwd: '/project',
      environment: {},
    });
    expect(launchProviderInvocation('claude', '/project', which(['claude']), { ok: true })).toEqual(
      {
        command: ['/bin/claude', expect.stringContaining('tasks setup status')],
        cwd: '/project',
        environment: {},
      },
    );
    expect(() => launchProviderInvocation('claude', '/project', which([]))).toThrow(ScrumlordError);
  });

  it('requires provider executables before building launch invocations', async () => {
    expect(() => launchProviderInvocation('claude', '/project', which([]))).toThrow(ScrumlordError);
    expect(launchProviderInvocation('codex', '/project', which(['codex']))).toEqual({
      command: [
        '/bin/codex',
        '--cd',
        '/project',
        expect.stringContaining('"projectRoot": "/project"'),
      ],
      cwd: '/project',
      environment: {},
    });
  });
});
