import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  runAgentHookCommand,
  runNextCommand,
  runStartCommand,
  runWorkflowCommand,
  renderPlanWorkflowPrompt,
  renderResolvePrompt,
  renderSyncPrompt,
  renderAuditPrompt,
  renderMergePrompt,
  renderCleanupWorkflowPrompt,
} from './cli-agent-commands.js';
import { runCompletionsBoundaryCommand } from './cli-completions-command.js';
import { runCompletionsDataCommand } from './cli-completions-data-command.js';
import { runOverviewWatchCommand } from './cli-overview-watch.js';
import { runPipelineCommand } from './cli-pipeline-command.js';
import { parsePollInteger, parsePollNumber, validatePullRequestFlags } from './cli-pr-flags.js';
import { runPullRequestWatchCommand } from './cli-pr-watch.js';
import { runTeleportCommand } from './cli-teleport-command.js';
import {
  helpPath,
  isHelpRequest,
  parseArguments,
  validatePositionals,
  type ParsedArguments,
} from './cli-arguments.js';
import { runSetupBoundaryCommand } from './cli-setup-commands.js';
import {
  runTaskStoreCommand,
  taskStoreCommands,
  validateStoreCommandInput,
} from './cli-store-commands.js';
import type { CliOptions, CliResult } from './cli-types.js';
import {
  formatCliError,
  formatStoreResult,
  rejectJsonOnRawForm,
  resolveModeForOptions,
} from './cli-output.js';
import { createTaskStore } from './database-open.js';
import { ScrumlordError } from './errors.js';
import { syncGitStatus } from './git-status.js';
import { renderHelp } from './help.js';
import { initializeProject } from './init.js';
import { formatJson } from './output-json.js';
import type { OutputMode } from './output-mode.js';
import { resolveProjectRoot } from './root-resolution.js';
import type { CleanupTasksMode, CleanupTasksResult } from './task-commands.js';
import type { CompleteSyncResult } from './tasks-complete-sync.js';
import type { TaskStore } from './types.js';

type BoundaryCommandHandler = (parsed: ParsedArguments, options: CliOptions) => Promise<CliResult>;

const json = (value: unknown): string => formatJson(value);
const success = (value: unknown): CliResult => ({ exitCode: 0, stdout: json(value), stderr: '' });
const dataSuccess = (parsed: ParsedArguments, value: unknown, options: CliOptions): CliResult =>
  formatStoreResult(parsed, value, options);
/** Returns a CLI result whose stdout is the raw string plus newline — no JSON wrapping. */
const rawString = (value: string): CliResult => ({ exitCode: 0, stdout: `${value}\n`, stderr: '' });
const emptySuccess = (): CliResult => ({ exitCode: 0, stdout: '', stderr: '' });
const storeCommands = new Set([
  ...taskStoreCommands,
  'overview',
  'pr',
  'start',
  'agent-hook',
  'pipeline',
  'completions-data',
  'teleport',
  'next',
  'resolve',
  'sync',
  'audit',
  'merge',
]);

const renderHelpResult = (parsed: ParsedArguments, options: CliOptions): CliResult => {
  const path = helpPath(parsed);
  const help = renderHelp(path, options.colorMode);
  if (!help) {
    const topic = path.length === 0 ? 'main' : path.join(' ');
    throw new ScrumlordError('unknown_help_topic', `Unknown help topic: ${topic}.`);
  }
  return { exitCode: 0, stdout: help, stderr: '' };
};

const runStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<unknown> => {
  if (parsed.command === 'overview') {
    const github = await githubModule(options);
    if (parsed.flags.has('sync')) {
      const syncResult = await (options.syncGitStatus
        ? options.syncGitStatus(store)
        : syncGitStatus(store));
      const items = await github.tasksOverview(store);
      return { items, sync: syncResult };
    }
    return await github.tasksOverview(store);
  }

  return await runTaskStoreCommand(store, parsed, options);
};

const githubModule = async (options: CliOptions): Promise<NonNullable<CliOptions['github']>> => {
  if (options.github) return options.github;
  const [github, githubPoll, overview] = await Promise.all([
    import('./github.js'),
    import('./github-poll.js'),
    import('./tasks-overview.js'),
  ]);
  return { ...github, ...githubPoll, tasksOverview: overview.tasksOverview };
};

const runCompleteSyncCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const { tasksCompleteSync } = await import('./tasks-complete-sync.js');
  const github = await githubModule(options);
  const result = await tasksCompleteSync(
    store,
    { tasksOverview: (target, overviewOptions) => github.tasksOverview(target, overviewOptions) },
    {
      apply: parsed.flags.has('apply'),
      all: parsed.flags.has('all'),
      ...(options.runner ? { runner: options.runner } : {}),
    },
  );
  const exitCode = result.failed.length > 0 ? 1 : 0;
  const stdout =
    options.outputMode === 'json' ? formatJson(result) : renderCompleteSyncResult(result);
  return { exitCode, stdout, stderr: '' };
};

const runPullRequestPollCommand: BoundaryCommandHandler = async (parsed, options) => {
  validatePullRequestFlags(parsed);
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  const maxPolls = parsePollInteger(parsed.flags, 'max-polls', 5);
  const pollIntervalSeconds = parsePollNumber(parsed.flags, 'poll-interval', 20);
  const botPatterns = parsed.flags.get('bot-patterns')?.[0];
  const pollOptions =
    botPatterns !== undefined
      ? { maxPolls, pollIntervalSeconds, botPatterns }
      : { maxPolls, pollIntervalSeconds };
  return dataSuccess(parsed, await github.pullRequestPollStatus(root, pollOptions), options);
};

const runPullRequestBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  validatePullRequestFlags(parsed);
  if (parsed.flags.has('poll')) return runPullRequestPollCommand(parsed, options);
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  if (parsed.flags.has('watch')) {
    return await runPullRequestWatchCommand(parsed, options, () => github.pullRequestStatus(root));
  }
  if (parsed.flags.has('url')) {
    const result = await github.pullRequestUrl(root, false);
    return rawString(result.url);
  }
  if (parsed.flags.has('open')) {
    return success(await github.pullRequestUrl(root, true));
  }
  if (parsed.flags.has('comments')) {
    if (parsed.flags.has('all')) {
      return dataSuccess(parsed, await github.allReviewComments(root), options);
    }
    if (parsed.flags.has('resolved')) {
      return dataSuccess(parsed, await github.resolvedReviewComments(root), options);
    }
    return dataSuccess(parsed, await github.unresolvedReviewComments(root), options);
  }
  return dataSuccess(parsed, await github.pullRequestStatus(root), options);
};

const runPullRequestSyncCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const quiet = parsed.flags.has('quiet');
  const root = store.projectRoot;

  const syncResult = await (options.syncGitStatus
    ? options.syncGitStatus(store)
    : syncGitStatus(store));

  const github = await githubModule(options);
  let pullRequest: unknown = null;
  try {
    pullRequest = await github.pullRequestStatus(root);
  } catch (error) {
    if (error instanceof ScrumlordError && error.code === 'pull_request_not_found') {
      pullRequest = null;
    } else if (quiet) {
      pullRequest = null;
    } else {
      throw error;
    }
  }

  if (quiet) return emptySuccess();
  return success({ pullRequest, sync: syncResult });
};

const runRepositoryBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  if (parsed.flags.has('json')) {
    const [name, url] = await Promise.all([
      github.repositoryName(root),
      github.repositoryUrl(root),
    ]);
    return success({ name, url });
  }
  if (parsed.flags.has('url')) return rawString(await github.repositoryUrl(root));
  return rawString(await github.repositoryName(root));
};

const projectRootKeys = new Set([
  'cwd',
  'currentWorkingDirectory',
  'projectRoot',
  'repositoryRoot',
  'workspaceRoot',
]);

const findStringByKey = (value: unknown, keys: Set<string>): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === 'string' && child.trim()) return child;
  }
  for (const child of Object.values(value)) {
    const match = findStringByKey(child, keys);
    if (match) return match;
  }
  return null;
};

const projectRootFromPayload = (raw: string): string | null => {
  try {
    return findStringByKey(JSON.parse(raw), projectRootKeys);
  } catch {
    return null;
  }
};

const resolveAgentHookRoot = async (
  options: CliOptions,
  payload: string,
): Promise<string | null> => {
  try {
    return await resolveProjectRoot(options.cwd);
  } catch {
    // Fall through to payload-derived cwd: hooks are often invoked from a
    // directory unrelated to the project (e.g. ~/.claude), but the harness
    // includes the conversation's cwd in the payload.
  }
  const payloadCwd = projectRootFromPayload(payload);
  if (!payloadCwd) return null;
  try {
    return await resolveProjectRoot(payloadCwd);
  } catch {
    return null;
  }
};

const runAgentHookBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const payload = await (options.readStdin?.() ?? Bun.stdin.text());
  const root = await resolveAgentHookRoot(options, payload);
  if (!root) return { exitCode: 0, stdout: '', stderr: '' };
  if (!existsSync(join(root, 'tmp', 'tasks.db'))) return { exitCode: 0, stdout: '', stderr: '' };

  const store = await openStore({ ...options, cwd: root });
  try {
    return await runAgentHookCommand(store, parsed, {
      ...options,
      readStdin: async () => payload,
    });
  } finally {
    store.close();
  }
};

const runInitBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const init = options.initializeProject ?? initializeProject;
  return success(await init(options.cwd === undefined ? {} : { cwd: options.cwd }));
};

const boundaryCommandHandlers: Record<string, BoundaryCommandHandler> = {
  init: runInitBoundaryCommand,
  repository: runRepositoryBoundaryCommand,
  pr: runPullRequestBoundaryCommand,
  setup: runSetupBoundaryCommand,
  'agent-hook': runAgentHookBoundaryCommand,
  completions: runCompletionsBoundaryCommand,
};

const runBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult | undefined> => {
  if (parsed.command === 'pr' && parsed.flags.has('sync')) {
    // Validate flags early so invalid combos fail before the store opens
    validatePullRequestFlags(parsed);
    return undefined;
  }
  const handler = parsed.command ? boundaryCommandHandlers[parsed.command] : undefined;
  return handler ? await handler(parsed, options) : undefined;
};

const openStore = async (options: CliOptions): Promise<TaskStore> => {
  if (options.createStore) return await options.createStore(options.cwd ?? process.cwd());
  return await createTaskStore(options.cwd === undefined ? {} : { cwd: options.cwd });
};

const renderAgedLines = (
  result: Extract<CleanupTasksResult, { mode: 'aged' | 'aged-and-orphans' }>,
  prefix: string,
): string[] => {
  if (result.dryRun) {
    return [
      `${prefix}Aged cleanup: would delete=${result.wouldDelete.length} (hard=${result.hard})`,
    ];
  }
  return [`${prefix}Aged cleanup: deleted=${result.deleted} (hard=${result.hard})`];
};

const renderOrphanLines = (
  result: Extract<CleanupTasksResult, { mode: 'orphans-only' | 'aged-and-orphans' }>,
  prefix: string,
): string[] => {
  const { orphans, skipped } = result;
  const lines = [
    `${prefix}Orphan recovery: recovered=${orphans.length}, skipped=${skipped.length}`,
  ];
  for (const orphan of orphans) {
    const branchDesc =
      orphan.previousBranch !== null ? `branch was ${orphan.previousBranch}` : 'no branch recorded';
    const applied = orphan.applied ? 'in-progress→ready' : 'would recover';
    lines.push(`  - task ${orphan.id}: ${applied} (${branchDesc}, missing in git)`);
  }
  for (const skip of skipped) {
    const detail = skip.detail ?? skip.reason;
    lines.push(
      `  - task ${skip.id}: skipped (${detail}${skip.branch !== null ? `: "${skip.branch}"` : ''})`,
    );
  }
  return lines;
};

const renderCleanupResult = (result: CleanupTasksResult): CliResult => {
  if (result.mode === 'prompt') {
    return { exitCode: 0, stdout: result.prompt, stderr: '' };
  }

  const prefix = result.dryRun ? '[dry-run] ' : '';
  const lines: string[] = [];

  if (result.mode === 'aged' || result.mode === 'aged-and-orphans') {
    lines.push(...renderAgedLines(result, prefix));
  }
  if (result.mode === 'orphans-only' || result.mode === 'aged-and-orphans') {
    lines.push(...renderOrphanLines(result, prefix));
  }

  return { exitCode: 0, stdout: lines.join('\n') + '\n', stderr: '' };
};

const mergeVerb = (outcome: 'merged' | 'already_merged'): string =>
  outcome === 'already_merged' ? 'Already merged' : 'Merged';

const completeSyncLines = (result: CompleteSyncResult, prefix: string): string[] => [
  ...result.planned.map((item) => {
    const detail = item.outcome === 'merge_no_tasks' ? 'no tasks' : item.taskIds.join(', ') || '—';
    return `${prefix}Would merge PR #${item.number} and complete: ${detail}`;
  }),
  ...result.merged.map(
    (item) =>
      `${mergeVerb(item.outcome)} PR #${item.number}; completed: ${item.completedTaskIds.join(', ') || '—'}`,
  ),
  ...result.mergedWithoutTasks.map(
    (item) => `${mergeVerb(item.outcome)} PR #${item.number} (no associated tasks)`,
  ),
  ...result.skipped.map((item) => `${prefix}Skipped PR #${item.number} (${item.reason})`),
  ...result.failed.map((item) => `Failed PR #${item.number}: ${item.reason}`),
];

const renderCompleteSyncResult = (result: CompleteSyncResult): string => {
  const prefix = result.applied ? '' : '[dry-run] ';
  const lines = completeSyncLines(result, prefix);
  if (lines.length === 0) lines.push(`${prefix}No open pull requests to sync.`);
  return lines.join('\n') + '\n';
};

const cleanupModes = new Set<string>([
  'aged',
  'orphans-only',
  'aged-and-orphans',
  'prompt',
] satisfies CleanupTasksMode[]);

const isCleanupResult = (value: unknown): value is CleanupTasksResult =>
  typeof value === 'object' &&
  value !== null &&
  'mode' in value &&
  typeof (value as { mode: unknown }).mode === 'string' &&
  cleanupModes.has((value as { mode: string }).mode);

const storeCommandResult = (
  parsed: ParsedArguments,
  value: unknown,
  options: CliOptions,
): CliResult => {
  if (parsed.command === 'peek' && value === null) return emptySuccess();
  if (parsed.command === 'plan' && typeof value === 'string') return rawString(value);
  if (parsed.command === 'cleanup' && isCleanupResult(value)) return renderCleanupResult(value);
  return formatStoreResult(parsed, value, options);
};

type OpenedStoreHandler = (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
) => Promise<CliResult> | CliResult;

/** Builds an {@link OpenedStoreHandler} that dispatches to a workflow skill. */
const workflowHandler =
  (config: Parameters<typeof runWorkflowCommand>[3]): OpenedStoreHandler =>
  (store, parsedArgs, opts) =>
    runWorkflowCommand(store, parsedArgs, opts, config);

/** Direct command → handler table (no flag gating needed). */
const directStoreHandlers: Record<string, OpenedStoreHandler> = {
  start: runStartCommand,
  pipeline: runPipelineCommand,
  teleport: runTeleportCommand,
  'completions-data': (store, parsedArgs) => runCompletionsDataCommand(store, parsedArgs),
  next: runNextCommand,
  resolve: workflowHandler({ skillName: 'resolve', renderPrompt: renderResolvePrompt }),
  sync: workflowHandler({ skillName: 'sync', renderPrompt: renderSyncPrompt }),
  audit: workflowHandler({ skillName: 'audit', renderPrompt: renderAuditPrompt }),
  merge: workflowHandler({ skillName: 'merge', renderPrompt: renderMergePrompt }),
};

/** Flag-gated alternate dispatch: `[command, flag] → handler`. */
const flagGatedHandlers: Array<[command: string, flag: string, handler: OpenedStoreHandler]> = [
  [
    'cleanup',
    'worktrees',
    workflowHandler({ skillName: 'cleanup', renderPrompt: renderCleanupWorkflowPrompt }),
  ],
  ['plan', 'start', workflowHandler({ skillName: 'plan', renderPrompt: renderPlanWorkflowPrompt })],
  ['pr', 'sync', runPullRequestSyncCommand],
  [
    'overview',
    'watch',
    (store, parsedArgs, opts) => runOverviewWatchCommand(store, parsedArgs, opts, runStoreCommand),
  ],
  ['complete', 'sync', runCompleteSyncCommand],
];

/**
 * Commands that bypass the generic store dispatch. Resolved before falling
 * through to {@link runStoreCommand}. Keyed by command name; entries gated on a
 * flag check their own flag and return undefined when it is absent.
 */
const specialStoreHandler = (parsed: ParsedArguments): OpenedStoreHandler | undefined => {
  const directHandler = parsed.command ? directStoreHandlers[parsed.command] : undefined;
  if (directHandler) return directHandler;
  for (const [command, flag, handler] of flagGatedHandlers) {
    if (parsed.command === command && parsed.flags.has(flag)) return handler;
  }
  return undefined;
};

const runOpenedStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const special = specialStoreHandler(parsed);
  if (special) return await special(store, parsed, options);
  return storeCommandResult(parsed, await runStoreCommand(store, parsed, options), options);
};

const removedCommandHints: Record<string, string> = {
  'sync-git-status':
    "Use 'tasks pr --sync' instead. Re-run 'tasks setup --git-hooks' to update managed Lefthook hooks.",
  'add-progress': "Use 'tasks progress add --message <note>' instead.",
  'set-status': "Use 'tasks update --status <status>' instead.",
  'set-branch': "Use 'tasks update --branch <branch>' instead.",
  'set-plan': "Use 'tasks update --plan <path>' instead.",
  'set-session': "Use 'tasks update --provider <p> --session <id>' instead.",
  'clear-branch': "Use 'tasks clear branch' instead.",
  'clear-plan': "Use 'tasks clear plan' instead.",
  'clear-session': "Use 'tasks clear session' instead.",
};

const parseErrorMode = (
  argv: string[],
  parsed: ParsedArguments | undefined,
  options: CliOptions,
): OutputMode => {
  if (options.outputMode !== undefined) return options.outputMode;
  if (parsed) return resolveModeForOptions(parsed, options);
  return resolveModeForOptions(
    {
      command: undefined,
      positionals: [],
      flags: new Map(argv.includes('--json') ? [['json', []]] : []),
    },
    options,
  );
};

/** Runs the tasks CLI and returns captured output for process wrappers and tests. */
export const runTasksCli = async (argv: string[], options: CliOptions = {}): Promise<CliResult> => {
  let parsed: ParsedArguments | undefined;
  try {
    parsed = parseArguments(argv);
    if (isHelpRequest(parsed)) return renderHelpResult(parsed, options);
    if (!parsed.command) throw new ScrumlordError('missing_command', 'A command is required.');
    validatePositionals(parsed);
    rejectJsonOnRawForm(parsed);

    const resolvedOptions: CliOptions = {
      ...options,
      outputMode: resolveModeForOptions(parsed, options),
    };

    const boundaryResult = await runBoundaryCommand(parsed, resolvedOptions);
    if (boundaryResult) return boundaryResult;
    if (!storeCommands.has(parsed.command)) {
      const hint = removedCommandHints[parsed.command];
      const message = hint
        ? `Unknown command: ${parsed.command}. ${hint}`
        : `Unknown command: ${parsed.command}`;
      throw new ScrumlordError('unknown_command', message);
    }
    validateStoreCommandInput(parsed, resolvedOptions);

    const store = await openStore(resolvedOptions);
    try {
      return await runOpenedStoreCommand(store, parsed, resolvedOptions);
    } finally {
      store.close();
    }
  } catch (error) {
    return formatCliError(error, { ...options, outputMode: parseErrorMode(argv, parsed, options) });
  }
};
