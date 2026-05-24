import { ScrumlordError } from './errors.js';
import type {
  AgentProvider,
  DateInput,
  ProgressEvent,
  TaskIdentifier,
  TaskPriority,
  TaskReference,
  TaskStatus,
} from './types.js';
import { agentProviderNames, progressEvents, taskPriorities, taskStatuses } from './types.js';

const isTaskPriority = (priority: number): priority is TaskPriority => {
  return taskPriorities.some((value) => value === priority);
};

const isTaskStatus = (status: string): status is TaskStatus => {
  return taskStatuses.some((value) => value === status);
};

const isAgentProvider = (provider: string): provider is AgentProvider => {
  return agentProviderNames.some((value) => value === provider);
};

export const taskIdFrom = (taskOrId: TaskReference): TaskIdentifier => {
  if (typeof taskOrId === 'string') return taskOrId;
  return taskOrId.id;
};

export const normalizeTag = (tag: string): string => {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) throw new ScrumlordError('invalid_tag', 'Tags cannot be empty.');
  return normalized;
};

export const parsePriority = (priority: number): TaskPriority => {
  if (isTaskPriority(priority)) return priority;
  throw new ScrumlordError('invalid_priority', 'Priority must be 1, 2, or 3.');
};

export const parseStatus = (status: string): TaskStatus => {
  if (isTaskStatus(status)) return status;
  throw new ScrumlordError('invalid_status', `Status must be one of: ${taskStatuses.join(', ')}.`);
};

export const parseAgentProvider = (provider: string): AgentProvider => {
  if (isAgentProvider(provider)) return provider;
  throw new ScrumlordError(
    'invalid_provider',
    `Provider must be one of: ${agentProviderNames.join(', ')}.`,
  );
};

const isProgressEvent = (event: string): event is ProgressEvent => {
  return progressEvents.some((value) => value === event);
};

export const parseProgressEvent = (event: string): ProgressEvent => {
  if (isProgressEvent(event)) return event;
  throw new ScrumlordError(
    'invalid_progress_event',
    `Progress event must be one of: ${progressEvents.join(', ')}.`,
  );
};

export const parseOptionalAgentProvider = (
  provider: string | null | undefined,
): AgentProvider | null | undefined => {
  if (provider === undefined) return undefined;
  if (provider === null) return null;
  const trimmed = provider.trim();
  return trimmed ? parseAgentProvider(trimmed) : null;
};

export const parseDateInput = (
  value: DateInput | undefined,
  fieldName: string,
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ScrumlordError('invalid_date', `${fieldName} must be a valid date.`);
  }
  return date.toISOString();
};

export const parseOptionalText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
};

/**
 * Branch names a task may never be associated with. These are integration
 * branches, not feature branches — a task that "owns" `main` corrupts
 * branch-based current-task resolution (every session on `main` resolves to a
 * stale task). Local and remote-qualified forms are both rejected.
 */
const reservedTaskBranches: ReadonlySet<string> = new Set([
  'main',
  'master',
  'origin/main',
  'origin/master',
]);

/** Reports whether a branch name is an integration branch a task may never own. */
export const isReservedTaskBranch = (branch: string | null | undefined): boolean => {
  return branch != null && reservedTaskBranches.has(branch);
};

/**
 * Parses a task branch value and rejects reserved integration branches. Returns
 * `undefined` when the field is absent (no change), `null` when explicitly
 * cleared, otherwise the trimmed branch name. Throws `invalid_branch` when the
 * resolved name is an integration branch such as `main`.
 */
export const parseTaskBranch = (value: string | null | undefined): string | null | undefined => {
  const branch = parseOptionalText(value);
  if (isReservedTaskBranch(branch)) {
    throw new ScrumlordError(
      'invalid_branch',
      `Tasks cannot be associated with the integration branch "${branch}". Work a task on a feature branch (Scrumlord derives one as tasks/<short-id>).`,
    );
  }
  return branch;
};

const dependencyLanguagePatterns = [
  /\bgated\s+(?:on|by)\b/i,
  /\bblocked\s+(?:by|until|on)\b/i,
  /\bdepends?\s+on\b/i,
  /\bdependent\s+on\b/i,
  /\bprerequisite\b/i,
  /\bonce\b[^.?!]{1,120}\bexists\b/i,
] as const;

export const hasDependencyLanguage = (description: string): boolean => {
  return dependencyLanguagePatterns.some((pattern) => pattern.test(description));
};

export const validateReadyTaskDependencyEdges = (
  status: TaskStatus,
  description: string,
  blockerCount: number,
): void => {
  if (status !== 'ready' || blockerCount > 0 || !hasDependencyLanguage(description)) return;
  throw new ScrumlordError(
    'dependency_edge_required',
    'Ready tasks with dependency language must have an explicit blocker. Pass --blocked-by, add a blocker before marking the task ready, or keep the task in draft.',
  );
};

export const requireTitle = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) throw new ScrumlordError('invalid_title', 'Task title is required.');
  return trimmed;
};

export const requireProgressMessage = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed)
    throw new ScrumlordError('invalid_progress_message', 'Progress message is required.');
  return trimmed;
};
