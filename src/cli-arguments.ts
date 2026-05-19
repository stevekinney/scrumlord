import { ScrumlordError } from './errors.js';

export type ParsedArguments = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
};

export type PositionalKind =
  | 'task-id'
  | 'tag'
  | 'tag-action'
  | 'blocker-action'
  | 'status'
  | 'priority'
  | 'shell'
  | 'file'
  | 'session-id'
  | 'free-text';

export type PositionalVariant = readonly PositionalKind[];

export type CommandSpecification = {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  minPositionals?: number;
  maxPositionals?: number;
  /** One or more allowed positional shapes. Each variant lists kinds, one per position. */
  positionalVariants?: readonly PositionalVariant[];
  /** When false, hides this command from generated completion lists. Defaults to true. */
  visibleInCompletions?: boolean;
};

/**
 * Adds `--json` to a command spec's boolean flags. Used for every command
 * whose contract resolves to `jsonData` or `bespoke`. Mechanical helper —
 * never edit `booleanFlags` directly when the intent is "this command
 * supports `--json`".
 */
const withJsonFlag = <T extends CommandSpecification>(spec: T): T => ({
  ...spec,
  booleanFlags: spec.booleanFlags?.includes('json')
    ? spec.booleanFlags
    : [...(spec.booleanFlags ?? []), 'json'],
});

const noPositionals = { minPositionals: 0, maxPositionals: 0 };
const onePositional = { minPositionals: 1, maxPositionals: 1 };
const requiredTaskId = { minPositionals: 1, maxPositionals: 1 };
const listingBooleanFlags = ['planned', 'unplanned', 'count'];
const taskListingCommandSpecification = {
  ...noPositionals,
  booleanFlags: listingBooleanFlags,
};
const onePositionalTaskListingCommandSpecification = {
  ...onePositional,
  booleanFlags: listingBooleanFlags,
};
const requiredTaskIdTaskListingCommandSpecification = {
  ...requiredTaskId,
  booleanFlags: listingBooleanFlags,
};

/** All command specifications — exported for use by the completions generator. */
export const commandSpecifications: Record<string, CommandSpecification> = {
  available: withJsonFlag(taskListingCommandSpecification),
  list: withJsonFlag({
    ...noPositionals,
    booleanFlags: ['all', 'completed', 'incomplete', ...listingBooleanFlags],
  }),
  blocked: withJsonFlag(taskListingCommandSpecification),
  completed: withJsonFlag(taskListingCommandSpecification),
  init: withJsonFlag(noPositionals),
  overview: withJsonFlag({ ...noPositionals, booleanFlags: ['sync', 'watch'] }),
  help: { minPositionals: 0, maxPositionals: 2 },
  current: withJsonFlag(noPositionals),
  next: withJsonFlag(noPositionals),
  remaining: withJsonFlag(noPositionals),
  repository: { ...noPositionals, booleanFlags: ['url', 'json'] },
  pr: {
    minPositionals: 0,
    maxPositionals: 0,
    booleanFlags: [
      'open',
      'url',
      'comments',
      'resolved',
      'all',
      'sync',
      'quiet',
      'poll',
      'watch',
      'json',
    ],
    valueFlags: ['max-polls', 'poll-interval', 'bot-patterns'],
  },
  get: withJsonFlag({ ...requiredTaskId, positionalVariants: [['task-id']] }),
  tagged: withJsonFlag({
    minPositionals: 1,
    booleanFlags: ['all', ...listingBooleanFlags],
    positionalVariants: [['tag']],
  }),
  tags: withJsonFlag({
    minPositionals: 1,
    maxPositionals: 3,
    positionalVariants: [['task-id'], ['tag-action', 'task-id', 'tag']],
  }),
  blockers: withJsonFlag({
    minPositionals: 1,
    maxPositionals: 3,
    booleanFlags: listingBooleanFlags,
    positionalVariants: [['task-id'], ['blocker-action', 'task-id', 'task-id']],
  }),
  'with-branch': withJsonFlag({
    ...onePositionalTaskListingCommandSpecification,
    positionalVariants: [['free-text']],
  }),
  'blocked-by': withJsonFlag({
    ...requiredTaskIdTaskListingCommandSpecification,
    positionalVariants: [['task-id']],
  }),
  blocking: withJsonFlag({
    ...requiredTaskIdTaskListingCommandSpecification,
    positionalVariants: [['task-id']],
  }),
  priority: withJsonFlag({
    ...onePositionalTaskListingCommandSpecification,
    positionalVariants: [['priority']],
  }),
  status: withJsonFlag({
    ...onePositionalTaskListingCommandSpecification,
    positionalVariants: [['status']],
  }),
  session: withJsonFlag({ ...requiredTaskId, positionalVariants: [['task-id']] }),
  progress: withJsonFlag({
    minPositionals: 0,
    maxPositionals: 2,
    valueFlags: ['message', 'provider', 'session'],
    booleanFlags: ['full'],
  }),
  clear: withJsonFlag({ minPositionals: 1, maxPositionals: 2 }),
  start: withJsonFlag({
    ...requiredTaskId,
    valueFlags: ['cli'],
    booleanFlags: ['no-worktree', 'force', 'quiet'],
    positionalVariants: [['task-id']],
  }),
  pipeline: {
    minPositionals: 0,
    maxPositionals: 0,
    valueFlags: ['cli', 'max', 'resume'],
    booleanFlags: ['recover', 'recover-then-run', 'apply', 'quiet', 'dry-run', 'json', 'once'],
  },
  resume: withJsonFlag({ ...requiredTaskId, positionalVariants: [['task-id']] }),
  'agent-hook': withJsonFlag({ ...onePositional, positionalVariants: [['free-text']] }),
  delete: withJsonFlag({
    ...requiredTaskId,
    booleanFlags: ['hard'],
    positionalVariants: [['task-id']],
  }),
  cleanup: withJsonFlag({
    minPositionals: 0,
    maxPositionals: 1,
    booleanFlags: ['hard', 'recover-orphans', 'orphans-only', 'dry-run', 'prompt'],
  }),
  search: withJsonFlag({
    minPositionals: 0,
    maxPositionals: 1,
    valueFlags: ['title', 'description'],
    booleanFlags: ['all', ...listingBooleanFlags],
    positionalVariants: [[], ['free-text']],
  }),
  plan: { minPositionals: 0, maxPositionals: 1, positionalVariants: [[], ['task-id']] },
  create: withJsonFlag({
    ...noPositionals,
    valueFlags: [
      'title',
      'description',
      'priority',
      'status',
      'start-date',
      'due-date',
      'branch',
      'plan',
      'provider',
      'session',
      'tag',
      'tags',
      'blocked-by',
    ],
    booleanFlags: ['draft'],
  }),
  update: withJsonFlag({
    ...requiredTaskId,
    valueFlags: [
      'title',
      'description',
      'priority',
      'status',
      'start-date',
      'due-date',
      'branch',
      'plan',
      'provider',
      'session',
      'deleted',
    ],
    positionalVariants: [['task-id']],
  }),
  teleport: { ...onePositional, booleanFlags: ['json'] },
  setup: withJsonFlag({
    minPositionals: 0,
    maxPositionals: 1,
    booleanFlags: [
      'skills',
      'subagents',
      'git-hooks',
      'agent-hooks',
      'prompt',
      'shell',
      'project',
      'user',
      'local',
      'claude',
      'codex',
      'yes',
      'all',
    ],
    valueFlags: ['agent'],
  }),
  completions: {
    minPositionals: 1,
    maxPositionals: 1,
    booleanFlags: ['install', 'force'],
    valueFlags: ['path'],
    positionalVariants: [['shell']],
  },
  'completions-data': {
    minPositionals: 1,
    maxPositionals: 1,
    positionalVariants: [['free-text']],
    visibleInCompletions: false,
  },
};

const appendFlag = (flags: Map<string, string[]>, name: string, value: string): void => {
  flags.set(name, [...(flags.get(name) ?? []), value]);
};

const flagKind = (
  specification: CommandSpecification | undefined,
  name: string,
): 'unknown' | 'boolean' | 'value' => {
  if (name === 'help') return 'boolean';
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

export const parseArguments = (argv: string[]): ParsedArguments => {
  if (argv.length === 0) return { command: 'help', positionals: [], flags: new Map() };
  if (argv[0] === '--help')
    return { command: 'help', positionals: argv.slice(1), flags: new Map() };
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

export const isHelpRequest = (parsed: ParsedArguments): boolean => {
  return parsed.command === 'help' || parsed.flags.has('help');
};

const progressHelpPath = (positionals: string[]): string[] => {
  const subcommand = positionals[0];
  if (subcommand === 'list' || subcommand === 'add') return ['progress', subcommand];
  return ['progress'];
};

const tagsHelpPath = (positionals: string[]): string[] => {
  const subcommand = positionals[0];
  if (subcommand === 'add' || subcommand === 'remove') return ['tags', subcommand];
  return ['tags'];
};

const blockersHelpPath = (positionals: string[]): string[] => {
  const subcommand = positionals[0];
  if (subcommand === 'add' || subcommand === 'remove') return ['blockers', subcommand];
  return ['blockers'];
};

export const helpPath = (parsed: ParsedArguments): string[] => {
  if (parsed.command === 'help') return parsed.positionals;
  if (parsed.command === 'setup' && parsed.positionals[0] === 'status') return ['setup', 'status'];
  if (parsed.command === 'progress') return progressHelpPath(parsed.positionals);
  if (parsed.command === 'tags') return tagsHelpPath(parsed.positionals);
  if (parsed.command === 'blockers') return blockersHelpPath(parsed.positionals);
  return [parsed.command ?? ''];
};

const plural = (count: number): string => (count === 1 ? '' : 's');

const unexpectedArgumentMessage = (command: string, minimum: number, maximum: number): string => {
  const expectation =
    minimum === maximum
      ? `exactly ${maximum} argument${plural(maximum)}`
      : `at most ${maximum} argument${plural(maximum)}`;
  return `${command} expects ${expectation}.`;
};

export const validatePositionals = (parsed: ParsedArguments): void => {
  if (!parsed.command) return;
  const specification = commandSpecifications[parsed.command];
  if (!specification) return;

  const count = parsed.positionals.length;
  const minimum = specification.minPositionals ?? 0;
  const maximum = specification.maxPositionals;
  if (count < minimum) {
    const expectation =
      maximum !== undefined && minimum === maximum
        ? `exactly ${minimum} argument${plural(minimum)}`
        : `at least ${minimum} argument${plural(minimum)}`;
    throw new ScrumlordError('missing_argument', `${parsed.command} expects ${expectation}.`);
  }

  if (maximum === undefined || count <= maximum) return;
  throw new ScrumlordError(
    'unexpected_argument',
    unexpectedArgumentMessage(parsed.command, minimum, maximum),
  );
};

export const required = (values: string[], name: string): string => {
  const value = values[0];
  if (!value) throw new ScrumlordError('missing_argument', `${name} is required.`);
  return value;
};

export const flag = (flags: Map<string, string[]>, name: string): string | undefined =>
  flags.get(name)?.at(-1);

export const flagList = (
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

/**
 * Maps flag names to their value kinds for completions.
 * Only includes flags whose values have meaningful completion candidates.
 */
export const flagValueKinds: Record<string, PositionalKind> = {
  status: 'status',
  priority: 'priority',
  provider: 'free-text',
  cli: 'free-text',
  plan: 'file',
};
