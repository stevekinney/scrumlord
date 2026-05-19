import type { ParsedArguments } from './cli-arguments.js';
import type { CliOptions, CliResult } from './cli-types.js';
import { formatStoreResult } from './cli-output.js';
import { ScrumlordError } from './errors.js';

type PullRequestStatusLoader = () => Promise<unknown>;

const watchDelayMilliseconds = 30_000;

const pullRequestWatchOptions = (options: CliOptions): CliOptions => ({
  ...options,
  outputMode: 'pretty',
});

const writeWatchedPullRequestStatus = (text: string, options: CliOptions): void => {
  const write = options.writeStdout ?? ((value: string) => process.stdout.write(value));
  write(`\u001B[2J\u001B[H${text}`);
};

export const runPullRequestWatchCommand = async (
  parsed: ParsedArguments,
  options: CliOptions,
  loadPullRequestStatus: PullRequestStatusLoader,
): Promise<CliResult> => {
  if (parsed.flags.has('json')) {
    throw new ScrumlordError(
      'pr_watch_json_unsupported',
      '--watch cannot be combined with --json.',
    );
  }

  const sleep = options.sleep ?? Bun.sleep;
  const maxIterations = options.watchIterations ?? Number.POSITIVE_INFINITY;
  let iterations = 0;

  while (iterations < maxIterations) {
    const watchOptions = pullRequestWatchOptions(options);
    writeWatchedPullRequestStatus(
      formatStoreResult(parsed, await loadPullRequestStatus(), watchOptions).stdout,
      options,
    );
    iterations += 1;
    if (iterations >= maxIterations) break;
    await sleep(watchDelayMilliseconds);
  }

  return { exitCode: 0, stdout: '', stderr: '' };
};
