import { createTaskStore } from './database.js';
import { ScrumlordError, errorMessage } from './errors.js';
import { setupGitHooks } from './git-hooks.js';
import { syncGitStatus } from './git-status.js';
import { resolveProjectRoot } from './root-resolution.js';
import { setupSkills, skillTargets, type SkillTarget } from './skills.js';
import type { CreateTaskInput, TaskStore, UpdateTaskInput } from './types.js';
import { parsePriority, parseStatus } from './validation.js';

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type CliOptions = {
  cwd?: string;
  createStore?: (cwd: string) => Promise<TaskStore>;
  setupGitHooks?: (projectRoot: string) => Promise<unknown>;
  syncGitStatus?: (store: TaskStore) => Promise<unknown>;
  github?: {
    pullRequestUrl(projectRoot: string, open: boolean): Promise<unknown>;
    pullRequestStatus(projectRoot: string): Promise<unknown>;
    unresolvedReviewComments(projectRoot: string): Promise<unknown>;
    continuousIntegrationStatus(projectRoot: string): Promise<unknown>;
  };
};

type ParsedArguments = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
};

type StoreCommandHandler = (store: TaskStore, parsed: ParsedArguments) => unknown;
type BoundaryCommandHandler = (parsed: ParsedArguments, options: CliOptions) => Promise<CliResult>;
type CommandSpecification = {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  minPositionals?: number;
  maxPositionals?: number;
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const success = (value: unknown): CliResult => ({ exitCode: 0, stdout: json(value), stderr: '' });
const noPositionals = { minPositionals: 0, maxPositionals: 0 };
const onePositional = { minPositionals: 1, maxPositionals: 1 };
const twoPositionals = { minPositionals: 2, maxPositionals: 2 };

const commandSpecifications: Record<string, CommandSpecification> = {
  available: noPositionals,
  blocked: noPositionals,
  completed: noPositionals,
  next: noPositionals,
  pr: { minPositionals: 0, maxPositionals: 1, booleanFlags: ['open', 'url'] },
  comments: noPositionals,
  ci: noPositionals,
  get: onePositional,
  'with-tag': onePositional,
  'with-all-tags': { minPositionals: 1 },
  'with-any-tag': { minPositionals: 1 },
  'with-branch': onePositional,
  'blocked-by': onePositional,
  blocking: onePositional,
  priority: onePositional,
  'with-priority': onePositional,
  delete: onePositional,
  archive: onePositional,
  restore: onePositional,
  'clear-parent': onePositional,
  cleanup: onePositional,
  create: {
    ...noPositionals,
    valueFlags: [
      'title',
      'description',
      'priority',
      'status',
      'start-date',
      'due-date',
      'branch',
      'parent',
      'tag',
      'tags',
      'blocked-by',
    ],
    booleanFlags: ['draft'],
  },
  update: {
    ...onePositional,
    valueFlags: [
      'title',
      'description',
      'priority',
      'status',
      'start-date',
      'due-date',
      'branch',
      'parent',
      'archived',
      'deleted',
    ],
  },
  'add-tag': twoPositionals,
  'remove-tag': twoPositionals,
  'set-parent': twoPositionals,
  'add-blocker': twoPositionals,
  'remove-blocker': twoPositionals,
  'sync-git-status': { ...noPositionals, booleanFlags: ['quiet'] },
  'setup-skills': { minPositionals: 0, maxPositionals: 1, booleanFlags: ['all'] },
  'setup-git-hooks': noPositionals,
};

const appendFlag = (flags: Map<string, string[]>, name: string, value: string): void => {
  flags.set(name, [...(flags.get(name) ?? []), value]);
};

const flagKind = (
  specification: CommandSpecification | undefined,
  name: string,
): 'unknown' | 'boolean' | 'value' => {
  if (!specification) return 'value';
  if (specification.booleanFlags?.includes(name)) return 'boolean';
  if (specification.valueFlags?.includes(name)) return 'value';
  return 'unknown';
};

const parseFlag = (
  command: string | undefined,
  specification: CommandSpecification | undefined,
  flags: Map<string, string[]>,
  value: string,
  next: string | undefined,
): number => {
  const name = value.slice(2);
  const kind = flagKind(specification, name);
  if (kind === 'unknown') {
    throw new ScrumlordError('unknown_flag', `Unknown flag for ${command}: --${name}.`);
  }
  if (kind === 'boolean') {
    appendFlag(flags, name, 'true');
    return 0;
  }
  if (!next || next.startsWith('--')) {
    throw new ScrumlordError('missing_flag_value', `--${name} requires a value.`);
  }
  appendFlag(flags, name, next);
  return 1;
};

const parseArguments = (argv: string[]): ParsedArguments => {
  const [command, ...rest] = argv;
  const specification = command ? commandSpecifications[command] : undefined;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value?.startsWith('--')) {
      positionals.push(value ?? '');
      continue;
    }

    index += parseFlag(command, specification, flags, value, rest[index + 1]);
  }

  return { command, positionals, flags };
};

const plural = (count: number): string => (count === 1 ? '' : 's');

const unexpectedArgumentMessage = (command: string, minimum: number, maximum: number): string => {
  const expectation =
    minimum === maximum
      ? `exactly ${maximum} argument${plural(maximum)}`
      : `at most ${maximum} argument${plural(maximum)}`;
  return `${command} expects ${expectation}.`;
};

const validatePositionals = (parsed: ParsedArguments): void => {
  if (!parsed.command) return;
  const specification = commandSpecifications[parsed.command];
  if (!specification) return;

  const count = parsed.positionals.length;
  const minimum = specification.minPositionals ?? 0;
  const maximum = specification.maxPositionals;
  if (count < minimum) {
    throw new ScrumlordError(
      'missing_argument',
      `${parsed.command} expects at least ${minimum} argument${plural(minimum)}.`,
    );
  }

  if (maximum === undefined || count <= maximum) return;
  throw new ScrumlordError(
    'unexpected_argument',
    unexpectedArgumentMessage(parsed.command, minimum, maximum),
  );
};

const required = (values: string[], name: string): string => {
  const value = values[0];
  if (!value) throw new ScrumlordError('missing_argument', `${name} is required.`);
  return value;
};

const flag = (flags: Map<string, string[]>, name: string): string | undefined =>
  flags.get(name)?.at(-1);

const flagList = (
  flags: Map<string, string[]>,
  name: string,
  emptyError: { code: string; message: string } = {
    code: 'invalid_flag_list',
    message: `--${name} must include at least one value.`,
  },
): string[] => {
  const values = (flags.get(name) ?? []).flatMap((value) => value.split(',')).filter(Boolean);
  if (flags.has(name) && values.length === 0) {
    throw new ScrumlordError(emptyError.code, emptyError.message);
  }
  return values;
};

const isSkillTarget = (target: string): target is SkillTarget =>
  skillTargets.some((value) => value === target);

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
  const optionalFields = [
    ['start-date', 'startDate'],
    ['due-date', 'dueDate'],
    ['branch', 'branch'],
    ['parent', 'parent'],
  ] as const;

  for (const [flagName, inputKey] of optionalFields) {
    const value = flag(flags, flagName);
    if (value !== undefined) input[inputKey] = value;
  }

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

const taskId = (parsed: ParsedArguments): string => required(parsed.positionals, 'task id');

const secondPositional = (parsed: ParsedArguments, name: string): string => {
  return required(parsed.positionals.slice(1), name);
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

const storeCommandHandlers: Record<string, StoreCommandHandler> = {
  available: (store) => store.available(),
  blocked: (store) => store.blocked(),
  completed: (store) => store.completed(),
  get: (store, parsed) => store.getTask(taskId(parsed)),
  'with-tag': (store, parsed) => store.withTag(required(parsed.positionals, 'tag')),
  'with-all-tags': (store, parsed) => store.withAllTags(...parsed.positionals),
  'with-any-tag': (store, parsed) => store.withAnyTag(...parsed.positionals),
  'with-branch': (store, parsed) => store.withBranch(required(parsed.positionals, 'branch')),
  'blocked-by': (store, parsed) => store.blockedBy(taskId(parsed)),
  blocking: (store, parsed) => store.blocking(taskId(parsed)),
  priority: (store, parsed) => store.withPriority(Number(required(parsed.positionals, 'priority'))),
  'with-priority': (store, parsed) =>
    store.withPriority(Number(required(parsed.positionals, 'priority'))),
  next: (store) => store.next(),
  create: (store, parsed) => store.create(createInputFromFlags(parsed.flags)),
  update: (store, parsed) => store.update(taskId(parsed), updateInputFromFlags(parsed.flags)),
  delete: (store, parsed) => store.delete(taskId(parsed)),
  archive: (store, parsed) => store.archive(taskId(parsed)),
  restore: (store, parsed) => store.restore(taskId(parsed)),
  'add-tag': (store, parsed) => store.addTag(taskId(parsed), secondPositional(parsed, 'tag')),
  'remove-tag': (store, parsed) => store.removeTag(taskId(parsed), secondPositional(parsed, 'tag')),
  'set-parent': (store, parsed) =>
    store.setParent(taskId(parsed), secondPositional(parsed, 'parent id')),
  'clear-parent': (store, parsed) => store.clearParent(taskId(parsed)),
  'add-blocker': (store, parsed) =>
    store.addBlocker(taskId(parsed), secondPositional(parsed, 'blocked-by task id')),
  'remove-blocker': (store, parsed) =>
    store.removeBlocker(taskId(parsed), secondPositional(parsed, 'blocked-by task id')),
  cleanup: (store, parsed) => store.cleanup(cleanupDaysFrom(parsed)),
};

const storeCommands = new Set([...Object.keys(storeCommandHandlers), 'sync-git-status']);

const validateStoreCommandInput = (parsed: ParsedArguments): void => {
  if (parsed.command === 'create') createInputFromFlags(parsed.flags);
  if (parsed.command === 'update') updateInputFromFlags(parsed.flags);
  if (parsed.command === 'cleanup') cleanupDaysFrom(parsed);
  if (parsed.command === 'priority' || parsed.command === 'with-priority') {
    parsePriority(Number(required(parsed.positionals, 'priority')));
  }
};

const runStoreCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<unknown> => {
  if (parsed.command === 'sync-git-status') {
    return await (options.syncGitStatus ?? syncGitStatus)(store);
  }

  const handler = storeCommandHandlers[parsed.command ?? ''];
  if (!handler)
    throw new ScrumlordError('unknown_command', `Unknown command: ${parsed.command ?? ''}`);
  return await handler(store, parsed);
};

const normalizeSkillTarget = (parsed: ParsedArguments): SkillTarget | '--all' => {
  const requestedTarget = parsed.flags.has('all')
    ? '--all'
    : required(parsed.positionals, 'skill target');
  if (requestedTarget === '-all' || requestedTarget === '--all') return '--all';
  if (isSkillTarget(requestedTarget)) return requestedTarget;
  throw new ScrumlordError(
    'invalid_skill_target',
    'Skill target must be codex, claude, cursor, or --all.',
  );
};

const githubModule = async (options: CliOptions): Promise<NonNullable<CliOptions['github']>> => {
  return options.github ?? (await import('./github.js'));
};

const runPullRequestBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  const subcommand = parsed.positionals[0];
  if (subcommand === 'status') return success(await github.pullRequestStatus(root));
  if (subcommand) {
    throw new ScrumlordError('unknown_command', `Unknown pull request command: pr ${subcommand}.`);
  }
  return success(await github.pullRequestUrl(root, parsed.flags.has('open')));
};

const runCommentsBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  return success(await github.unresolvedReviewComments(root));
};

const runContinuousIntegrationBoundaryCommand: BoundaryCommandHandler = async (
  _parsed,
  options,
) => {
  const github = await githubModule(options);
  const root = await resolveProjectRoot(options.cwd);
  return success(await github.continuousIntegrationStatus(root));
};

const runSetupSkillsBoundaryCommand: BoundaryCommandHandler = async (parsed, options) => {
  const root = await resolveProjectRoot(options.cwd);
  return success(await setupSkills(root, normalizeSkillTarget(parsed)));
};

const runSetupGitHooksBoundaryCommand: BoundaryCommandHandler = async (_parsed, options) => {
  const root = await resolveProjectRoot(options.cwd);
  return success(await (options.setupGitHooks ?? setupGitHooks)(root));
};

const boundaryCommandHandlers: Record<string, BoundaryCommandHandler> = {
  pr: runPullRequestBoundaryCommand,
  comments: runCommentsBoundaryCommand,
  ci: runContinuousIntegrationBoundaryCommand,
  'setup-skills': runSetupSkillsBoundaryCommand,
  'setup-git-hooks': runSetupGitHooksBoundaryCommand,
};

const runBoundaryCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
): Promise<CliResult | undefined> => {
  const handler = parsed.command ? boundaryCommandHandlers[parsed.command] : undefined;
  return handler ? await handler(parsed, options) : undefined;
};

const openStore = async (options: CliOptions): Promise<TaskStore> => {
  if (options.createStore) return await options.createStore(options.cwd ?? process.cwd());
  return await createTaskStore(options.cwd === undefined ? {} : { cwd: options.cwd });
};

/** Runs the tasks CLI and returns captured output for process wrappers and tests. */
export const runTasksCli = async (argv: string[], options: CliOptions = {}): Promise<CliResult> => {
  try {
    const parsed = parseArguments(argv);
    if (!parsed.command) throw new ScrumlordError('missing_command', 'A command is required.');
    validatePositionals(parsed);

    const boundaryResult = await runBoundaryCommand(parsed, options);
    if (boundaryResult) return boundaryResult;
    if (!storeCommands.has(parsed.command)) {
      throw new ScrumlordError('unknown_command', `Unknown command: ${parsed.command}`);
    }
    validateStoreCommandInput(parsed);

    const store = await openStore(options);
    try {
      const value = await runStoreCommand(store, parsed, options);
      if (parsed.command === 'sync-git-status' && parsed.flags.has('quiet')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return success(value);
    } finally {
      store.close();
    }
  } catch (error) {
    const code = error instanceof ScrumlordError ? error.code : 'unexpected_error';
    return {
      exitCode: 1,
      stdout: '',
      stderr: json({ error: { code, message: errorMessage(error) } }),
    };
  }
};
