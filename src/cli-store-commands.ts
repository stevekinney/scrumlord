import { resolveTaskSession } from './agent-providers.js';
import { providerFromStartCommand } from './cli-agent-commands.js';
import { flag, flagList, required, type ParsedArguments } from './cli-arguments.js';
import { requiredTaskCommandArgument, taskIdFromArguments } from './cli-task-id.js';
import { progressInputFromFlags } from './cli-progress.js';
import { currentBranchTask } from './current-branch-task.js';
import { ScrumlordError } from './errors.js';
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
  tasksWithTag,
  updateTask,
} from './task-commands.js';
import { next, remaining } from './task-queries.js';
import type { CliOptions } from './cli-types.js';
import type { CreateTaskInput, Task, TaskStore, UpdateTaskInput } from './types.js';
import { parseAgentProvider, parsePriority, parseStatus } from './validation.js';

type StoreCommandHandler = (store: TaskStore, parsed: ParsedArguments) => unknown;
type StoreCommandInputValidator = (parsed: ParsedArguments, options: CliOptions) => void;
type TaskPlanFilter = 'planned' | 'unplanned';

const taskListingCommands = new Set([
  'available',
  'list',
  'blocked',
  'completed',
  'with-tag',
  'with-all-tags',
  'with-any-tag',
  'with-branch',
  'blocked-by',
  'blocking',
  'priority',
  'with-priority',
]);

const applyOptionalCreateFlags = (input: CreateTaskInput, flags: Map<string, string[]>): void => {
  const startDate = flag(flags, 'start-date');
  if (startDate !== undefined) input.startDate = startDate;
  const dueDate = flag(flags, 'due-date');
  if (dueDate !== undefined) input.dueDate = dueDate;
  const branch = flag(flags, 'branch');
  if (branch !== undefined) input.branch = branch;
  const plan = flag(flags, 'plan');
  if (plan !== undefined) input.plan = plan;
  const provider = flag(flags, 'provider');
  if (provider !== undefined)
    input.provider = provider.trim() ? parseAgentProvider(provider) : null;
  const session = flag(flags, 'session');
  if (session !== undefined) input.session = session;
  const parent = flag(flags, 'parent');
  if (parent !== undefined) input.parent = parent;
};

const createInputFromFlags = (flags: Map<string, string[]>): CreateTaskInput => {
  const title = flag(flags, 'title');
  if (!title) throw new ScrumlordError('missing_title', '--title is required.');

  const input: CreateTaskInput = {
    title,
    description: flag(flags, 'description') ?? '',
    priority: parsePriority(Number(flag(flags, 'priority') ?? 1)),
    status: flags.has('draft') ? 'draft' : parseStatus(flag(flags, 'status') ?? 'ready'),
    tags: flagList(flags, 'tag', {
      code: 'invalid_tag',
      message: 'Tags cannot be empty.',
    }).concat(flagList(flags, 'tags', { code: 'invalid_tag', message: 'Tags cannot be empty.' })),
    blockedBy: flagList(flags, 'blocked-by'),
  };
  applyOptionalCreateFlags(input, flags);

  return input;
};

const applyStringUpdateFlags = (input: UpdateTaskInput, flags: Map<string, string[]>): void => {
  const stringSetters = {
    title: (value: string) => {
      input.title = value;
    },
    status: (value: string) => {
      input.status = parseStatus(value);
    },
    description: (value: string) => {
      input.description = value;
    },
    provider: (value: string) => {
      input.provider = value.trim() ? parseAgentProvider(value) : null;
    },
    session: (value: string) => {
      input.session = value;
    },
    plan: (value: string) => {
      input.plan = value;
    },
  };

  for (const [name, setter] of Object.entries(stringSetters)) {
    const value = flag(flags, name);
    if (value !== undefined) setter(value);
  }
};

const applyPriorityUpdateFlag = (input: UpdateTaskInput, flags: Map<string, string[]>): void => {
  const priority = flag(flags, 'priority');
  if (priority !== undefined) input.priority = parsePriority(Number(priority));
};

const applyDateUpdateFlags = (input: UpdateTaskInput, flags: Map<string, string[]>): void => {
  for (const name of ['start-date', 'due-date'] as const) {
    if (!flags.has(name)) continue;
    const key = name === 'start-date' ? 'startDate' : 'dueDate';
    input[key] = flag(flags, name) ?? null;
  }
};

const applyBooleanUpdateFlags = (input: UpdateTaskInput, flags: Map<string, string[]>): void => {
  for (const name of ['archived', 'deleted'] as const) {
    if (flags.has(name)) input[name] = flag(flags, name) !== 'false';
  }
};

const updateInputFromFlags = (flags: Map<string, string[]>): UpdateTaskInput => {
  const input: UpdateTaskInput = {};
  applyStringUpdateFlags(input, flags);
  applyPriorityUpdateFlag(input, flags);
  applyDateUpdateFlags(input, flags);
  applyBooleanUpdateFlags(input, flags);

  if (flags.has('branch')) input.branch = flag(flags, 'branch') ?? null;
  if (flags.has('parent')) input.parent = flag(flags, 'parent') ?? null;
  return input;
};

const cleanupDaysFrom = (parsed: ParsedArguments): number => {
  const days = Number(required(parsed.positionals, 'days'));
  if (!Number.isInteger(days) || days < 0) {
    throw new ScrumlordError(
      'invalid_cleanup_days',
      'Cleanup days must be a non-negative integer.',
    );
  }
  return days;
};

const taskPlanFilterFrom = (parsed: ParsedArguments): TaskPlanFilter | null => {
  if (parsed.flags.has('planned') && parsed.flags.has('unplanned')) {
    throw new ScrumlordError(
      'plan_filter_conflict',
      'Use either --planned or --unplanned, not both.',
    );
  }
  if (parsed.flags.has('planned')) return 'planned';
  if (parsed.flags.has('unplanned')) return 'unplanned';
  return null;
};

const filterTaskListByPlan = (parsed: ParsedArguments, tasks: Task[]): Task[] => {
  const planFilter = taskPlanFilterFrom(parsed);
  if (!planFilter) return tasks;
  return tasks.filter((task) =>
    planFilter === 'planned' ? task.plan !== null : task.plan === null,
  );
};

const storeCommandHandlers: Record<string, StoreCommandHandler> = {
  available: (store, parsed) => filterTaskListByPlan(parsed, availableTasks(store)),
  list: (store, parsed) =>
    filterTaskListByPlan(parsed, listTasks(store, { includeInactive: parsed.flags.has('all') })),
  blocked: (store, parsed) => filterTaskListByPlan(parsed, blockedTasks(store)),
  completed: (store, parsed) => filterTaskListByPlan(parsed, completedTasks(store)),
  get: async (store, parsed) => getTask(store, await taskIdFromArguments(store, parsed)),
  'with-tag': (store, parsed) =>
    filterTaskListByPlan(parsed, tasksWithTag(store, required(parsed.positionals, 'tag'))),
  'with-all-tags': (store, parsed) =>
    filterTaskListByPlan(parsed, tasksWithAllTags(store, ...parsed.positionals)),
  'with-any-tag': (store, parsed) =>
    filterTaskListByPlan(parsed, tasksWithAnyTags(store, ...parsed.positionals)),
  'with-branch': (store, parsed) =>
    filterTaskListByPlan(parsed, tasksWithBranch(store, required(parsed.positionals, 'branch'))),
  'blocked-by': async (store, parsed) =>
    filterTaskListByPlan(parsed, tasksBlockedBy(store, await taskIdFromArguments(store, parsed))),
  blocking: async (store, parsed) =>
    filterTaskListByPlan(parsed, tasksBlocking(store, await taskIdFromArguments(store, parsed))),
  priority: (store, parsed) =>
    filterTaskListByPlan(
      parsed,
      tasksWithPriority(store, parsePriority(Number(required(parsed.positionals, 'priority')))),
    ),
  'with-priority': (store, parsed) =>
    filterTaskListByPlan(
      parsed,
      tasksWithPriority(store, parsePriority(Number(required(parsed.positionals, 'priority')))),
    ),
  session: async (store, parsed) =>
    resolveTaskSession(store, await taskIdFromArguments(store, parsed)),
  progress: async (store, parsed) => taskProgress(store, await taskIdFromArguments(store, parsed)),
  'current-task': async (store) => await currentBranchTask(store),
  next: (store) => next(store),
  remaining: (store) => remaining(store),
  create: (store, parsed) => createTask(store, createInputFromFlags(parsed.flags)),
  update: async (store, parsed) =>
    updateTask(store, await taskIdFromArguments(store, parsed), updateInputFromFlags(parsed.flags)),
  'add-progress': async (store, parsed) =>
    addTaskProgress(
      store,
      await taskIdFromArguments(store, parsed),
      progressInputFromFlags(parsed.flags),
    ),
  'set-status': async (store, parsed) =>
    setTaskStatus(
      store,
      await taskIdFromArguments(store, parsed, 1),
      parseStatus(requiredTaskCommandArgument(parsed, 1, 'status')),
    ),
  'set-branch': async (store, parsed) =>
    setTaskBranch(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'branch'),
    ),
  'clear-branch': async (store, parsed) =>
    clearTaskBranch(store, await taskIdFromArguments(store, parsed)),
  'set-plan': async (store, parsed) =>
    setTaskPlan(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'plan'),
    ),
  'clear-plan': async (store, parsed) =>
    clearTaskPlan(store, await taskIdFromArguments(store, parsed)),
  'set-session': async (store, parsed) =>
    setTaskSession(
      store,
      await taskIdFromArguments(store, parsed, 2),
      parseAgentProvider(requiredTaskCommandArgument(parsed, 2, 'provider')),
      requiredTaskCommandArgument(parsed, 2, 'session', 1),
    ),
  'clear-session': async (store, parsed) =>
    clearTaskSession(store, await taskIdFromArguments(store, parsed)),
  delete: async (store, parsed) => deleteTask(store, await taskIdFromArguments(store, parsed)),
  archive: async (store, parsed) => archiveTask(store, await taskIdFromArguments(store, parsed)),
  restore: async (store, parsed) => restoreTask(store, await taskIdFromArguments(store, parsed)),
  'add-tag': async (store, parsed) =>
    addTaskTag(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'tag'),
    ),
  'remove-tag': async (store, parsed) =>
    removeTaskTag(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'tag'),
    ),
  'set-parent': async (store, parsed) =>
    setTaskParent(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'parent id'),
    ),
  'clear-parent': async (store, parsed) =>
    clearTaskParent(store, await taskIdFromArguments(store, parsed)),
  'add-blocker': async (store, parsed) =>
    addTaskBlocker(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'blocked-by task id'),
    ),
  'remove-blocker': async (store, parsed) =>
    removeTaskBlocker(
      store,
      await taskIdFromArguments(store, parsed, 1),
      requiredTaskCommandArgument(parsed, 1, 'blocked-by task id'),
    ),
  cleanup: (store, parsed) => cleanupTasks(store, cleanupDaysFrom(parsed)),
};

export const taskStoreCommands = new Set(Object.keys(storeCommandHandlers));

const storeCommandInputValidators: Partial<Record<string, StoreCommandInputValidator>> = {
  create: (parsed) => {
    createInputFromFlags(parsed.flags);
  },
  update: (parsed) => {
    updateInputFromFlags(parsed.flags);
  },
  'add-progress': (parsed) => {
    progressInputFromFlags(parsed.flags);
  },
  cleanup: (parsed) => {
    cleanupDaysFrom(parsed);
  },
  'set-status': (parsed) => {
    parseStatus(requiredTaskCommandArgument(parsed, 1, 'status'));
  },
  'set-session': (parsed) => {
    parseAgentProvider(requiredTaskCommandArgument(parsed, 2, 'provider'));
  },
  start: (parsed, options) => {
    providerFromStartCommand(parsed, options);
  },
  'agent-hook': (parsed) => {
    parseAgentProvider(required(parsed.positionals, 'provider'));
  },
  priority: (parsed) => {
    parsePriority(Number(required(parsed.positionals, 'priority')));
  },
  'with-priority': (parsed) => {
    parsePriority(Number(required(parsed.positionals, 'priority')));
  },
};

export const validateStoreCommandInput = (parsed: ParsedArguments, options: CliOptions): void => {
  const validator = parsed.command ? storeCommandInputValidators[parsed.command] : undefined;
  validator?.(parsed, options);
  if (parsed.command && taskListingCommands.has(parsed.command)) taskPlanFilterFrom(parsed);
};

export const runTaskStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
): Promise<unknown> => {
  const handler = storeCommandHandlers[parsed.command ?? ''];
  if (!handler)
    throw new ScrumlordError('unknown_command', `Unknown command: ${parsed.command ?? ''}`);
  return await handler(store, parsed);
};
