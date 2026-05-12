import { existsSync } from 'node:fs';
import {
  absoluteTaskPlanPath,
  buildTaskResumeInvocation,
  buildTaskStartInvocation,
  defaultTaskPlanPath,
  getAgentProvider,
  resolveTaskSession,
  type AgentInvocation,
} from './agent-providers.js';
import { runAgentHook } from './agent-hook.js';
import { flag, required, type ParsedArguments } from './cli-arguments.js';
import { taskIdFromArguments } from './cli-task-id.js';
import { runCommand } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import { currentGitBranch, worktreeForBranch } from './git-status.js';
import type { CliOptions, CliResult } from './cli-types.js';
import type { AgentProvider, Task, TaskStore } from './types.js';
import { parseAgentProvider } from './validation.js';

export type TaskAgentCommandOptions = {
  provider?: AgentProvider;
  environment?: Record<string, string | undefined>;
  runAgentInvocation?: (invocation: AgentInvocation) => Promise<number>;
  which?: (executable: string) => string | null;
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

const currentBranchOrNull = async (projectRoot: string): Promise<string | null> => {
  try {
    return await currentGitBranch(projectRoot, runCommand);
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
  });
  return { exitCode: result.exitCode, stdout: '', stderr: '' };
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

  const adapter = getAgentProvider(provider);
  const session = adapter.createSession();
  const branch = task.branch ?? (await currentBranchOrNull(store.projectRoot));
  const updated = store.update(task.id, {
    status: 'in-progress',
    provider,
    session: session ?? task.session,
    branch,
  });
  const worktree = updated.branch
    ? await worktreeForBranch(store.projectRoot, updated.branch, runCommand)
    : store.projectRoot;
  const storedPlan = updated.plan ?? defaultTaskPlanPath(updated.id);
  const planPath = absoluteTaskPlanPath(store.projectRoot, storedPlan);
  const planContents = await planContentsFor(planPath);
  const invocation = withExecutablePath(
    buildTaskStartInvocation(provider, {
      task: updated,
      projectRoot: store.projectRoot,
      cwd: worktree,
      planPath,
      planContents,
      session: session ?? updated.session,
    }),
    executablePath,
  );

  return { exitCode: await runAgentInvocation(invocation, options) };
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
