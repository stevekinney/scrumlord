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
  /**
   * Optional prompt body to write to the agent's stdin. When present, the
   * spawner pipes this string into the process and closes stdin. Used by
   * the pipeline to keep large prompts out of argv (where they would hit
   * argv-length limits on Linux and leak into `ps` output).
   */
  stdin?: string;
};

export type AgentCliProvider = {
  id: AgentProvider;
  executable: string;
  createSession(): string | null;
  buildStartInvocation(context: TaskPromptContext): AgentInvocation;
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

export const taskPhases = ['start', 'resume-planning', 'resume-implementation'] as const;
export type TaskPhase = (typeof taskPhases)[number];

const providerSystemPrompt = [
  'You are working on a Scrumlord task in a per-task git worktree. The branch is checked out; do not create new worktrees or branches.',
  'The workflow has four phases: plan, implement, committee-review, address-pr.',
  '1. Plan in plan mode. Write the plan to the task plan path and run `tasks update [task-id] --plan <path>`. Before exiting plan mode, invoke the `plan-review` skill and drive it to approval.',
  '2. Implement against the approved plan. Record progress at major checkpoints with `tasks progress add [task-id] --message <note>`. Keep the plan file accurate if scope shifts.',
  '3. Open the pull request via the `committee-review` skill. Do not run `gh pr create` yourself; the skill handles the approval marker and the push.',
  '4. Drive the pull request to merge via the `address-pr` skill. Do not stop until the pull request is merged.',
  'Use the tasks CLI for task state. If you do not already know the task ID, run `tasks current` before falling back to `tasks next`. Commands whose first positional argument is a task ID can omit it when exactly one active task is assigned to the current Git branch.',
  'Record the branch with `tasks update [task-id] --branch <branch>` if it is not already recorded. Run `tasks pr --sync` when GitHub may already know about the pull request, and mark tasks completed after the pull request merges into the base branch.',
].join(' ');

const planInstructionsByPhase: Record<TaskPhase, string> = {
  start: [
    'Start in plan mode.',
    'Do not edit files until the plan is ready, the `plan-review` skill has approved it, and you exit plan mode.',
    'If task.plan is set, read that file before planning.',
    'If you generate or replace a plan, write it to planPath and run `tasks update [task-id] --plan <path>`.',
    'After the plan is saved, run `tasks progress add [task-id] --message <note>` to record the planning result.',
  ].join(' '),
  'resume-planning': [
    'Resume planning for this task.',
    'No plan exists yet; start in plan mode, draft the plan, and gate exit on the `plan-review` skill.',
    'Write the plan to planPath and run `tasks update [task-id] --plan <path>` before exiting plan mode.',
  ].join(' '),
  'resume-implementation': [
    'Resume implementation for this task. A plan already exists at planPath.',
    'Do not re-plan. Read the existing plan, check `tasks progress list [task-id]` for prior checkpoints, and continue from where the previous session left off.',
    'Record progress at major checkpoints with `tasks progress add [task-id] --message <note>`.',
  ].join(' '),
};

export type TaskPromptContext = AgentStartInvocationContext & { phase: TaskPhase };

const buildTaskPrompt = (context: TaskPromptContext): string => {
  const payload = {
    task: context.task,
    projectRoot: context.projectRoot,
    worktree: context.cwd,
    branch: context.task.branch,
    planPath: context.planPath,
    existingPlan: context.planContents,
    phase: context.phase,
  };
  return [
    planInstructionsByPhase[context.phase],
    '',
    'Task context:',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
};

/** True when the provider should force its planning UX (Claude plan mode, Codex /plan prefix). */
export const phaseForcesPlanMode = (phase: TaskPhase): boolean => phase !== 'resume-implementation';

const buildSetupPrompt = (context: AgentSetupInvocationContext): string => {
  return [
    'Scrumlord setup has just completed for this project.',
    '',
    'Inspect the setup state with `tasks setup status` before making changes.',
    'Use the `tasks` CLI for all task graph changes. Never edit `tmp/tasks.db` directly.',
    'If you break down documents or checklists into work, first run `tasks list` to avoid duplicates, then use `tasks create` and `tasks blockers add` to build the graph.',
    '',
    'Setup context:',
    '```json',
    JSON.stringify(context.setup, null, 2),
    '```',
  ].join('\n');
};

const workflowSystemPrompt = [
  'You are running a Scrumlord workflow skill in the project worktree.',
  'Use the `tasks` CLI for any task state changes.',
  'Do not create new worktrees or branches unless the skill explicitly instructs you to.',
  'When the skill is complete, exit cleanly.',
].join(' ');

const withEnvironment = (command: string[], cwd: string): AgentInvocation => ({
  command,
  cwd,
  environment: {},
});

/** Options for building a provider-agnostic skill (workflow) invocation. */
export type SkillInvocationContext = {
  cwd: string;
  prompt: string;
  session?: string | null;
  planMode?: boolean;
};

/**
 * Builds a Claude argv array for a skill invocation.
 * Extracted so both `buildTaskStartInvocation` and `buildSkillInvocation` share
 * the same flag-emitting logic without duplication.
 */
const buildClaudeSkillArgv = (
  systemPrompt: string,
  prompt: string,
  session: string | null | undefined,
  planMode: boolean,
): string[] => {
  const command = ['claude'];
  if (planMode) command.push('--permission-mode', 'plan');
  command.push('--append-system-prompt', systemPrompt);
  if (session) command.push('--session-id', session);
  command.push(prompt);
  return command;
};

/**
 * Builds a Codex argv array for a skill invocation.
 * Extracted so both `buildTaskStartInvocation` and `buildSkillInvocation` share
 * the same flag-emitting logic without duplication.
 */
const buildCodexSkillArgv = (
  cwd: string,
  systemPrompt: string,
  prompt: string,
  planMode: boolean,
): string[] => {
  const fullPrompt = planMode
    ? `/plan ${systemPrompt}\n\n${prompt}`
    : `${systemPrompt}\n\n${prompt}`;
  return ['codex', '--cd', cwd, fullPrompt];
};

const claudeProvider: AgentCliProvider = {
  id: 'claude',
  executable: 'claude',
  createSession: () => crypto.randomUUID(),
  buildStartInvocation(context) {
    const command = buildClaudeSkillArgv(
      providerSystemPrompt,
      buildTaskPrompt(context),
      context.session,
      phaseForcesPlanMode(context.phase),
    );
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
    const command = buildCodexSkillArgv(
      context.cwd,
      providerSystemPrompt,
      buildTaskPrompt(context),
      phaseForcesPlanMode(context.phase),
    );
    return withEnvironment(command, context.cwd);
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

/**
 * Builds a provider-specific start command for a Scrumlord task. The `phase`
 * defaults to `"start"` so existing callers behave the same.
 */
export const buildTaskStartInvocation = (
  provider: AgentProvider,
  context: AgentStartInvocationContext & { phase?: TaskPhase },
): AgentInvocation => {
  const phase: TaskPhase = context.phase ?? 'start';
  return getAgentProvider(provider).buildStartInvocation({ ...context, phase });
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

/**
 * Builds a provider-specific invocation for a workflow skill (plan-review,
 * committee-review, address-pr, etc.). Unlike `buildTaskStartInvocation`, this
 * builder is prompt-agnostic: the caller supplies the fully-rendered prompt and
 * the builder only wraps it with provider-specific flags and the workflow system
 * prompt.
 *
 * - Claude: `claude [--permission-mode plan] --append-system-prompt <workflowSystemPrompt>
 *            [--session-id <session>] <prompt>`
 * - Codex:  `codex --cd <cwd> [/plan ]<workflowSystemPrompt>\n\n<prompt>`
 */
export const buildSkillInvocation = (
  provider: AgentProvider,
  context: SkillInvocationContext,
): AgentInvocation => {
  const { cwd, prompt, session, planMode = false } = context;
  const adapter = getAgentProvider(provider);
  if (adapter.id === 'claude') {
    const command = buildClaudeSkillArgv(workflowSystemPrompt, prompt, session, planMode);
    return withEnvironment(command, cwd);
  }
  const command = buildCodexSkillArgv(cwd, workflowSystemPrompt, prompt, planMode);
  return withEnvironment(command, cwd);
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
    sessionPath,
    warnings,
  };
};
