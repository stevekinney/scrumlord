import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, resolve } from 'node:path';
import type { CommandRunner } from './command-runner.js';
import { runCommand } from './command-runner.js';
import { worktreeForBranch } from './git-status.js';
import type { AgentProvider, Task, TaskSession, TaskStore } from './types.js';
import { agentProviderNames } from './types.js';
import { parseAgentProvider } from './validation.js';

export const agentProviders = agentProviderNames;

export type AgentInvocation = {
  command: string[];
  cwd: string;
  environment: Record<string, string>;
};

export type AgentCliProvider = {
  id: AgentProvider;
  executable: string;
  createSession(): string | null;
  buildStartInvocation(context: AgentStartInvocationContext): AgentInvocation;
  buildResumeInvocation(context: AgentResumeInvocationContext): AgentInvocation;
  buildSetupInvocation(context: AgentSetupInvocationContext): AgentInvocation;
  sessionSearchRoots(options?: AgentSessionPathOptions): string[];
};

export type AgentSessionPathOptions = {
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
};

export type AgentStartInvocationContext = {
  task: Task;
  projectRoot: string;
  cwd: string;
  planPath: string | null;
  planContents: string | null;
  session: string | null;
};

export type AgentResumeInvocationContext = {
  cwd: string;
  session: string;
};

export type AgentSetupInvocationContext = {
  projectRoot: string;
  setup: unknown;
};

export type ResolveTaskSessionOptions = AgentSessionPathOptions & {
  runner?: CommandRunner;
};

const providerSystemPrompt =
  'You are working on a Scrumlord task. Use the tasks CLI for task state. If you do not already know the task ID, run tasks current-task before falling back to tasks next. Commands whose first positional argument is a task ID can omit it when exactly one active task is assigned to the current Git branch. Read any existing plan before implementation. If you create or replace a plan, write it to the task plan path and update the task plan field with tasks set-plan [task-id] <path>. Record meaningful task progress with tasks add-progress [task-id] --message <note> after planning, major implementation steps, blockers, and handoffs; recording progress moves draft or ready tasks to in-progress. Record the branch with tasks set-branch [task-id] <branch> when work starts; setting a branch moves draft or ready tasks to in-progress. Run tasks sync-git-status when GitHub might already know about the pull request, and mark tasks completed after the pull request merges into origin/main.';

const planInstructions = [
  'Start in plan mode.',
  'Do not edit files until the plan is ready and the user exits plan mode.',
  'If task.plan is set, read that file before planning.',
  'If you generate a plan, write it to planPath and run tasks set-plan [task-id] <path>.',
  'After the plan is saved, run tasks add-progress [task-id] --message <note> to record the planning result.',
].join(' ');

const buildTaskPrompt = (context: AgentStartInvocationContext): string => {
  const payload = {
    task: context.task,
    projectRoot: context.projectRoot,
    worktree: context.cwd,
    planPath: context.planPath,
    existingPlan: context.planContents,
  };
  return [
    planInstructions,
    '',
    'Task context:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
};

const buildSetupPrompt = (context: AgentSetupInvocationContext): string => {
  return [
    'Scrumlord setup has just completed for this project.',
    '',
    'Inspect the setup state with `tasks setup status` before making changes.',
    'Use the `tasks` CLI for all task graph changes. Never edit `tmp/tasks.db` directly.',
    'If you break down documents or checklists into work, first run `tasks list` to avoid duplicates, then use `tasks create` and `tasks add-blocker` to build the graph.',
    '',
    'Setup context:',
    '```json',
    JSON.stringify(context.setup, null, 2),
    '```',
  ].join('\n');
};

const withEnvironment = (command: string[], cwd: string): AgentInvocation => ({
  command,
  cwd,
  environment: {},
});

const claudeProvider: AgentCliProvider = {
  id: 'claude',
  executable: 'claude',
  createSession: () => crypto.randomUUID(),
  buildStartInvocation(context) {
    const command = [
      'claude',
      '--permission-mode',
      'plan',
      '--append-system-prompt',
      providerSystemPrompt,
    ];
    if (context.session) command.push('--session-id', context.session);
    command.push(buildTaskPrompt(context));
    return withEnvironment(command, context.cwd);
  },
  buildResumeInvocation(context) {
    return withEnvironment(['claude', '--resume', context.session], context.cwd);
  },
  buildSetupInvocation(context) {
    return withEnvironment(['claude', buildSetupPrompt(context)], context.projectRoot);
  },
  sessionSearchRoots(options = {}) {
    const home = options.homeDirectory ?? homedir();
    const root = options.environment?.['CLAUDE_CONFIG_DIR'] ?? join(home, '.claude');
    return [join(root, 'projects')];
  },
};

const codexProvider: AgentCliProvider = {
  id: 'codex',
  executable: 'codex',
  createSession: () => null,
  buildStartInvocation(context) {
    const prompt = `/plan ${providerSystemPrompt}\n\n${buildTaskPrompt(context)}`;
    return withEnvironment(['codex', '--cd', context.cwd, prompt], context.cwd);
  },
  buildResumeInvocation(context) {
    return withEnvironment(['codex', 'resume', '--cd', context.cwd, context.session], context.cwd);
  },
  buildSetupInvocation(context) {
    return withEnvironment(
      ['codex', '--cd', context.projectRoot, buildSetupPrompt(context)],
      context.projectRoot,
    );
  },
  sessionSearchRoots(options = {}) {
    const home = options.homeDirectory ?? homedir();
    const root = options.environment?.['CODEX_HOME'] ?? join(home, '.codex');
    return [join(root, 'sessions')];
  },
};

const providers = new Map<AgentProvider, AgentCliProvider>([
  [claudeProvider.id, claudeProvider],
  [codexProvider.id, codexProvider],
]);

/** Returns the provider adapter for a supported agent CLI. */
export const getAgentProvider = (provider: AgentProvider): AgentCliProvider => {
  const parsed = parseAgentProvider(provider);
  return providers.get(parsed)!;
};

/** Returns the default project-relative plan file path for a task. */
export const defaultTaskPlanPath = (taskId: string): string => {
  return normalize(join('tmp', 'tasks', taskId, 'PLAN.md'));
};

/** Resolves a stored task plan path to an absolute filesystem path. */
export const absoluteTaskPlanPath = (projectRoot: string, plan: string | null): string | null => {
  if (!plan) return null;
  return isAbsolute(plan) ? normalize(plan) : resolve(projectRoot, plan);
};

const matchingSessionFile = async (root: string, session: string): Promise<string | null> => {
  if (!existsSync(root)) return null;
  const glob = new Bun.Glob('**/*.jsonl');
  const candidates: string[] = [];

  for await (const path of glob.scan({ cwd: root, absolute: true })) {
    candidates.push(path);
    if (basename(path).includes(session)) return path;
  }

  for (const path of candidates) {
    try {
      const contents = await Bun.file(path).text();
      if (contents.includes(session)) return path;
    } catch {
      continue;
    }
  }

  return null;
};

const findSessionPath = async (
  provider: AgentCliProvider,
  session: string,
  options: AgentSessionPathOptions,
): Promise<string | null> => {
  for (const root of provider.sessionSearchRoots(options)) {
    const path = await matchingSessionFile(root, session);
    if (path) return path;
  }
  return null;
};

/** Builds a provider-specific start command for a Scrumlord task. */
export const buildTaskStartInvocation = (
  provider: AgentProvider,
  context: AgentStartInvocationContext,
): AgentInvocation => {
  return getAgentProvider(provider).buildStartInvocation(context);
};

/** Builds a provider-specific resume command for a Scrumlord task session. */
export const buildTaskResumeInvocation = (
  provider: AgentProvider,
  context: AgentResumeInvocationContext,
): AgentInvocation => {
  return getAgentProvider(provider).buildResumeInvocation(context);
};

/** Builds a provider-specific command for setup follow-up work. */
export const buildSetupInvocation = (
  provider: AgentProvider,
  context: AgentSetupInvocationContext,
): AgentInvocation => {
  return getAgentProvider(provider).buildSetupInvocation(context);
};

/** Resolves persisted session metadata with derived worktree and local session file paths. */
export const resolveTaskSession = async (
  store: TaskStore,
  taskId: string,
  options: ResolveTaskSessionOptions = {},
): Promise<TaskSession> => {
  const session = store.taskSession(taskId);
  const warnings: string[] = [];
  const worktree = session.branch
    ? await worktreeForBranch(store.projectRoot, session.branch, options.runner ?? runCommand)
    : null;
  const planPath = absoluteTaskPlanPath(store.projectRoot, session.plan);
  let sessionPath: string | null = null;

  if (!session.provider) {
    warnings.push('provider_missing');
  } else if (!session.session) {
    warnings.push('session_missing');
  } else {
    sessionPath = await findSessionPath(
      getAgentProvider(session.provider),
      session.session,
      options,
    );
    if (!sessionPath) warnings.push('session_path_not_found');
  }

  return {
    ...session,
    worktree,
    planPath,
    sessionPath,
    warnings,
  };
};
