import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentHookCommand, runResumeCommand, runStartCommand } from './cli-agent-commands.js';
import { runPipelineCommand } from './cli-pipeline-command.js';
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
import { createTaskStore } from './database-open.js';
import { ScrumlordError, errorMessage } from './errors.js';
import { syncGitStatus } from './git-status.js';
import { renderHelp } from './help.js';
import { initializeProject } from './init.js';
import { resolveProjectRoot } from './root-resolution.js';
import type { CleanupTasksResult } from './task-commands.js';
import type { TaskStore } from './types.js';

type BoundaryCommandHandler = (parsed: ParsedArguments, options: CliOptions) => Promise<CliResult>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const success = (value: unknown): CliResult => ({ exitCode: 0, stdout: json(value), stderr: '' });
/** Returns a CLI result whose stdout is the raw string plus newline — no JSON wrapping. */
const rawString = (value: string): CliResult => ({ exitCode: 0, stdout: `${value}\n`, stderr: '' });
const emptySuccess = (): CliResult => ({ exitCode: 0, stdout: '', stderr: '' });
const storeCommands = new Set([
  ...taskStoreCommands,
  'overview',
  'pr',
  'start',
  'resume',
  'agent-hook',
  'pipeline',
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

type PullRequestFlagRule = { when: boolean; message: string };

const commentsRules = (
  url: boolean,
  open: boolean,
  commentsLike: boolean,
  resolved: boolean,
  all: boolean,
): PullRequestFlagRule[] => [
  { when: url && (open || commentsLike), message: '--url cannot be combined with other pr flags.' },
  {
    when: open && commentsLike,
    message: '--open cannot be combined with --comments / --resolved / --all.',
  },
  { when: (resolved || all) && !commentsLike, message: '--resolved and --all require --comments.' },
  { when: resolved && all, message: '--resolved and --all are mutually exclusive.' },
];

const syncRules = (
  sync: boolean,
  quiet: boolean,
  url: boolean,
  open: boolean,
  commentsLike: boolean,
): PullRequestFlagRule[] => [
  { when: quiet && !sync, message: '--quiet requires --sync.' },
  {
    when: sync && (url || open || commentsLike),
    message: '--sync cannot be combined with --url, --open, --comments, --resolved, or --all.',
  },
];

const pollRules = (
  poll: boolean,
  url: boolean,
  open: boolean,
  sync: boolean,
  quiet: boolean,
  commentsLike: boolean,
): PullRequestFlagRule[] => [
  {
    when: poll && (url || open || sync || quiet || commentsLike),
    message:
      '--poll cannot be combined with --url, --open, --sync, --quiet, --comments, --resolved, or --all.',
  },
];

const pullRequestFlagRules = (flags: ParsedArguments['flags']): PullRequestFlagRule[] => {
  const url = flags.has('url');
  const open = flags.has('open');
  const comments = flags.has('comments');
  const resolved = flags.has('resolved');
  const all = flags.has('all');
  const sync = flags.has('sync');
  const quiet = flags.has('quiet');
  const poll = flags.has('poll');
  const commentsLike = comments || resolved || all;
  return [
    ...commentsRules(url, open, commentsLike, resolved, all),
    ...syncRules(sync, quiet, url, open, commentsLike),
    ...pollRules(poll, url, open, sync, quiet, commentsLike),
  ];
};

const validatePullRequestFlags = (parsed: ParsedArguments): void => {
  for (const rule of pullRequestFlagRules(parsed.flags)) {
    if (rule.when) throw new ScrumlordError('pr_flag_conflict', rule.message);
  }
};

const parsePollInteger = (
  flags: ParsedArguments['flags'],
  name: string,
  defaultValue: number,
): number => {
  const raw = flags.get(name)?.[0];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ScrumlordError('pr_flag_conflict', `--${name} must be a positive integer.`);
  }
  return parsed;
};

const parsePollNumber = (
  flags: ParsedArguments['flags'],
  name: string,
  defaultValue: number,
): number => {
  const raw = flags.get(name)?.[0];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ScrumlordError('pr_flag_conflict', `--${name} must be a positive number.`);
  }
  return parsed;
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
  return success(await github.pullRequestPollStatus(root, pollOptions));
};

const runPullRequestBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  validatePullRequestFlags(parsed);
  if (parsed.flags.has('poll')) return runPullRequestPollCommand(parsed, options);
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  if (parsed.flags.has('url')) {
    const result = await github.pullRequestUrl(root, false);
    return rawString(result.url);
  }
  if (parsed.flags.has('open')) {
    return success(await github.pullRequestUrl(root, true));
  }
  if (parsed.flags.has('comments')) {
    if (parsed.flags.has('all')) return success(await github.allReviewComments(root));
    if (parsed.flags.has('resolved')) return success(await github.resolvedReviewComments(root));
    return success(await github.unresolvedReviewComments(root));
  }
  return success(await github.pullRequestStatus(root));
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

const isCleanupResult = (value: unknown): value is CleanupTasksResult =>
  typeof value === 'object' &&
  value !== null &&
  'mode' in value &&
  typeof (value as { mode: unknown }).mode === 'string' &&
  ['aged', 'orphans-only', 'aged-and-orphans', 'prompt'].includes((value as { mode: string }).mode);

const storeCommandResult = (parsed: ParsedArguments, value: unknown): CliResult => {
  if (parsed.command === 'next' && value === null) return emptySuccess();
  if (parsed.command === 'plan' && typeof value === 'string') return rawString(value);
  if (parsed.command === 'cleanup' && isCleanupResult(value)) return renderCleanupResult(value);
  return success(value);
};

const runOpenedStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  if (parsed.command === 'start') return await runStartCommand(store, parsed, options);
  if (parsed.command === 'resume') return await runResumeCommand(store, parsed, options);
  if (parsed.command === 'pipeline') return await runPipelineCommand(store, parsed, options);
  if (parsed.command === 'pr' && parsed.flags.has('sync')) {
    return await runPullRequestSyncCommand(store, parsed, options);
  }
  return storeCommandResult(parsed, await runStoreCommand(store, parsed, options));
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

/** Runs the tasks CLI and returns captured output for process wrappers and tests. */
export const runTasksCli = async (argv: string[], options: CliOptions = {}): Promise<CliResult> => {
  try {
    const parsed = parseArguments(argv);
    if (isHelpRequest(parsed)) return renderHelpResult(parsed, options);
    if (!parsed.command) throw new ScrumlordError('missing_command', 'A command is required.');
    validatePositionals(parsed);

    const boundaryResult = await runBoundaryCommand(parsed, options);
    if (boundaryResult) return boundaryResult;
    if (!storeCommands.has(parsed.command)) {
      const hint = removedCommandHints[parsed.command];
      const message = hint
        ? `Unknown command: ${parsed.command}. ${hint}`
        : `Unknown command: ${parsed.command}`;
      throw new ScrumlordError('unknown_command', message);
    }
    validateStoreCommandInput(parsed, options);

    const store = await openStore(options);
    try {
      return await runOpenedStoreCommand(store, parsed, options);
    } finally {
      store.close();
    }
  } catch (error) {
    const code = error instanceof ScrumlordError ? error.code : 'unexpected_error';
    return {
      exitCode: 1,
      stdout: '',
      stderr: json({ error: { code, message: errorMessage(error) } }),
    };
  }
};
