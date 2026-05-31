import { describe, expect, it } from 'bun:test';
import * as packageRoot from './index';
import { storeCommandLibraryMethods, taskStoreCommands } from './cli-store-commands';
import {
  absoluteTaskPlanPath,
  addTaskBlocker,
  addTaskTag,
  agentProviders,
  availableTasks,
  blockedTasks,
  buildTaskResumeInvocation,
  buildSetupInvocation,
  buildTaskStartInvocation,
  checksForPullRequest,
  cleanupTasks,
  completedTasks,
  continuousIntegrationStatus,
  createScrumlordMcpServer,
  createTask,
  createTaskStore,
  createTheme,
  currentGitBranch,
  currentPullRequest,
  defaultTaskPlanPath,
  deleteTask,
  getAgentProvider,
  getTask,
  helpTopics,
  initializeProject,
  launchProviderInvocation,
  listTasks,
  next,
  nextTask,
  openPullRequests,
  pullRequestStatus,
  pullRequestUrl,
  repositoryName,
  repositoryUrl,
  remaining,
  remainingTasks,
  removeTaskBlocker,
  removeTaskTag,
  renderHelp,
  resolveTaskSession,
  reviewCommentsForPullRequest,
  runAgentHook,
  runCommand,
  runScrumlordMcpServer,
  ScrumlordError,
  setTaskPlan,
  setTaskSession,
  setupAgentHooks,
  setupGitHooks,
  setupProject,
  setupSelectionFromFlags,
  setupSelectionFromInput,
  setupSkills,
  setupStatus,
  setupSubagents,
  skillTargets,
  startTask,
  syncGitStatus,
  tasksBlockedBy,
  tasksBlocking,
  tasksOverview,
  taskTags,
  tasksWithAllTags,
  tasksWithAnyTags,
  tasksWithBranch,
  tasksWithPriority,
  tasksWithStatus,
  tasksWithTag,
  unresolvedReviewComments,
  updateTask,
  withTaskStore,
  worktreeForBranch,
} from './index';
import type {
  AgentCliProvider,
  AgentHookOptions,
  AgentHookResult,
  AgentInvocation,
  AgentProvider,
  AgentResumeInvocationContext,
  AgentSetupInvocationContext,
  AgentSessionPathOptions,
  AgentStartInvocationContext,
  CleanupTasksResult,
  ColorMode,
  CommandResult,
  CommandRunner,
  CreateTaskInput,
  CreateTaskStoreOptions,
  CountListTasksOptions,
  CountTaskListingOptions,
  DateInput,
  GitHubOptions,
  InitializeProjectOptions,
  InitializeProjectResult,
  PersistedTaskSession,
  PullRequest,
  PullRequestCheck,
  PullRequestCheckConclusion,
  PullRequestCheckReport,
  PullRequestOverviewItem,
  PullRequestStatusReport,
  ResolveTaskSessionOptions,
  ReviewComment,
  ScrumlordMcpServerOptions,
  ScrumlordError as ScrumlordErrorInstance,
  SetupAgentHooksResult,
  SetupGitHooksOptions,
  SetupGitHooksResult,
  SetupProjectOptions,
  SetupProjectResult,
  SetupSelection,
  SetupStatus,
  SetupStatusProvider,
  SetupStatusSkill,
  SetupSubagentsOptions,
  SetupSubagentsResult,
  SkillTarget,
  SubagentScope,
  SyncGitStatusOptions,
  SyncGitStatusResult,
  SynchronizedPullRequestState,
  Task,
  TaskAgentCommandOptions,
  TaskAgentCommandResult,
  TaskIdentifier,
  TaskListingOptions,
  ListTasksOptions,
  TaskPlanFilter,
  TaskPriority,
  TaskReference,
  TaskSession,
  TaskStatus,
  TaskStore,
  Theme,
  UpdateTaskInput,
  WrittenSkill,
  WhichExecutable,
  WrittenSubagent,
  WrittenSubagentSkill,
} from './index';

type PublicCompanionTypes = {
  agentCliProvider: AgentCliProvider;
  agentHookOptions: AgentHookOptions;
  agentHookResult: AgentHookResult;
  agentInvocation: AgentInvocation;
  agentProvider: AgentProvider;
  agentResumeInvocationContext: AgentResumeInvocationContext;
  agentSetupInvocationContext: AgentSetupInvocationContext;
  agentSessionPathOptions: AgentSessionPathOptions;
  agentStartInvocationContext: AgentStartInvocationContext;
  cleanupTasksResult: CleanupTasksResult;
  colorMode: ColorMode;
  commandResult: CommandResult;
  commandRunner: CommandRunner;
  createTaskInput: CreateTaskInput;
  createTaskStoreOptions: CreateTaskStoreOptions;
  countListTasksOptions: CountListTasksOptions;
  countTaskListingOptions: CountTaskListingOptions;
  dateInput: DateInput;
  gitHubOptions: GitHubOptions;
  initializeProjectOptions: InitializeProjectOptions;
  initializeProjectResult: InitializeProjectResult;
  persistedTaskSession: PersistedTaskSession;
  pullRequest: PullRequest;
  pullRequestCheck: PullRequestCheck;
  pullRequestCheckConclusion: PullRequestCheckConclusion;
  pullRequestCheckReport: PullRequestCheckReport;
  pullRequestOverviewItem: PullRequestOverviewItem;
  pullRequestStatusReport: PullRequestStatusReport;
  resolveTaskSessionOptions: ResolveTaskSessionOptions;
  reviewComment: ReviewComment;
  scrumlordMcpServerOptions: ScrumlordMcpServerOptions;
  scrumlordError: ScrumlordErrorInstance;
  setupAgentHooksResult: SetupAgentHooksResult;
  setupGitHooksOptions: SetupGitHooksOptions;
  setupGitHooksResult: SetupGitHooksResult;
  setupProjectOptions: SetupProjectOptions;
  setupProjectResult: SetupProjectResult;
  setupSelection: SetupSelection;
  setupStatus: SetupStatus;
  setupStatusProvider: SetupStatusProvider;
  setupStatusSkill: SetupStatusSkill;
  setupSubagentsOptions: SetupSubagentsOptions;
  setupSubagentsResult: SetupSubagentsResult;
  skillTarget: SkillTarget;
  subagentScope: SubagentScope;
  syncGitStatusOptions: SyncGitStatusOptions;
  syncGitStatusResult: SyncGitStatusResult;
  synchronizedPullRequestState: SynchronizedPullRequestState;
  taskAgentCommandOptions: TaskAgentCommandOptions;
  taskAgentCommandResult: TaskAgentCommandResult;
  taskIdentifier: TaskIdentifier;
  taskListingOptions: TaskListingOptions;
  listTasksOptions: ListTasksOptions;
  taskPlanFilter: TaskPlanFilter;
  taskPriority: TaskPriority;
  taskReference: TaskReference;
  taskSession: TaskSession;
  taskStatus: TaskStatus;
  taskStore: TaskStore;
  theme: Theme;
  updateTaskInput: UpdateTaskInput;
  writtenSkill: WrittenSkill;
  whichExecutable: WhichExecutable;
  writtenSubagent: WrittenSubagent;
  writtenSubagentSkill: WrittenSubagentSkill;
};

const acceptsPublicCompanionTypes = (_value: Partial<PublicCompanionTypes>): boolean => true;

describe('library command equivalents', () => {
  it('exports a package-root method for each CLI command family', () => {
    const methods = [
      absoluteTaskPlanPath,
      initializeProject,
      launchProviderInvocation,
      renderHelp,
      createTheme,
      createScrumlordMcpServer,
      createTaskStore,
      availableTasks,
      blockedTasks,
      completedTasks,
      getTask,
      listTasks,
      tasksWithTag,
      tasksWithAllTags,
      tasksWithAnyTags,
      tasksWithBranch,
      tasksBlockedBy,
      tasksBlocking,
      tasksWithPriority,
      tasksWithStatus,
      taskTags,
      next,
      remaining,
      resolveTaskSession,
      createTask,
      updateTask,
      deleteTask,
      addTaskTag,
      removeTaskTag,
      setTaskPlan,
      setTaskSession,
      addTaskBlocker,
      removeTaskBlocker,
      setTaskPlan,
      setTaskSession,
      cleanupTasks,
      syncGitStatus,
      setupSkills,
      setupGitHooks,
      setupAgentHooks,
      setupProject,
      setupSelectionFromFlags,
      setupSelectionFromInput,
      setupStatus,
      setupSubagents,
      runAgentHook,
      startTask,
      runScrumlordMcpServer,
      runCommand,
      withTaskStore,
      currentGitBranch,
      worktreeForBranch,
      currentPullRequest,
      repositoryName,
      repositoryUrl,
      pullRequestUrl,
      pullRequestStatus,
      tasksOverview,
      unresolvedReviewComments,
      continuousIntegrationStatus,
      openPullRequests,
      reviewCommentsForPullRequest,
      checksForPullRequest,
      defaultTaskPlanPath,
      getAgentProvider,
      buildSetupInvocation,
      buildTaskStartInvocation,
      buildTaskResumeInvocation,
    ];

    expect(methods.every((method) => typeof method === 'function')).toBe(true);
    expect(agentProviders).toEqual(['claude', 'codex']);
    expect(skillTargets).toEqual(['codex', 'claude']);
    expect(helpTopics).toContain('next');
    expect(ScrumlordError.name).toBe('ScrumlordError');
    expect(nextTask).toBe(next);
    expect(remainingTasks).toBe(remaining);
  });

  // This is the real parity guard. The hand-maintained list above is a sanity
  // check on the surface; these two tests are what fail when a `tasks <command>`
  // is added without a matching package-root export. The expectation is derived
  // from `storeCommandLibraryMethods`, so the only way to keep the suite green is
  // to wire the new command to a real library function and export it.
  it('keeps the command→library map in lockstep with the store commands', () => {
    const mappedCommands = new Set(Object.keys(storeCommandLibraryMethods));
    const storeCommands = new Set(taskStoreCommands);
    // Every store command must declare a library equivalent...
    const unmapped = [...storeCommands].filter((command) => !mappedCommands.has(command));
    // ...and the map must not name commands that no longer exist.
    const stale = [...mappedCommands].filter((command) => !storeCommands.has(command));
    expect({ unmapped, stale }).toEqual({ unmapped: [], stale: [] });
  });

  it('exports every library method that backs a store command', () => {
    const expected = [...new Set(Object.values(storeCommandLibraryMethods).flat())].toSorted();
    const missing = expected.filter(
      (name) => typeof (packageRoot as Record<string, unknown>)[name] !== 'function',
    );
    expect(missing).toEqual([]);
  });

  it('exports companion types for root-level functions', () => {
    expect(acceptsPublicCompanionTypes({})).toBe(true);
  });
});
