import { resolveTaskSession } from './agent-providers.js';
import { providerFromStartCommand } from './cli-agent-commands.js';
import { flag, flagList, required, type ParsedArguments } from './cli-arguments.js';
import { resolveTaskId } from './cli-task-id.js';
import { progressInputFromContext } from './cli-progress.js';
import { currentBranchTask } from './current-branch-task.js';
import { ScrumlordError } from './errors.js';
import {
  addTaskBlocker,
  addTaskProgress,
  addTaskTag,
  availableTasks,
  blockedTasks,
  cleanupTasks,
  clearTaskBranch,
  clearTaskPlan,
  clearTaskSession,
  completedTasks,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  removeTaskBlocker,
  removeTaskTag,
  type CountListTasksOptions,
  type CountTaskListingOptions,
  type ListTasksOptions,
  type TaskListingOptions,
  type TaskPlanFilter,
  taskProgress,
  tasksBlockedBy,
  tasksBlocking,
  tasksWithAllTags,
  tasksWithAnyTags,
  tasksWithBranch,
  tasksWithPriority,
  updateTask,
} from './task-commands.js';
import { next, remaining } from './task-queries.js';
import type { CliOptions } from './cli-types.js';
import type { CreateTaskInput, TaskStore, UpdateTaskInput } from './types.js';
import { parseAgentProvider, parsePriority, parseStatus } from './validation.js';

type StoreCommandHandler = (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
) => unknown;
type StoreCommandInputValidator = (parsed: ParsedArguments, options: CliOptions) => void;

const taskListingCommands = new Set([
  'available',
  'list',
  'blocked',
  'completed',
  'tagged',
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
  if (flags.has('deleted')) input.deleted = flag(flags, 'deleted') !== 'false';
};

const updateInputFromFlags = (flags: Map<string, string[]>): UpdateTaskInput => {
  const input: UpdateTaskInput = {};
  applyStringUpdateFlags(input, flags);
  applyPriorityUpdateFlag(input, flags);
  applyDateUpdateFlags(input, flags);
  applyBooleanUpdateFlags(input, flags);

  if (flags.has('branch')) input.branch = flag(flags, 'branch') ?? null;
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

const taskListingOptionsFrom = (parsed: ParsedArguments): TaskListingOptions => {
  const planFilter = taskPlanFilterFrom(parsed);
  return planFilter ? { plan: planFilter } : {};
};

const taskListingResultOptionsFrom = (
  parsed: ParsedArguments,
): TaskListingOptions | CountTaskListingOptions => {
  const options = taskListingOptionsFrom(parsed);
  return parsed.flags.has('count') ? { ...options, count: true } : options;
};

const listTasksOptionsFrom = (
  parsed: ParsedArguments,
): ListTasksOptions | CountListTasksOptions => {
  const options = {
    ...taskListingOptionsFrom(parsed),
    includeInactive: parsed.flags.has('all'),
  };
  return parsed.flags.has('count') ? { ...options, count: true } : options;
};

const storeCommandHandlers: Record<string, StoreCommandHandler> = {
  available: (store, parsed) => availableTasks(store, taskListingResultOptionsFrom(parsed)),
  list: (store, parsed) => listTasks(store, listTasksOptionsFrom(parsed)),
  blocked: (store, parsed) => blockedTasks(store, taskListingResultOptionsFrom(parsed)),
  completed: (store, parsed) => completedTasks(store, taskListingResultOptionsFrom(parsed)),
  get: async (store, parsed) =>
    getTask(store, await resolveTaskId(store, required(parsed.positionals, 'task id'))),
  tagged: (store, parsed) => {
    const options = taskListingResultOptionsFrom(parsed);
    if (parsed.flags.has('all')) {
      return tasksWithAllTags(store, options, ...parsed.positionals);
    }
    return tasksWithAnyTags(store, options, ...parsed.positionals);
  },
  'with-branch': (store, parsed) =>
    tasksWithBranch(
      store,
      required(parsed.positionals, 'branch'),
      taskListingResultOptionsFrom(parsed),
    ),
  'blocked-by': async (store, parsed) =>
    tasksBlockedBy(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      taskListingResultOptionsFrom(parsed),
    ),
  blocking: async (store, parsed) =>
    tasksBlocking(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      taskListingResultOptionsFrom(parsed),
    ),
  priority: (store, parsed) =>
    tasksWithPriority(
      store,
      parsePriority(Number(required(parsed.positionals, 'priority'))),
      taskListingResultOptionsFrom(parsed),
    ),
  'with-priority': (store, parsed) =>
    tasksWithPriority(
      store,
      parsePriority(Number(required(parsed.positionals, 'priority'))),
      taskListingResultOptionsFrom(parsed),
    ),
  session: async (store, parsed, options) =>
    resolveTaskSession(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      options.environment ? { environment: options.environment } : {},
    ),
  progress: async (store, parsed, options) => {
    const subcommand = parsed.positionals[0];
    if (subcommand === 'list') {
      const taskId = parsed.positionals[1]
        ? await resolveTaskId(store, parsed.positionals[1])
        : await resolveTaskId(store, 'current');
      return taskProgress(store, taskId);
    }
    if (subcommand === 'add') {
      const taskId = parsed.positionals[1]
        ? await resolveTaskId(store, parsed.positionals[1])
        : await resolveTaskId(store, 'current');
      const task = store.getTask(taskId);
      return addTaskProgress(
        store,
        taskId,
        progressInputFromContext({
          flags: parsed.flags,
          ...(options.environment !== undefined ? { environment: options.environment } : {}),
          ...(task !== null ? { task } : {}),
        }),
      );
    }
    throw new ScrumlordError(
      'invalid_progress_subcommand',
      'tasks progress subcommand must be list or add.',
    );
  },
  clear: async (store, parsed) => {
    const property = parsed.positionals[0] as string;
    const taskId = await resolveTaskId(store, parsed.positionals[1] ?? 'current');
    if (property === 'branch') return clearTaskBranch(store, taskId);
    if (property === 'plan') return clearTaskPlan(store, taskId);
    if (property === 'session') return clearTaskSession(store, taskId);
    if (property === 'start-date') return updateTask(store, taskId, { startDate: null });
    if (property === 'due-date') return updateTask(store, taskId, { dueDate: null });
    throw new ScrumlordError(
      'invalid_clear_property',
      'tasks clear expects one of branch|plan|session|start-date|due-date.',
    );
  },
  current: async (store) => await currentBranchTask(store),
  next: (store) => next(store),
  remaining: (store) => remaining(store),
  create: (store, parsed) => createTask(store, createInputFromFlags(parsed.flags)),
  update: async (store, parsed) =>
    updateTask(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      updateInputFromFlags(parsed.flags),
    ),
  delete: async (store, parsed) =>
    deleteTask(store, await resolveTaskId(store, required(parsed.positionals, 'task id')), {
      hard: parsed.flags.has('hard'),
    }),
  'add-tag': async (store, parsed) =>
    addTaskTag(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      required(parsed.positionals.slice(1), 'tag'),
    ),
  'remove-tag': async (store, parsed) =>
    removeTaskTag(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      required(parsed.positionals.slice(1), 'tag'),
    ),
  'add-blocker': async (store, parsed) =>
    addTaskBlocker(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      await resolveTaskId(store, required(parsed.positionals.slice(1), 'blocked-by task id')),
    ),
  'remove-blocker': async (store, parsed) =>
    removeTaskBlocker(
      store,
      await resolveTaskId(store, required(parsed.positionals, 'task id')),
      await resolveTaskId(store, required(parsed.positionals.slice(1), 'blocked-by task id')),
    ),
  cleanup: (store, parsed) =>
    cleanupTasks(store, cleanupDaysFrom(parsed), { hard: parsed.flags.has('hard') }),
};

export const taskStoreCommands = new Set(Object.keys(storeCommandHandlers));

const validateProgressListFlags = (flags: Map<string, string[]>): void => {
  for (const flagName of ['message', 'provider', 'session'] as const) {
    if (flags.has(flagName)) {
      throw new ScrumlordError(
        'invalid_progress_flag',
        `--${flagName} is not valid for progress list.`,
      );
    }
  }
};

const validateProgressAddFlags = (flags: Map<string, string[]>): void => {
  const explicitProvider = flags.get('provider')?.at(-1);
  if (explicitProvider !== undefined && explicitProvider.trim()) {
    parseAgentProvider(explicitProvider);
  }
  if (!flags.has('message')) {
    throw new ScrumlordError('missing_progress_message', '--message is required.');
  }
};

const storeCommandInputValidators: Partial<Record<string, StoreCommandInputValidator>> = {
  create: (parsed) => {
    createInputFromFlags(parsed.flags);
  },
  update: (parsed) => {
    updateInputFromFlags(parsed.flags);
  },
  progress: (parsed) => {
    const subcommand = parsed.positionals[0];
    if (!subcommand) {
      throw new ScrumlordError(
        'missing_subcommand',
        'tasks progress requires a subcommand: list or add.',
      );
    }
    if (subcommand !== 'list' && subcommand !== 'add') {
      throw new ScrumlordError(
        'invalid_progress_subcommand',
        'tasks progress subcommand must be list or add.',
      );
    }
    if (subcommand === 'list') validateProgressListFlags(parsed.flags);
    if (subcommand === 'add') validateProgressAddFlags(parsed.flags);
  },
  clear: (parsed) => {
    const property = parsed.positionals[0];
    if (!property) return; // caught by validatePositionals
    const valid = new Set(['branch', 'plan', 'session', 'start-date', 'due-date']);
    if (!valid.has(property)) {
      throw new ScrumlordError(
        'invalid_clear_property',
        'tasks clear expects one of branch|plan|session|start-date|due-date.',
      );
    }
  },
  cleanup: (parsed) => {
    cleanupDaysFrom(parsed);
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
  options: CliOptions,
): Promise<unknown> => {
  const handler = storeCommandHandlers[parsed.command ?? ''];
  if (!handler)
    throw new ScrumlordError('unknown_command', `Unknown command: ${parsed.command ?? ''}`);
  return await handler(store, parsed, options);
};
