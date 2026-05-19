import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { formatStoreResult } from './cli-output.js';
import { ScrumlordError } from './errors.js';
import type { TaskStore } from './types.js';

type OverviewValueLoader = (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
) => Promise<unknown>;

const watchDelayMilliseconds = 30_000;

const overviewWatchOptions = (options: CliOptions): CliOptions => ({
  ...options,
  outputMode: 'pretty',
});

const writeWatchedOverview = (text: string, options: CliOptions): void => {
  const write = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  write(`\u001B[2J\u001B[H${text}`);
};

const overviewValueForWatch = (value: unknown): unknown => {
  if (typeof value === 'object' && value !== null && 'items' in value) {
    return (value as { items: unknown }).items;
  }
  return value;
};

export const runOverviewWatchCommand = async (
  store: TaskStore,
  parsed: ParsedArguments,
  options: CliOptions,
  loadOverviewValue: OverviewValueLoader,
): Promise<CliResult> => {
  if (parsed.flags.has('json')) {
    throw new ScrumlordError(
      'overview_watch_json_unsupported',
      '--watch cannot be combined with --json.',
    );
  }

  const sleep = options.sleep ?? Bun.sleep;
  const maxIterations = options.watchIterations ?? Number.POSITIVE_INFINITY;
  let iterations = 0;

  while (iterations < maxIterations) {
    const watchOptions = overviewWatchOptions(options);
    const value = await loadOverviewValue(store, parsed, watchOptions);
    writeWatchedOverview(
      formatStoreResult(parsed, overviewValueForWatch(value), watchOptions).stdout,
      options,
    );
    iterations += 1;
    if (iterations >= maxIterations) break;
    await sleep(watchDelayMilliseconds);
  }

  return { exitCode: 0, stdout: '', stderr: '' };
};
