import { existsSync } from 'node:fs';
import {
  absoluteTaskPlanPath,
  buildSkillInvocation,
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
import { resolveTaskId } from './cli-task-id.js';
import { runCommand, type CommandRunner } from './command-runner.js';
import { ScrumlordError } from './errors.js';
import { currentGitBranch } from './git-status.js';
import type { CliOptions, CliResult } from './cli-types.js';
import type { AgentProvider, Task, TaskStore } from './types.js';
import { isReservedTaskBranch, parseAgentProvider } from './validation.js';
import {
  checkProviderCapabilities,
  deriveBranchAndShortId,
  ensureTaskWorktree,
  repoCommonDir,
  resolveBaseBranch,
  scrumlordWorktreePath,
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

const optionalProviderFromStartOptions = (
  options: StartProviderOptions,
): AgentProvider | undefined => {
  const provider = options.provider ?? environmentValue(options, 'SCRUMLORD_CLI');
  return provider ? parseAgentProvider(provider) : undefined;
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
    .filter((blocker) => blocker.status !== 'completed' && !blocker.deleted);
};

const assertTaskCanStart = (store: TaskStore, task: Task): void => {
  if (task.deleted) throw new ScrumlordError('task_deleted', `Task is deleted: ${task.id}`);
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
  const taskId = await resolveTaskId(store, required(parsed.positionals, 'task id'));
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
  created: 'created' | 'reused' | 'skipped';
};

const shortIdFromBranch = (branch: string, commonDir: string, taskId: string): string => {
  const match = /^tasks\/([0-9a-f]{8})$/.exec(branch);
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
  // The agent runs in projectRoot regardless, but a task must never be pinned to
  // an integration branch — fall back to the task's existing branch (often null).
  const resolved = task.branch ?? current;
  const branch = isReservedTaskBranch(resolved) ? (task.branch ?? null) : resolved;
  return { worktree: store.projectRoot, branch: branch ?? '', created: 'skipped' };
};

/**
 * Materializes (or reuses) a Scrumlord-managed worktree for the task, regardless
 * of provider. The agent is always launched in a dedicated worktree so the
 * shell wrapper can teleport into it after the session.
 */
const setupTaskWorktree = async (
  store: TaskStore,
  task: Task,
  options: PrepareTaskWorktreeOptions,
  runner: CommandRunner,
): Promise<WorktreeSetup> => {
  if (options.noWorktree) return noWorktreeSetup(store, task, options, runner);
  const common = await repoCommonDir(store.projectRoot, runner);
  const derived = task.branch
    ? { branch: task.branch, shortId: shortIdFromBranch(task.branch, common, task.id) }
    : deriveBranchAndShortId(common, task.id);
  const directory =
    options.worktreeDirectory ?? (await scrumlordWorktreePath(store.projectRoot, derived.shortId));
  const base = await resolveBaseBranch(store.projectRoot, runner);
  const worktreeLog = options.stderr
    ? (line: string): void => writeStderrLine(options, line)
    : undefined;
  const result = await ensureTaskWorktree(
    store.projectRoot,
    derived.branch,
    base,
    directory,
    runner,
    worktreeLog,
  );
  return {
    worktree: result.worktree,
    branch: derived.branch,
    created: result.created ? 'created' : 'reused',
  };
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

export type PrepareTaskWorktreeResult = {
  task: Task;
  worktree: string;
  branch: string;
  worktreeCreated: WorktreeSetup['created'];
  previousStatus: Task['status'];
  previousBranch: string | null;
};

export type PrepareTaskWorktreeOptions = TaskAgentCommandOptions & {
  /** When false, skips status/branch/provider/session persistence and only resolves the worktree. */
  persistClaim?: boolean;
  /**
   * When set, the worktree is placed at this exact path instead of computing
   * one via `scrumlordWorktreePath`. The `assertTmpFallbackIgnored` safety check
   * still applies (enforced inside `ensureTaskWorktree`), so a path under
   * `tmp/worktrees/` is only accepted when `.gitignore` covers `tmp/`.
   */
  worktreeDirectory?: string;
};

/**
 * Validates a task is startable, runs the provider capability precheck, materializes
 * (or reuses) the per-task worktree, and persists status/provider/session/branch.
 * Shared by `startTask` and the pipeline driver so both go through the same seam.
 */
export const prepareTaskWorktree = async (
  store: TaskStore,
  taskId: string,
  options: PrepareTaskWorktreeOptions = {},
): Promise<PrepareTaskWorktreeResult> => {
  const provider = providerFromStartOptions(options);
  const task = store.getTask(taskId);
  if (!task) throw new ScrumlordError('task_not_found', `Task not found: ${taskId}`);
  assertTaskCanStart(store, task);
  const runner = options.runner ?? runCommand;
  await checkProviderCapabilities(provider, runner, store.projectRoot);

  const previousStatus = task.status;
  const previousBranch = task.branch;
  const setup = await setupTaskWorktree(store, task, options, runner);

  if (options.persistClaim === false) {
    return {
      task,
      worktree: setup.worktree,
      branch: setup.branch,
      worktreeCreated: setup.created,
      previousStatus,
      previousBranch,
    };
  }

  const adapter = getAgentProvider(provider);
  const session = task.session ?? adapter.createSession();
  const updated = store.update(task.id, {
    status: 'in-progress',
    provider,
    session: session ?? task.session,
    branch: setup.branch,
  });

  emitStatusLine(options, updated, provider, setup);

  return {
    task: updated,
    worktree: setup.worktree,
    branch: setup.branch,
    worktreeCreated: setup.created,
    previousStatus,
    previousBranch,
  };
};

/**
 * Reattaches the recorded provider session for an in-progress task. Bypasses
 * startability checks and worktree (re)creation because the task is already
 * claimed; mutates no task state.
 */
const reattachTask = async (
  store: TaskStore,
  task: Task,
  options: TaskAgentCommandOptions,
): Promise<TaskAgentCommandResult> => {
  const session = await resolveTaskSession(
    store,
    task.id,
    options.environment ? { environment: options.environment } : {},
  );
  if (!session.provider || !session.session) {
    throw new ScrumlordError(
      'task_session_missing',
      `Task does not have a resumable provider session: ${task.id}`,
    );
  }
  const requested = optionalProviderFromStartOptions(options);
  if (requested && requested !== session.provider) {
    throw new ScrumlordError(
      'provider_mismatch',
      `Task ${task.id} was started with ${session.provider}; refusing to resume with ${requested}.`,
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

/**
 * Starts (or resumes) work on a task in an agent CLI. If the task is already
 * in-progress with a recorded provider+session, reattaches that session via the
 * provider's native resume command. Otherwise validates startability,
 * materializes the worktree, claims the task, and launches the provider with
 * task context.
 */
export const startTask = async (
  store: TaskStore,
  taskId: string,
  options: TaskAgentCommandOptions = {},
): Promise<TaskAgentCommandResult> => {
  const existing = store.getTask(taskId);
  if (existing && existing.status === 'in-progress' && existing.provider && existing.session) {
    return await reattachTask(store, existing, options);
  }

  const provider = providerFromStartOptions(options);
  const executablePath = providerExecutablePath(provider, options);
  const prepared = await prepareTaskWorktree(store, taskId, options);
  const { task: updated, worktree } = prepared;

  const storedPlan = updated.plan ?? defaultTaskPlanPath(updated.id);
  const planPath = absoluteTaskPlanPath(store.projectRoot, storedPlan);
  const planContents = await planContentsFor(planPath);
  const phase = await resolvePhase(updated, planPath);

  const invocation = withExecutablePath(
    buildTaskStartInvocation(provider, {
      task: updated,
      projectRoot: store.projectRoot,
      cwd: worktree,
      planPath,
      planContents,
      session: updated.session,
      phase,
    }),
    executablePath,
  );

  return { exitCode: await runAgentInvocation(invocation, options) };
};

/** Context passed to a workflow skill's `renderPrompt` function. */
export type WorkflowPromptContext = {
  store: TaskStore;
  parsed: ParsedArguments;
  options: CliOptions;
};

/** Configuration for a workflow skill dispatched via `runWorkflowCommand`. */
export type WorkflowCommandConfig = {
  skillName: string;
  /**
   * Pure function that renders the skill prompt from the resolved context.
   * Exported and tested in isolation so callers can verify prompt output
   * without spawning an agent process.
   */
  renderPrompt: (context: WorkflowPromptContext) => string;
};

/**
 * Dispatch helper for workflow skill commands (plan-review, committee-review,
 * address-pr, etc.). Behaviour depends on whether `--start` is present:
 *
 * - **Print mode** (no `--start`): calls `renderPrompt` and returns the
 *   rendered prompt as a raw string result. No provider resolution, no
 *   worktree materialisation, no agent spawn.
 *
 * - **Start mode** (`--start` present): resolves the provider via the same
 *   seam used by `startTask` (`--cli` flag / `SCRUMLORD_CLI` env), builds a
 *   `buildSkillInvocation`, runs it via the injected (or real) agent spawner,
 *   and returns the exit code.
 */
export const runWorkflowCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
  config: WorkflowCommandConfig,
): Promise<CliResult> => {
  const context: WorkflowPromptContext = { store, parsed, options };
  const prompt = config.renderPrompt(context);

  if (!parsed.flags.has('start')) {
    return { exitCode: 0, stdout: `${prompt}\n`, stderr: '' };
  }

  const provider = providerFromStartCommand(parsed, options);
  const adapter = getAgentProvider(provider);
  const executablePath = (options.which ?? Bun.which)(adapter.executable);
  if (!executablePath) {
    throw new ScrumlordError(
      'provider_cli_not_found',
      `Could not find ${adapter.executable} in PATH.`,
    );
  }

  const invocation = withExecutablePath(
    buildSkillInvocation(provider, {
      cwd: store.projectRoot,
      prompt,
    }),
    executablePath,
  );

  const exitCode = await runAgentInvocation(invocation, options);
  return { exitCode, stdout: '', stderr: '' };
};

/**
 * Renders the prompt for the `next` workflow skill. In print mode this is
 * called with the already-resolved next task so the prompt can reference the
 * task id and title; pass `null` when no task is available.
 */
export const renderNextPrompt = (taskId: string | null, taskTitle: string | null): string => {
  if (!taskId) return '';
  return `Run the \`next\` workflow skill for task ${taskId}${taskTitle ? ` — ${taskTitle}` : ''}.`;
};

/** Renders the prompt for the `plan` workflow skill (fan-out planning via --start). */
export const renderPlanWorkflowPrompt = (_context: WorkflowPromptContext): string =>
  'Run the `plan` workflow skill.';

/** Renders the prompt for the `resolve` workflow skill. */
export const renderResolvePrompt = (_context: WorkflowPromptContext): string =>
  'Run the `resolve` workflow skill.';

/** Renders the prompt for the `sync` workflow skill. */
export const renderSyncPrompt = (_context: WorkflowPromptContext): string =>
  'Run the `sync` workflow skill.';

/** Renders the prompt for the `audit` workflow skill. */
export const renderAuditPrompt = (_context: WorkflowPromptContext): string =>
  'Run the `audit` workflow skill.';

/** Renders the prompt for the `merge` workflow skill. */
export const renderMergePrompt = (_context: WorkflowPromptContext): string =>
  'Run the `merge` workflow skill.';

/** Renders the prompt for the `cleanup` workflow skill (triggered by --worktrees). */
export const renderCleanupWorkflowPrompt = (_context: WorkflowPromptContext): string =>
  'Run the `cleanup` workflow skill.';

/**
 * Handles the `next` command. In print mode (no `--start`), resolves the next
 * task read-only and emits the skill prompt seeded with its id and title; exits
 * 0 with no output when no task is available. In start mode, claims the task,
 * materializes a dedicated worktree at `tmp/worktrees/tasks/<task-id>`, and
 * launches the agent with the `next` skill prompt.
 */
export const runNextCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult> => {
  if (!parsed.flags.has('start')) {
    const task = store.next();
    if (!task) return { exitCode: 0, stdout: '', stderr: '' };
    const prompt = renderNextPrompt(task.id, task.title);
    return { exitCode: 0, stdout: `${prompt}\n`, stderr: '' };
  }

  const provider = providerFromStartCommand(parsed, options);
  const adapter = getAgentProvider(provider);
  const executablePath = (options.which ?? Bun.which)(adapter.executable);
  if (!executablePath) {
    throw new ScrumlordError(
      'provider_cli_not_found',
      `Could not find ${adapter.executable} in PATH.`,
    );
  }

  const task = store.next();
  if (!task) return { exitCode: 0, stdout: '', stderr: '' };

  // The default worktree path is already tmp/worktrees/tasks/<short-id>; no override needed.
  const prepared = await prepareTaskWorktree(store, task.id, {
    ...options,
    provider,
    persistClaim: true,
  });

  const prompt = renderNextPrompt(prepared.task.id, prepared.task.title);

  const invocation = withExecutablePath(
    buildSkillInvocation(provider, {
      cwd: prepared.worktree,
      prompt,
    }),
    executablePath,
  );

  const exitCode = await runAgentInvocation(invocation, options);
  return { exitCode, stdout: '', stderr: '' };
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
