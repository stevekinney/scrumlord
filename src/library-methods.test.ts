import { describe, expect, it } from 'bun:test';
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
    expect(helpTopics).toContain('peek');
    expect(ScrumlordError.name).toBe('ScrumlordError');
    expect(nextTask).toBe(next);
    expect(remainingTasks).toBe(remaining);
  });

  it('exports companion types for root-level functions', () => {
    expect(acceptsPublicCompanionTypes({})).toBe(true);
  });
});
