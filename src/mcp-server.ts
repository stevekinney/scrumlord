/* eslint-disable max-lines */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createTaskStore } from './database-open.js';
import { errorMessage, ScrumlordError } from './errors.js';
import {
  addTaskBlocker,
  addTaskProgress,
  addTaskTag,
  archiveTask,
  availableTasks,
  blockedTasks,
  cleanupTasks,
  clearTaskBranch,
  clearTaskParent,
  clearTaskPlan,
  clearTaskSession,
  completedTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  persistedTaskSession,
  removeTaskBlocker,
  removeTaskTag,
  restoreTask,
  setTaskBranch,
  setTaskParent,
  setTaskPlan,
  setTaskSession,
  setTaskStatus,
  taskProgress,
  tasksBlockedBy,
  tasksBlocking,
  tasksWithAllTags,
  tasksWithAnyTags,
  tasksWithBranch,
  tasksWithPriority,
  tasksWithSession,
  tasksWithTag,
  updateTask,
} from './task-commands.js';
import { next as nextTaskFromStore, remaining as remainingTasksFromStore } from './task-queries.js';
import type {
  AddTaskProgressInput,
  CreateTaskInput,
  Task,
  TaskPriority,
  TaskStatus,
  TaskStore,
  UpdateTaskInput,
} from './types.js';
import {
  parseAgentProvider,
  parseOptionalAgentProvider,
  parsePriority,
  parseStatus,
} from './validation.js';

export type ScrumlordMcpServerOptions = {
  cwd?: string;
  createStore?: (cwd: string) => Promise<TaskStore>;
};

type ToolOutput = Record<string, unknown>;
type TaskStoreOperation<T> = (store: TaskStore) => T | Promise<T>;

type InputToolSpecification<Input> = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (input: Input, store: TaskStore) => ToolOutput | Promise<ToolOutput>;
};

type NoInputToolSpecification = {
  name: string;
  title: string;
  description: string;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (store: TaskStore) => ToolOutput | Promise<ToolOutput>;
};

const readOnlyAnnotations: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const mutationAnnotations: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

const destructiveMutationAnnotations: ToolAnnotations = {
  ...mutationAnnotations,
  destructiveHint: true,
};

const taskResultSchema = z.object({ task: z.unknown().nullable() });
const tasksResultSchema = z.object({ tasks: z.array(z.unknown()) });
const countResultSchema = z.object({ count: z.number() });
const cleanupResultSchema = z.object({ deleted: z.number() });
const sessionResultSchema = z.object({ session: z.unknown() });
const progressResultSchema = z.object({ progress: z.array(z.unknown()) });
const progressEntryResultSchema = z.object({ progress: z.unknown() });

const taskIdInputSchema = z.object({ id: z.string().min(1) });
const tagInputSchema = z.object({ tag: z.string() });
const tagsInputSchema = z.object({ tags: z.array(z.string()).min(1) });
const branchInputSchema = z.object({ branch: z.string() });
const priorityInputSchema = z.object({ priority: z.number() });
const dependencyInputSchema = z.object({
  id: z.string().min(1),
  blockedBy: z.string().min(1),
});
const parentInputSchema = z.object({
  id: z.string().min(1),
  parent: z.string().min(1),
});
const taskTagInputSchema = z.object({
  id: z.string().min(1),
  tag: z.string(),
});
const taskBranchInputSchema = z.object({
  id: z.string().min(1),
  branch: z.string(),
});
const taskPlanInputSchema = z.object({
  id: z.string().min(1),
  plan: z.string().nullable(),
});
const sessionInputSchema = z.object({
  provider: z.string(),
  session: z.string(),
});
const taskSessionInputSchema = z.object({
  id: z.string().min(1),
  provider: z.string(),
  session: z.string().nullable(),
});
const taskStatusInputSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
});
const addProgressInputSchema = z.object({
  id: z.string().min(1),
  message: z.string(),
  provider: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
});
const cleanupInputSchema = z.object({ days: z.number() });

const createTaskInputSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  status: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
  blockedBy: z.array(z.string()).optional(),
});

const updateTaskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  plan: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
  parent: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const jsonContent = (value: ToolOutput): CallToolResult['content'] => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
];

const toolSuccess = (structuredContent: ToolOutput): CallToolResult => ({
  content: jsonContent(structuredContent),
  structuredContent,
});

const toolError = (error: unknown): CallToolResult => {
  const structuredContent = {
    error: {
      code: error instanceof ScrumlordError ? error.code : 'unexpected_error',
      message: errorMessage(error),
    },
  };
  return {
    content: jsonContent(structuredContent),
    isError: true,
    structuredContent,
  };
};

const taskResult = (task: Task | null): ToolOutput => ({ task });
const tasksResult = (tasks: Task[]): ToolOutput => ({ tasks });

/** Opens a task store for one MCP operation and always closes it afterwards. */
export const withTaskStore = async <T>(
  options: ScrumlordMcpServerOptions,
  operation: TaskStoreOperation<T>,
): Promise<T> => {
  const cwd = options.cwd ?? process.cwd();
  const store = options.createStore
    ? await options.createStore(cwd)
    : await createTaskStore({ cwd });
  try {
    return await operation(store);
  } finally {
    store.close();
  }
};

const runToolOperation = async (
  options: ScrumlordMcpServerOptions,
  operation: TaskStoreOperation<ToolOutput>,
): Promise<CallToolResult> => {
  try {
    return toolSuccess(await withTaskStore(options, operation));
  } catch (error) {
    return toolError(error);
  }
};

const parseOptionalPriority = (priority: number | undefined): TaskPriority | undefined => {
  return priority === undefined ? undefined : parsePriority(priority);
};

const parseOptionalStatus = (status: string | undefined): TaskStatus | undefined => {
  return status === undefined ? undefined : parseStatus(status);
};

const assignDefined = <Target, Key extends keyof Target>(
  target: Target,
  key: Key,
  value: Target[Key] | undefined,
): void => {
  if (value !== undefined) target[key] = value;
};

const createTaskInputFromTool = (input: z.infer<typeof createTaskInputSchema>): CreateTaskInput => {
  const taskInput: CreateTaskInput = { title: input.title };
  assignDefined(taskInput, 'id', input.id);
  assignDefined(taskInput, 'status', parseOptionalStatus(input.status));
  assignDefined(taskInput, 'description', input.description);
  assignDefined(taskInput, 'priority', parseOptionalPriority(input.priority));
  assignDefined(taskInput, 'startDate', input.startDate);
  assignDefined(taskInput, 'dueDate', input.dueDate);
  assignDefined(taskInput, 'branch', input.branch);
  assignDefined(taskInput, 'plan', input.plan);
  assignDefined(taskInput, 'provider', parseOptionalAgentProvider(input.provider));
  assignDefined(taskInput, 'session', input.session);
  assignDefined(taskInput, 'tags', input.tags);
  assignDefined(taskInput, 'parent', input.parent);
  assignDefined(taskInput, 'blockedBy', input.blockedBy);

  return taskInput;
};

const updateTaskInputFromTool = (input: z.infer<typeof updateTaskInputSchema>): UpdateTaskInput => {
  const taskInput: UpdateTaskInput = {};
  assignDefined(taskInput, 'title', input.title);
  assignDefined(taskInput, 'status', parseOptionalStatus(input.status));
  assignDefined(taskInput, 'description', input.description);
  assignDefined(taskInput, 'priority', parseOptionalPriority(input.priority));
  assignDefined(taskInput, 'startDate', input.startDate);
  assignDefined(taskInput, 'dueDate', input.dueDate);
  assignDefined(taskInput, 'branch', input.branch);
  assignDefined(taskInput, 'plan', input.plan);
  assignDefined(taskInput, 'provider', parseOptionalAgentProvider(input.provider));
  assignDefined(taskInput, 'session', input.session);
  assignDefined(taskInput, 'parent', input.parent);
  assignDefined(taskInput, 'archived', input.archived);
  assignDefined(taskInput, 'deleted', input.deleted);

  return taskInput;
};

const registerNoInputTool = (
  server: McpServer,
  options: ScrumlordMcpServerOptions,
  specification: NoInputToolSpecification,
): void => {
  server.registerTool(
    specification.name,
    {
      annotations: specification.annotations,
      description: specification.description,
      outputSchema: specification.outputSchema,
      title: specification.title,
    },
    async () => await runToolOperation(options, specification.handler),
  );
};

const registerInputTool = <Input>(
  server: McpServer,
  options: ScrumlordMcpServerOptions,
  specification: InputToolSpecification<Input>,
): void => {
  server.registerTool(
    specification.name,
    {
      annotations: specification.annotations,
      description: specification.description,
      inputSchema: specification.inputSchema,
      outputSchema: specification.outputSchema,
      title: specification.title,
    },
    async (input: unknown) =>
      await runToolOperation(options, async (store) => {
        const parsedInput = specification.inputSchema.parse(input);
        return await specification.handler(parsedInput, store);
      }),
  );
};

const registerQueryTools = (server: McpServer, options: ScrumlordMcpServerOptions): void => {
  for (const specification of [
    {
      name: 'scrumlord_available_tasks',
      title: 'Available Tasks',
      description: 'Return ready, unblocked tasks that can be started now.',
      outputSchema: tasksResultSchema,
      annotations: readOnlyAnnotations,
      handler: (store: TaskStore) => tasksResult(availableTasks(store)),
    },
    {
      name: 'scrumlord_blocked_tasks',
      title: 'Blocked Tasks',
      description: 'Return active tasks that still have incomplete blockers.',
      outputSchema: tasksResultSchema,
      annotations: readOnlyAnnotations,
      handler: (store: TaskStore) => tasksResult(blockedTasks(store)),
    },
    {
      name: 'scrumlord_completed_tasks',
      title: 'Completed Tasks',
      description: 'Return completed tasks that have not been deleted.',
      outputSchema: tasksResultSchema,
      annotations: readOnlyAnnotations,
      handler: (store: TaskStore) => tasksResult(completedTasks(store)),
    },
    {
      name: 'scrumlord_next_task',
      title: 'Next Task',
      description:
        'Return the next available task, preferring tasks with plans, or null when none is available.',
      outputSchema: taskResultSchema,
      annotations: readOnlyAnnotations,
      handler: (store: TaskStore) => taskResult(nextTaskFromStore(store)),
    },
    {
      name: 'scrumlord_remaining_tasks',
      title: 'Remaining Tasks',
      description: 'Count active unfinished tasks, including future-start tasks.',
      outputSchema: countResultSchema,
      annotations: readOnlyAnnotations,
      handler: (store: TaskStore) => ({ count: remainingTasksFromStore(store) }),
    },
  ] satisfies NoInputToolSpecification[]) {
    registerNoInputTool(server, options, specification);
  }

  registerInputTool(server, options, {
    name: 'scrumlord_list_tasks',
    title: 'List Tasks',
    description: 'Return active tasks, or all tasks when includeInactive is true.',
    inputSchema: z.object({ includeInactive: z.boolean().optional() }),
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => {
      const listOptions =
        input.includeInactive === undefined ? {} : { includeInactive: input.includeInactive };
      return tasksResult(listTasks(store, listOptions));
    },
  });
  registerInputTool(server, options, {
    name: 'scrumlord_get_task',
    title: 'Get Task',
    description: 'Return a task by ID, or null when it does not exist.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => taskResult(getTask(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_tag',
    title: 'Tasks With Tag',
    description: 'Return tasks with one normalized tag.',
    inputSchema: tagInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksWithTag(store, input.tag)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_all_tags',
    title: 'Tasks With All Tags',
    description: 'Return tasks containing every supplied tag.',
    inputSchema: tagsInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksWithAllTags(store, ...input.tags)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_any_tags',
    title: 'Tasks With Any Tags',
    description: 'Return tasks containing at least one supplied tag.',
    inputSchema: tagsInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksWithAnyTags(store, ...input.tags)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_branch',
    title: 'Tasks With Branch',
    description: 'Return tasks associated with one Git branch.',
    inputSchema: branchInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksWithBranch(store, input.branch)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_priority',
    title: 'Tasks With Priority',
    description: 'Return tasks with priority 1, 2, or 3.',
    inputSchema: priorityInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksWithPriority(store, parsePriority(input.priority))),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_blocked_by',
    title: 'Blocked By',
    description: 'Return tasks blocking the supplied task.',
    inputSchema: taskIdInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksBlockedBy(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_blocking',
    title: 'Blocking',
    description: 'Return tasks blocked by the supplied task.',
    inputSchema: taskIdInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => tasksResult(tasksBlocking(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_tasks_with_session',
    title: 'Tasks With Session',
    description: 'Return active tasks with matching provider session metadata.',
    inputSchema: sessionInputSchema,
    outputSchema: tasksResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) =>
      tasksResult(tasksWithSession(store, parseAgentProvider(input.provider), input.session)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_task_session',
    title: 'Task Session',
    description: 'Return persisted provider session metadata for one task.',
    inputSchema: taskIdInputSchema,
    outputSchema: sessionResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => ({ session: persistedTaskSession(store, input.id) }),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_task_progress',
    title: 'Task Progress',
    description: 'Return chronological progress entries for one task.',
    inputSchema: taskIdInputSchema,
    outputSchema: progressResultSchema,
    annotations: readOnlyAnnotations,
    handler: (input, store) => ({ progress: taskProgress(store, input.id) }),
  });
};

const registerMutationTools = (server: McpServer, options: ScrumlordMcpServerOptions): void => {
  registerInputTool(server, options, {
    name: 'scrumlord_create_task',
    title: 'Create Task',
    description: 'Create a task and return the hydrated task.',
    inputSchema: createTaskInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(createTask(store, createTaskInputFromTool(input))),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_update_task',
    title: 'Update Task',
    description: 'Update task fields and return the hydrated task.',
    inputSchema: updateTaskInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) =>
      taskResult(updateTask(store, input.id, updateTaskInputFromTool(input))),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_delete_task',
    title: 'Delete Task',
    description: 'Soft-delete a task.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: destructiveMutationAnnotations,
    handler: (input, store) => taskResult(deleteTask(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_archive_task',
    title: 'Archive Task',
    description: 'Archive a task.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(archiveTask(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_restore_task',
    title: 'Restore Task',
    description: 'Restore a deleted or archived task.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(restoreTask(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_add_tag',
    title: 'Add Tag',
    description: 'Add a normalized tag to a task.',
    inputSchema: taskTagInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(addTaskTag(store, input.id, input.tag)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_remove_tag',
    title: 'Remove Tag',
    description: 'Remove a normalized tag from a task.',
    inputSchema: taskTagInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(removeTaskTag(store, input.id, input.tag)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_set_status',
    title: 'Set Status',
    description: 'Set a task lifecycle status.',
    inputSchema: taskStatusInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) =>
      taskResult(setTaskStatus(store, input.id, parseStatus(input.status))),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_set_branch',
    title: 'Set Branch',
    description: 'Set the Git branch associated with a task.',
    inputSchema: taskBranchInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(setTaskBranch(store, input.id, input.branch)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_clear_branch',
    title: 'Clear Branch',
    description: 'Clear the Git branch associated with a task.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(clearTaskBranch(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_set_parent',
    title: 'Set Parent',
    description: 'Assign a parent task.',
    inputSchema: parentInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(setTaskParent(store, input.id, input.parent)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_clear_parent',
    title: 'Clear Parent',
    description: 'Clear a task parent.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(clearTaskParent(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_add_blocker',
    title: 'Add Blocker',
    description: 'Add a dependency blocker.',
    inputSchema: dependencyInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(addTaskBlocker(store, input.id, input.blockedBy)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_remove_blocker',
    title: 'Remove Blocker',
    description: 'Remove a dependency blocker.',
    inputSchema: dependencyInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(removeTaskBlocker(store, input.id, input.blockedBy)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_set_plan',
    title: 'Set Plan',
    description: 'Set or clear the task plan path.',
    inputSchema: taskPlanInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(setTaskPlan(store, input.id, input.plan)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_clear_plan',
    title: 'Clear Plan',
    description: 'Clear the task plan path.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(clearTaskPlan(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_set_session',
    title: 'Set Session',
    description: 'Set the provider session for a task.',
    inputSchema: taskSessionInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) =>
      taskResult(
        setTaskSession(store, input.id, parseAgentProvider(input.provider), input.session),
      ),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_clear_session',
    title: 'Clear Session',
    description: 'Clear provider and session metadata for a task.',
    inputSchema: taskIdInputSchema,
    outputSchema: taskResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => taskResult(clearTaskSession(store, input.id)),
  });
  registerInputTool(server, options, {
    name: 'scrumlord_add_progress',
    title: 'Add Progress',
    description: 'Append a progress entry to a task and start draft or ready tasks.',
    inputSchema: addProgressInputSchema,
    outputSchema: progressEntryResultSchema,
    annotations: mutationAnnotations,
    handler: (input, store) => {
      const provider = parseOptionalAgentProvider(input.provider);
      const progressInput: AddTaskProgressInput = { message: input.message };
      if (provider !== undefined) progressInput.provider = provider;
      if (input.session !== undefined) progressInput.session = input.session;
      return { progress: addTaskProgress(store, input.id, progressInput) };
    },
  });
  registerInputTool(server, options, {
    name: 'scrumlord_cleanup_tasks',
    title: 'Cleanup Tasks',
    description: 'Permanently remove old completed or archived tasks.',
    inputSchema: cleanupInputSchema,
    outputSchema: cleanupResultSchema,
    annotations: destructiveMutationAnnotations,
    handler: (input, store) => cleanupTasks(store, input.days),
  });
};

/** Creates a local Scrumlord MCP server with typed task graph tools. */
export const createScrumlordMcpServer = (options: ScrumlordMcpServerOptions = {}): McpServer => {
  const server = new McpServer({ name: 'scrumlord', version: '0.0.1' });
  registerQueryTools(server, options);
  registerMutationTools(server, options);
  return server;
};

/** Runs the Scrumlord MCP server over stdio for local MCP clients. */
export const runScrumlordMcpServer = async (
  options: ScrumlordMcpServerOptions = {},
): Promise<void> => {
  const server = createScrumlordMcpServer(options);
  await server.connect(new StdioServerTransport());
};
