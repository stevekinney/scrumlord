import { ScrumlordError } from './errors.js';
import type {
  AgentProvider,
  DateInput,
  TaskIdentifier,
  TaskPriority,
  TaskReference,
  TaskStatus,
} from './types.js';
import { agentProviderNames, taskPriorities, taskStatuses } from './types.js';

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
