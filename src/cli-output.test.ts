import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner.js';
import { emptyProgressStoreMethods } from './test-progress-store-methods.js';
import type { TaskStore } from './types.js';

/**
 * Minimal in-memory store that always reports zero available tasks. Enough
 * to exercise the cli-runner output-mode plumbing without dragging in the
 * full fakeStore from `cli-runner.test.ts`.
 */
const emptyStore = (): TaskStore =>
  ({
    projectRoot: '/project',
    databasePath: '/project/tmp/tasks.db',
    available: () => [],
    availableCount: () => 0,
    close: () => {},
    ...emptyProgressStoreMethods,
  }) as unknown as TaskStore;

describe('cli-runner output mode resolution', () => {
  const createStore = async () => emptyStore();

  it('rejects --json on raw text invocations', async () => {
    const result = await runTasksCli(['pr', '--url', '--json'], { createStore });
    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'json_not_supported',
      message: '--json is not supported on this command form.',
    });
  });

  it('rejects --json on silent invocations', async () => {
    const result = await runTasksCli(['pr', '--open', '--json'], { createStore });
    expect(JSON.parse(result.stderr).error.code).toBe('json_not_supported');
  });

  it('rejects --json on setup --prompt', async () => {
    const result = await runTasksCli(['setup', '--prompt', '--json'], { createStore });
    expect(JSON.parse(result.stderr).error.code).toBe('json_not_supported');
  });

  it('rejects --json on repository --url', async () => {
    const result = await runTasksCli(['repository', '--url', '--json'], { createStore });
    expect(JSON.parse(result.stderr).error.code).toBe('json_not_supported');
  });

  it('emits byte-identical JSON across --json, CLAUDECODE, and non-TTY paths', async () => {
    const jsonFlag = await runTasksCli(['available', '--json'], {
      createStore,
      isStdoutTty: true,
    });
    const agentEnv = await runTasksCli(['available'], {
      createStore,
      isStdoutTty: true,
      environment: { CLAUDECODE: '1' },
    });
    const nonTty = await runTasksCli(['available'], { createStore, isStdoutTty: false });
    const prettyOff = await runTasksCli(['available'], {
      createStore,
      isStdoutTty: true,
      environment: { SCRUMLORD_PRETTY: '0' },
    });
    expect(jsonFlag.stdout).toBe(agentEnv.stdout);
    expect(jsonFlag.stdout).toBe(nonTty.stdout);
    expect(jsonFlag.stdout).toBe(prettyOff.stdout);
    expect(jsonFlag.stdout).toBe('[]\n');
  });

  it('emits pretty output on a TTY when the shape has a renderer', async () => {
    const pretty = await runTasksCli(['available'], {
      createStore,
      isStdoutTty: true,
      environment: {},
    });
    // The task-list renderer emits a "(no matching tasks)" placeholder for an
    // empty array — distinct from the JSON `[]\n` form.
    expect(pretty.stdout).toContain('no matching tasks');
    expect(pretty.stdout).not.toBe('[]\n');
  });

  it('emits JSON byte-for-byte for jsonFallback shapes even in pretty mode', async () => {
    // `init-result` is jsonFallback in this PR. Drive the runtime path (not
    // just the readiness constant) via the init boundary command with an
    // injected initializer. Both --json and pretty-mode-on-TTY must produce
    // identical JSON bytes — the fallback path is the whole point.
    const initializeProject = async () => ({ created: false, configured: true });
    const jsonOut = await runTasksCli(['init', '--json'], { createStore, initializeProject });
    const prettyOut = await runTasksCli(['init'], {
      createStore,
      initializeProject,
      isStdoutTty: true,
    });
    expect(prettyOut.stdout).toBe(jsonOut.stdout);
    expect(jsonOut.stdout.startsWith('{')).toBe(true);
  });

  it('routes progress add vs progress list to distinct shapes', async () => {
    const progressEntry = {
      id: 'p1',
      taskId: 'task-id',
      message: 'noted',
      createdAt: '2026-05-15T00:00:00.000Z',
      provider: null,
      session: null,
      event: null,
      tool: null,
      cwd: null,
      transcriptPath: null,
      commitSha: null,
    };
    const progressStore = (): TaskStore =>
      ({
        projectRoot: '/project',
        databasePath: '/project/tmp/tasks.db',
        progress: () => [progressEntry, progressEntry],
        addProgress: () => progressEntry,
        getTask: () => ({
          id: 'task-id',
          title: 'T',
          status: 'in-progress',
          description: '',
          priority: 1,
          createdAt: '2026-05-15T00:00:00.000Z',
          lastModifiedAt: '2026-05-15T00:00:00.000Z',
          startDate: null,
          dueDate: null,
          branch: null,
          plan: null,
          provider: null,
          session: null,
          tags: [],
          blockedBy: [],
          blocking: [],
          deleted: false,
        }),
        close: () => {},
      }) as unknown as TaskStore;
    const list = await runTasksCli(['progress', 'list', 'task-id'], {
      createStore: async () => progressStore(),
    });
    const add = await runTasksCli(['progress', 'add', 'task-id', '--message', 'noted'], {
      createStore: async () => progressStore(),
    });
    // `progress list` returns an array; `progress add` returns a single
    // object. Mode is JSON because isStdoutTty is undefined.
    expect(JSON.parse(list.stdout)).toBeInstanceOf(Array);
    expect(JSON.parse(add.stdout)).toMatchObject({ message: 'noted' });
  });

  it('swallows unknown_command from the contract lookup so the parser error wins', async () => {
    // The contract lookup throws unknown_command but the rejectJsonOnRawForm
    // helper swallows it so the runner can surface its own better message.
    // Here the parser rejects --json as missing a value (value flag form), but
    // either way the contract layer must not get in the way.
    const result = await runTasksCli(['not-a-command', '--json', 'arg'], { createStore });
    expect(JSON.parse(result.stderr).error.code).toBe('unknown_command');
  });
});
