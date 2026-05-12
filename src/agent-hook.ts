import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runCommand, type CommandRunner } from './command-runner.js';
import { currentGitBranch, syncGitStatus } from './git-status.js';
import { absoluteTaskPlanPath, defaultTaskPlanPath, getAgentProvider } from './agent-providers.js';
import type { AgentProvider, Task, TaskStore } from './types.js';

type HookRecord = Record<string, unknown>;

export type AgentHookOptions = {
  environment?: Record<string, string | undefined>;
  runner?: CommandRunner;
};

export type AgentHookResult = {
  taskId: string | null;
  actions: string[];
  skipped: string | null;
  context: string | null;
};

const isRecord = (value: unknown): value is HookRecord => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const parsePayload = (input: string): HookRecord | null => {
  if (!input.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const findStringByKey = (value: unknown, keys: Set<string>): string | null => {
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === 'string' && child.trim()) return child;
  }
  for (const child of Object.values(value)) {
    const match = findStringByKey(child, keys);
    if (match) return match;
  }
  return null;
};

const sessionFromPayload = (payload: HookRecord): string | null => {
  return findStringByKey(
    payload,
    new Set(['session_id', 'sessionId', 'conversation_id', 'conversationId']),
  );
};

const eventFromPayload = (payload: HookRecord): string | null => {
  return findStringByKey(
    payload,
    new Set(['hook_event_name', 'hookEventName', 'event', 'eventName']),
  );
};

const toolFromPayload = (payload: HookRecord): string | null => {
  return findStringByKey(payload, new Set(['tool_name', 'toolName', 'tool']));
};

const commandFromPayload = (payload: HookRecord): string | null => {
  return findStringByKey(payload, new Set(['command']));
};

const planFromPayload = (provider: AgentProvider, payload: HookRecord): string | null => {
  const plan = findStringByKey(payload, new Set(['plan']));
  if (plan) return plan;
  if (provider !== 'codex') return null;
  return findStringByKey(payload, new Set(['output', 'message', 'last_response', 'lastResponse']));
};

const activeTask = (task: Task): boolean => {
  return !task.deleted && !task.archived && task.status !== 'completed';
};

const exactlyOne = (tasks: Task[]): Task | null => {
  return tasks.length === 1 ? (tasks[0] ?? null) : null;
};

const taskFromEnvironment = (
  store: TaskStore,
  environment: AgentHookOptions['environment'],
): Task | null => {
  const taskId = environment?.['SCRUMLORD_TASK_ID'];
  return taskId ? store.getTask(taskId) : null;
};

const resolveHookTask = async (
  store: TaskStore,
  provider: AgentProvider,
  session: string | null,
  options: AgentHookOptions,
): Promise<Task | null> => {
  const environmentTask = taskFromEnvironment(store, options.environment);
  if (environmentTask) return environmentTask;

  if (session) {
    const sessionTask = exactlyOne(store.withSession(provider, session).filter(activeTask));
    if (sessionTask) return sessionTask;
  }

  try {
    const branch = await currentGitBranch(store.projectRoot, options.runner ?? runCommand);
    return exactlyOne(store.withBranch(branch).filter(activeTask));
  } catch {
    return null;
  }
};

const shouldCapturePlan = (
  provider: AgentProvider,
  event: string | null,
  tool: string | null,
): boolean => {
  if (provider === 'claude') return event === 'PostToolUse' && tool === 'ExitPlanMode';
  return event === 'Stop';
};

const shouldInjectPromptContext = (event: string | null): boolean => {
  return event === 'UserPromptSubmit';
};

const summarize = (value: string, maximumLength: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maximumLength) return trimmed;
  return `${trimmed.slice(0, maximumLength - 3).trimEnd()}...`;
};

const listValue = (values: readonly string[]): string => {
  return values.length === 0 ? 'none' : values.join(', ');
};

const maybeLine = (label: string, value: string | null): string | null => {
  const summarized = value ? summarize(value, 600) : '';
  return summarized ? `${label}: ${summarized}` : null;
};

const promptContextForTask = (task: Task): string => {
  const lines = [
    '<scrumlord-current-task>',
    'Scrumlord inferred this task for the current branch.',
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `priority: ${task.priority}`,
    `branch: ${task.branch ?? 'not recorded'}`,
    `plan: ${task.plan ?? 'not recorded'}`,
    `provider: ${task.provider ?? 'not recorded'}`,
    `session: ${task.session ?? 'not recorded'}`,
    `tags: ${listValue(task.tags)}`,
    `parent: ${task.parent ?? 'none'}`,
    `blocked by: ${listValue(task.blockedBy)}`,
    `blocking: ${listValue(task.blocking)}`,
    maybeLine('description', task.description),
    'Use branch-local task commands without a task ID when acting on this task; pass an explicit ID for any other task.',
    'Before resuming or handing off, inspect `tasks progress`; after meaningful work, run `tasks add-progress --message "<note>"`.',
    '</scrumlord-current-task>',
  ].filter((line): line is string => Boolean(line));

  return `${lines.join('\n')}\n`;
};

const branchRelevantCommand = (command: string | null): boolean => {
  if (!command) return false;
  return /\b(git\s+(branch|checkout|switch|worktree|merge|rebase)|gh\s+pr\s+(create|ready|merge|close|reopen))\b/.test(
    command,
  );
};

const synchronizationCommand = (command: string | null): boolean => {
  if (!command) return false;
  return /\b(gh\s+pr\s+(create|ready|merge)|git\s+(merge|rebase))\b/.test(command);
};

const writePlan = async (
  store: TaskStore,
  task: Task,
  planText: string,
  actions: string[],
): Promise<void> => {
  const storedPlanPath = task.plan ?? defaultTaskPlanPath(task.id);
  const planPath = absoluteTaskPlanPath(store.projectRoot, storedPlanPath) ?? storedPlanPath;
  mkdirSync(dirname(planPath), { recursive: true });
  await Bun.write(planPath, planText);
  store.setPlan(task.id, storedPlanPath);
  actions.push('set-plan');
};

const recordHookSession = (
  store: TaskStore,
  task: Task,
  provider: AgentProvider,
  session: string | null,
  actions: string[],
): void => {
  if (!session) return;
  if (task.provider === provider && task.session === session) return;
  store.setSession(task.id, provider, session);
  actions.push('set-session');
};

const synchronizeHookBranch = async (
  store: TaskStore,
  task: Task,
  command: string | null,
  options: AgentHookOptions,
  actions: string[],
): Promise<void> => {
  if (!branchRelevantCommand(command)) return;
  try {
    const branch = await currentGitBranch(store.projectRoot, options.runner ?? runCommand);
    if (task.branch === branch) return;
    store.update(task.id, { branch });
    actions.push('set-branch');
  } catch {
    actions.push('branch-unavailable');
  }
};

const synchronizeHookGitStatus = async (
  store: TaskStore,
  command: string | null,
  options: AgentHookOptions,
  actions: string[],
): Promise<void> => {
  if (!synchronizationCommand(command)) return;
  await syncGitStatus(store, options.runner ? { runner: options.runner } : {});
  actions.push('sync-git-status');
};

const captureHookPlan = async (
  store: TaskStore,
  task: Task,
  provider: AgentProvider,
  payload: HookRecord,
  actions: string[],
): Promise<void> => {
  const event = eventFromPayload(payload);
  const tool = toolFromPayload(payload);
  if (!shouldCapturePlan(provider, event, tool)) return;
  const plan = planFromPayload(provider, payload);
  if (plan) await writePlan(store, task, plan, actions);
};

/** Handles a provider hook payload and keeps Scrumlord task metadata synchronized. */
export const runAgentHook = async (
  store: TaskStore,
  providerName: AgentProvider,
  input: string,
  options: AgentHookOptions = {},
): Promise<AgentHookResult> => {
  const provider = getAgentProvider(providerName).id;
  const payload = parsePayload(input);
  if (!payload) return { taskId: null, actions: [], skipped: 'invalid_payload', context: null };

  const session = sessionFromPayload(payload);
  const event = eventFromPayload(payload);
  const task = await resolveHookTask(store, provider, session, options);
  if (!task) return { taskId: null, actions: [], skipped: 'task_not_resolved', context: null };

  const actions: string[] = [];
  recordHookSession(store, task, provider, session, actions);
  const command = commandFromPayload(payload);
  await synchronizeHookBranch(store, task, command, options, actions);
  await synchronizeHookGitStatus(store, command, options, actions);
  await captureHookPlan(store, task, provider, payload, actions);
  const context = shouldInjectPromptContext(event) ? promptContextForTask(task) : null;

  return { taskId: task.id, actions, skipped: null, context };
};
