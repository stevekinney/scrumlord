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

  it('falls back to JSON in pretty mode while no renderers are implemented', async () => {
    // Phase A ships all shapes as jsonFallback; pretty mode on a TTY with no
    // machine env should therefore still emit JSON byte-for-byte.
    const pretty = await runTasksCli(['available'], {
      createStore,
      isStdoutTty: true,
      environment: {},
    });
    const json = await runTasksCli(['available', '--json'], { createStore });
    expect(pretty.stdout).toBe(json.stdout);
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
