import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { progressInputFromContext } from './cli-progress';
import { runTasksCli } from './cli-runner';

const flags = (entries: Record<string, string>): Map<string, string[]> => {
  return new Map(Object.entries(entries).map(([k, v]) => [k, [v]]));
};

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'scrumlord-cli-progress-'));
  temporaryDirectories.push(directory);
  return directory;
};

const workspaceRoot = async (): Promise<string> => {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await Bun.write(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
  return root;
};

const taskIdFromOutput = (output: string): string => {
  const parsed: unknown = JSON.parse(output);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'id' in parsed &&
    typeof parsed.id === 'string'
  ) {
    return parsed.id;
  }
  throw new Error('Expected task JSON with a string id.');
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('progressInputFromContext', () => {
  it('infers provider=codex and session from CODEX_SESSION_ID', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { CODEX_SESSION_ID: 'session-abc' },
    });
    expect(input).toMatchObject({ provider: 'codex', session: 'session-abc' });
  });

  it('infers provider=claude from CLAUDECODE=1', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { CLAUDECODE: '1' },
    });
    expect(input).toMatchObject({ provider: 'claude' });
    expect(input.session).toBeUndefined();
  });

  it('infers provider=claude from CLAUDE_SESSION_ID', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { CLAUDE_SESSION_ID: 'claude-abc' },
    });
    expect(input).toMatchObject({ provider: 'claude', session: 'claude-abc' });
  });

  it('prefers SCRUMLORD_CLI over other env vars for provider', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { SCRUMLORD_CLI: 'claude', CODEX_SESSION_ID: 'codex-id' },
    });
    expect(input).toMatchObject({ provider: 'claude' });
  });

  it('prefers CLAUDECODE=1 over CODEX_SESSION_ID (CLAUDECODE fires first in inference order)', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { CLAUDECODE: '1', CODEX_SESSION_ID: 'codex-id' },
    });
    expect(input).toMatchObject({ provider: 'claude' });
  });

  it('explicit --provider and --session both used verbatim', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello', provider: 'claude', session: 'my-session' }),
      environment: { CODEX_SESSION_ID: 'codex-id' },
    });
    expect(input).toMatchObject({ provider: 'claude', session: 'my-session' });
  });

  it('explicit --provider overrides env; session inferred from env for that provider', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello', provider: 'claude' }),
      environment: { CODEX_SESSION_ID: 'codex-id', CLAUDE_SESSION_ID: 'claude-id' },
    });
    expect(input).toMatchObject({ provider: 'claude', session: 'claude-id' });
  });

  it('--provider claude with stored codex session does not borrow it', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello', provider: 'claude' }),
      environment: {},
      task: { provider: 'codex', session: 'codex-stored' } as never,
    });
    expect(input.session).toBeUndefined();
  });

  it('infers session from stored task when provider matches', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { SCRUMLORD_CLI: 'codex' },
      task: { provider: 'codex', session: 'stored-session' } as never,
    });
    expect(input).toMatchObject({ provider: 'codex', session: 'stored-session' });
  });

  it('empty --provider string sets provider to null', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello', provider: '' }),
      environment: { CLAUDECODE: '1' },
    });
    expect(input.provider).toBeNull();
  });

  it('--session without provider and no resolvable provider throws orphan_session', () => {
    expect(() =>
      progressInputFromContext({
        flags: flags({ message: 'hello', session: 'abc' }),
        environment: {},
        task: null,
      }),
    ).toThrow('requires a resolvable provider');
  });

  it('--session with --provider is valid (resolvable provider)', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello', session: 'abc', provider: 'claude' }),
      environment: {},
    });
    expect(input).toMatchObject({ provider: 'claude', session: 'abc' });
  });

  it('throws missing_progress_message when --message is absent', () => {
    expect(() => progressInputFromContext({ flags: new Map(), environment: {} })).toThrow(
      '--message is required.',
    );
  });

  it('uses CLAUDE_PROJECT_DIR as default cwd', () => {
    const input = progressInputFromContext({
      flags: flags({ message: 'hello' }),
      environment: { CLAUDE_PROJECT_DIR: '/project/root' },
    });
    expect(input.cwd).toBe('/project/root');
  });

  it('defaults cwd to process.cwd() when env absent', () => {
    const input = progressInputFromContext({ flags: flags({ message: 'hello' }), environment: {} });
    expect(input.cwd).toBe(process.cwd());
  });
});

describe('tasks progress CLI commands', () => {
  it('records and lists progress entries for a task', async () => {
    const root = await workspaceRoot();
    const created = await runTasksCli(
      ['create', '--title', 'Progress task', '--provider', 'codex', '--session', 'codex-session'],
      { cwd: root },
    );
    const taskId = taskIdFromOutput(created.stdout);

    const recorded = await runTasksCli(
      ['progress', 'add', taskId, '--message', '  Wrote regression coverage.  '],
      // Isolate environment so agent env vars don't override task-inherited provider/session.
      { cwd: root, environment: {} },
    );
    expect(JSON.parse(recorded.stdout)).toMatchObject({
      taskId,
      message: 'Wrote regression coverage.',
      provider: 'codex',
      session: 'codex-session',
    });

    const progress = await runTasksCli(['progress', 'list', taskId], { cwd: root });
    expect(JSON.parse(progress.stdout)).toEqual([
      expect.objectContaining({ taskId, message: 'Wrote regression coverage.' }),
    ]);
  });

  it('moves draft and ready tasks to in-progress when progress is recorded', async () => {
    const root = await workspaceRoot();
    const draft = await runTasksCli(['create', '--title', 'Draft task', '--draft'], { cwd: root });
    const ready = await runTasksCli(['create', '--title', 'Ready task'], { cwd: root });
    const draftId = taskIdFromOutput(draft.stdout);
    const readyId = taskIdFromOutput(ready.stdout);

    await runTasksCli(['progress', 'add', draftId, '--message', 'Started draft work.'], {
      cwd: root,
    });
    await runTasksCli(['progress', 'add', readyId, '--message', 'Started ready work.'], {
      cwd: root,
    });

    const fetchedDraft = await runTasksCli(['get', draftId], { cwd: root });
    const fetchedReady = await runTasksCli(['get', readyId], { cwd: root });

    expect(JSON.parse(fetchedDraft.stdout)).toMatchObject({ id: draftId, status: 'in-progress' });
    expect(JSON.parse(fetchedReady.stdout)).toMatchObject({ id: readyId, status: 'in-progress' });
  });

  it('renders progress help and validates progress input before opening a store', async () => {
    const progressHelp = await runTasksCli(['progress', '--help'], { colorMode: 'never' });
    expect(progressHelp.stdout).toContain('tasks progress');
    expect(progressHelp.stdout).toContain('list');
    expect(progressHelp.stdout).toContain('add');

    const progressAddHelp = await runTasksCli(['help', 'progress', 'add'], { colorMode: 'never' });
    expect(progressAddHelp.stdout).toContain('tasks progress add');
    expect(progressAddHelp.stdout).toContain('--message');

    let createStoreCalls = 0;
    const noMessageResult = await runTasksCli(['progress', 'add', 'task-id'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('Store should not open for missing --message.');
      },
    });
    expect(JSON.parse(noMessageResult.stderr).error.code).toBe('missing_progress_message');
    expect(createStoreCalls).toBe(0);

    const invalidBareListFlagResult = await runTasksCli(['progress', '--message', 'x'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('nope');
      },
    });
    expect(JSON.parse(invalidBareListFlagResult.stderr).error.code).toBe('invalid_progress_flag');
    expect(createStoreCalls).toBe(0);

    const invalidSubcommandResult = await runTasksCli(['progress', 'nope'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('nope');
      },
    });
    expect(JSON.parse(invalidSubcommandResult.stderr).error.code).toBe(
      'invalid_progress_subcommand',
    );
    expect(createStoreCalls).toBe(0);

    const invalidFlagResult = await runTasksCli(['progress', 'list', '--message', 'x'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('nope');
      },
    });
    expect(JSON.parse(invalidFlagResult.stderr).error.code).toBe('invalid_progress_flag');
    expect(createStoreCalls).toBe(0);

    const invalidFullFlagResult = await runTasksCli(
      ['progress', 'add', 'task-id', '--message', 'x', '--full'],
      {
        createStore: async () => {
          createStoreCalls += 1;
          throw new Error('nope');
        },
      },
    );
    expect(JSON.parse(invalidFullFlagResult.stderr).error.code).toBe('invalid_progress_flag');
    expect(createStoreCalls).toBe(0);
  });

  it('rejects tasks progress list --provider and --session flags', async () => {
    let createStoreCalls = 0;
    const createStore = async () => {
      createStoreCalls += 1;
      throw new Error('nope');
    };

    const providerFlagResult = await runTasksCli(['progress', 'list', '--provider', 'claude'], {
      createStore,
    });
    expect(JSON.parse(providerFlagResult.stderr).error.code).toBe('invalid_progress_flag');

    const sessionFlagResult = await runTasksCli(['progress', 'list', '--session', 'abc'], {
      createStore,
    });
    expect(JSON.parse(sessionFlagResult.stderr).error.code).toBe('invalid_progress_flag');

    expect(createStoreCalls).toBe(0);
  });

  it('rejects invalid --provider for progress add without opening store', async () => {
    let createStoreCalls = 0;
    const result = await runTasksCli(
      ['progress', 'add', '--message', 'hi', '--provider', 'banana'],
      {
        createStore: async () => {
          createStoreCalls += 1;
          throw new Error('nope');
        },
      },
    );
    expect(JSON.parse(result.stderr).error.code).toBe('invalid_provider');
    expect(createStoreCalls).toBe(0);
  });
});

describe('tasks clear CLI commands', () => {
  it('clears branch, plan, session, start-date, due-date', async () => {
    const root = await workspaceRoot();
    const created = await runTasksCli(
      [
        'create',
        '--title',
        'Clear test',
        '--branch',
        'feature/x',
        '--provider',
        'codex',
        '--session',
        'sess',
        '--start-date',
        '2026-01-01',
        '--due-date',
        '2026-12-31',
      ],
      { cwd: root },
    );
    const taskId = taskIdFromOutput(created.stdout);

    await runTasksCli(['clear', 'branch', taskId], { cwd: root });
    const branchResult = await runTasksCli(['get', taskId], { cwd: root });
    expect(JSON.parse(branchResult.stdout).branch).toBeNull();

    await runTasksCli(['clear', 'session', taskId], { cwd: root });
    const sessionResult = await runTasksCli(['get', taskId], { cwd: root });
    expect(JSON.parse(sessionResult.stdout).provider).toBeNull();
    expect(JSON.parse(sessionResult.stdout).session).toBeNull();

    await runTasksCli(['clear', 'start-date', taskId], { cwd: root });
    const startDateResult = await runTasksCli(['get', taskId], { cwd: root });
    expect(JSON.parse(startDateResult.stdout).startDate).toBeNull();

    await runTasksCli(['clear', 'due-date', taskId], { cwd: root });
    const dueDateResult = await runTasksCli(['get', taskId], { cwd: root });
    expect(JSON.parse(dueDateResult.stdout).dueDate).toBeNull();
  });

  it('rejects invalid clear property without opening the store', async () => {
    let createStoreCalls = 0;
    const result = await runTasksCli(['clear', 'nonsense'], {
      createStore: async () => {
        createStoreCalls += 1;
        throw new Error('nope');
      },
    });
    expect(JSON.parse(result.stderr).error.code).toBe('invalid_clear_property');
    expect(createStoreCalls).toBe(0);
  });
});
