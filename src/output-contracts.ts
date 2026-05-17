import { ScrumlordError } from './errors.js';

/** Output shape for a given command + flag combination. */
export type OutputContract =
  | { kind: 'jsonData'; shape: DataShape; countLabel?: string }
  | { kind: 'rawText' }
  | { kind: 'silent' }
  | { kind: 'bespoke' };

/** Distinct value shapes the CLI returns for `jsonData` commands. */
export type DataShape =
  | 'task-list'
  | 'single-task'
  | 'task-progress'
  | 'single-task-progress'
  | 'task-session'
  | 'pr-status'
  | 'review-comments'
  | 'pr-overview'
  | 'remaining'
  | 'cleanup'
  | 'sync-summary'
  | 'init-result'
  | 'setup-result'
  | 'start-result'
  | 'repository-summary';

/**
 * Tracks whether a shape currently has a pretty renderer wired up. Phase A
 * ships every shape as `'jsonFallback'`; later phases flip entries to
 * `'implemented'` in the same commit that adds the renderer.
 *
 * The exhaustiveness test in `output-renderer.test.ts` iterates this map and
 * fails on drift, so a forgotten flip becomes a test failure rather than a
 * silent runtime fallback.
 */
export type RenderReadiness = 'implemented' | 'jsonFallback';

export const renderReadiness: Record<DataShape, RenderReadiness> = {
  'task-list': 'implemented',
  'single-task': 'implemented',
  'task-progress': 'implemented',
  'single-task-progress': 'implemented',
  'task-session': 'implemented',
  'pr-status': 'implemented',
  'review-comments': 'implemented',
  'pr-overview': 'implemented',
  remaining: 'implemented',
  cleanup: 'implemented',
  'sync-summary': 'jsonFallback',
  'init-result': 'jsonFallback',
  'setup-result': 'jsonFallback',
  'start-result': 'jsonFallback',
  'repository-summary': 'jsonFallback',
};

const pureCommandContracts: Record<string, OutputContract> = {
  available: { kind: 'jsonData', shape: 'task-list', countLabel: 'available tasks' },
  list: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks' },
  blocked: { kind: 'jsonData', shape: 'task-list', countLabel: 'blocked tasks' },
  completed: { kind: 'jsonData', shape: 'task-list', countLabel: 'completed tasks' },
  tagged: { kind: 'jsonData', shape: 'task-list', countLabel: 'tagged tasks' },
  'with-branch': { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks on branch' },
  'blocked-by': { kind: 'jsonData', shape: 'task-list', countLabel: 'blocking tasks' },
  blocking: { kind: 'jsonData', shape: 'task-list', countLabel: 'dependent tasks' },
  priority: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks at priority' },
  'with-priority': { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks at priority' },
  search: { kind: 'jsonData', shape: 'task-list', countLabel: 'matching tasks' },
  get: { kind: 'jsonData', shape: 'single-task' },
  current: { kind: 'jsonData', shape: 'single-task' },
  next: { kind: 'jsonData', shape: 'single-task' },
  create: { kind: 'jsonData', shape: 'single-task' },
  update: { kind: 'jsonData', shape: 'single-task' },
  delete: { kind: 'jsonData', shape: 'single-task' },
  'add-tag': { kind: 'jsonData', shape: 'single-task' },
  'remove-tag': { kind: 'jsonData', shape: 'single-task' },
  'add-blocker': { kind: 'jsonData', shape: 'single-task' },
  'remove-blocker': { kind: 'jsonData', shape: 'single-task' },
  clear: { kind: 'jsonData', shape: 'single-task' },
  session: { kind: 'jsonData', shape: 'task-session' },
  remaining: { kind: 'jsonData', shape: 'remaining' },
  cleanup: { kind: 'jsonData', shape: 'cleanup' },
  overview: { kind: 'jsonData', shape: 'pr-overview' },
  init: { kind: 'jsonData', shape: 'init-result' },
  start: { kind: 'jsonData', shape: 'start-result' },
  resume: { kind: 'jsonData', shape: 'start-result' },
  'agent-hook': { kind: 'jsonData', shape: 'start-result' },
  pipeline: { kind: 'bespoke' },
  teleport: { kind: 'bespoke' },
  plan: { kind: 'rawText' },
  completions: { kind: 'rawText' },
  'completions-data': { kind: 'rawText' },
};

/**
 * Set of all command names known to the contract system. Used by the drift
 * test to assert coverage parity with the parser specifications.
 */
export const knownContractCommands = new Set<string>([
  ...Object.keys(pureCommandContracts),
  'pr',
  'repository',
  'setup',
  'progress',
]);

const progressContract = (flags: ReadonlySet<string>): OutputContract => {
  // `progress add` returns a single TaskProgress; `progress list` returns an
  // array. The subcommand lives in positionals, not flags, so the contract
  // helper accepts a "synthetic" flag name `subcommand:add` /
  // `subcommand:list` injected by the dispatcher.
  if (flags.has('subcommand:add')) return { kind: 'jsonData', shape: 'single-task-progress' };
  return { kind: 'jsonData', shape: 'task-progress' };
};

const repositoryContract = (flags: ReadonlySet<string>): OutputContract => {
  // `--url` always wins for raw output. When both `--url` and `--json` are
  // passed, the contract stays rawText so the generic --json rejection fires
  // with a clear error rather than silently emitting JSON.
  if (flags.has('url')) return { kind: 'rawText' };
  if (flags.has('json')) return { kind: 'jsonData', shape: 'repository-summary' };
  return { kind: 'rawText' };
};

const pullRequestContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('url')) return { kind: 'rawText' };
  if (flags.has('open')) return { kind: 'silent' };
  if (flags.has('sync')) {
    if (flags.has('quiet')) return { kind: 'silent' };
    return { kind: 'jsonData', shape: 'sync-summary' };
  }
  if (flags.has('poll')) return { kind: 'jsonData', shape: 'pr-status' };
  if (flags.has('comments') || flags.has('resolved') || flags.has('all')) {
    return { kind: 'jsonData', shape: 'review-comments' };
  }
  return { kind: 'jsonData', shape: 'pr-status' };
};

const setupContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('prompt')) return { kind: 'rawText' };
  if (flags.has('shell')) return { kind: 'rawText' };
  return { kind: 'jsonData', shape: 'setup-result' };
};

/**
 * Resolves the {@link OutputContract} for a parsed command + flag
 * combination. Mixed-form commands (`pr`, `repository`, `setup`, `progress`)
 * are routed through per-command helpers; everything else is a static lookup.
 */
export const contractForInvocation = (
  command: string,
  flags: ReadonlySet<string>,
): OutputContract => {
  if (command === 'pr') return pullRequestContract(flags);
  if (command === 'repository') return repositoryContract(flags);
  if (command === 'setup') return setupContract(flags);
  if (command === 'progress') return progressContract(flags);
  const contract = pureCommandContracts[command];
  if (!contract) throw new ScrumlordError('unknown_command', `Unknown command: ${command}`);
  return contract;
};

/**
 * Throws `json_not_supported` when `--json` is passed on an invocation whose
 * resolved contract has no JSON form (`rawText` or `silent`). Generic
 * fallback; per-command validators may surface more precise messages first.
 */
export const rejectJsonOnNonDataContract = (command: string, flags: ReadonlySet<string>): void => {
  if (!flags.has('json')) return;
  const contract = contractForInvocation(command, flags);
  if (contract.kind === 'rawText' || contract.kind === 'silent') {
    throw new ScrumlordError('json_not_supported', `--json is not supported on this command form.`);
  }
};
