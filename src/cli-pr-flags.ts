import type { ParsedArguments } from './cli-arguments.js';
import { ScrumlordError } from './errors.js';

type PullRequestFlagRule = { when: boolean; message: string };

const commentsRules = (
  url: boolean,
  open: boolean,
  commentsLike: boolean,
  resolved: boolean,
  all: boolean,
): PullRequestFlagRule[] => [
  { when: url && (open || commentsLike), message: '--url cannot be combined with other pr flags.' },
  {
    when: open && commentsLike,
    message: '--open cannot be combined with --comments / --resolved / --all.',
  },
  { when: (resolved || all) && !commentsLike, message: '--resolved and --all require --comments.' },
  { when: resolved && all, message: '--resolved and --all are mutually exclusive.' },
];

const syncRules = (
  sync: boolean,
  quiet: boolean,
  url: boolean,
  open: boolean,
  commentsLike: boolean,
): PullRequestFlagRule[] => [
  { when: quiet && !sync, message: '--quiet requires --sync.' },
  {
    when: sync && (url || open || commentsLike),
    message: '--sync cannot be combined with --url, --open, --comments, --resolved, or --all.',
  },
];

const pollRules = (
  poll: boolean,
  url: boolean,
  open: boolean,
  sync: boolean,
  quiet: boolean,
  commentsLike: boolean,
): PullRequestFlagRule[] => [
  {
    when: poll && (url || open || sync || quiet || commentsLike),
    message:
      '--poll cannot be combined with --url, --open, --sync, --quiet, --comments, --resolved, or --all.',
  },
];

const watchRules = (
  watch: boolean,
  url: boolean,
  open: boolean,
  sync: boolean,
  quiet: boolean,
  poll: boolean,
  commentsLike: boolean,
): PullRequestFlagRule[] => [
  {
    when: watch && (url || open || sync || quiet || poll || commentsLike),
    message:
      '--watch cannot be combined with --url, --open, --sync, --quiet, --poll, --comments, --resolved, or --all.',
  },
];

const pullRequestFlagRules = (flags: ParsedArguments['flags']): PullRequestFlagRule[] => {
  const url = flags.has('url');
  const open = flags.has('open');
  const comments = flags.has('comments');
  const resolved = flags.has('resolved');
  const all = flags.has('all');
  const sync = flags.has('sync');
  const quiet = flags.has('quiet');
  const poll = flags.has('poll');
  const watch = flags.has('watch');
  const commentsLike = comments || resolved || all;
  return [
    ...commentsRules(url, open, commentsLike, resolved, all),
    ...syncRules(sync, quiet, url, open, commentsLike),
    ...pollRules(poll, url, open, sync, quiet, commentsLike),
    ...watchRules(watch, url, open, sync, quiet, poll, commentsLike),
  ];
};

export const validatePullRequestFlags = (parsed: ParsedArguments): void => {
  for (const rule of pullRequestFlagRules(parsed.flags)) {
    if (rule.when) throw new ScrumlordError('pr_flag_conflict', rule.message);
  }
};

export const parsePollInteger = (
  flags: ParsedArguments['flags'],
  name: string,
  defaultValue: number,
): number => {
  const raw = flags.get(name)?.[0];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ScrumlordError('pr_flag_conflict', `--${name} must be a positive integer.`);
  }
  return parsed;
};

export const parsePollNumber = (
  flags: ParsedArguments['flags'],
  name: string,
  defaultValue: number,
): number => {
  const raw = flags.get(name)?.[0];
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ScrumlordError('pr_flag_conflict', `--${name} must be a positive number.`);
  }
  return parsed;
};
