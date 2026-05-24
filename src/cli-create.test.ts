import { describe, expect, it } from 'bun:test';
import { runTasksCli } from './cli-runner';
import { fakeStore } from './cli-runner-test-helpers';

describe('tasks create input parsing and validation', () => {
  it('creates a task with a special-character, dependency-prose description on stdout', async () => {
    const calls: string[] = [];
    const description =
      'Refactor the module that was blocked by the old API. `code` $VAR ! (parens) colons: semis;';

    const result = await runTasksCli(['create', '--title', 'Repro', '--description', description], {
      createStore: async () => fakeStore(calls),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(calls).toContain(`create:Repro:ready:1::desc=${description}`);
  });

  it('parses --flag=value for value flags, including dash-leading and empty values', async () => {
    const dashCalls: string[] = [];
    const dashResult = await runTasksCli(
      ['create', '--title', 'Dash', '--description=--starts-with-dashes'],
      { createStore: async () => fakeStore(dashCalls) },
    );
    expect(dashResult.exitCode).toBe(0);
    expect(dashResult.stderr).toBe('');
    expect(dashCalls).toContain('create:Dash:ready:1::desc=--starts-with-dashes');

    const emptyCalls: string[] = [];
    const emptyResult = await runTasksCli(['create', '--title', 'Empty', '--description='], {
      createStore: async () => fakeStore(emptyCalls),
    });
    expect(emptyResult.exitCode).toBe(0);
    expect(emptyResult.stderr).toBe('');
    expect(emptyCalls).toContain('create:Empty:ready:1::desc=');
  });

  it('does not let --flag=value flip boolean or required-value semantics', async () => {
    let booleanStoreCalls = 0;
    // `--draft` is a boolean flag: `--draft=false` must not be accepted as a value.
    const booleanResult = await runTasksCli(['create', '--title', 'T', '--draft=false'], {
      createStore: async () => {
        booleanStoreCalls += 1;
        return fakeStore([]);
      },
    });
    expect(JSON.parse(booleanResult.stderr).error.code).toBe('unknown_flag');
    expect(booleanStoreCalls).toBe(0);

    let titleStoreCalls = 0;
    // An empty required value still fails downstream validation, not silently.
    const emptyTitleResult = await runTasksCli(['create', '--title='], {
      createStore: async () => {
        titleStoreCalls += 1;
        return fakeStore([]);
      },
    });
    expect(JSON.parse(emptyTitleResult.stderr).error.code).toBe('missing_title');
    expect(titleStoreCalls).toBe(0);
  });

  it('rejects empty comma-delimited tag lists before opening a store', async () => {
    let createStoreCalls = 0;
    const result = await runTasksCli(['create', '--title', 'Task', '--tags', ','], {
      createStore: async () => {
        createStoreCalls += 1;
        return fakeStore([]);
      },
    });

    expect(JSON.parse(result.stderr).error).toEqual({
      code: 'invalid_tag',
      message: 'Tags cannot be empty.',
    });
    expect(createStoreCalls).toBe(0);
  });
});
