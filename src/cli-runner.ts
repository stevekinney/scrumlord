import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupAgentHooks } from './agent-hooks.js';
import { runAgentHookCommand, runResumeCommand, runStartCommand } from './cli-agent-commands.js';
import { runPipelineCommand } from './cli-pipeline-command.js';
import {
  helpPath,
  isHelpRequest,
  parseArguments,
  required,
  validatePositionals,
  type ParsedArguments,
} from './cli-arguments.js';
import { runSetupBoundaryCommand, runSetupSubagentsBoundaryCommand } from './cli-setup-commands.js';
import {
  runTaskStoreCommand,
  taskStoreCommands,
  validateStoreCommandInput,
} from './cli-store-commands.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { createTaskStore } from './database-open.js';
import { ScrumlordError, errorMessage } from './errors.js';
import { setupGitHooks } from './git-hooks.js';
import { syncGitStatus } from './git-status.js';
import { renderHelp } from './help.js';
import { initializeProject } from './init.js';
import { resolveProjectRoot } from './root-resolution.js';
import { setupSkills, skillTargets, type SkillTarget } from './skills.js';
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
  'sync-git-status',
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

const isSkillTarget = (target: string): target is SkillTarget =>
  skillTargets.some((value) => value === target);

const runStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<unknown> => {
  if (parsed.command === 'sync-git-status') {
    return await (options.syncGitStatus ?? syncGitStatus)(store);
  }

  if (parsed.command === 'overview') {
    const github = await githubModule(options);
    return await github.tasksOverview(store);
  }

  return await runTaskStoreCommand(store, parsed, options);
};

const normalizeSkillTarget = (parsed: ParsedArguments): SkillTarget | '--all' => {
  const requestedTarget = parsed.flags.has('all')
    ? '--all'
    : required(parsed.positionals, 'skill target');
  if (requestedTarget === '-all' || requestedTarget === '--all') return '--all';
  if (isSkillTarget(requestedTarget)) return requestedTarget;
  throw new ScrumlordError(
    'invalid_skill_target',
    'Skill target must be codex, claude, cursor, or --all.',
  );
};

const githubModule = async (options: CliOptions): Promise<NonNullable<CliOptions['github']>> => {
  if (options.github) return options.github;
  const [github, overview] = await Promise.all([
    import('./github.js'),
    import('./tasks-overview.js'),
  ]);
  return { ...github, tasksOverview: overview.tasksOverview };
};

type PullRequestFlagRule = { when: boolean; message: string };

const pullRequestFlagRules = (flags: ParsedArguments['flags']): PullRequestFlagRule[] => {
  const url = flags.has('url');
  const open = flags.has('open');
  const comments = flags.has('comments');
  const resolved = flags.has('resolved');
  const all = flags.has('all');
  const commentsLike = comments || resolved || all;
  return [
    {
      when: url && (open || commentsLike),
      message: '--url cannot be combined with other pr flags.',
    },
    {
      when: open && commentsLike,
      message: '--open cannot be combined with --comments / --resolved / --all.',
    },
    { when: (resolved || all) && !comments, message: '--resolved and --all require --comments.' },
    { when: resolved && all, message: '--resolved and --all are mutually exclusive.' },
  ];
};

const validatePullRequestFlags = (parsed: ParsedArguments): void => {
  for (const rule of pullRequestFlagRules(parsed.flags)) {
    if (rule.when) throw new ScrumlordError('pr_flag_conflict', rule.message);
  }
};

const runPullRequestBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  validatePullRequestFlags(parsed);
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

const runSetupSkillsBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const root = await resolveProjectRoot(options.cwd);
  return success(await setupSkills(root, normalizeSkillTarget(parsed)));
};

const runSetupGitHooksBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const root = await resolveProjectRoot(options.cwd);
  return success(await (options.setupGitHooks ?? setupGitHooks)(root));
};

const runSetupAgentHooksBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const root = await resolveProjectRoot(options.cwd);
  const hookOptions =
    options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory };
  return success(await (options.setupAgentHooks ?? setupAgentHooks)(root, hookOptions));
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
  'setup-skills': runSetupSkillsBoundaryCommand,
  setup: runSetupBoundaryCommand,
  'setup-subagents': runSetupSubagentsBoundaryCommand,
  'setup-git-hooks': runSetupGitHooksBoundaryCommand,
  'setup-agent-hooks': runSetupAgentHooksBoundaryCommand,
  'agent-hook': runAgentHookBoundaryCommand,
};

const runBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult | undefined> => {
  const handler = parsed.command ? boundaryCommandHandlers[parsed.command] : undefined;
  return handler ? await handler(parsed, options) : undefined;
};

const openStore = async (options: CliOptions): Promise<TaskStore> => {
  if (options.createStore) return await options.createStore(options.cwd ?? process.cwd());
  return await createTaskStore(options.cwd === undefined ? {} : { cwd: options.cwd });
};

const storeCommandResult = (parsed: ParsedArguments, value: unknown): CliResult => {
  if (parsed.command === 'next' && value === null) return emptySuccess();
  if (parsed.command === 'sync-git-status' && parsed.flags.has('quiet')) return emptySuccess();
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
  return storeCommandResult(parsed, await runStoreCommand(store, parsed, options));
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
      throw new ScrumlordError('unknown_command', `Unknown command: ${parsed.command}`);
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
