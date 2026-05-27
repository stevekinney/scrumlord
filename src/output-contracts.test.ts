import { describe, expect, it } from 'bun:test';
import { commandSpecifications } from './cli-arguments.js';
import {
  contractForInvocation,
  internalDelegationContractCommands,
  knownContractCommands,
  rejectJsonOnNonDataContract,
  renderReadiness,
} from './output-contracts.js';

const expectedContracts: ReadonlyArray<{
  command: string;
  flags: ReadonlySet<string>;
  expected: ReturnType<typeof contractForInvocation>;
}> = [
  {
    command: 'available',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'available tasks' },
  },
  {
    command: 'list',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks' },
  },
  {
    command: 'blocked',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'blocked tasks' },
  },
  {
    command: 'completed',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'completed tasks' },
  },
  {
    command: 'tagged',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'tagged tasks' },
  },
  {
    command: 'with-branch',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks on branch' },
  },
  {
    command: 'blocked-by',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'blocking tasks' },
  },
  {
    command: 'blocking',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'dependent tasks' },
  },
  {
    command: 'priority',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks at priority' },
  },
  {
    command: 'status',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks at status' },
  },
  {
    command: 'search',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'matching tasks' },
  },
  { command: 'get', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'current', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'next', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'create', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'update', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'delete', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'tags', flags: new Set(), expected: { kind: 'jsonData', shape: 'tag-list' } },
  {
    command: 'tags',
    flags: new Set(['subcommand:add']),
    expected: { kind: 'jsonData', shape: 'single-task' },
  },
  {
    command: 'tags',
    flags: new Set(['subcommand:remove']),
    expected: { kind: 'jsonData', shape: 'single-task' },
  },
  {
    command: 'blockers',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'task-list', countLabel: 'blocking tasks' },
  },
  {
    command: 'blockers',
    flags: new Set(['subcommand:add']),
    expected: { kind: 'jsonData', shape: 'single-task' },
  },
  {
    command: 'blockers',
    flags: new Set(['subcommand:remove']),
    expected: { kind: 'jsonData', shape: 'single-task' },
  },
  { command: 'clear', flags: new Set(), expected: { kind: 'jsonData', shape: 'single-task' } },
  { command: 'session', flags: new Set(), expected: { kind: 'jsonData', shape: 'task-session' } },
  { command: 'remaining', flags: new Set(), expected: { kind: 'jsonData', shape: 'remaining' } },
  { command: 'cleanup', flags: new Set(), expected: { kind: 'jsonData', shape: 'cleanup' } },
  { command: 'overview', flags: new Set(), expected: { kind: 'jsonData', shape: 'pr-overview' } },
  { command: 'init', flags: new Set(), expected: { kind: 'jsonData', shape: 'init-result' } },
  { command: 'start', flags: new Set(), expected: { kind: 'jsonData', shape: 'start-result' } },
  {
    command: 'agent-hook',
    flags: new Set(),
    expected: { kind: 'jsonData', shape: 'start-result' },
  },
  { command: 'pipeline', flags: new Set(), expected: { kind: 'bespoke' } },
  { command: 'locate', flags: new Set(), expected: { kind: 'bespoke' } },
  { command: 'completions', flags: new Set(), expected: { kind: 'rawText' } },
  { command: 'completions-data', flags: new Set(), expected: { kind: 'rawText' } },
  // `tasks prompt <skill>`: pure skills are rawText; plan delegates to plan's
  // rawText contract; cleanup store mode resolves the cleanup shape.
  { command: 'prompt', flags: new Set(['skill:next']), expected: { kind: 'rawText' } },
  { command: 'prompt', flags: new Set(['skill:resolve']), expected: { kind: 'rawText' } },
  { command: 'prompt', flags: new Set(['skill:sync']), expected: { kind: 'rawText' } },
  { command: 'prompt', flags: new Set(['skill:audit']), expected: { kind: 'rawText' } },
  { command: 'prompt', flags: new Set(['skill:merge']), expected: { kind: 'rawText' } },
  { command: 'prompt', flags: new Set(['skill:plan']), expected: { kind: 'rawText' } },
  {
    command: 'prompt',
    flags: new Set(['skill:cleanup']),
    expected: { kind: 'jsonData', shape: 'cleanup' },
  },
  { command: 'pr', flags: new Set(), expected: { kind: 'jsonData', shape: 'pr-status' } },
  { command: 'pr', flags: new Set(['url']), expected: { kind: 'rawText' } },
  { command: 'pr', flags: new Set(['open']), expected: { kind: 'silent' } },
  {
    command: 'pr',
    flags: new Set(['comments']),
    expected: { kind: 'jsonData', shape: 'review-comments' },
  },
  {
    command: 'pr',
    flags: new Set(['comments', 'resolved']),
    expected: { kind: 'jsonData', shape: 'review-comments' },
  },
  {
    command: 'pr',
    flags: new Set(['comments', 'all']),
    expected: { kind: 'jsonData', shape: 'review-comments' },
  },
  {
    command: 'pr',
    flags: new Set(['sync']),
    expected: { kind: 'jsonData', shape: 'sync-summary' },
  },
  { command: 'pr', flags: new Set(['sync', 'quiet']), expected: { kind: 'silent' } },
  { command: 'pr', flags: new Set(['poll']), expected: { kind: 'jsonData', shape: 'pr-status' } },
  { command: 'pr', flags: new Set(['watch']), expected: { kind: 'jsonData', shape: 'pr-status' } },
  { command: 'repository', flags: new Set(), expected: { kind: 'rawText' } },
  { command: 'repository', flags: new Set(['url']), expected: { kind: 'rawText' } },
  {
    command: 'repository',
    flags: new Set(['json']),
    expected: { kind: 'jsonData', shape: 'repository-summary' },
  },
  { command: 'setup', flags: new Set(), expected: { kind: 'jsonData', shape: 'setup-result' } },
  { command: 'setup', flags: new Set(['prompt']), expected: { kind: 'rawText' } },
  { command: 'setup', flags: new Set(['shell']), expected: { kind: 'rawText' } },
  { command: 'progress', flags: new Set(), expected: { kind: 'jsonData', shape: 'task-progress' } },
  {
    command: 'progress',
    flags: new Set(['subcommand:list']),
    expected: { kind: 'jsonData', shape: 'task-progress' },
  },
  {
    command: 'progress',
    flags: new Set(['subcommand:add']),
    expected: { kind: 'jsonData', shape: 'single-task-progress' },
  },
];

describe('contractForInvocation', () => {
  for (const { command, flags, expected } of expectedContracts) {
    it(`resolves ${command} ${[...flags].map((f) => `--${f}`).join(' ')} → ${expected.kind}${expected.kind === 'jsonData' ? `:${expected.shape}` : ''}`, () => {
      expect(contractForInvocation(command, flags)).toEqual(expected);
    });
  }

  it('throws unknown_command for an unknown command', () => {
    expect(() => contractForInvocation('does-not-exist', new Set())).toThrow(/Unknown command/);
  });
});

describe('contract / parser drift', () => {
  it('every known contract command exists in commandSpecifications', () => {
    for (const command of knownContractCommands) {
      expect(commandSpecifications[command]).toBeDefined();
    }
  });

  it('every commandSpecifications key is registered in knownContractCommands or is help', () => {
    for (const command of Object.keys(commandSpecifications)) {
      if (command === 'help') continue;
      expect(knownContractCommands.has(command)).toBe(true);
    }
  });

  it('every jsonData/bespoke command accepts --json in its parser spec', () => {
    // Bespoke commands (pipeline, locate) own their own renderers but
    // still accept --json — both honor the resolved outputMode and emit a
    // JSON envelope when it is `'json'`. Pure rawText commands have no JSON
    // form and are excluded.
    const exclusions = new Set<string>(['completions', 'completions-data']);
    for (const command of knownContractCommands) {
      if (exclusions.has(command)) continue;
      const spec = commandSpecifications[command];
      const supportsJson = spec?.booleanFlags?.includes('json') ?? false;
      // `repository`, `pr`, `setup`, and `prompt` are mixed-form; --json must
      // still appear in their spec because at least one invocation is jsonData.
      expect({ command, supportsJson }).toEqual({ command, supportsJson: true });
    }
  });

  it('pure rawText commands do not accept --json', () => {
    const rawTextCommands = ['completions', 'completions-data'];
    for (const cmd of rawTextCommands) {
      const spec = commandSpecifications[cmd];
      expect({ cmd, supportsJson: spec?.booleanFlags?.includes('json') ?? false }).toEqual({
        cmd,
        supportsJson: false,
      });
    }
  });

  it('internal-delegation contracts (plan, cleanup) have no top-level parser spec', () => {
    for (const command of internalDelegationContractCommands) {
      expect(commandSpecifications[command]).toBeUndefined();
      expect(knownContractCommands.has(command)).toBe(false);
    }
  });
});

describe('rejectJsonOnNonDataContract', () => {
  it('throws json_not_supported on rawText invocations', () => {
    expect(() => rejectJsonOnNonDataContract('pr', new Set(['url', 'json']))).toThrow(
      /--json is not supported/,
    );
    expect(() => rejectJsonOnNonDataContract('repository', new Set(['url', 'json']))).toThrow(
      /--json is not supported/,
    );
    expect(() => rejectJsonOnNonDataContract('setup', new Set(['prompt', 'json']))).toThrow(
      /--json is not supported/,
    );
  });

  it('throws json_not_supported on silent invocations', () => {
    expect(() => rejectJsonOnNonDataContract('pr', new Set(['open', 'json']))).toThrow(
      /--json is not supported/,
    );
    expect(() => rejectJsonOnNonDataContract('pr', new Set(['sync', 'quiet', 'json']))).toThrow(
      /--json is not supported/,
    );
  });

  it('does nothing when --json is absent', () => {
    expect(() => rejectJsonOnNonDataContract('pr', new Set(['url']))).not.toThrow();
  });

  it('does nothing on jsonData invocations', () => {
    expect(() => rejectJsonOnNonDataContract('repository', new Set(['json']))).not.toThrow();
    expect(() => rejectJsonOnNonDataContract('pr', new Set(['comments', 'json']))).not.toThrow();
    expect(() => rejectJsonOnNonDataContract('available', new Set(['json']))).not.toThrow();
  });
});

describe('renderReadiness', () => {
  it('reports only implemented or jsonFallback for every shape', () => {
    for (const value of Object.values(renderReadiness)) {
      expect(['implemented', 'jsonFallback']).toContain(value);
    }
  });
});
