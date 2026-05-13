import { existsSync } from 'node:fs';
import {
  absoluteTaskPlanPath,
  buildTaskResumeInvocation,
  buildTaskStartInvocation,
  defaultTaskPlanPath,
  getAgentProvider,
  resolveTaskSession,
  type AgentInvocation,
  type TaskPhase,
} from './agent-providers.js';
import { runAgentHook } from './agent-hook.js';
import { flag, required, type ParsedArguments } from './cli-arguments.js';
import { taskIdFromArguments } from './cli-task-id.js';
import { runCommand, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import { currentGitBranch, worktreeForBranch } from './git-status.js';
import type { CliOptions, CliResult } from './cli-types.js';
import type { AgentProvider, Task, TaskStore } from './types.js';
import { parseAgentProvider } from './validation.js';
import {
  checkProviderCapabilities,
  codexWorktreePath,
  deriveBranchAndShortId,
  ensureCodexWorktree,
  repoCommonDir,
  repoSlug,
  resolveBaseBranch,
} from './worktree.js';

export type TaskAgentCommandOptions = {
  provider?: AgentProvider;
  environment?: Record<string, string | undefined>;
  runAgentInvocation?: (invocation: AgentInvocation) => Promise<number>;
  which?: (executable: string) => string | null;
  noWorktree?: boolean;
  force?: boolean;
  quiet?: boolean;
  stderr?: (line: string) => void;
  runner?: CommandRunner;
};

export type TaskAgentCommandResult = {
  exitCode: number;
};

const environmentValue = (
  options: Pick<TaskAgentCommandOptions, 'environment'>,
  name: string,
): string | undefined => {
  return options.environment?.[name] ?? Bun.env[name];
};

type StartProviderOptions = Omit<TaskAgentCommandOptions, 'provider'> & {
  provider?: string;
};

const providerFromStartOptions = (options: StartProviderOptions): AgentProvider => {
  const provider = options.provider ?? environmentValue(options, 'SCRUMLORD_CLI');
  if (!provider) {
    throw new ScrumlordError(
      'scrumlord_cli_required',
      'tasks start requires --cli or SCRUMLORD_CLI.',
    );
  }
  return parseAgentProvider(provider);
};

export const providerFromStartCommand = (
  parsed: ParsedArguments,
  options: CliOptions,
): AgentProvider => {
  const provider = flag(parsed.flags, 'cli');
  return providerFromStartOptions(provider ? { ...options, provider } : options);
};

const providerExecutablePath = (
  provider: AgentProvider,
  options: TaskAgentCommandOptions,
): string => {
  const adapter = getAgentProvider(provider);
  const path = (options.which ?? Bun.which)(adapter.executable);
  if (!path) {
    throw new ScrumlordError(
      'provider_cli_not_found',
      `Could not find ${adapter.executable} in PATH.`,
    );
  }
  return path;
};

const withExecutablePath = (
  invocation: AgentInvocation,
  executablePath: string,
): AgentInvocation => {
  return { ...invocation, command: [executablePath, ...invocation.command.slice(1)] };
};

const runAgentInvocation = async (
  invocation: AgentInvocation,
  options: TaskAgentCommandOptions,
): Promise<number> => {
  if (options.runAgentInvocation) return await options.runAgentInvocation(invocation);
  const subprocess = Bun.spawn(invocation.command, {
    cwd: invocation.cwd,
    env: { ...Bun.env, ...options.environment, ...invocation.environment },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await subprocess.exited;
};

const incompleteBlockers = (store: TaskStore, task: Task): Task[] => {
  return store
    .blockedBy(task.id)
    .filter((blocker) => blocker.status !== 'completed' && !blocker.deleted && !blocker.archived);
};

const assertTaskCanStart = (store: TaskStore, task: Task): void => {
  if (task.deleted) throw new ScrumlordError('task_deleted', `Task is deleted: ${task.id}`);
  if (task.archived) throw new ScrumlordError('task_archived', `Task is archived: ${task.id}`);
  if (task.status === 'completed') {
    throw new ScrumlordError('task_completed', `Task is already completed: ${task.id}`);
  }
  if (task.startDate && task.startDate > new Date().toISOString()) {
    throw new ScrumlordError('task_not_started', `Task has a future start date: ${task.id}`);
  }
  const blockers = incompleteBlockers(store, task);
  if (blockers.length > 0) {
    throw new ScrumlordError(
      'task_blocked',
      `Task is blocked by incomplete tasks: ${blockers.map((blocker) => blocker.id).join(', ')}`,
    );
  }
};

const planContentsFor = async (planPath: string | null): Promise<string | null> => {
  if (!planPath) return null;
  try {
    if (!existsSync(planPath)) return null;
    return await Bun.file(planPath).text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScrumlordError('plan_unreadable', `Could not read task plan ${planPath}: ${message}`);
  }
};

const currentBranchOrNull = async (
  projectRoot: string,
  runner: CommandRunner = runCommand,
): Promise<string | null> => {
  try {
    return await currentGitBranch(projectRoot, runner);
  } catch {
    return null;
  }
};

export const runStartCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const taskId = await taskIdFromArguments(store, parsed);
  const result = await startTask(store, taskId, {
    ...options,
    provider: providerFromStartCommand(parsed, options),
    noWorktree: parsed.flags.has('no-worktree'),
    force: parsed.flags.has('force'),
    quiet: parsed.flags.has('quiet'),
  });
  return { exitCode: result.exitCode, stdout: '', stderr: '' };
};

const writeStderrLine = (options: TaskAgentCommandOptions, line: string): void => {
  if (options.stderr) options.stderr(line);
  else process.stderr.write(`${line}\n`);
};

/**
 * Resolves the task `phase` from observable state:
 *  - `start` when the current status is not in-progress.
 *  - `resume-planning` when a resumed task has no non-empty plan.
 *  - `resume-implementation` when a resumed task has a non-empty plan.
 */
const resolvePhase = async (task: Task, planPath: string | null): Promise<TaskPhase> => {
  if (task.status !== 'in-progress') return 'start';
  if (!planPath || !existsSync(planPath)) return 'resume-planning';
  const size = Bun.file(planPath).size;
  return size > 0 ? 'resume-implementation' : 'resume-planning';
};

type WorktreeSetup = {
  worktree: string;
  branch: string;
  created: 'created' | 'reused' | 'claude-managed' | 'skipped';
};

const setupClaudeWorktree = async (
  store: TaskStore,
  task: Task,
  options: TaskAgentCommandOptions,
  runner: CommandRunner,
): Promise<WorktreeSetup> => {
  if (options.noWorktree) return noWorktreeSetup(store, task, options, runner);
  const common = await repoCommonDir(store.projectRoot, runner).catch(() => store.projectRoot);
  const { branch } = task.branch
    ? { branch: task.branch }
    : deriveBranchAndShortId(common, task.id);
  const existing = task.branch
    ? await worktreeForBranch(store.projectRoot, task.branch, runner)
    : store.projectRoot;
  const worktree = existing === store.projectRoot ? store.projectRoot : existing;
  return { worktree, branch, created: 'claude-managed' };
};

const setupCodexWorktree = async (
  store: TaskStore,
  task: Task,
  options: TaskAgentCommandOptions,
  runner: CommandRunner,
): Promise<WorktreeSetup> => {
  if (options.noWorktree) return noWorktreeSetup(store, task, options, runner);
  const common = await repoCommonDir(store.projectRoot, runner);
  const derived = task.branch
    ? { branch: task.branch, shortId: shortIdFromBranch(task.branch, common, task.id) }
    : deriveBranchAndShortId(common, task.id);
  const slug = repoSlug(store.projectRoot);
  const directory = await codexWorktreePath(store.projectRoot, slug, derived.shortId);
  const base = await resolveBaseBranch(store.projectRoot, runner);
  const result = await ensureCodexWorktree(
    store.projectRoot,
    derived.branch,
    base,
    directory,
    runner,
  );
  return {
    worktree: result.worktree,
    branch: derived.branch,
    created: result.created ? 'created' : 'reused',
  };
};

const shortIdFromBranch = (branch: string, commonDir: string, taskId: string): string => {
  const match = /^task\/([0-9a-f]{8})$/.exec(branch);
  if (match) return match[1]!;
  return deriveBranchAndShortId(commonDir, taskId).shortId;
};

const noWorktreeSetup = async (
  store: TaskStore,
  task: Task,
  options: TaskAgentCommandOptions,
  runner: CommandRunner,
): Promise<WorktreeSetup> => {
  const current = (await currentBranchOrNull(store.projectRoot, runner)) ?? task.branch ?? 'HEAD';
  const base = await resolveBaseBranch(store.projectRoot, runner).catch(() => null);
  if (base && current === base.name && !options.force) {
    throw new ScrumlordError(
      'refuse_no_worktree_on_base_branch',
      `Refusing to run on base branch ${current} with --no-worktree. Pass --force to override.`,
    );
  }
  writeStderrLine(
    options,
    `⚠ --no-worktree: agent will run on the current branch (${current}). Not recommended.`,
  );
  return { worktree: store.projectRoot, branch: task.branch ?? current, created: 'skipped' };
};

const setupWorktree = (
  provider: AgentProvider,
  store: TaskStore,
  task: Task,
  options: TaskAgentCommandOptions,
  runner: CommandRunner,
): Promise<WorktreeSetup> => {
  if (provider === 'claude') return setupClaudeWorktree(store, task, options, runner);
  return setupCodexWorktree(store, task, options, runner);
};

const emitStatusLine = (
  options: TaskAgentCommandOptions,
  task: Task,
  provider: AgentProvider,
  setup: WorktreeSetup,
): void => {
  if (options.quiet) return;
  writeStderrLine(
    options,
    `▶ task ${task.id}: branch ${setup.branch}, worktree ${setup.worktree} [${setup.created}], provider ${provider}`,
  );
};

const verifyClaudeWorktreeAfterSession = async (
  store: TaskStore,
  branch: string,
  exitCode: number,
  previous: { status: Task['status']; branch: string | null },
  taskId: string,
  options: TaskAgentCommandOptions,
  runner: CommandRunner,
): Promise<void> => {
  const worktree = await worktreeForBranch(store.projectRoot, branch, runner);
  if (worktree !== store.projectRoot) return;
  if (exitCode === 0) {
    writeStderrLine(
      options,
      `⚠ Claude session ended but no worktree exists for branch ${branch}; task left in-progress.`,
    );
    return;
  }
  store.update(taskId, { status: previous.status, branch: previous.branch });
  writeStderrLine(
    options,
    `↩ Claude session failed and no worktree was created; reverted task ${taskId} to ${previous.status}.`,
  );
};

/** Starts a task in an agent CLI and updates task status, session, and branch metadata. */
export const startTask = async (
  store: TaskStore,
  taskId: string,
  options: TaskAgentCommandOptions = {},
): Promise<TaskAgentCommandResult> => {
  const provider = providerFromStartOptions(options);
  const executablePath = providerExecutablePath(provider, options);
  const task = store.getTask(taskId);
  if (!task) throw new ScrumlordError('task_not_found', `Task not found: ${taskId}`);
  assertTaskCanStart(store, task);
  const runner = options.runner ?? runCommand;
  await checkProviderCapabilities(provider, runner, store.projectRoot);

  const previous = { status: task.status, branch: task.branch };
  const setup = await setupWorktree(provider, store, task, options, runner);
  const adapter = getAgentProvider(provider);
  const session = adapter.createSession();
  const updated = store.update(task.id, {
    status: 'in-progress',
    provider,
    session: session ?? task.session,
    branch: setup.branch,
  });

  const storedPlan = updated.plan ?? defaultTaskPlanPath(updated.id);
  const planPath = absoluteTaskPlanPath(store.projectRoot, storedPlan);
  const planContents = await planContentsFor(planPath);
  const phase = await resolvePhase(task, planPath);

  emitStatusLine(options, updated, provider, setup);

  const invocation = withExecutablePath(
    buildTaskStartInvocation(provider, {
      task: updated,
      projectRoot: store.projectRoot,
      cwd: setup.worktree,
      planPath,
      planContents,
      session: session ?? updated.session,
      phase,
    }),
    executablePath,
  );

  const exitCode = await runAgentInvocation(invocation, options);
  if (provider === 'claude' && setup.created === 'claude-managed') {
    await verifyClaudeWorktreeAfterSession(
      store,
      setup.branch,
      exitCode,
      previous,
      updated.id,
      options,
      runner,
    );
  }
  return { exitCode };
};

export const runResumeCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const taskId = await taskIdFromArguments(store, parsed);
  const result = await resumeTask(store, taskId, options);
  return { exitCode: result.exitCode, stdout: '', stderr: '' };
};

/** Resumes the recorded provider session for a task. */
export const resumeTask = async (
  store: TaskStore,
  taskId: string,
  options: TaskAgentCommandOptions = {},
): Promise<TaskAgentCommandResult> => {
  const session = await resolveTaskSession(
    store,
    taskId,
    options.environment ? { environment: options.environment } : {},
  );
  if (!session.provider || !session.session) {
    throw new ScrumlordError(
      'task_session_missing',
      `Task does not have a resumable provider session: ${taskId}`,
    );
  }
  const executablePath = providerExecutablePath(session.provider, options);
  const cwd = session.worktree ?? store.projectRoot;
  const invocation = withExecutablePath(
    buildTaskResumeInvocation(session.provider, { cwd, session: session.session }),
    executablePath,
  );
  return { exitCode: await runAgentInvocation(invocation, options) };
};

export const runAgentHookCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  const input = await (options.readStdin?.() ?? Bun.stdin.text());
  const result = await runAgentHook(
    store,
    parseAgentProvider(required(parsed.positionals, 'provider')),
    input,
    options.environment ? { environment: options.environment } : {},
  );
  return { exitCode: 0, stdout: result.context ?? '', stderr: '' };
};
