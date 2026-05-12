import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setupAgentHooks } from './agent-hooks.js';
import { runAgentHookCommand, runResumeCommand, runStartCommand } from './cli-agent-commands.js';
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
const emptySuccess = (): CliResult => ({ exitCode: 0, stdout: '', stderr: '' });
const storeCommands = new Set([
  ...taskStoreCommands,
  'overview',
  'sync-git-status',
  'start',
  'resume',
  'agent-hook',
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

  return await runTaskStoreCommand(store, parsed);
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

const runPullRequestBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  const subcommand = parsed.positionals[0];
  if (subcommand === 'status') return success(await github.pullRequestStatus(root));
  if (subcommand) {
    throw new ScrumlordError('unknown_command', `Unknown pull request command: pr ${subcommand}.`);
  }
  return success(await github.pullRequestUrl(root, parsed.flags.has('open')));
};

const runRepositoryBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  return success(
    parsed.flags.has('url') ? await github.repositoryUrl(root) : await github.repositoryName(root),
  );
};

const runCommentsBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  return success(await github.unresolvedReviewComments(root));
};

const runContinuousIntegrationBoundaryCommand: BoundaryCommandHandler = async (
  _parsed,
  options,
) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  return success(await github.continuousIntegrationStatus(root));
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

const runAgentHookBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  let root: string;
  try {
    root = await resolveProjectRoot(options.cwd);
  } catch {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (!existsSync(join(root, 'tmp', 'tasks.db'))) return { exitCode: 0, stdout: '', stderr: '' };

  const store = await openStore({ ...options, cwd: root });
  try {
    return await runAgentHookCommand(store, parsed, options);
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
  comments: runCommentsBoundaryCommand,
  ci: runContinuousIntegrationBoundaryCommand,
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
