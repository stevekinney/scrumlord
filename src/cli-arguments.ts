import { ScrumlordError } from './errors.js';

export type ParsedArguments = {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string[]>;
};

type CommandSpecification = {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  minPositionals?: number;
  maxPositionals?: number;
};

const noPositionals = { minPositionals: 0, maxPositionals: 0 };
const onePositional = { minPositionals: 1, maxPositionals: 1 };
const optionalTaskId = { minPositionals: 0, maxPositionals: 1 };
const optionalTaskIdWithOneArgument = { minPositionals: 1, maxPositionals: 2 };
const optionalTaskIdWithTwoArguments = { minPositionals: 2, maxPositionals: 3 };
const listingBooleanFlags = ['planned', 'unplanned', 'count'];
const taskListingCommandSpecification = {
  ...noPositionals,
  booleanFlags: listingBooleanFlags,
};
const onePositionalTaskListingCommandSpecification = {
  ...onePositional,
  booleanFlags: listingBooleanFlags,
};
const optionalTaskIdTaskListingCommandSpecification = {
  ...optionalTaskId,
  booleanFlags: listingBooleanFlags,
};

const commandSpecifications: Record<string, CommandSpecification> = {
  available: taskListingCommandSpecification,
  list: { ...noPositionals, booleanFlags: ['all', ...listingBooleanFlags] },
  blocked: taskListingCommandSpecification,
  completed: taskListingCommandSpecification,
  init: noPositionals,
  overview: noPositionals,
  help: { minPositionals: 0, maxPositionals: 2 },
  current: noPositionals,
  next: noPositionals,
  remaining: noPositionals,
  repository: { ...noPositionals, booleanFlags: ['url', 'json'] },
  pr: {
    minPositionals: 0,
    maxPositionals: 0,
    booleanFlags: ['open', 'url', 'comments', 'resolved', 'all'],
  },
  get: optionalTaskId,
  tagged: { minPositionals: 1, booleanFlags: ['all', ...listingBooleanFlags] },
  'with-branch': onePositionalTaskListingCommandSpecification,
  'blocked-by': optionalTaskIdTaskListingCommandSpecification,
  blocking: optionalTaskIdTaskListingCommandSpecification,
  priority: onePositionalTaskListingCommandSpecification,
  'with-priority': onePositionalTaskListingCommandSpecification,
  session: optionalTaskId,
  progress: optionalTaskId,
  'add-progress': {
    ...optionalTaskId,
    valueFlags: ['message', 'provider', 'session', 'event', 'tool', 'cwd'],
  },
  start: {
    ...optionalTaskId,
    valueFlags: ['cli'],
    booleanFlags: ['no-worktree', 'force', 'quiet'],
  },
  pipeline: {
    minPositionals: 0,
    maxPositionals: 0,
    valueFlags: ['cli', 'max', 'resume'],
    booleanFlags: ['recover', 'recover-then-run', 'apply', 'quiet', 'dry-run', 'json', 'once'],
  },
  resume: optionalTaskId,
  'agent-hook': onePositional,
  delete: { ...optionalTaskId, booleanFlags: ['hard'] },
  'set-status': optionalTaskIdWithOneArgument,
  'set-branch': optionalTaskIdWithOneArgument,
  'clear-branch': optionalTaskId,
  'set-plan': optionalTaskIdWithOneArgument,
  'clear-plan': optionalTaskId,
  'set-session': optionalTaskIdWithTwoArguments,
  'clear-session': optionalTaskId,
  cleanup: { ...onePositional, booleanFlags: ['hard'] },
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
      'plan',
      'provider',
      'session',
      'tag',
      'tags',
      'blocked-by',
    ],
    booleanFlags: ['draft'],
  },
  update: {
    ...optionalTaskId,
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
  },
  'add-tag': optionalTaskIdWithOneArgument,
  'remove-tag': optionalTaskIdWithOneArgument,
  'add-blocker': optionalTaskIdWithOneArgument,
  'remove-blocker': optionalTaskIdWithOneArgument,
  'sync-git-status': { ...noPositionals, booleanFlags: ['quiet', 'with-progress'] },
  setup: {
    minPositionals: 0,
    maxPositionals: 1,
    booleanFlags: [
      'skills',
      'subagents',
      'git-hooks',
      'agent-hooks',
      'prompt',
      'project',
      'user',
      'local',
      'claude',
      'codex',
      'yes',
      'all',
    ],
    valueFlags: ['agent'],
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

export const helpPath = (parsed: ParsedArguments): string[] => {
  if (parsed.command === 'help') return parsed.positionals;
  if (parsed.command === 'setup' && parsed.positionals[0] === 'status') return ['setup', 'status'];
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
