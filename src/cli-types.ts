import type { AgentInvocation } from './agent-providers.js';
import type { ColorMode } from './color.js';
import type { OutputMode } from './output-mode.js';
import type { CommandRunner } from './command-runner.js';
import type { PullRequestStatusReport, ReviewComment } from './github.js';
import type { PullRequestPollReport } from './github-poll.js';
import type { InitializeProjectOptions } from './init.js';
import type { SetupAgentHooksOptions, SetupAgentHooksResult } from './agent-hooks.js';
import type { SetupGitHooksResult } from './git-hooks.js';
import type { SetupProjectOptions, SetupProjectResult } from './setup.js';
import type { SetupSubagentsOptions, SetupSubagentsResult } from './subagents.js';
import type { PullRequestOverviewItem } from './tasks-overview.js';
import type { TaskStore } from './types.js';

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CliOptions = {
  cwd?: string;
  colorMode?: ColorMode;
  environment?: Record<string, string | undefined>;
  /** Whether stdout is a TTY. Undefined is treated as `false` (JSON path). */
  isStdoutTty?: boolean;
  /** Terminal width in columns. Defaults to 100 when undefined. */
  terminalWidth?: number;
  /**
   * Resolved output mode. Computed once at the boundary by `runTasksCli` and
   * threaded into command handlers. Callers should not set this directly.
   */
  outputMode?: OutputMode;
  createStore?: (cwd: string) => Promise<TaskStore>;
  initializeProject?: (options: InitializeProjectOptions) => Promise<unknown>;
  readStdin?: () => Promise<string>;
  runAgentInvocation?: (invocation: AgentInvocation) => Promise<number>;
  which?: (executable: string) => string | null;
  runner?: CommandRunner;
  homeDirectory?: string;
  setupProject?: (options: SetupProjectOptions) => Promise<SetupProjectResult>;
  setupSubagents?: (
    projectRoot: string,
    options?: SetupSubagentsOptions,
  ) => Promise<SetupSubagentsResult>;
  setupAgentHooks?: (
    projectRoot: string,
    options?: SetupAgentHooksOptions,
  ) => Promise<SetupAgentHooksResult>;
  setupGitHooks?: (projectRoot: string) => Promise<SetupGitHooksResult>;
  syncGitStatus?: (store: TaskStore) => Promise<unknown>;
  github?: {
    repositoryName(projectRoot: string): Promise<string>;
    repositoryUrl(projectRoot: string): Promise<string>;
    pullRequestUrl(projectRoot: string, open: boolean): Promise<{ url: string }>;
    pullRequestStatus(projectRoot: string): Promise<PullRequestStatusReport>;
    pullRequestPollStatus(
      projectRoot: string,
      options?: {
        maxPolls?: number;
        pollIntervalSeconds?: number;
        botPatterns?: string;
        sleep?: (ms: number) => Promise<void>;
      },
    ): Promise<PullRequestPollReport>;
    tasksOverview(store: TaskStore): Promise<PullRequestOverviewItem[]>;
    unresolvedReviewComments(projectRoot: string): Promise<ReviewComment[]>;
    resolvedReviewComments(projectRoot: string): Promise<ReviewComment[]>;
    allReviewComments(projectRoot: string): Promise<ReviewComment[]>;
  };
};
