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
  | 'tag-list'
  | 'task-progress'
  | 'single-task-progress'
  | 'task-session'
  | 'pr-status'
  | 'review-comments'
  | 'pr-overview'
  | 'remaining'
  | 'cleanup'
  | 'sync-summary'
  | 'complete-sync'
  | 'init-result'
  | 'setup-result'
  | 'start-result'
  | 'import-legacy-result'
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
  'tag-list': 'implemented',
  'task-progress': 'implemented',
  'single-task-progress': 'implemented',
  'task-session': 'implemented',
  'pr-status': 'implemented',
  'review-comments': 'implemented',
  'pr-overview': 'implemented',
  remaining: 'implemented',
  cleanup: 'implemented',
  'sync-summary': 'jsonFallback',
  'complete-sync': 'jsonFallback',
  'init-result': 'jsonFallback',
  'setup-result': 'jsonFallback',
  'start-result': 'jsonFallback',
  'import-legacy-result': 'jsonFallback',
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
  status: { kind: 'jsonData', shape: 'task-list', countLabel: 'tasks at status' },
  search: { kind: 'jsonData', shape: 'task-list', countLabel: 'matching tasks' },
  get: { kind: 'jsonData', shape: 'single-task' },
  current: { kind: 'jsonData', shape: 'single-task' },
  peek: { kind: 'jsonData', shape: 'single-task' },
  create: { kind: 'jsonData', shape: 'single-task' },
  update: { kind: 'jsonData', shape: 'single-task' },
  delete: { kind: 'jsonData', shape: 'single-task' },
  clear: { kind: 'jsonData', shape: 'single-task' },
  session: { kind: 'jsonData', shape: 'task-session' },
  remaining: { kind: 'jsonData', shape: 'remaining' },
  overview: { kind: 'jsonData', shape: 'pr-overview' },
  init: { kind: 'jsonData', shape: 'init-result' },
  'import-legacy-databases': { kind: 'jsonData', shape: 'import-legacy-result' },
  start: { kind: 'jsonData', shape: 'start-result' },
  'agent-hook': { kind: 'jsonData', shape: 'start-result' },
  pipeline: { kind: 'bespoke' },
  teleport: { kind: 'bespoke' },
  completions: { kind: 'rawText' },
  'completions-data': { kind: 'rawText' },
  // `plan` keeps a rawText contract because `tasks prompt plan` delegates its
  // store/print path to the plan handler under a shifted `command: 'plan'`. It is
  // not a top-level command — see `knownContractCommands` notes below.
  plan: { kind: 'rawText' },
};

/**
 * Commands whose contracts exist only for internal `tasks prompt <skill>`
 * delegation (the prompt handler runs the plan/cleanup store path under a shifted
 * `command`) and so are intentionally absent from the parser specifications and
 * from {@link knownContractCommands}.
 */
export const internalDelegationContractCommands = new Set<string>(['plan', 'cleanup']);

/**
 * Set of all top-level command names known to the contract system. Used by the
 * drift test to assert coverage parity with the parser specifications. Excludes
 * {@link internalDelegationContractCommands}, which have no top-level spec.
 */
export const knownContractCommands = new Set<string>([
  ...Object.keys(pureCommandContracts).filter(
    (command) => !internalDelegationContractCommands.has(command),
  ),
  'pr',
  'repository',
  'setup',
  'progress',
  'tags',
  'blockers',
  'complete',
  'prompt',
]);

const tagsContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('subcommand:add') || flags.has('subcommand:remove')) {
    return { kind: 'jsonData', shape: 'single-task' };
  }
  return { kind: 'jsonData', shape: 'tag-list' };
};

const blockersContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('subcommand:add') || flags.has('subcommand:remove')) {
    return { kind: 'jsonData', shape: 'single-task' };
  }
  return { kind: 'jsonData', shape: 'task-list', countLabel: 'blocking tasks' };
};

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

const completeContract = (flags: ReadonlySet<string>): OutputContract => {
  // `--sync` produces the sync summary (rendered bespoke, JSON in JSON mode);
  // the batch `complete <id...>` form returns the completed tasks.
  if (flags.has('sync')) return { kind: 'jsonData', shape: 'complete-sync' };
  return { kind: 'jsonData', shape: 'task-list', countLabel: 'completed tasks' };
};

const setupContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('prompt')) return { kind: 'rawText' };
  if (flags.has('shell')) return { kind: 'rawText' };
  return { kind: 'jsonData', shape: 'setup-result' };
};

const cleanupContract = (): OutputContract => {
  // The agent-launch / print form (`--cli`/no-selector `--print`) is bespoke and
  // never reaches this contract; the store/graph path renders the cleanup shape.
  return { kind: 'jsonData', shape: 'cleanup' };
};

/**
 * `tasks prompt <skill>` dispatches on the skill (surfaced as a synthetic
 * `skill:<name>` flag). The agent-launch and print paths build their own
 * `CliResult` and never resolve a contract; only the `plan`/`cleanup` store path
 * does, so those map to the underlying plan/cleanup contracts. Pure skills are
 * rawText (defensive — `--json` is already rejected for them at validation).
 */
const promptContract = (flags: ReadonlySet<string>): OutputContract => {
  if (flags.has('skill:plan')) return { kind: 'rawText' };
  if (flags.has('skill:cleanup')) return cleanupContract();
  return { kind: 'rawText' };
};

/**
 * Resolves the {@link OutputContract} for a parsed command + flag
 * combination. Mixed-form commands (`pr`, `repository`, `setup`, `progress`)
 * are routed through per-command helpers; everything else is a static lookup.
 */
const mixedFormContracts: Record<string, (flags: ReadonlySet<string>) => OutputContract> = {
  pr: pullRequestContract,
  repository: repositoryContract,
  setup: setupContract,
  cleanup: () => cleanupContract(),
  prompt: promptContract,
  progress: progressContract,
  tags: tagsContract,
  blockers: blockersContract,
  complete: completeContract,
};

export const contractForInvocation = (
  command: string,
  flags: ReadonlySet<string>,
): OutputContract => {
  const mixedForm = mixedFormContracts[command];
  if (mixedForm) return mixedForm(flags);
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
