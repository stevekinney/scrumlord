import type { Database } from 'bun:sqlite';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { ScrumlordError } from './errors.js';
import type {
  AddTaskProgressInput,
  AgentProvider,
  CreateTaskInput,
  DateInput,
  Task,
  TaskIdentifier,
  TaskProgress,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from './types.js';
import {
  normalizeTag,
  parseDateInput,
  parseOptionalAgentProvider,
  parseOptionalText,
  parsePriority,
  parseStatus,
  validateReadyTaskDependencyEdges,
  requireProgressMessage,
  requireTitle,
} from './validation.js';

export type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  description: string;
  priority: TaskPriority;
  created_at: string;
  start_date: string | null;
  due_date: string | null;
  branch: string | null;
  plan: string | null;
  provider: AgentProvider | null;
  session: string | null;
  last_modified_at: string;
  archived: number;
  deleted: number;
  parent_id: string | null;
};

export type TaskProgressRow = {
  id: string;
  task_id: string;
  message: string;
  created_at: string;
  provider: AgentProvider | null;
  session: string | null;
};

export type QueryBindings = Record<string, string | number | null>;

const availableTasksWhereSql = `WHERE status = 'ready'
  AND deleted = 0
  AND archived = 0
  AND (start_date IS NULL OR start_date <= $now)
  AND NOT EXISTS (
    SELECT 1 FROM task_dependencies
    JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
    WHERE task_dependencies.task_id = tasks.id
      AND blocker.status != 'completed'
      AND blocker.deleted = 0
      AND blocker.archived = 0
  )`;

export const availableTasksSql = `SELECT * FROM tasks
 ${availableTasksWhereSql}
 ORDER BY priority DESC, created_at ASC, id ASC`;

export const nextTaskSql = `SELECT * FROM tasks
 ${availableTasksWhereSql}
 ORDER BY
   CASE WHEN plan IS NULL THEN 1 ELSE 0 END,
   priority DESC,
   created_at ASC,
   id ASC
 LIMIT 1`;

export const blockedTasksSql = `SELECT DISTINCT tasks.* FROM tasks
 JOIN task_dependencies ON task_dependencies.task_id = tasks.id
 JOIN tasks AS blocker ON blocker.id = task_dependencies.blocked_by_task_id
 WHERE tasks.deleted = 0
   AND tasks.archived = 0
   AND blocker.status != 'completed'
   AND blocker.deleted = 0
   AND blocker.archived = 0
 ORDER BY tasks.priority DESC, tasks.created_at ASC, tasks.id ASC`;

export const remainingTasksSql = `SELECT count(*) AS count FROM tasks
 WHERE deleted = 0
   AND archived = 0
   AND status NOT IN ('completed', 'in-progress')`;

export const booleanToInteger = (value: boolean): number => (value ? 1 : 0);

const hasInputField = (input: UpdateTaskInput, key: keyof UpdateTaskInput): boolean => {
  return key in input;
};

export const nullableDateInput = (
  value: DateInput | undefined,
  fieldName: 'startDate' | 'dueDate',
): string | null => {
  return parseDateInput(value, fieldName) ?? null;
};

export const updatedStartDate = (input: UpdateTaskInput, current: Task): string | null => {
  return hasInputField(input, 'startDate')
    ? nullableDateInput(input.startDate, 'startDate')
    : current.startDate;
};

export const updatedDueDate = (input: UpdateTaskInput, current: Task): string | null => {
  return hasInputField(input, 'dueDate')
    ? nullableDateInput(input.dueDate, 'dueDate')
    : current.dueDate;
};

export const updatedBranch = (input: UpdateTaskInput, current: Task): string | null => {
  return hasInputField(input, 'branch')
    ? (parseOptionalText(input.branch) ?? null)
    : current.branch;
};

const updatedPlan = (projectRoot: string, input: UpdateTaskInput, current: Task): string | null => {
  return hasInputField(input, 'plan')
    ? (normalizeStoredPlanPath(projectRoot, input.plan) ?? null)
    : current.plan;
};

export const updatedTitle = (input: UpdateTaskInput, current: Task): string => {
  return input.title === undefined ? current.title : requireTitle(input.title);
};

export const updatedStatus = (input: UpdateTaskInput, current: Task): Task['status'] => {
  return input.status === undefined ? current.status : parseStatus(input.status);
};

const isStartableStatus = (status: Task['status']): boolean => {
  return status === 'draft' || status === 'ready';
};

export const updatedStatusForBranch = (
  input: UpdateTaskInput,
  current: Task,
  branch: string | null,
): Task['status'] => {
  if (hasInputField(input, 'branch') && branch && isStartableStatus(current.status)) {
    return 'in-progress';
  }

  return updatedStatus(input, current);
};

export const updatedPriority = (input: UpdateTaskInput, current: Task): Task['priority'] => {
  return input.priority === undefined ? current.priority : parsePriority(input.priority);
};

export const updatedBoolean = (value: boolean | undefined, currentValue: boolean): number => {
  return booleanToInteger(value ?? currentValue);
};

export const updatedProvider = (input: UpdateTaskInput, current: Task): AgentProvider | null => {
  return hasInputField(input, 'provider')
    ? (parseOptionalAgentProvider(input.provider) ?? null)
    : current.provider;
};

export const updatedSession = (input: UpdateTaskInput, current: Task): string | null => {
  return hasInputField(input, 'session')
    ? (parseOptionalText(input.session) ?? null)
    : current.session;
};

export const validateDateOrder = (startDate: string | null, dueDate: string | null): void => {
  if (startDate && dueDate && dueDate < startDate) {
    throw new ScrumlordError('invalid_date_range', 'Due date cannot be before start date.');
  }
};

export const validateSessionFields = (
  provider: AgentProvider | null,
  session: string | null,
): void => {
  if (session && !provider) {
    throw new ScrumlordError('session_provider_required', 'A session requires a provider.');
  }
};

const isInsideDirectory = (parent: string, child: string): boolean => {
  const difference = relative(parent, child);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
};

export const normalizeStoredPlanPath = (
  projectRoot: string,
  plan: string | null | undefined,
): string | null | undefined => {
  const parsed = parseOptionalText(plan);
  if (parsed === undefined || parsed === null) return parsed;
  const absolutePlanPath = isAbsolute(parsed) ? normalize(parsed) : resolve(projectRoot, parsed);
  if (isInsideDirectory(projectRoot, absolutePlanPath)) {
    return normalize(relative(projectRoot, absolutePlanPath) || '.');
  }
  return absolutePlanPath;
};

export const createTaskBindings = (
  projectRoot: string,
  input: CreateTaskInput,
  id: string,
  now: string,
): QueryBindings => {
  const startDate = nullableDateInput(input.startDate, 'startDate');
  const dueDate = nullableDateInput(input.dueDate, 'dueDate');
  const provider = parseOptionalAgentProvider(input.provider) ?? null;
  const session = parseOptionalText(input.session) ?? null;
  const status = parseStatus(input.status ?? 'ready');
  const description = input.description ?? '';
  validateDateOrder(startDate, dueDate);
  validateSessionFields(provider, session);
  validateReadyTaskDependencyEdges(status, description, input.blockedBy?.length ?? 0);
  return {
    id,
    title: requireTitle(input.title),
    status,
    description,
    priority: parsePriority(input.priority ?? 1),
    createdAt: now,
    startDate,
    dueDate,
    branch: parseOptionalText(input.branch) ?? null,
    plan: normalizeStoredPlanPath(projectRoot, input.plan) ?? null,
    provider,
    session,
    lastModifiedAt: now,
  };
};

export const updateTaskBindings = (
  projectRoot: string,
  id: TaskIdentifier,
  input: UpdateTaskInput,
  current: Task,
  now: string,
): QueryBindings => {
  const startDate = updatedStartDate(input, current);
  const dueDate = updatedDueDate(input, current);
  const provider = updatedProvider(input, current);
  const session = updatedSession(input, current);
  const branch = updatedBranch(input, current);
  const status = updatedStatusForBranch(input, current, branch);
  const description = input.description ?? current.description;
  validateDateOrder(startDate, dueDate);
  validateSessionFields(provider, session);
  validateReadyTaskDependencyEdges(status, description, current.blockedBy.length);
  return {
    id,
    title: updatedTitle(input, current),
    status,
    description,
    priority: updatedPriority(input, current),
    startDate,
    dueDate,
    branch,
    plan: updatedPlan(projectRoot, input, current),
    provider,
    session,
    archived: updatedBoolean(input.archived, current.archived),
    deleted: updatedBoolean(input.deleted, current.deleted),
    lastModifiedAt: now,
  };
};

export const createTaskProgressBindings = (
  input: AddTaskProgressInput,
  task: Task,
  progressId: string,
  now: string,
): QueryBindings => {
  const requestedProvider = parseOptionalAgentProvider(input.provider);
  const requestedSession = parseOptionalText(input.session);
  const provider = requestedProvider === undefined ? task.provider : requestedProvider;
  const session = requestedSession === undefined ? task.session : requestedSession;
  validateSessionFields(provider, session);

  return {
    id: progressId,
    taskId: task.id,
    message: requireProgressMessage(input.message),
    createdAt: now,
    provider,
    session,
  };
};

export const normalizeTagSet = (tags: string[]): string[] => {
  const normalized = Array.from(new Set(tags.map((tag) => normalizeTag(tag))));
  if (normalized.length === 0)
    throw new ScrumlordError('invalid_tags', 'At least one tag is required.');
  return normalized;
};

export const placeholders = (values: string[]): string => {
  return values.map((_value, index) => `$value${index}`).join(', ');
};

export const indexedBindings = (values: string[], extra: QueryBindings = {}): QueryBindings => {
  return values.reduce<QueryBindings>((bindings, value, index) => {
    bindings[`value${index}`] = value;
    return bindings;
  }, extra);
};

export type TaskRelationships = Pick<Task, 'tags' | 'subtasks' | 'blockedBy' | 'blocking'>;

export const hydrateTask = (row: TaskRow, relationships: TaskRelationships): Task => ({
  id: row.id,
  title: row.title,
  status: row.status,
  description: row.description,
  priority: row.priority,
  createdAt: row.created_at,
  startDate: row.start_date,
  dueDate: row.due_date,
  branch: row.branch,
  plan: row.plan,
  provider: row.provider,
  session: row.session,
  parent: row.parent_id,
  lastModifiedAt: row.last_modified_at,
  archived: row.archived === 1,
  deleted: row.deleted === 1,
  ...relationships,
});

export const hydrateTaskProgress = (row: TaskProgressRow): TaskProgress => ({
  id: row.id,
  taskId: row.task_id,
  message: row.message,
  createdAt: row.created_at,
  provider: row.provider,
  session: row.session,
});

export const hasParentPath = (database: Database, start: string, target: string): boolean => {
  return Boolean(
    database
      .query<{ id: string }, QueryBindings>(
        `WITH RECURSIVE parents(id) AS (
          SELECT parent_id FROM tasks WHERE id = $start AND parent_id IS NOT NULL
          UNION
          SELECT tasks.parent_id FROM tasks JOIN parents ON tasks.id = parents.id
          WHERE tasks.parent_id IS NOT NULL
        )
        SELECT id FROM parents WHERE id = $target LIMIT 1`,
      )
      .get({ start, target }),
  );
};

export const hasBlockerPath = (database: Database, start: string, target: string): boolean => {
  return Boolean(
    database
      .query<{ id: string }, QueryBindings>(
        `WITH RECURSIVE blockers(id) AS (
          SELECT blocked_by_task_id FROM task_dependencies WHERE task_id = $start
          UNION
          SELECT task_dependencies.blocked_by_task_id
          FROM task_dependencies JOIN blockers ON task_dependencies.task_id = blockers.id
        )
        SELECT id FROM blockers WHERE id = $target LIMIT 1`,
      )
      .get({ start, target }),
  );
};
