import type { CommandResult, CommandRunner } from './command-runner.js';

type RunnerReply = CommandResult;

const ok = (stdout = ''): RunnerReply => ({ exitCode: 0, stdout, stderr: '' });
const failure = (): RunnerReply => ({ exitCode: 1, stdout: '', stderr: '' });

const defaultRunnerReplies: ReadonlyArray<[string | RegExp, RunnerReply]> = [
  [/(?:^|\s)--help$/, ok('Options:\n  --worktree [name]\n  -C, --cd <DIR>\n')],
  ['git rev-parse --git-common-dir', ok('.git\n')],
  ['git worktree list --porcelain', ok('')],
  ['git branch --show-current', ok('feature/scratch\n')],
  ['git symbolic-ref --short refs/remotes/origin/HEAD', ok('origin/main\n')],
  [/^git show-ref --verify --quiet refs\/remotes\/origin\/main/, ok('')],
  [/^git show-ref/, failure()],
  [/^git fetch/, ok('')],
  [/^git worktree add/, ok('')],
];

const matchRunner = (joined: string): RunnerReply => {
  for (const [pattern, reply] of defaultRunnerReplies) {
    if (typeof pattern === 'string' ? joined === pattern : pattern.test(joined)) return reply;
  }
  return failure();
};

/**
 * Returns a CommandRunner that answers all the git/help probes `tasks start`
 * performs. Pass `overrides` keyed by the joined command string to inject
 * test-specific replies (e.g., a different current branch).
 */
export const taskStartRunner = (
  overrides: Partial<Record<string, () => Promise<RunnerReply> | RunnerReply>> = {},
): CommandRunner => {
  return async (command) => {
    const joined = command.join(' ');
    const override = overrides[joined];
    return override ? await override() : matchRunner(joined);
  };
};
